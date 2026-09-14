# AIStudioToAPI 高并发与首包稳定性改造方案

## 1. 背景

当前服务已经支持：

- 多账号、账号 × 模型独立状态；
- 多 browser context/page；
- 单账号多请求并发；
- 全局逻辑执行槽和模型队列；
- 请求级 `request_id` / `request_attempt_id` 消息隔离。

实际公益站流量存在持续几十、峰值接近 100 个在途请求的情况。现状是在提高 `GLOBAL_MAX_CONCURRENCY` 后，本地 503、`Queue is closed` 和下游 `Client.Timeout exceeded while awaiting headers` 明显增加。

本次改造的目标不是通过降低全局并发把请求重新塞回长队列，而是在维持高并发接入能力的前提下：

1. 消除请求热路径中的 context 初始化串行等待；
2. 尽早向流式客户端返回响应头和心跳；
3. 将浏览器/WebSocket 故障与账号/模型故障分开；
4. 缩小单个 context 断线的故障范围；
5. 保证未开始输出的请求可以安全迁移到其他 ready context；
6. 让管理界面准确区分 ready、busy、idle、initializing 和 reconnecting context。

## 2. 当前并发模型

### 2.1 已经具备的真实并发

不同 HTTP 请求拥有不同 `request_id`。浏览器端使用 `activeOperations` 保存多个请求，并为不同 `request_id` 创建独立 `fetch()`。同一页面可以同时存在多个 pending fetch；只有同一 `request_id` 的旧 attempt 才会被新 attempt 取消。

因此，已就绪 context 上的请求不是按照“前一个请求先返回 headers，后一个请求才开始”的方式串行执行。

### 2.2 当前的串行点

`BrowserManager.ensureWorkerContext()` 通过全局 `_workerContextTask` 串行执行以下操作：

- context 创建或置换；
- storage state 加载；
- AI Studio Build 页面初始化；
- 注入代理脚本；
- 等待内部 WebSocket 建立。

当 scheduler 先发放 lease、随后才发现目标账号 context 未 ready 时，HTTP 请求会在 `ensureWorkerContext()` 内等待。多个冷账号同时被选中时，它们会在同一条初始化链上排队。

### 2.3 当前首包延迟

目前流式处理大致是：

```text
收到请求
→ 分配 lease
→ ensureWorkerContext
→ 创建 MessageQueue
→ 浏览器 fetch
→ 等浏览器收到上游 response headers
→ 服务端才写下游 HTTP/SSE headers
```

只要 lease、context、WebSocket、浏览器 fetch 或上游首包中的任一步变慢，下游就一直处于 `awaiting headers`。即使请求之间正在并发等待，下游也会把它表现为连接超时。

### 2.4 当前断线故障范围

一个账号 context 对应一个 page 和一个内部 WebSocket。同一账号并发开放后，该 WebSocket 上可能承载多个请求。一旦它断开，当前实现会关闭该账号关联的全部 MessageQueue。

`Queue is closed` 随后通常被归类为 temporary error，并可能给 `account + model` 设置 cooldown。这会把本地浏览器/传输层故障错误地反馈到模型额度状态，造成可用容量进一步下降和连锁 503。

## 3. 设计原则

### 3.1 接入并发、执行并发和 context 数量分离

三个概念必须独立：

- `GLOBAL_MAX_CONCURRENCY`：服务允许的最大在途请求数；
- `MAX_BROWSER_WORKERS`：最大常驻 browser context/page 数；
- 单 context 并发：一个 ready context 当前承载的请求数。

允许 `GLOBAL_MAX_CONCURRENCY > MAX_BROWSER_WORKERS`。但必须通过 least-inflight 调度和可选的单 context 上限，避免大量请求集中到少数 page/WebSocket。

### 3.2 热路径不初始化 context

请求热路径只允许选择：

```text
context.state == READY
&& page 未关闭
&& WebSocket connected
&& 账号健康
&& account + model 未 cooldown / unsupported
```

请求处理器不得在拿到 lease 后同步创建或重建 context。所有创建、补池、轮换和重连都由后台 ContextPoolManager 完成。

