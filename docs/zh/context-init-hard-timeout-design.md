# Browser Context 初始化硬超时与故障自愈改造方案

> 2026-10-14 更新：本文保留历史排查背景；浏览器生命周期、必要鼠标行为、恢复判断及外部监督以[浏览器恢复与调度负载优化方案](./browser-recovery-and-scheduler-optimization-plan-20261013.md)及现有实现为准。初始化/页面错误不得改变账号资格。

## 1. 背景

2026-09-28，线上出现大量 `504 Queue timeout`。排查发现，请求入口、内部 WebSocket 和代理节点均可用，真正的故障链如下：

1. 部分已加载账号因 Google 返回 `429 RESOURCE_EXHAUSTED` 进入模型级冷却；
2. 调度器尝试换入仍有额度的冷账号；
3. `Context#15` 和 `Context#16` 完成页面导航后，卡在 WebSocket 初始化等待阶段；
4. 两个任务长期保持 `INITIALIZING`，占满 `CONTEXT_INIT_CONCURRENCY=2`；
5. 调度器无法继续换入其他账号；
6. `gemini-3.1-pro-preview` 和 `gemini-3.7-flash` 的 `ready_accounts` 降为 0；
7. 请求等待 `REQUEST_DISPATCH_TIMEOUT_MS=60000` 后返回 504。

故障期间，两个初始化任务远超名义上的 120 秒超时，直到容器重启、浏览器被关闭后才退出：

```text
[Context#15] init_started attempt=15:34
[Context#15 attempt=15:34] Waiting for ... timeout: 120s

[Context#16] init_started attempt=16:35
[Context#16 attempt=16:35] Waiting for ... timeout: 120s
```

在隔离的新 Camoufox 实例中，使用相同账号认证文件访问相同页面时，导航、locator 查询、`page.evaluate()` 和鼠标操作均能正常返回。这说明账号、认证文件、目标页面和网络并非稳定复现条件；长期运行的共享浏览器中出现了页面级或 Playwright 协议级调用不返回的情况。

## 2. 根因

### 2.1 当前超时不是可抢占的硬超时

`_waitForWebSocketInit()` 通过循环条件判断是否超过 120 秒：

```js
while (Date.now() - startTime < timeout) {
  await somePlaywrightOperation();
}
```

如果 `somePlaywrightOperation()` 返回的 Promise 一直不结束，代码永远无法重新执行循环条件。当前等待流程包含多处这种调用：

- `locator.count()`；
- `locator.isVisible()`；
- `locator.isEnabled()`；
- `locator.click()`；
- `page.evaluate()`；
- `page.mouse.move()`；
- `page.waitForTimeout()`。

其中只有个别点击操作设置了 Playwright 自身的 timeout。循环总时限无法中断挂起的 RPC。

### 2.2 初始化任务没有统一的总 watchdog

`_createBrowserContext()` 已对 `browser.newContext()` 使用 `Promise.race()`，但完整的 `_initializeContext()` 没有总 watchdog。因此，context 创建完成后的任意阶段都可能永久挂起。

### 2.3 超时后仅返回错误仍不够

仅在外层使用 `Promise.race()` 会让调用方提前收到错误，但不会自动取消已经发给 Playwright 的底层操作。Playwright 的大多数页面 API 不接受 `AbortSignal`。

要真正终止挂起操作，必须关闭本次 attempt 创建的 page 或 BrowserContext。清理操作自身也可能挂起，因此关闭动作同样需要有界等待。

### 2.4 两个挂起任务会阻塞整个账号换入通道

初始化并发由 `CONTEXT_INIT_CONCURRENCY` 控制。挂起任务未执行 `_getOrStartContextInit()` 的 `finally`，以下状态无法释放：

- `_contextInitTasks`；
- `initializingContexts`；
- 初始化 semaphore/并发名额；
- context 池中的 `INITIALIZING` 状态。

当所有初始化名额被占满后，即使还有大量未冷却账号，调度器也无法把它们加载进浏览器。

