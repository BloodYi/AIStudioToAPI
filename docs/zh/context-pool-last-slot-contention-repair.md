# Context 池 9/10 占用但 Pro 排队：容量预留竞争修复方案

## 1. 问题与结论

2026-10-08，生产面板出现以下状态：

- Context 池占用 `9 / 10`，`BUSY 9`、`READY 0`；
- `gemini-3.1-pro-preview` 有 3 个排队请求，执行数为 0；
- 全局逻辑执行槽只使用 `26 / 100`；
- Pro 仍有可用账号，但迟迟没有新的 context 加入服务。

排查结论：**多个冷账号初始化任务先登记占位，再分别检查容量，互相把对方算成已经占用最后空位，导致全部退出。** 后续事件再次调度时，可能重复相同过程。

本问题已通过生产日志和本地同版代码模拟交叉验证。排查期间只读取生产日志、配置及代码校验值，没有修改代码或配置，没有重启服务、关闭 context 或操作在途请求。本文是后续修复方案，尚未实施。

## 2. 生产证据

以下时间均为北京时间（Asia/Shanghai）。

### 2.1 版本与配置

运行容器：`ai-gateway-us-aistudio-1`。

运行镜像：`aistudio-to-api:us-5bf9614`。

```dotenv
MAX_CONTEXTS=10
MAX_BROWSER_WORKERS=10
CONTEXT_POOL_MIN_READY=10
CONTEXT_INIT_CONCURRENCY=2
CONTEXT_MAX_CONCURRENCY=10
GLOBAL_MAX_CONCURRENCY=100
SCHEDULER_READY_CONTEXT_ONLY=true
```

生产 `/app/src/core/BrowserManager.js`、`/app/src/core/ModelScheduler.js` 与本地对应文件的 SHA-256 一致：

```text
BrowserManager.js f62b8a7b6a22c3e367dc3a0be19497b076743861a69e9c9a1301d9e995a81d56
ModelScheduler.js a2bb4aea3d8e569e7c92efecca42d2f22665233d0b3b8f8daee1651fafaf78d9
```

### 2.2 日志时间线

- `19:29:19.238`：`#78` 开始反复启动初始化任务。
- `19:29:32.986`：`#79` 也开始反复启动初始化任务。
- `19:29:54.786`：`[Browser] Context #73 closed.`。
- `19:30` 后，在所采集日志中承接请求的账号共 9 个：`#19、#69、#70、#71、#72、#74、#75、#76、#77`。
- `19:30:32` 至 `19:30:43`：多次出现 `Queue timeout for model gemini-3.1-pro-preview`。
- 至 `19:37:11`，`#78`、`#79` 仍持续成对启动、结束；采集窗口内分别出现 739、726 条 `init_started`，没有两者成功建立连接的记录。

典型片段：

```text
19:30:01.695 [Context#78] init_started attempt=78:16887
19:30:01.697 [Context#79] init_started attempt=79:16888
19:30:01.735 [Context#78] init_finished attempt=78:16887 released=true initializing_count=1 pending_init=1
19:30:01.736 [Context#79] init_finished attempt=79:16888 released=true initializing_count=0 pending_init=0

19:30:01.914 [Context#78] init_started attempt=78:16889
19:30:01.914 [Context#79] init_started attempt=79:16890
19:30:02.005 [Context#78] init_finished attempt=78:16889 released=true initializing_count=1 pending_init=1
19:30:02.005 [Context#79] init_finished attempt=79:16890 released=true initializing_count=0 pending_init=0
```

这里的 `init_started` 只代表初始化任务已登记，不代表已经调用 `browser.newContext()`。生产日志未直接输出 `blockedByCapacity`，该退出分支由代码分析与本地复现确认；未读取生产进程堆内状态。

## 3. 根因与触发条件

涉及文件与方法：

| 文件 | 方法 | 当前作用 |
| --- | --- | --- |
| `src/core/ModelScheduler.js` | `_signalContextDemand()` | 为排队请求选择冷账号并发出 context 需求 |
| `src/core/BrowserManager.js` | `_poolCandidates()` | 合并有效需求与预热候选 |
| `src/core/BrowserManager.js` | `_pumpContextPool()` | 依据初始化并发名额启动任务 |
| `src/core/BrowserManager.js` | `_getOrStartContextInit()` | 同步登记初始化状态，异步执行 runner |
| `src/core/BrowserManager.js` | `_startPooledContext()` | 在 runner 内检查容量、替换或创建 context |

### 3.1 启动任务时没有先分配物理容量

当前 `_pumpContextPool()` 只限制初始化并发：

```js
let available = limit - (this._contextInitTasks?.size || 0);
for (const authIndex of this._poolCandidates()) {
    if (available-- <= 0) break;
    this._startPooledContext(authIndex);
}
```

随后 `_getOrStartContextInit()` 同步执行：

```js
this.initializingContexts.add(authIndex);
const runnerTask = Promise.resolve().then(() => runner(attempt));
```

