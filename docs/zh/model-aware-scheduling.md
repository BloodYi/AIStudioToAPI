# 模型感知账号池与浏览器 Worker 调度

## 原架构与改造范围

原来 `RequestHandler` 和 `AuthSwitcher` 共享 `BrowserManager.currentAuthIndex`，按使用次数、失败阈值和状态码触发全局切换。`BrowserManager` 已经在一个 Firefox/Camoufox 进程中维护多个独立 context/page，`ConnectionRegistry` 也已经按 `authIndex` 和 `request_attempt_id` 隔离 WebSocket 消息，但请求仍集中在当前账号上。

现在保留登录、storageState、Build App 注入脚本、WebSocket 消息格式和协议转换。`ModelScheduler` 管理账号×模型状态、同步租约和模型队列；`ScheduledRequestHandler` 为每次 HTTP 请求创建独立处理器，复用原有协议与 streaming 方法。真正完成模型后缀转换之后才申请租约，因此 `-high`、`-real`、`-search` 等变体共享真实模型额度。

Worker 是一个执行槽，执行时独占一个账号的 context/page，**不是独立 Firefox 进程**。同一账号跨模型最多一个在途任务；六个 worker 要同时执行，需要至少六个符合条件的不同账号。账号 cookie 始终属于自己的 context，worker 可以在请求之间选用其他账号。空闲 context 缓存最多保留 `MAX_BROWSER_WORKERS` 个，只有空闲 context 可以被置换；创建和置换串行化，已经就绪的 context 并行处理请求。启动采用按需初始化，首次使用账号需要等待原有 Build 初始化流程。

页面保活、Launch 检测和 WebSocket 重连按 context 工作。旧账号池后台 rebalance 在新模式下停用，避免清理已被 worker 预留的 context。管理界面的账号修改、删除和 auth 文件写入在存在运行任务时返回 409；管理操作执行期间暂停新租约发放。

## 配置

新模式默认开启。未配置 worker 数量时沿用正数 `MAX_CONTEXTS`，否则使用 1；原先 `MAX_CONTEXTS=0` 的无限缓存不会转换成无限 worker。配置修改后重启生效。

下面的模型名仅用于展示配置格式，必须替换为实际 upstream model ID（可查看 `configs/models.json`）：

```dotenv
ACCOUNT_ROTATION_STRATEGY=least_recently_used
MAX_BROWSER_WORKERS=6
GLOBAL_MAX_CONCURRENCY=6
MODEL_WORKER_ALLOCATION={"model-a":{"min_workers":3,"preferred_workers":5},"model-b":{"min_workers":1,"preferred_workers":1}}
MODEL_MAX_CONCURRENCY={"model-a":6,"model-b":6}
ENABLE_DYNAMIC_WORKER_ALLOCATION=true
MODEL_QUEUE_SIZE=100
MODEL_QUEUE_TIMEOUT_MS=120000
RATE_LIMIT_COOLDOWN=3600
TEMP_ERROR_COOLDOWN=30
MAX_RETRIES_PER_REQUEST=2
SCHEDULER_STATE_PATH=data/scheduler-state.json
```

| 配置                               | 语义                                                                                                |
| ---------------------------------- | --------------------------------------------------------------------------------------------------- |
| `ACCOUNT_ROTATION_STRATEGY`        | `least_recently_used` 默认；`least_used` 按调用次数优先；`legacy` 恢复原账号轮换                    |
| `MAX_BROWSER_WORKERS`              | 最大缓存 context/page 数量                                                                          |
| `GLOBAL_MAX_CONCURRENCY`           | 最大执行租约数，默认等于 worker 数，不得超过它                                                      |
| `MODEL_WORKER_ALLOCATION`          | JSON 对象。值为整数时表示 preferred、min 为 0；也支持上面的对象写法。preferred 总和不能超过全局并发 |
| `MODEL_MAX_CONCURRENCY`            | 模型的硬并发上限；默认等于全局并发；不得低于该模型 min                                              |
| `ENABLE_DYNAMIC_WORKER_ALLOCATION` | 默认 `true`，可借用空闲配额；`false` 时每个已配置模型以 preferred 为上限                            |
| `MODEL_QUEUE_SIZE`                 | 每模型最大等待数，不包含已拿到租约的请求；0 表示不排队                                              |
| `MODEL_QUEUE_TIMEOUT_MS`           | 最长排队时间，默认 120000 毫秒                                                                      |
| `RATE_LIMIT_COOLDOWN`              | 429 冷却秒数，默认 3600，不猜测 Google 的日额度重置时刻                                             |
| `TEMP_ERROR_COOLDOWN`              | 临时错误初始冷却秒数，默认 30，连续失败退避到 60、120，最多 4 倍                                    |
| `MAX_RETRIES_PER_REQUEST`          | 初次之外的最大重试次数，默认继承旧 `MAX_RETRIES - 1`，未配置时为 2；初始化失败也占用预算            |
| `SCHEDULER_STATE_PATH`             | 默认工作目录下 `data/scheduler-state.json`                                                          |