## 3. 改造目标

本次改造必须满足以下目标：

1. 任意单个 Playwright 初始化操作不能无限等待；
2. 完整 context 初始化不能超过配置的总时限；
3. 超时后必须释放初始化跟踪状态和并发名额；
4. 旧 attempt 后续恢复时不得覆盖或删除新 attempt 的资源；
5. 日志必须指出超时阶段、具体操作和 attempt；
6. 清理失败不能再次形成永久等待；
7. 多个页面同时出现协议超时时，能够识别浏览器级故障；
8. 健康接口能够发现超龄的 `INITIALIZING` 状态；
9. 修复不能中断仍在正常输出的其他 context，除非确认浏览器 transport 整体失效。

## 4. 总体设计

采用三层保护：

| 层级              | 作用                                               |         建议默认值 |
| ----------------- | -------------------------------------------------- | -----------------: |
| 单操作硬超时      | 限制 locator、evaluate、mouse 等 RPC               |              10 秒 |
| 初始化总 watchdog | 限制一次 `_initializeContext()` 的完整生命周期     |             180 秒 |
| 浏览器级 watchdog | 关键操作超时后进行独立健康探测，确认共享故障才恢复 | 数量阈值仅启动探测 |

“硬超时”仅保证在事件循环可运行时有界结束等待，不保证底层 RPC 已取消。触发后尝试关闭所属资源；关闭失败时保留物理容量记账并升级恢复。主线程卡死时由外部 supervisor 处理，不能依赖进程内计时器抢占。

## 5. Attempt 状态模型

扩展现有 attempt 对象：

```js
{
    id: "15:34",
    authIndex: 15,
    startedAt: 179059...,
    deadlineAt: 179059...,
    phase: "ws_initialization",
    operation: "continue_button.locator.count",
    phaseStartedAt: 179059...,
    operationStartedAt: 179059...,
    connectionEpoch: 0,
    ws: { failed: false, success: false },
    context: null,
    page: null,
    aborted: false,
    abortReason: null,
    settled: false,
}
```

状态写入规则：

- 每进入一个初始化阶段，先同步更新 `phase` 和 `phaseStartedAt`；
- 每次调用 Playwright API 前，先同步更新 `operation` 和 `operationStartedAt`；
- context/page 创建后立即保存到 attempt，供 watchdog 清理；
- watchdog 触发时设置 `aborted=true` 和 `abortReason`；
- context 发布到 `contexts` Map 前必须再次检查 attempt 是否仍是当前 owner；
- attempt 完成后设置 `settled=true`。

## 6. 通用硬超时工具

新增统一工具，例如 `src/utils/TimeoutUtils.js`：

```js
class OperationTimeoutError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "OperationTimeoutError";
    this.code = details.code || "OPERATION_TIMEOUT";
    this.reason = details.reason || "operation_timeout";
    Object.assign(this, details);
  }
}

function withHardTimeout(task, timeoutMs, details = {}) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new OperationTimeoutError(`${details.operation || "Operation"} timed out after ${timeoutMs}ms`, {
          ...details,
          timeoutMs,
        })
      );
    }, timeoutMs);
  });

  return Promise.race([Promise.resolve().then(task), timeout]).finally(() => clearTimeout(timer));
}
```

调用方必须给原始 Promise 添加 rejection handler，避免 timeout 先结束后原任务再拒绝时形成未处理 rejection：

```js
const operation = Promise.resolve().then(task);
operation.catch(() => {});
return Promise.race([operation, timeoutPromise]);
```

该工具只负责使等待方按时退出。真正取消 Playwright 操作由初始化 watchdog 的清理逻辑负责。

## 7. 单个 Playwright 操作超时

对初始化路径中的页面操作统一封装：