因此，在 runner 开始判断容量之前，两个账号都可能已经进入 `initializingContexts`。即使预热缺口只有一个，多个有效排队需求仍可能提供两个候选。

### 3.2 两个任务互相阻塞

runner 在 `await this._ensureBrowserForPool()` 之后计算：

```js
const occupancy = new Set([
    ...this.contexts.keys(),
    ...this.initializingContexts,
    ...(this._poolClosingContexts || []),
]).size - 1;
```

当 9 个已有 context 均忙，两个冷账号都已登记时，两者看到的结果都是：

```text
occupancy = 9 + 2 - 1 = 10
occupancy >= maxWorkers
没有可安全替换的空闲 context
blockedByCapacity = true
return
```

二者都在 `_initializeContext()` 之前返回。Promise 清理阶段会释放各自标记，因此面板大多数时间仍显示 `9/10`，而不是持续显示两个初始化任务。

### 3.3 为什么会长期持续、又偶尔恢复

`onSettledAfterRelease` 中存在：

```js
if (blockedByCapacity) return;
```

该保护原本用于避免满池时立即重试形成微任务循环，应当保留其意图。但在本问题中，两个任务释放之后不会主动重新分配最后一个空位；新请求、请求完成或池协调事件可能再次启动相同两个任务，继续互相阻塞。

当某个已有 context 完全空闲、额外容量释放，或者待初始化需求减少时，可能恢复。这解释了故障的间歇性。

这与 [热池稳定停在目标减一的旧问题](context-pool-stuck-at-15-repair.md) 有区别：旧问题是初始化标记释放后的补池顺序；本问题是在实际初始化前，多个任务缺少统一容量准入。当前代码已经有释放后回调，仍可复现本问题。

## 4. 修复设计

### 4.1 必须满足的不变量

1. 初始化并发名额与 context 容量分别管理。
2. 新账号必须先同步取得容量预留，再进入初始化任务登记和异步 runner。
3. 容量占用按账号去重：现有 context、有效容量预留、尚未关闭完成的 context 的并集不超过 `maxWorkers`。
4. 每个容量预留有明确所有者；失败、超时、取消、关闭及成功发布后，按所有者校验释放或转移，旧 attempt 不得释放新 attempt 的预留。
5. 不允许关闭有 inflight 请求或活动消息队列的 context 来腾位。
6. 容量不足的需求继续等待，不应重复创建空跑的 attempt，也不应被标记为账号故障。
7. 所有资源释放后必须有明确唤醒路径；真正满池且全部忙时，不得无条件自我重试。

### 4.2 推荐：在 pump 中统一执行容量准入

增加显式容量预留集合或 Map，例如 `contextCapacityReservations`，记录账号及本次准入的所有者 token。

准入流程：

1. 计算剩余初始化并发名额。
2. 按现有需求优先级遍历候选，先检查是否已有任务或预留。
3. 计算容量占用并集。存在空位时，同步创建预留，然后启动该账号的初始化任务。
4. 一旦最后一个空位已预留，其他冷账号保留需求并等待，不登记到 `initializingContexts`。
5. 没有空位但存在可安全替换的空闲 context 时，按现有淘汰规则选取一个，立即标记正在关闭，防止重复选取或重新租用；关闭完成后重新 pump，再取得新账号的预留。
6. 没有空位且全部忙时退出本轮 pump，由现有请求释放、关闭完成等事件再次唤醒。

建议第一版采用“替换关闭完成后，再准入新账号”的方式，避免引入交换容量的额外状态。关闭中的旧 context 继续占用容量，不能提前认为空位已释放。

伪代码仅表达设计顺序，辅助方法需要实际实现：

```js
for (const candidate of orderedCandidates) {
    if (!hasInitConcurrency()) break;
    if (hasAttemptOrReservation(candidate)) continue;

    const reservation = tryReserveCapacity(candidate); // 同步检查、同步预留
    if (reservation) {
        startReservedInitialization(candidate, reservation);
        continue;
    }

    scheduleOneSafeIdleReplacementIfPossible();
    break; // 等待关闭或其他容量释放事件，保留需求
}
```

成功发布 context 时，容量所有权从预留转移到已有 context；失败或取消时释放预留。成功路径可以利用按账号去重的并集避免重复计数，但状态清理仍必须显式完成。

### 4.3 初始化与清理的配套调整

- `_startPooledContext()` 不再使用“全部初始化标记减自己”决定已准入任务能否进入空位；应验证当前任务拥有有效预留。
- single-flight 仍负责 attempt 的唯一所有权、watchdog 和初始化标记释放。
- 若保留直接调用 `_startPooledContext()` 的入口，应由它取得相同的预留，或者明确拒绝未准入调用，不能绕开容量管理。
- 检查前台初始化、旧预热流程及其他创建入口；在调度模式下所有消耗同一容量的路径应遵循同一规则。
- stale context 重建也需要保护：忙时等待，空闲时先关闭；关闭过程不得丢失该账号的任务所有权或产生重复创建。
- `_poolClosingContexts` 中的账号在关闭完成前继续计入容量，并确保不会成为其他任务重复选中的淘汰对象。
- 浏览器断连、调度器关闭、账号禁用、初始化硬超时和延迟完成都必须正确清理预留。
- 重试退避与模型额度判断沿用现有语义，不把容量等待转换成账号不可用或 429。