### 3.3 本地故障不污染账号额度状态

以下故障不得设置账号 × 模型 cooldown：

- `page_closed`；
- `context_closed`；
- `reconnect_cleanup`；
- `grace_period_timeout`；
- `QueueClosedError`；
- 内部 WebSocket 断开；
- context 初始化排队或取消。

只有明确的上游状态才更新模型状态，例如：

- 上游 429 / `RESOURCE_EXHAUSTED` → account × model rate limited；
- 上游明确模型权限错误 → account × model unsupported；
- 登录、cookie、账号禁用错误 → account unhealthy；
- 上游 5xx → account × model 短暂 cooldown，可配置。

### 3.4 已发响应头不等于已输出模型内容

需要分别记录：

- `headersSent`：HTTP/SSE headers 已发送；
- `keepaliveSent`：只发送过 SSE 注释心跳；
- `modelOutputStarted`：已经向客户端输出模型 token 或最终响应内容。

只要 `modelOutputStarted == false`，即使已经发送 headers 和 keep-alive，仍允许将请求迁移到其他账号重试。

一旦 `modelOutputStarted == true`，禁止自动重放整个请求，避免客户端收到重复内容。

## 4. 目标架构

```text
HTTP 请求
  ↓
协议校验与鉴权
  ↓
流式请求立即建立 SSE + keep-alive
  ↓
ModelScheduler
  ↓ 只选择 ready context
Ready Context Pool
  ↓
Account × Model eligibility
  ↓
按 context/model inflight 最少分配 lease
  ↓
浏览器 fetch
  ↓
按 request_id + attempt_id + connection_epoch 路由响应
```

后台独立运行：

```text
ContextPoolManager
  ├─ 将 ready context 数补到目标值
  ├─ 有界并行初始化 context
  ├─ 重连断开的 context
  ├─ 根据模型可用性轮换冷账号
  └─ 只置换无在途请求的 context
```

## 5. Context 状态机

每个账号 context 至少具有以下状态：

```text
COLD
  ↓ initialize
INITIALIZING
  ↓ page + WebSocket ready
READY
  ↓ 获得一个或多个 lease
BUSY
  ↓ inflight 归零
READY
  ↓ WebSocket lost
RECONNECTING
  ├─ reconnect success → READY/BUSY
  └─ reconnect exhausted → UNAVAILABLE → 后台重建
```

`READY` 和 `BUSY` 都代表 context 存活且可被观察。是否允许继续发新 lease 由 context 并发上限、draining 状态和 WebSocket 状态共同决定。

管理界面不得再用“活跃 context”同时表达存活和繁忙。至少展示：

- ready contexts；
- busy contexts；
- idle contexts；
- initializing contexts；
- reconnecting contexts；
- unavailable contexts；
- active logical requests；
- 每个 context 的 inflight 数。

## 6. 调度器改造

### 6.1 Ready-first 账号选择

`ModelScheduler.candidates()` 拆成两层：

1. `eligibleAccounts(model)`：账号和模型状态可用；
2. `readyCandidates(model)`：eligible 且存在 ready WebSocket context。

普通请求只从 `readyCandidates` 获取 lease。排序顺序建议为：

1. `account + model inflight` 较少；
2. context 总 inflight 较少；
3. 近期本地传输失败次数较少；
4. LRU / Least Used；
5. auth index。

排序和 inflight 预留必须保持同步，中间不能出现 `await`。

### 6.2 冷账号按需换入

当没有 ready candidate，但存在 cold eligible account 时：

- 不在请求 handler 中调用 `ensureWorkerContext()`；
- 向 ContextPoolManager 发出 `model/account demand`；
- 选择无 active attempt 的 idle context 作为置换对象；
- 后台初始化新的账号 context；
- context ready 后唤醒 scheduler drain。

流式请求在等待期间持续发送 SSE keep-alive。非流式请求受独立的 dispatch timeout 约束，超时后返回明确的本地容量错误。

### 6.3 context 容量

新增可选配置：

```dotenv
# 0 表示不设单 context 硬上限，仍使用 least-inflight 分散请求
CONTEXT_MAX_CONCURRENCY=0
```