```js
async _runInitOperation(attempt, operation, task, timeoutMs = this.contextOperationTimeoutMs) {
    attempt.operation = operation;
    attempt.operationStartedAt = Date.now();

    try {
        return await withHardTimeout(task, timeoutMs, {
            authIndex: attempt.authIndex,
            attemptId: attempt.id,
            code: "PLAYWRIGHT_RPC_TIMEOUT",
            operation,
            phase: attempt.phase,
            reason: "playwright_rpc_timeout",
        });
    } finally {
        attempt.operation = null;
        attempt.operationStartedAt = null;
    }
}
```

需要覆盖：

- Continue 按钮的 `locator.count/isVisible/isEnabled/click`；
- Skip 按钮检查；
- Launch 按钮 `page.evaluate()`；
- 页面错误检查 `page.evaluate()`；
- 初始化阶段的鼠标操作；
- 初始化阶段的其他无 Playwright timeout 参数的 RPC。

对于本身支持 timeout 的 API，也应保留统一外层 timeout，使错误码和日志格式一致。

## 8. 初始化总 watchdog

### 8.1 入口

在 `_getOrStartContextInit()` 中，对 runner 增加总 watchdog，而不是让各调用入口自行处理：

```js
const runnerTask = Promise.resolve().then(() => runner(attempt));
runnerTask.catch(() => {});

const task = Promise.race([runnerTask, this._createContextInitWatchdog(attempt)]).finally(() =>
  this._releaseContextInitOwnership(attempt)
);
```

这样所有初始化入口共享相同保护：

- 启动预热；
- 动态账号换入；
- 手工 apply/rebuild；
- 恢复流程；
- 单账号切换。

### 8.2 Watchdog 行为

watchdog 到期后按以下顺序执行：

1. 原子设置 `attempt.aborted=true`；
2. 记录 `context_init_timeout` 结构化日志；
3. 从正确性层面注销 attempt owner，防止晚到任务发布资源；
4. 对 `attempt.context` 发起关闭；
5. context 关闭最多等待 5 秒；
6. 关闭失败时记录 `context_cleanup_timeout`；
7. 抛出 `CONTEXT_INIT_TOTAL_TIMEOUT`；
8. 通知 context 池继续泵送下一个候选账号。

注意：释放 owner 后，旧 runner 可能仍在后台执行。因此 `_initializeContext()` 内所有写入共享状态的步骤都必须进行 attempt owner 校验。

### 8.3 释放后的调度只能由一个入口决定

`_getOrStartContextInit()` 的公共 `finally` 负责清除 watchdog、释放当前 attempt 的 owner 和初始化名额。释放完成后，按以下规则通知调度器：

```js
if (released) {
  if (options.onSettledAfterRelease) options.onSettledAfterRelease();
  else this.scheduler?.drain?.();
}
```

有 `onSettledAfterRelease` 时，由该回调决定是否继续调度；没有回调时，才执行默认 `drain()`。公共 `finally` 不得在回调执行后追加一次无条件 `drain()`。

context 池的 runner 在以下两种情况下设置 `blockedByCapacity=true` 并返回：

1. 目标账号已有旧 context，且该账号仍有 inflight 请求；
2. context 容量已满，且没有可淘汰的空闲 context。

这两种返回表示等待占用变化，并不表示需要立即重试。回调检查 `blockedByCapacity` 后停止泵送，保留 `contextDemand`；已有请求通过 `ModelScheduler.release()` 释放占用时，再由 `drain()` 重新发出 context demand。正常初始化完成或其他失败仍由池回调执行 `drain()` 和 `_pumpContextPool()`。

总 watchdog 只能限制一次 attempt 的等待时间。对于立即返回、持续重建 attempt 的 Promise 微任务循环，每次完成都会清除自己的 watchdog，而且循环会阻止定时器获得执行机会。因此 watchdog 不能替代容量阻塞保护。

## 9. 所有权隔离与晚到任务处理

新增判断：

```js
_isCurrentInitAttempt(attempt) {
    return this._contextInitAttempts.get(attempt.authIndex) === attempt && !attempt.aborted;
}
```

以下操作前必须检查 owner：

- 写入 `contexts`；
- 标记 context 为 `READY`；
- 保存认证文件；
- 启动健康监控；
- 通知 scheduler drain；
- 删除或关闭账号当前 context。

