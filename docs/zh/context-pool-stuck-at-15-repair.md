# Context 热池目标 16、常驻 15：修复文档

## 1. 问题摘要

部署包含 context 初始化 single-flight 修复的新版本后，配置明确要求：

```dotenv
MAX_CONTEXTS=16
MAX_BROWSER_WORKERS=16
CONTEXT_POOL_MIN_READY=16
CONTEXT_INIT_CONCURRENCY=2
```

服务启动日志也确认：

```text
[Scheduler] Model-aware ready-context pool enabled (16 max, 16 warm).
```

但启动完成后只常驻 15 个 context。线上日志显示账号 `#0` 至 `#14` 均成功完成初始化，没有 `#15 init_started`，也没有初始化失败、浏览器崩溃、容器重启或 OOM。

结论：这不是账号不足、初始化失败或 context 泄漏，而是补池调用发生在初始化任务标记释放之前，造成一个“幽灵占位”。池在最后一次初始化结束后没有重新计算，因此稳定停在目标值减一。

## 2. 影响范围

- 当前 15 个 context 均可正常服务请求。
- 热池容量比配置目标少 1 个。
- 服务有新的冷账号需求、账号启停或其他事件再次调用 `_pumpContextPool()` 时，第 16 个 context 可能随后被创建。
- 重启不能根治：相同启动时序仍可能再次停在 15。
- 该问题与此前 WebSocket 已连接却被误判超时的问题不同；single-flight 修复本身有效，本问题是修复后清理/补池顺序产生的回归。

## 3. 线上证据

### 3.1 已确认事实

- 运行镜像：`aistudio-to-api:local-upgrade-20260916T0510Z`。
- 容器启动后没有重启。
- 100 个有效认证源已加载，账号数量足够。
- `#0` 至 `#14` 共 15 个 attempt 均记录：
  - `init_started`；
  - `Connection successful!`；
  - `ws_connected`；
  - `init_finished`。
- 日志中不存在 `#15 init_started`。
- 部署后不存在 `initialization failed`、`initialization timeout` 或 `Context unavailable`。

因此，第 16 个 context 不是“启动后失败”，而是根本没有被调度启动。

## 4. 根因

### 4.1 当前调用顺序

`_startPooledContext()` 通过 `_getOrStartContextInit()` 创建任务。任务包含两层结束处理：

```text
runner finally
    └─ 调用 _pumpContextPool()

_getOrStartContextInit task finally
    ├─ 删除 _contextInitTasks[authIndex]
    └─ 删除 initializingContexts[authIndex]
```

问题在于 runner 的 `finally` 先执行，而真正释放任务标记的外层 `finally` 后执行。

### 4.2 最后一个任务完成时的错误计算

当第 15 个 context 已经就绪、当前初始化任务即将结束时：

```text
readyCount = 15
initializingContexts.size = 1  // 当前任务尚未释放
target = 16
```

`_poolCandidates()` 的计算为：

```js
needWarm = Math.max(0, target - readyCount - initializingContexts.size);
// Math.max(0, 16 - 15 - 1) === 0
```

因此提前执行的 `_pumpContextPool()` 认为不需要继续预热。

随后 `_getOrStartContextInit()` 的外层 `finally` 删除当前任务和初始化标记，但删除后没有再次调用 `_pumpContextPool()`。此时真实状态已经是：

```text
readyCount = 15
initializingContexts.size = 0
needWarm = 1
```

由于没有新的 pump，`#15` 永远不会开始，直到其他外部事件触发补池。

## 5. 修复原则

1. 初始化任务的发布、标记释放和结束回调必须由同一个 single-flight 所有者管理。
2. 补池必须发生在 `_contextInitTasks` 和 `initializingContexts` 完成释放之后。
3. `blockedByCapacity` 语义必须保留，避免所有 worker 都忙时形成立即重试循环。
4. 不要用 `setTimeout()`、多层 `queueMicrotask()` 等时序技巧掩盖问题；应显式提供“释放后回调”。
5. 不应把 `CONTEXT_POOL_MIN_READY` 临时改成 17 来抵消误差，这会破坏容量约束。