若设置非零值，理论即时执行容量为：

```text
ready_context_count × CONTEXT_MAX_CONCURRENCY
```

如果该值小于 `GLOBAL_MAX_CONCURRENCY`，多出的请求只能等待或快速失败；任何实现都无法在有限执行容量下同时做到“不等待、不拒绝”。

如果目标是 100 路逻辑并发且希望单 context 不超过 4～5 路，应准备约 20～25 个 ready context，而不是让 12 个 context 无限复用。

### 6.4 公平性

即使 `ACCOUNT_MAX_CONCURRENCY=0`，也必须执行 least-inflight。开放单账号并发只表示账号已在途时仍可选，不表示忽略其他 ready context。

同等条件下优先使用 idle ready context，使高峰流量自然铺满热池；不能出现 100 个 lease 集中在 5～6 个 context，而其余 ready context 长期 idle。

## 7. 流式首包改造

### 7.1 提前建立 SSE

对 OpenAI、Responses 和 Anthropic 的流式接口，在完成以下步骤后立即发送 headers：

- API key / session 鉴权；
- 请求体解析；
- 协议和模型名基础校验。

建议响应：

```http
HTTP/1.1 200 OK
Content-Type: text/event-stream
Cache-Control: no-cache
Connection: keep-alive
X-Accel-Buffering: no
```

随后立即调用 `flushHeaders()` 并写入：

```text
: accepted

```

在等待 lease、ready context 或上游首包期间，每 8～12 秒发送一次 SSE comment：

```text
: keep-alive

```

SSE comment 不得计为 `modelOutputStarted`。

### 7.2 首包后的错误语义

headers 已发但模型尚未输出时，如果最终无法执行，请发送与协议兼容的 SSE error，然后正常结束连接。不得再次尝试发送 JSON HTTP 503 响应头。

### 7.3 非流式接口

非流式 JSON 接口不能通过 SSE comment 保活，否则会破坏协议兼容。它们必须依赖：

- ready-only 热路径；
- context 后台补池；
- 有界 dispatch timeout；
- 与下游协调合理的 HTTP timeout。

建议本地 dispatch timeout 明显短于下游 HTTP timeout，从而返回结构化错误，而不是让下游得到模糊的 `awaiting headers`。

## 8. WebSocket 与 MessageQueue 改造

### 8.1 引入 connection epoch

每次 context 建立新的内部 WebSocket 时生成递增 `connection_epoch`。MessageQueue 绑定：

```text
request_id
request_attempt_id
auth_index
connection_epoch
```

旧连接的延迟消息或 close 事件不得影响新连接及新 attempt。

### 8.2 禁止重连成功时批量关闭新队列

建立新 WebSocket 时不得无条件执行“关闭该 authIndex 的全部队列”。只处理绑定旧 epoch 的 attempt。

### 8.3 结构化关闭原因

MessageQueue close reason 分为：

| 分类 | 示例 | 是否重试 | 是否 cooldown |
| --- | --- | --- | --- |
| 正常结束 | `request_complete` | 否 | 否 |
| 客户端取消 | `client_disconnect` | 否 | 否 |
| attempt 替换 | `retry_replaced` | 已进入新 attempt | 否 |
| context/WS 故障 | `page_closed`、`connection_lost` | 未输出内容时立即重试 | 否 |
| 上游 429 | `upstream_rate_limited` | 换账号重试 | account × model cooldown |
| 上游临时错误 | `upstream_5xx` | 换账号重试 | 可配置短 cooldown |

错误分类优先使用结构化 `kind/reason`，只有旧协议没有结构化字段时才退回状态码或文本正则。

### 8.4 断线处理

context WebSocket 断开后：

1. 立即将 context 标记为 `RECONNECTING`，停止发放新 lease；
2. 枚举该 connection epoch 上的 attempt；
3. 尚未输出模型内容的 attempt 迁移到其他 ready context；
4. 已输出模型内容的 attempt 发送结构化流错误并结束，不能重放；
5. 不修改 account × model 额度状态；
6. 后台执行轻量重连，失败后再重建 context；
7. 重连成功后恢复为 `READY`，由 scheduler 决定何时重新承载流量。