发布 context 时保存 `attemptId`：

```js
this.contexts.set(authIndex, {
    attemptId: attempt.id,
    context,
    page,
    ...
});
```

失败清理只能删除属于自己的实例：

```js
const current = this.contexts.get(authIndex);
if (current?.attemptId === attempt.id) {
  this.contexts.delete(authIndex);
}
```

如果旧 runner 在 watchdog 之后恢复，应记录：

```text
context_init_late_settlement attempt=15:34 outcome=resolved ignored=true
```

不得把晚到结果重新放入 context 池。

## 10. 有界资源清理

新增清理函数：

```js
async _closeAttemptContext(attempt) {
    const context = attempt.context;
    if (!context) return;

    const closeTask = context.close().catch(error => ({ error }));
    const result = await Promise.race([
        closeTask,
        new Promise(resolve => setTimeout(() => resolve({ timedOut: true }), 5000)),
    ]);

    if (result?.timedOut) {
        this.logger.error(/* context_cleanup_timeout */);
    }
}
```

不得因为 `context.close()` 不返回而延迟释放初始化名额。清理超时后，把该浏览器记录为疑似 transport 异常。

## 11. 浏览器级自愈

单个页面 RPC 超时优先只关闭对应 context，避免影响其他请求。

数量阈值不再直接判断浏览器整体失效：

- 默认 60 秒内两个不同账号发生关键 RPC 超时，仅触发独立、有界的页面健康探测；有响应页面时保留健康资源。
- 鼠标移动是必要行为，失败后有界结束本次操作、清理资源并退避重建后重新执行，不跳过动作，也不进入全局 RPC 数量判定。
- 认证刷新独立于 READY 发布，失败不直接触发全池恢复。
- 浏览器断连、关键探测共同失败或物理清理持续无法完成时，允许扩大恢复范围。

浏览器恢复先建立接纳与补池屏障，结束受影响旧请求及任务，再串行关闭和启动实例。旧代际回调不能清空新资源。必须等一个 context 的连接及必要鼠标动作均满足要求，才报告服务恢复并逐步补池；失败保持屏障并请求外部应用恢复。

浏览器和应用恢复都有退避及预算。超时不等于物理释放，关闭失败由 supervisor 跟踪并终止进程树；运行恢复使用最后正常运行配置，避免激活待重启配置。完整流程和验收见新方案。

## 12. 日志设计

日志必须能回答以下问题：

- 哪个账号、哪个 attempt 超时；
- 卡在哪个阶段；
- 卡在哪个 Playwright 操作；
- 总共运行多久；
- 当前页面 URL；
- 使用什么代理来源和节点；
- WebSocket 是否出现过；
- ConnectionRegistry epoch 是否变化；
- context 清理是否成功；
- 初始化名额是否释放；
- 是否触发浏览器级恢复。

推荐日志：

```text
[Context#15] context_init_timeout attempt=15:34 reason=playwright_rpc_timeout \
phase=ws_initialization operation=continue_button.locator.count \
elapsed_ms=180001 phase_elapsed_ms=176404 operation_elapsed_ms=10001 \
page_url=https://aistudio.google.com/apps/... \
proxy_source=direct_node applied_node_id=node-... \
ws_console_success=false connection_epoch_before=0 connection_epoch_current=0 \
browser_connected=true
```

清理日志：

```text
[Context#15] context_init_cleanup attempt=15:34 context_closed=true duration_ms=84
[Context#15] context_init_released attempt=15:34 initializing_count=1 pending_init=4
```

清理也超时时：

```text
[Context#15] context_cleanup_timeout attempt=15:34 timeout_ms=5000 browser_suspect=true
```

不得为了记录超时原因再调用 `page.title()`、`page.content()` 或截图，因为页面 RPC 已经可能失效。`page.url()` 是同步读取缓存，可用于日志；其他诊断信息应来自 attempt 中已保存的状态。

## 13. 错误码