## 6. 推荐代码修改

### 6.1 给 single-flight 增加释放后回调

在 `_getOrStartContextInit()` 中支持 `onSettledAfterRelease`。必须先删除标记，再执行回调：

```js
_getOrStartContextInit(authIndex, options = {}) {
    const existing = this._contextInitTasks.get(authIndex);
    if (existing) return existing;

    // attempt 创建逻辑保持不变

    const task = Promise.resolve()
        .then(() => {
            this.logger.info(`[Context#${authIndex}] init_started attempt=${attempt.id}`);
            return runner(attempt);
        })
        .finally(() => {
            let released = false;
            if (this._contextInitTasks.get(authIndex) === task) {
                this._contextInitTasks.delete(authIndex);
                this.initializingContexts.delete(authIndex);
                this.abortedContexts.delete(authIndex);
                released = true;
            }

            this.logger.info(`[Context#${authIndex}] init_finished attempt=${attempt.id}`);

            if (released) {
                options.onSettledAfterRelease?.();
            }
        });

    this._contextInitTasks.set(authIndex, task);
    return task;
}
```

回调只在当前 task 仍是该账号的所有者并成功释放标记时执行，避免旧 task 为新 task 触发错误补池。

### 6.2 把池调度的补池动作移到释放后

`_startPooledContext()` 中删除 runner `finally` 里的 `_pumpContextPool()`，改为：

```js
return this._getOrStartContextInit(authIndex, {
    isBackgroundTask: true,
    runner: async attempt => {
        try {
            // 原初始化、容量检查和错误处理逻辑保持不变
        } finally {
            // 这里只保留无需等待标记释放的局部清理；不要在这里 pump。
        }
    },
    onSettledAfterRelease: () => {
        if (blockedByCapacity) return;
        this.scheduler?.drain();
        this._pumpContextPool();
    },
});
```

如果 runner 已经在正常和异常路径完成 `scheduler.drain()`，也应将它统一移动到 `onSettledAfterRelease`，避免同一任务结束时重复 drain/pump。

### 6.3 为什么不建议只增加一次无条件 pump

直接在 `_getOrStartContextInit().finally()` 中无条件调用 `_pumpContextPool()` 虽然能修复 15/16，但会影响所有调用方，包括前台切换、旧预热流程和关闭流程；在容量完全被忙 context 占用时还可能制造无意义的调度循环。

显式的 `onSettledAfterRelease` 能把“现代热池任务结束后继续补池”的行为限制在 `_startPooledContext()`，边界更清晰。

## 7. 回归测试

在 `tests/browser-workers.test.js` 增加以下测试。

### 7.1 热池必须精确达到目标值

```js
test("warm pool reaches all 16 workers after init markers are released", async () => {
    const manager = browserFixture(16);
    manager.authSource.getRotationIndices = () => Array.from({ length: 100 }, (_, index) => index);
    manager.scheduler.config.contextPoolMinReady = 16;
    manager.scheduler.config.contextInitConcurrency = 2;
    manager.scheduler.account = () => ({ healthy: true, inflight: 0, models: {} });

    manager.startContextPool();

    const deadline = Date.now() + 2000;
    while (
        (manager.contexts.size !== 16 || manager._contextInitTasks.size !== 0) &&
        Date.now() < deadline
    ) {
        await new Promise(resolve => setImmediate(resolve));
    }

    assert.equal(manager.contexts.size, 16);
    assert.equal(manager.initializingContexts.size, 0);
    assert.equal(manager._contextInitTasks.size, 0);
});
```

此测试在当前缺陷版本上应得到 15，并明确失败；应用修复后应稳定得到 16。

### 7.2 建议补充的参数化测试

对以下组合逐一验证最终 ready 数等于 `min(target, enabledAccounts, maxWorkers)`：

| target | init concurrency | enabled accounts | 预期 ready |
| ---: | ---: | ---: | ---: |
| 1 | 1 | 100 | 1 |
| 2 | 2 | 100 | 2 |
| 15 | 2 | 100 | 15 |
| 16 | 2 | 100 | 16 |
| 16 | 1 | 100 | 16 |
| 16 | 4 | 100 | 16 |
| 16 | 2 | 10 | 10 |

还应验证：

- 任意时刻 `_contextInitTasks.size <= CONTEXT_INIT_CONCURRENCY`；
- 不超过 `MAX_BROWSER_WORKERS`；
- 被禁用账号不进入热池；
- `blockedByCapacity=true` 时不会形成同步或微任务忙循环；
- 一个任务失败后，释放标记并继续尝试下一可用账号；
- 服务关闭后，释放回调不得重新启动 context。

## 8. 临时措施

代码修复发布前，15 个已就绪 context 可以继续承载流量，不需要为了补足一个 context 紧急重启服务。

注意：

- 不要把 `CONTEXT_INIT_CONCURRENCY` 降为 1。当前缺陷下，这可能让启动预热更早停止，因为唯一任务结束时同样会把自己算作初始化占位。
- 如果实际只需要 15 个常驻 context，可以把 `MAX_BROWSER_WORKERS`、`MAX_CONTEXTS` 和 `CONTEXT_POOL_MIN_READY` 全部明确设为 15；这属于容量策略调整，不是修复。
- 不建议在线手动触发账号切换来补第 16 个，因为当前 15 个 context 已健康，额外操作收益很小。

## 9. 部署步骤

### 9.1 部署前

1. 应用第 6 节修改。
2. 运行 `tests/browser-workers.test.js` 和完整测试集。
3. 确认新增 16-worker 测试在未修复版本失败、修复版本通过。
4. 构建新的不可变镜像标签，不覆盖当前 `local-upgrade-20260916T0510Z`。
5. 保留当前 compose override 和镜像 ID，便于快速回滚。

### 9.2 发布

修复需要替换 `aistudio-to-api` 容器，应安排短维护窗口。只更新 aistudio 服务：

```bash
cd /opt/ai-gateway
docker compose up -d --no-deps aistudio
```

不要重建 PostgreSQL、Redis、New API 或 antigravity，也不要删除认证和数据挂载目录。

### 9.3 验收

启动后应看到恰好 16 个不同账号的：

```text
init_started
ws_connected
init_finished
```

随后确认：

- ready/busy context 合计为 16；
- `_contextInitTasks` 和 `initializingContexts` 最终均为空；
- 没有第 17 个初始化 attempt，除非发生正常账号置换；
- 没有初始化失败、WebSocket 误判或持续补池循环；
- 空闲稳定期 CPU 和内存不持续增长。

推荐验收日志命令：

```bash
docker logs --since 15m aistudio-to-api 2>&1 \
  | grep -E "init_started|init_finished|ws_connected|initialization_timeout|ContextPool"
```

## 10. 回滚

如果新版本出现重复初始化、超过 16 个 context 或持续补池循环：

1. 将 compose override 恢复到当前镜像 `aistudio-to-api:local-upgrade-20260916T0510Z`；
2. 只重建 `aistudio` 服务；
3. 保留 `aistudio/auth` 和 `aistudio/data`；
4. 回滚后接受暂时常驻 15 个 context，该状态可正常提供服务。

## 11. 完成标准

满足以下条件才算修复完成：

- 配置目标为 16 时，启动后无需外部请求即可自动达到 16；
- 初始化并发上限始终为 2；
- 最后一个任务释放后会自动重新计算热池缺口；
- 目标为 1、2、15、16 时均无 off-by-one；
- 失败和容量阻塞路径不会形成重试忙循环；
- 线上观察一个完整账号轮换周期后，热池仍能自动回到目标值。