## 9. 重试策略

重试判断改为：

```text
retryable error
&& modelOutputStarted == false
&& request 未被客户端取消
&& retry budget 未耗尽
```

不得继续使用 `response.headersSent` 作为禁止重试的条件，因为提前建立 SSE 后它几乎始终为 true。

一次请求的 attempt 必须排除已经失败的 `account + model`。本地 context/WS 故障可以立即换 ready context；上游 429 按账号 × 模型冷却。

为避免断线后大量请求同时重试造成惊群，可对批量迁移加入很短的随机抖动，但不能串行等待前一个请求完成。

## 10. 配置建议

保留现有配置兼容性，并增加以下配置：

```dotenv
# context 热池目标
MAX_CONTEXTS=12
MAX_BROWSER_WORKERS=12

# 逻辑请求上限，可高于 context 数
GLOBAL_MAX_CONCURRENCY=100

# 账号/模型限制；0 表示不设硬上限
ACCOUNT_MAX_CONCURRENCY=0
ACCOUNT_MODEL_MAX_CONCURRENCY={}
CONTEXT_MAX_CONCURRENCY=0

# 共享模型执行槽
MODEL_WORKER_ALLOCATION={}
MODEL_MAX_CONCURRENCY={}
ENABLE_DYNAMIC_WORKER_ALLOCATION=true

# 新增：热路径和首包
SCHEDULER_READY_CONTEXT_ONLY=true
CONTEXT_POOL_MIN_READY=12
CONTEXT_INIT_CONCURRENCY=2
CONTEXT_CREATION_TIMEOUT_MS=120000
STREAM_EARLY_HEADERS=true
STREAM_KEEPALIVE_INTERVAL_MS=10000
REQUEST_DISPATCH_TIMEOUT_MS=30000

# 重试
MAX_RETRIES_PER_REQUEST=3
```

`CONTEXT_INIT_CONCURRENCY` 应使用有界并行，不建议无限并行登录和初始化。推荐从 2 开始压测。

对于 100 路持续并发，12 个 context 是否足够必须通过压测决定。如果单 context 在 8 路左右开始出现 WebSocket 不稳定，应增加 context 数，而不是继续放大单账号并发。

## 11. 代码改造范围

### `src/core/ModelScheduler.js`

- candidate 拆分为 eligible 和 ready；
- 增加 context readiness/capacity 判断；
- least-inflight 必须优先铺满 ready context；
- 本地 transport error 不更新 account × model cooldown；
- context ready/recovered 后主动触发 `drain()`。

### `src/core/BrowserManager.js`

- 新增明确 context 状态机；
- 增加后台 ContextPoolManager；
- 将全局串行 `_workerContextTask` 改为有界初始化并发；
- 请求热路径不再负责初始化 context；
- ready 数不足时自动补池；
- 只关闭无 active attempt 的 context。

### `src/core/ConnectionRegistry.js`

- WebSocket 增加 connection epoch；
- MessageQueue 绑定 epoch；
- 旧连接关闭不得影响新连接；
- 取消 reconnect 时按 authIndex 批量关闭所有队列；
- 提供按 epoch 查询和迁移 attempt 的接口。

### `src/core/ScheduledRequestHandler.js`

- 提前建立流式 SSE；
- 用 `modelOutputStarted` 替代 `headersSent` 控制重试；
- context/WS 错误直接换 ready context；
- 统一启动和停止 keep-alive；
- 正确释放每个 attempt 的 lease。

### `src/core/RequestHandler.js`

- 流式输出方法设置 `modelOutputStarted`；
- headers 已发时统一输出协议兼容 SSE error；
- 非流式请求增加明确 dispatch timeout。

### `scripts/client/build.js`

- 明确并发派发不同 `request_id`，异步错误必须被捕获；
- 保持每个 operation 独立 AbortController；
- 连接断开时携带结构化 transport reason；
- 增加浏览器端 active fetch 和首包延迟统计。

### `src/core/SchedulerConfig.js` 与 `.env.example`