统一错误结构：

| code                             | reason                           | 含义                       |
| -------------------------------- | -------------------------------- | -------------------------- |
| `CONTEXT_CREATION_TIMEOUT`       | `context_creation_timeout`       | BrowserContext 创建超时    |
| `NAVIGATION_TIMEOUT`             | `navigation_timeout`             | 目标页导航超时             |
| `PLAYWRIGHT_RPC_TIMEOUT`         | `playwright_rpc_timeout`         | 单个 Playwright RPC 不返回 |
| `CONSENT_DIALOG_TIMEOUT`         | `consent_dialog_timeout`         | Continue 弹窗无法关闭      |
| `WS_CONNECTION_TIMEOUT`          | `ws_connection_timeout`          | 内部 WebSocket 未建立      |
| `CONTEXT_INIT_TOTAL_TIMEOUT`     | `context_init_total_timeout`     | 初始化总时限耗尽           |
| `CONTEXT_CLEANUP_TIMEOUT`        | `context_cleanup_timeout`        | context 清理不返回         |
| `BROWSER_TRANSPORT_UNRESPONSIVE` | `browser_transport_unresponsive` | 共享浏览器协议通道失效     |

错误对象应包含：

```js
{
    code,
    reason,
    authIndex,
    attemptId,
    phase,
    operation,
    elapsedMs,
    timeoutMs,
}
```

## 14. 配置项

新增配置：

```dotenv
# 单个初始化阶段 Playwright RPC 的最大等待时间
CONTEXT_OPERATION_TIMEOUT_MS=10000

# 从 init_started 到成功发布 READY context 的总时限
CONTEXT_INIT_TOTAL_TIMEOUT_MS=180000

# 关闭异常 BrowserContext 的最大等待时间
CONTEXT_CLEANUP_TIMEOUT_MS=5000

# 浏览器级故障统计窗口
BROWSER_RPC_FAILURE_WINDOW_MS=60000

# 统计窗口内达到该次数后触发浏览器级恢复
BROWSER_RPC_FAILURE_THRESHOLD=2
```

校验要求：

- 所有值必须为安全正整数；
- `CONTEXT_INIT_TOTAL_TIMEOUT_MS` 必须大于单操作 timeout；
- 总时限不应小于正常导航 timeout 与 WebSocket 初始化预期的合理组合；
- 配置错误时启动失败，不静默回退。

## 15. 健康检查

扩展 `/health` 或新增内部深度健康状态：

```json
{
  "status": "degraded",
  "browserConnected": true,
  "contextPool": {
    "ready": 10,
    "initializing": 2,
    "staleInitializing": 2,
    "oldestInitializingMs": 584000
  },
  "scheduler": {
    "queued": 36,
    "modelsWithoutReadyAccounts": ["gemini-3.1-pro-preview"]
  }
}
```

判定建议：

- 任一初始化时间超过 `CONTEXT_INIT_TOTAL_TIMEOUT_MS + 10000`：`degraded`；
- 所有初始化名额都超龄：`unhealthy`；
- 浏览器断开：`unhealthy`；
- 有候选账号但某模型 `ready_accounts=0` 且队列持续增长：`degraded`。

Docker 自身不会因为容器变为 `unhealthy` 自动重启。若需要容器级兜底，应由宿主机 systemd、容器编排器或专用 watchdog 根据健康状态执行重启。

## 16. 调度器联动

当初始化 attempt 超时时：

1. 将该账号本次失败记录为临时 transport 故障；
2. 使用短冷却，避免立即重复选择同一账号；
3. 释放初始化名额后立刻调用 context pool pump；
4. scheduler 重新 drain pending queue；
5. 不把初始化超时误记为 Google 429、403 或账号永久不可用。

建议增加指标：

```text
context_init_started_total
context_init_success_total
context_init_timeout_total{reason,phase,operation}
context_init_late_settlement_total{outcome}
context_cleanup_timeout_total
browser_recovery_total{reason}
stale_initializing_contexts
```

## 17. 测试要求