### 4.4 唤醒和防空转

在容量或初始化并发释放之后，合并触发一次池协调，重新评估当前需求。禁止在“满池且所有 context 都忙”的退出路径中无条件递归 pump。

需要覆盖的唤醒来源包括：初始化完成或失败、context 关闭完成、请求租约与活动消息队列释放、账号恢复、冷却到期，以及新的有效需求。

若 pump 可能同步重入，应增加运行标记与合并唤醒机制；不能靠多层 `setTimeout()` 或 `queueMicrotask()` 改变时序来掩盖容量归属问题。

## 5. 回归测试与验收

主要测试位置：`tests/browser-workers.test.js`；真实排队、租约和模型额度联动可结合 `tests/model-scheduler.test.js`。

### 5.1 已完成的本地诊断复现

使用 `Object.create(BrowserManager.prototype)` 调用实际池方法，将浏览器初始化替换为内存模拟；设置 9 个忙 context、上限 10、初始化并发 2，并提前放入冷账号需求后调用 pump。没有启动真实浏览器或发起上游请求。

| 初始状态 | 冷账号需求数 | 实际进入 `_initializeContext()` 次数 | 最终 context 数 |
| --- | ---: | ---: | ---: |
| 9 个忙 context，上限 10 | 2 | 0 | 9 |
| 9 个忙 context，上限 10 | 1 | 1 | 10 |

上述结果是当前代码的故障复现，不是修复后的测试结果。

### 5.2 必须新增的行为测试

1. **最后一个空位必须能使用。** 9 个忙 context、上限 10、初始化并发 2、至少两个冷账号需求；无需新请求或已有 context 空闲，至少一个新 context 就能就绪，总数达到 10，另一个需求继续等待。
2. **真实调度器联动。** 已有 9 个账号持续处理 Flash，且对 Pro 不可用；3 个 Pro 请求排队。补入一个可用账号后 Pro 开始执行，Flash 在途请求保持完整。
3. **满池保持等待。** 10 个 context 全忙时，不发生空转初始化或微任务重试循环；一个 context 完全释放后，等待需求能够继续执行。
4. **容量与初始化并发独立受限。** 覆盖初始化并发 1、2、4，以及剩余容量 0、1、2；每个时刻占用与预留的并集不超过上限，实际初始化并发不超过配置。
5. **关闭中的容量不提前复用。** 延迟旧 context 的关闭 Promise；关闭完成前不能创建替代 context，且多个候选不能重复替换同一个旧 context。
6. **失败释放与后续进展。** 初始化失败、硬超时、取消或账号禁用后，预留和任务标记均释放，后续有效需求能使用空位。
7. **旧 attempt 隔离。** 超时后旧初始化延迟返回，不能覆盖新 context 或释放新任务的容量预留。
8. **stale context 安全重建。** 有租约或活动队列时不关闭；真正空闲后只重建一次，容量计数正确。
9. **预热与请求竞争。** 空池仍能达到预热目标；已有预热任务和排队需求竞争最后一个空位时，按既定优先级取得进展，无永久饥饿。

测试需要控制异步屏障、观察创建次数和队列是否实际取得租约，不能只断言集合中增加了某个标记。保留已有“容量不足不立即 repump”和“初始化标记释放后补满热池”的回归测试。

### 5.3 建议验证命令

```bash
node --test tests/browser-workers.test.js tests/model-scheduler.test.js tests/scheduled-request.test.js
```

根据实际修改范围再执行项目要求的 lint 和其他相关检查。本文编写阶段没有实施修复，也没有运行上述修复验收测试。

## 6. 日志与上线观察

建议在容量准入和等待状态发生变化时记录：候选账号、容量上限、已有 context 数、预留数、关闭中数量，以及取得预留或等待的原因。容量拒绝日志应合并或限频，避免每个请求都刷屏。

`init_started` 应对应已准入的真实初始化任务；容量等待应有独立状态，不能继续伪装成初始化成功结束。

上线后的关键验收：

- 在 `9/10 BUSY` 且有可用冷账号需求时，最后一个空位能够被填充。
- 不再出现两个冷账号数百次成对启动、结束却没有实际创建的现象。
- Pro 排队能够取得租约；总逻辑并发、context 容量与初始化并发分别受限。
- 现有流式请求完整结束，未因补池被主动关闭。

不得通过提高 `MAX_BROWSER_WORKERS`、关闭忙 context、重置所有账号 429 或重启共享浏览器代替本次容量准入修复。生产部署应另行安排，本排查及文档编写不包含部署操作。
