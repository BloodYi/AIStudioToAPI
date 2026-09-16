# Context 初始化连续失败：诊断结论与修复方案

## 1. 结论

本次故障不是单纯由服务器资源不足造成。2026-09-15 至 2026-09-16 的线上证据显示，`WebSocket initialization timeout` 包含两种不同故障：

| 类型 | 次数 | 比例 | 实际状态 |
| --- | ---: | ---: | --- |
| WebSocket 已连接但被误判为超时 | 19 | 70.4% | 页面已经显示 `Connection successful!`，内部 WebSocket 也已连接 |
| 页面停留在确认弹窗 | 8 | 29.6% | 页面仍显示 `Continue to the app`，客户端脚本未启动 |
| 合计 | 27 | 100% | 日志中的两条错误信息不得重复计数 |

主要根因是初始化状态的生命周期和并发控制存在缺陷；服务器压力会延长页面加载和事件循环延迟，增加触发概率，但不是 19 次误判的直接原因。

## 2. 线上证据

### 2.1 已排除项

- `aistudio-to-api` 自 `2026-09-15T06:37:07Z` 启动后没有容器重启。
- 内核日志没有 OOM、进程被杀或内存不足记录。
- 最近 72 小时只启动过一次主浏览器，没有意外断开记录。
- 最近 72 小时没有执行过轻量重连，也就没有由重连流程重置 WebSocket 初始化状态。
- 远端部署目录、运行中容器和本地工作区的 `BrowserManager.js` SHA-256 一致：
  `c0d62089b2a2286b24f274764d746630462496652a04b4c8d731e96c317662e5`。
- 失败页面标题仍为 `AIStudioToAPI-V1.3.4 | Google AI Studio`，不是 Google 登录页，不能归因于登录过期。

### 2.2 误判样本

`Context#21` 和 `Context#22` 均出现以下顺序：

1. 开始等待 Continue/Launch 或 WebSocket 初始化；
2. 收到正确的 `authIndex`；
3. 连接 `ws://127.0.0.1:9998?authIndex=<index>`；
4. 日志和失败截图均显示 `Connection successful!`；
5. 约两分钟后仍报告 `WebSocket initialization timeout`；
6. 成功连接的页面被当作泄漏 context 关闭。

这不是慢连接：连接已经完成，只是等待方没有保留或读取到对应成功状态。

### 2.3 确认弹窗样本

另外 8 个失败页面停留在 Google AI Studio 的安全确认弹窗，页面中存在：

```html
<button ...> Continue to the app </button>
```

当前实现只在轮询期间查找按钮。按钮若较晚出现，或第一次程序化点击没有使弹窗消失，初始化仍会一直等到超时。代码中的 `continueClicked` 一旦变为 `true` 就不会再次尝试点击，也没有验证弹窗是否真的关闭。

### 2.4 资源压力的作用

故障期间观测到：

- `aistudio-to-api` 约占 7 GiB 内存；
- CPU 使用约 338%；
- 主机 load average 约 5；
- Camoufox 有约 19 个内容页面进程；
- 配置为 16 个热 context、2 个并行初始化、128 全局并发、每 context 最多 8 并发。

部分名义 120 秒的等待实际经过了 141 至 158 秒才输出超时，说明浏览器或 Node.js 事件循环确实发生延迟。资源压力能解释确认弹窗较晚出现和轮询变慢，但不能解释页面已连接后仍被判定为未连接。

## 3. 代码根因

### 3.1 WebSocket 成功状态按 `authIndex` 全局共享

当前 `_initializeContext()` 使用：

```js
this._wsInitState.set(authIndex, { failed: false, success: false });
```

控制台监听器和 `_waitForWebSocketInit()` 随后都通过 `authIndex` 重新读取该 Map。任何同账号的后续初始化都会替换前一轮状态对象。当前代码中能写入新状态对象的路径只有：

1. `_initializeContext()`；
2. `lightweightReconnect()`；
3. 浏览器整体清理时清空 Map。

线上没有轻量重连和浏览器重启。因此，在页面已经输出连接成功之后，等待逻辑仍读取到未成功状态，只能由同一 `authIndex` 的另一轮初始化覆盖状态来解释。

### 3.2 初始化没有统一的 single-flight 所有权

当前代码同时使用：

- `initializingContexts: Set`；
- `_contextInitTasks: Map`；
- 直接调用 `_initializeContext()` 的多个入口。