`MODEL_WORKER_ALLOCATION={}` 表示共享池。动态模式下，未配置模型的默认 min=0、preferred=1；静态模式下，未配置模型使用剩余共享容量（至少允许一个槽位竞争）。静态模式限制每模型并发，但不绑定具体 worker ID。

每次有空闲 worker 时，调度顺序是：低于 min 的等待模型、低于 preferred 的等待模型、其他等待模型；同级按入队顺序。热门模型不能绕过更早入队的同级请求。借用不会中断正在输出的流，低流量模型的最低配额在下一次 worker 释放时满足，还受可用账号数和 context 初始化时间约束。这里的 min 是调度优先级保证，不是可抢占的独立进程保留。

## 错误、重试与恢复

- 429 / `RESOURCE_EXHAUSTED`：仅对该账号×模型冷却，其他模型继续可选。
- 明确 `PERMISSION_DENIED` 或模型不支持：仅该账号×模型标记 `UNSUPPORTED`，重启后保留；需手动恢复。没有明确模型权限证据的普通 403 不会永久禁用账号或模型。
- 503、网络/WebSocket 故障：短暂模型冷却；不会永久剔除整个账号。
- 明确登录、cookie 失效或账号暂停：整个账号 unhealthy。原有 auth 文件过期标记仍然有效。
- 参数错误不自动切换账号。客户端取消不作为账号故障。

重试发生在真实响应内容输出之前，整个请求不重试同一账号，即使该账号的 auth 文件编号变化。模型池没有任何符合条件的账号时立即返回 503；上游失败之后无法找到下一个账号时保留最后一次上游错误（例如 429）。只有账号仍可用但正在执行任务时才排队。队列满返回 429，排队超时返回 504。已经输出流内容后发生错误，只记录状态并沿用原协议错误输出，不重放内容。

冷却到期后，下一个实际请求作为 probe，不进行额外的付费/额度消耗健康请求。`request_count` 记录真实转发次数，不存在“达到 100 次就认为耗尽”的规则。

Web 管理主页展示模型调用次数、成功/失败、可用账号数、429 数、排队数和 worker 配额，并提供账号×模型状态详情与恢复按钮。管理接口沿用原 Web UI session 认证：

- `GET /api/scheduler`：全局、模型、账号与 worker 快照。
- `POST /api/scheduler/reset`，body `{"account_id":0,"model":"model-a"}`：恢复单模型，保留统计。
- `POST /api/scheduler/reset`，body `{"account_id":0}`：恢复账号及全部模型，保留统计。

正在执行任务的账号不能被 reset（409）。如果原 auth 文件已被标记 expired，仍需通过原登录/恢复流程修复 auth；scheduler reset 不会伪造有效登录。

## 持久化与兼容性

JSON 状态由单个 Node 进程串行更新，250ms 合并写入、同目录临时文件原子 rename；正常停机 flush。异常断电最多可能丢失最近一次合并窗口的更新；不承诺 fsync 级断电持久性。重启不恢复 inflight。损坏状态备份为 `.corrupt-时间戳` 后重建，并在日志提示。写入失败记录错误。Docker 继续挂载 `/app/data` 即可。**多个服务进程不要共享此 JSON 文件和同一套账号池**；当前租约只保证单进程 async 并发安全。

OpenAI Chat、Responses、Embeddings，Gemini 原生，以及 Anthropic Messages/count tokens 使用同一调度层；转换实现保持原样。非模型文件操作记在 `__files__` 池。服务记录它收到的 resumable upload ID、返回的文件 URI 与账号的映射，并持久化；后续已知文件引用固定到拥有它的账号，不能通过换账号绕过文件所属账号的额度。不同账号文件不能混在一次请求里。服务未见过的外部上传文件没有可推断的账号映射。

设置 `ACCOUNT_ROTATION_STRATEGY=legacy` 可恢复原 `SWITCH_ON_USES`、`FAILURE_THRESHOLD`、`IMMEDIATE_SWITCH_STATUS_CODES` 和 `MAX_CONTEXTS` 轮换流程。新模式不使用这些旧轮换阈值，避免全局切换干扰请求。

## 验证与部署验收

```bash
npm test
npm run lint
npm run build:ui
```

自动测试使用模拟浏览器/WebSocket，覆盖并发独占、配额隔离、冷却、持久化、动态借用、静态上限、队列取消、重试预算、流式中途失败、文件归属、context 置换及旧 WebSocket 延迟关闭。真实登录、Google 上游行为和六账号持续压力测试需要有效 auth 文件及 Camoufox 环境，自动测试不替代这些验收。

部署后建议先使用两个账号并交替请求两个模型，确认一个模型的 429 不影响另一个；再提高到六个 worker，观察 context 内存、每模型排队和上游延迟。浏览器进程崩溃会影响其所有 context；状态保持模型粒度，后续请求按需重建 context。真正的多进程浏览器隔离和跨服务分布式租约留作后续扩展。