### 17.1 单元测试

1. `locator.count()` 永不结束时，单操作 timeout 按时触发；
2. `page.evaluate()` 永不结束时，单操作 timeout 按时触发；
3. `_initializeContext()` 任意阶段永不结束时，总 watchdog 按时触发；
4. watchdog 触发后 `_contextInitTasks` 和 `initializingContexts` 被释放；
5. `context.close()` 永不结束时，清理在 5 秒内返回；
6. 旧 runner 晚到成功时不能写入 `contexts`；
7. 旧 runner 晚到失败时不能删除新 attempt 的 context；
8. 超时日志包含 authIndex、attempt、phase、operation 和 elapsed；
9. 初始化超时不会写入模型 429/403 状态；
10. timeout timer 在正常完成后被清除，不残留 handle。

### 17.2 并发测试

1. 两个初始化任务永久挂起时，watchdog 能分别回收并继续初始化第三个账号；
2. `CONTEXT_INIT_CONCURRENCY=2` 时，活跃初始化数始终不超过 2；
3. 100 个冷账号轮换时，单个坏页面不能阻塞整个初始化队列；
4. 同账号并发初始化继续保持 single-flight；
5. 高请求压力下，超时回收不会重复释放 semaphore；
6. 浏览器级恢复期间新请求得到明确的可重试错误。

### 17.3 集成测试

使用假的 Playwright page/context 对象注入以下行为：

- locator Promise 永不 resolve；
- evaluate Promise 永不 resolve；
- context close 永不 resolve；
- timeout 后旧任务延迟 resolve；
- 两个不同账号的关键 RPC timeout 仅启动探测，健康页面响应时不恢复；必要鼠标失败不跳过行为、不改变账号资格；
- 页面正常连接 WebSocket，但控制台成功日志缺失。

不得只使用 `setTimeout` 模拟正常慢请求；必须包含永不 settle 的 Promise，才能验证真正的硬超时。

### 17.4 容量阻塞与真实调度器回归测试

在 `tests/browser-workers.test.js` 中使用真实 `ModelScheduler`，保留 `drain → _signalContextDemand → requestContext → _pumpContextPool` 调用链，仅替换浏览器创建和页面操作：

1. 容量已满且没有空闲 context 时，只启动一次 attempt，不执行浏览器初始化；
2. 旧 context 仍有 inflight 请求时，只启动一次 attempt，不关闭在途请求的 context；
3. 两种阻塞情况下都释放初始化跟踪状态，保留 demand 和排队请求，并让 `setImmediate` 获得执行机会；
4. 调用真实 `scheduler.release()` 后，排队请求完成 context 初始化并取得 lease；
5. 自定义完成回调在 owner 释放后执行，回调主动 drain 时公共 `finally` 不重复 drain；
6. 没有完成回调时，成功和失败都仍执行默认 drain。

测试设置同步的尝试次数上限：达到 8 次时暂停调度器，使错误实现也能有界退出并报告断言失败。不能只依赖测试 timeout 截断循环，因为定时器本身可能被微任务饿死。原有空 `drain()` fixture 无法覆盖这条反馈路径，仍可用于其他浏览器单元测试。

## 18. 实施顺序

### P0

1. 新增通用 hard timeout 工具和标准错误；
2. 扩展 attempt 状态；
3. 为 `_getOrStartContextInit()` 增加总 watchdog；
4. 增加有界 context 清理；
5. 增加 attempt owner 校验和晚到结果隔离；
6. 为初始化循环中的 Playwright RPC 增加单操作 timeout；
7. 增加结构化超时日志；
8. 补充永不 settle Promise 测试。

### P1

1. 增加浏览器级故障计数和自动恢复；
2. 扩展健康检查；
3. 增加管理页面的超龄初始化告警；
4. 增加监控指标。

### P2

1. 根据线上数据调整 timeout 默认值；
2. 优化 Camoufox 长时间运行后的 context 回收策略；
3. 评估定期滚动重启浏览器，而不重启 Node 服务。