其中 `_initializeContext()` 在 `finally` 中自行删除 `initializingContexts`，而 `_startPooledContext()` 又在外层 `finally` 中删除相同标记及 `_contextInitTasks`。锁的创建者和释放者不是同一层级。

此外，池调度路径使用 `_contextInitTasks` 去重，而 `launchOrSwitchContext()` 主要检查 `initializingContexts`。旧恢复/切换路径和新模型调度路径同时存在时，不能保证所有入口共享同一个 Promise。这给同账号的重叠初始化留下窗口。

### 3.3 旧失败任务可以清理新成功 context

初始化失败的 catch 当前只判断：

```js
if (this.contexts.has(authIndex)) {
    this.contexts.delete(authIndex);
}
```

它没有验证 Map 中的 context 是否属于本次初始化 attempt。因此旧任务超时后，可能删除并关闭同账号较新的成功实例。这会把一次状态竞态放大成可见的服务容量下降。

### 3.4 按钮点击没有闭环确认

`_clickButtonByTextIfVisible()` 返回 `true` 只表示调用了 DOM `click()`，不表示弹窗消失或应用开始启动。`continueClicked`/`skipClicked` 会永久阻止后续重试。按钮在超时边界才出现时，也没有最后一次检查或短暂宽限期。

## 4. 修复设计

### 4.1 P0：统一同账号初始化为 single-flight

新增唯一入口，例如 `_getOrStartContextInit(authIndex, options)`：

1. 首先读取 `_contextInitTasks.get(authIndex)`；存在时直接返回同一个 Promise。
2. 在执行任何异步操作前创建 attempt，并同步写入 `_contextInitTasks`。
3. `_startPooledContext()`、`launchOrSwitchContext()`、启动预热和恢复流程不得再直接调用 `_initializeContext()`。
4. 只允许创建 Promise 的外层删除 `_contextInitTasks` 和 `initializingContexts`。
5. 从 `_initializeContext()` 的 `finally` 中删除 `initializingContexts.delete(authIndex)`。

建议 attempt 结构：

```js
{
    id: `${authIndex}:${++this._contextInitSequence}`,
    authIndex,
    startedAt: Date.now(),
    ws: { failed: false, success: false },
}
```

日志必须带 `attempt.id`，这样可以直接证明是否发生重叠。

### 4.2 P0：状态绑定到 attempt，而不是重新按账号查询

`_initializeContext()` 创建局部 `attempt` 后：

- page console 监听器闭包直接修改 `attempt.ws.success`；
- `_waitForWebSocketInit()` 接收 `attempt`，只读取该对象；
- 不再在等待循环中调用 `_wsInitState.get(authIndex)`；
- `_wsInitState` 如需保留给状态页，仅作为观测数据，不参与正确性判断。

这能避免后续任务、重连或清理覆盖当前等待者的状态。

### 4.3 P0：以 ConnectionRegistry 为权威成功条件

控制台文本不应是唯一成功信号。初始化开始时记录该账号的 `connectionEpoch`，成功条件应为以下任一项：

- 当前 attempt 的页面明确报告连接成功；
- `ConnectionRegistry` 中该账号出现比初始化前更新的 connection epoch，且 socket 仍为 OPEN。

超时清理前必须最后检查一次 Registry。如果新连接已经存在，应把初始化判为成功，不得关闭页面。

注意：只检查“存在连接”不够，因为可能读到旧连接；必须比较 epoch 或连接实例标识。

### 4.4 P0：清理动作增加 attempt 所有权校验

写入 `contexts` 时保存 `attemptId`：

```js
this.contexts.set(authIndex, { attemptId: attempt.id, context, page, ... });
```

失败清理时仅允许删除自己的资源：

```js
const current = this.contexts.get(authIndex);
if (current?.attemptId === attempt.id) {
    this.contexts.delete(authIndex);
}
```

关闭 Playwright context 前也要确认它是本 attempt 创建的局部对象，不能通过账号索引关闭后来者。

### 4.5 P1：把确认弹窗点击改成可验证重试

- 使用 Playwright locator，例如 `getByRole("button", { name: "Continue to the app", exact: true })`。
- 按钮存在且可用时点击；点击后等待弹窗消失或新 connection epoch 出现。
- 如果弹窗仍存在，每 2 至 3 秒允许重试，而不是设置永久 `continueClicked=true`。
- 同时兼容 `button` 和 `[role="button"]`。
- 到达超时边界时再执行一次按钮检查，并提供 5 至 10 秒宽限期；宽限期只在按钮刚出现或刚点击时启用。
- 分别记录 `button_found`、`click_dispatched`、`dialog_closed`、`ws_connected`，不要把“已调用 click”记录成“点击成功”。