- 加载并校验新增配置；
- 允许 global concurrency 高于 context 数；
- 校验 context pool min/limit 关系。

### 管理 UI

- 拆分 ready/busy/idle/initializing/reconnecting；
- 显示每个 context 的 inflight、WS epoch 和最后断线原因；
- 503 按 local transport、dispatch timeout、upstream error 分类；
- 展示请求首包时间 p50/p95/p99。

## 12. 实施顺序

### 第一阶段：可观察性与错误分类

1. 增加 context 状态、connection epoch 和结构化 queue close reason；
2. 增加 dispatch latency、context wait、upstream TTFB 指标；
3. 本地 QueueClosed/WS 错误不再污染模型 cooldown。

### 第二阶段：稳定热路径

1. scheduler 只选 ready context；
2. ContextPoolManager 后台补池；
3. context 初始化改为有界并行；
4. 取消请求路径同步初始化。

### 第三阶段：流式首包与无损迁移

1. 流式接口提前 headers 和 keep-alive；
2. 引入 `modelOutputStarted`；
3. 未输出请求在 context 断线后迁移重试；
4. headers 已发后的错误使用 SSE error。

### 第四阶段：容量压测和调优

1. 12 context × 2/4/6/8 路并发阶梯测试；
2. 评估 12、16、20、24 context 的 CPU、内存和断线率；
3. 根据实测设置 context 并发上限和生产默认值。

## 13. 测试要求

### 自动测试

- 100 个请求使用 12 个 ready context 时能并发发出，不等待其他请求返回 headers；
- ready context 的选择按 least-inflight 铺满，不允许长期只有少数 context busy；
- 冷 context 初始化不会阻塞已有 ready context 请求；
- 一个 WebSocket 断开只影响其 epoch 上的请求；
- 未输出请求能迁移到其他 context；
- 已输出请求不会自动重放；
- `QueueClosedError` 不设置模型 cooldown；
- 上游 429 只冷却对应 account × model；
- 新 WebSocket 建立不会关闭新 epoch 的 MessageQueue；
- 提前发送 SSE headers 后仍允许 pre-output retry；
- client disconnect 能取消排队、fetch、timer 和 lease；
- 所有完成、失败、取消路径均不泄漏 worker、queue 和 inflight。

### 集成压测

至少覆盖：

1. 12 个 ready context、100 个持续真实流请求；
2. 测试中随机断开一个 context WebSocket；
3. 测试中让一个账号返回 429；
4. 测试中重建一个 context；
5. 同时混合两个模型和流式/非流式请求。

记录：

- 本地 503 比例；
- 成功率；
- HTTP headers 延迟；
- 模型首 token 延迟；
- context wait 时间；
- WebSocket 断开和重连次数；
- 单 context inflight 分布；
- CPU、RSS、浏览器内存和 event loop lag。

## 14. 验收标准

在模拟上游稳定、不返回配额错误的自动压测中：

- 100 个请求均能进入并发处理，不存在请求间 headers 串行依赖；
- 流式 HTTP headers p95 小于 1 秒；
- 等待上游期间 keep-alive 间隔不超过配置值；
- local transport 造成的最终 503 低于 1%；
- 单 context 断线不会导致其他 context 请求失败；
- QueueClosed/WS 本地故障不会产生 account × model cooldown；
- context 池在故障后自动恢复到目标 ready 数；
- 无 MessageQueue、lease、timer、AbortController 泄漏；
- 管理页能够区分本地故障、上游错误和客户端取消。

真实 Google 上游压测还需单独观察 429、上游 5xx 和模型首包分布；这些结果不得与本地调度器 503 混为一类。

## 15. 明确不做的事情

- 不通过无限增加重试掩盖 context 故障；
- 不把 SSE keep-alive 伪装成模型内容；
- 不在已输出模型 token 后自动重放请求；
- 不把本地 WebSocket/Queue 错误标记为账号额度耗尽；
- 不要求所有 context 始终 busy，目标是始终 ready；
- 不改变 OpenAI、Gemini、Anthropic 的已有请求和响应内容格式。