## 19. 上线与回滚

上线前：

1. 运行完整测试；
2. 使用唯一镜像标签构建；
3. 保留旧镜像和 Compose 配置；
4. 不修改认证文件和使用统计数据；
5. 记录上线前的 context、队列和 504 基线。

上线后至少观察一个完整账号轮换周期，验收：

- 不再存在超过总时限的 `INITIALIZING`；
- 初始化槽能在坏页面后继续处理其他账号；
- `context_init_timeout` 日志具有明确 phase/operation；
- 没有晚到 attempt 覆盖新 context；
- 504 不再因初始化槽永久占满而持续增长；
- 正常 context 的在途请求不受单账号超时清理影响。

出现以下任一情况应回滚：

- watchdog 误杀正常初始化显著增加；
- context 重复发布或重复关闭；
- 初始化并发计数为负或超过配置；
- 浏览器级恢复频繁触发；
- 正常请求成功率明显下降。

## 20. 本次改造的核心原则

1. 超时必须独立于被等待的 Promise；
2. 超时后必须主动终止或隔离底层任务；
3. 清理操作本身也必须有界；
4. 释放调度名额不能依赖 Playwright 正常返回；
5. 所有晚到结果必须经过 attempt owner 校验；
6. 日志必须记录“卡在哪一步”，不能只记录笼统的初始化失败；
7. 单页面故障先局部恢复，浏览器级故障才执行全局恢复。

## 21. 2026-09-30 容量阻塞重试循环复盘

### 21.1 生产核实

通过 `ssh meow_us` 对生产容器进行只读核查，确认：

- 镜像为 `aistudio-to-api:us-4f44576`；
- 容器内 `BrowserManager.js`、`ModelScheduler.js` 的 SHA256 与提交 `4f44576` 中对应文件完全一致；
- `Context#0` 和 `Context#32` 持续输出 `init_started / init_finished`，最近约 1.15 秒的 1000 行日志全部属于这两类事件，约每秒 436 次初始化尝试，全局 attempt 序号已超过 217 万；
- 直连 `127.0.0.1:7860/health` 的 TCP 连接成功，但 5 秒内收到 0 字节；Docker 健康检查连续超时，容器处于 `unhealthy`；
- 保留日志最早已处于约第 197 万次尝试，无法据此确定最初触发的是哪条容量阻塞分支。

### 21.2 故障机制与修复

提交 `4f44576` 在 `_getOrStartContextInit()` 的公共 `finally` 中新增了回调之后的无条件 `scheduler.drain()`。池回调虽然根据 `blockedByCapacity` 停止调度，公共 `finally` 仍沿以下路径重新创建同一账号的初始化任务：

```text
runner 遇到容量阻塞并返回
  → finally 释放初始化 owner 和名额
  → onSettledAfterRelease 因 blockedByCapacity 返回
  → 公共 finally 无条件 scheduler.drain()
  → _signalContextDemand()
  → requestContext()
  → _pumpContextPool()
  → 新 runner 再次遇到相同容量阻塞
```

容量没有变化时，这条路径形成持续执行的 Promise 微任务循环，导致 HTTP、WebSocket 和定时器无法获得执行机会。快速完成的 attempt 不会触发初始化总 watchdog。

本次源码修复采用第 8.3 节的互斥通知规则，不增加轮询或重试定时器。新增真实调度器回归测试在修复前的两条阻塞分支均达到 8 次上限并失败；修复后均只尝试一次，实际浏览器初始化次数为 0，释放占用后均可完成一次初始化并处理排队请求。

首次生产核查未修改源码或重启容器。后续按授权于 2026-09-30 发布 `aistudio-to-api:us-6defd1b`，生产容器已恢复 `healthy`，启用 `init: true` 并持久化自动登录数据库及截图目录；保留旧镜像和 `compose.yaml.pre-6defd1b` 供回滚。自动登录新增数据纳入每小时在线备份，备份不暂停容器，具体规则见 `account-auto-login-operations.md`。