### 4.6 P1：分离阶段超时和原因码

至少区分：

- `context_creation_timeout`；
- `navigation_timeout`；
- `consent_dialog_timeout`；
- `ws_connection_timeout`；
- `state_tracking_invariant_violation`（页面/Registry 已连接但等待状态未成功）。

提高统一的 120 秒超时只能降低发生频率，不能修复状态覆盖和错误清理。

## 5. 必需测试

合并修复前至少增加以下自动化测试：

1. 同时对同一 `authIndex` 发起 20 次初始化，只创建一个 BrowserContext，所有调用收到同一个结果。
2. 池预热和 `launchOrSwitchContext()` 同时请求同一账号，也只创建一次。
3. attempt A 成功后，attempt B 不得覆盖 A 的等待状态。
4. 旧 attempt 超时，不得删除 attempt ID 不同的新 context。
5. console 成功事件遗漏，但 Registry 出现新的 OPEN connection 时，初始化成功。
6. Registry 中只有旧 epoch 时，不得误判成功。
7. Continue 按钮第一次点击无效，第二次点击后消失，初始化成功。
8. Continue 按钮在接近超时边界时才出现，宽限期内初始化成功。
9. 页面始终停留在确认弹窗时，返回 `consent_dialog_timeout`，而不是笼统的 WebSocket 超时。
10. 100 个冷账号、16 个 worker、2 个初始化并发的压力测试中，同一账号的活跃 attempt 数始终不超过 1。

## 6. 临时缓解措施

在代码修复部署前，可将 `CONTEXT_INIT_CONCURRENCY` 从 2 临时降为 1，减少竞态和浏览器导航争用。该措施会降低账号换入速度，且不能保证消除由旧恢复路径触发的同账号重叠初始化。

不建议把主要修复做成单纯增加 `CONTEXT_CREATION_TIMEOUT_MS` 或 WebSocket 等待时间，因为 70.4% 的失败页面已经连接成功。

## 7. 部署与回滚

### 7.1 部署前

1. 运行完整单元测试和上述新增并发测试。
2. 构建唯一、不可变的新镜像标签，禁止覆盖当前标签。
3. 保存当前 compose 配置和镜像 ID：
   - 当前服务镜像：`aistudio-to-api:local-upgrade-20260915T063153Z`
   - 当前容器镜像 ID：`sha256:50b9de231a93d45b05b7d7e14938d015621e17852db5ca5c1544d04b0f480abb`
4. 不修改 `aistudio/auth` 和 `aistudio/data`。

### 7.2 发布

该修复需要替换 `aistudio-to-api` 容器，必须安排短维护窗口。只更新该服务，不重建 PostgreSQL、Redis、New API 或 antigravity：

```bash
cd /opt/ai-gateway
docker compose up -d --no-deps aistudio
```

发布前应确保 compose override 已指向新的不可变镜像标签。不要在线执行无标签的 `latest` 拉取。

### 7.3 验收指标

观察至少一个完整额度轮换周期：

- `state_tracking_invariant_violation` 为 0；
- 任意账号同时只有一个 init attempt；
- 页面或 Registry 已连接后不再出现初始化超时；
- 失败清理不会使同账号的新 connection 断开；
- `consent_dialog_timeout` 单独统计；
- context 池能够恢复到 `CONTEXT_POOL_MIN_READY`。

### 7.4 回滚

若出现新回归，将 override 恢复到：

```yaml
image: aistudio-to-api:local-upgrade-20260915T063153Z
```

然后仍只重建 `aistudio` 服务：

```bash
cd /opt/ai-gateway
docker compose up -d --no-deps aistudio
```

账号认证和业务数据均位于挂载卷中，回滚镜像时不应删除或重建这些目录。

## 8. 修复优先级

1. 统一 single-flight 与 attempt 所有权；
2. 使用 attempt 局部状态和 Registry epoch 判定成功；
3. 防止旧失败任务清理新成功 context；
4. 修复确认弹窗的可验证重试；
5. 最后再根据压测结果调整 worker、初始化并发和超时参数。

