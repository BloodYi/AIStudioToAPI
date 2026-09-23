请阅读并理解整个 AIStudioToAPI 项目源码：

https://github.com/iBUHub/AIStudioToAPI

我要把它改造成更适合多账号公益站使用的版本。核心目标不是改变现有 API 协议转换、AI Studio Build 调用或认证方式，而是重构“账号轮换 + 浏览器资源调度”逻辑，使其能够最大化利用不同 Google 账号、不同模型彼此独立的调用额度。

## 一、现有问题

目前项目的账号调度逻辑比较粗粒度，大致是：

- 当前账号调用 N 次后切换账号；
- 当前账号遇到 429 / 某些错误后切到下一个账号；
- 调度状态主要以“账号”为单位。

但 AI Studio 实际存在“同一个账号，不同 Flash 模型额度彼此独立”的情况。

例如：

账号 A：
- Gemini 3.7 Flash：100 / 100，已经耗尽
- Gemini 3.8 Flash：20 / 100，仍剩 80 次

如果请求 3.7 Flash 时账号 A 返回 429，目前项目可能直接切换账号，后续也不再有效利用账号 A。

但实际上账号 A 只是：

A × 3.7 Flash

这个资源槽耗尽了。

它的：

A × 3.8 Flash

仍然完全可用。

因此账号可用性必须从：

Account

升级成：

Account × Model

的粒度。

---

## 二、核心数据模型

请设计类似下面的状态：

AccountState
- account_id
- account_health
- browser/context 状态
- auth 状态
- last_error
- models:
  - model_id
    - available
    - request_count
    - success_count
    - failure_count
    - consecutive_failures
    - rate_limited
    - cooldown_until
    - unsupported
    - last_used_at
    - last_error

例如：

account01
- healthy: true
- models:
  - gemini-3.7-flash
    - available: false
    - rate_limited: true
    - cooldown_until: xxx
  - gemini-3.8-flash
    - available: true
    - request_count: 23

重点：

一个模型出问题，默认只能影响：

account + model

不能直接影响整个 account。

只有账号级错误才允许把整个账号从所有模型池中摘除。

---

## 三、错误分类

不要再把所有错误统一理解成“换账号”。

至少区分：

### 1. 模型额度耗尽 / 429

例如：

account01 + 3.7F -> 429

只标记：

account01 + 3.7F unavailable / cooldown

不能禁用：

account01 + 3.8F

然后当前请求自动选择另一个仍支持 3.7F 的账号重试。

需要避免无限重试。

---

### 2. 模型权限错误

如果某个账号对某个模型返回明确的：

PERMISSION_DENIED
unsupported
model unavailable for account
或其他能够确认“这个账号没有这个模型权限”的错误

则记录：

account01 + modelX -> unsupported

以后这个模型不要再调度到这个账号。

但该账号的其他模型继续正常工作。

---

### 3. 暂时性 503 / 网络错误

503、临时 WebSocket 错误、短暂 upstream failure 等，不应立即永久移除账号或模型。

使用短 cooldown，例如：

30 秒
60 秒
120 秒

具体实现请根据现有项目代码结构设计，并尽量支持配置。

---

### 4. 账号级错误

只有类似：

- Cookie/Auth 明确失效
- Google 登录失败
- Account suspended
- 浏览器 context 无法恢复
- 整个账号初始化失败

这种明确账号级问题，才标记：

account.healthy = false

然后该账号从所有模型池中移除。

---

## 四、模型感知调度器

原有的简单：

currentAccount
switchAccount()

需要重构成类似：

selectAccountForModel(model)
markModelRateLimited(account, model)
markModelUnsupported(account, model)
markAccountUnhealthy(account)
recoverModelState(...)
recoverAccountState(...)

每个模型实际上拥有独立的账号池。

例如：

3.7F pool:
A
B
C
D
E

3.8F pool:
A
B
C
D
E

如果 A 的 3.7F 耗尽：

3.7F pool:
B
C
D
E

但：

3.8F pool:
A
B
C
D
E

保持不变。

---

## 五、不要简单“一个账号连续打 N 次”

当前项目如果存在 SWITCH_ON_USES=N 一类逻辑，可以保留作为兼容模式，但新的默认调度思路希望更加合理。

可以考虑：

Round Robin

或者：

Least Recently Used

或者：

Least Used

最终请结合项目现有并发模型选择最稳定的方案。

目标是：

- 尽量均匀使用账号；
- 遇到模型额度耗尽后自动跳过；
- 当可用账号减少或高峰流量到来时，允许同一账号承接多个并发请求；
- 优先选择当前 inflight 较少的可用账号，但不得再将 `inflight > 0` 作为不可选条件；
- 需要考虑线程安全 / async 并发安全。

---

## 五-A、高峰吞吐优先：开放单账号并发

该项目主要用于短期公益站和 Workspace 子号池，高峰期用户可用性优先级高于单个账号的长期寿命。不应继续将：

`account.inflight == 0`

作为账号可被调度的必要条件。同一账号、同一 browser context/page 在协议和消息隔离可以保证正确性的前提下，应允许同时执行多个不同 `request_id` 的请求。

并发必须由配置控制：

```dotenv
# 0 表示不设置账号级并发上限，仅受全局和模型并发上限约束
ACCOUNT_MAX_CONCURRENCY=0

# 可选：按模型限制单账号在该模型上的并发；未配置模型继承 ACCOUNT_MAX_CONCURRENCY
ACCOUNT_MODEL_MAX_CONCURRENCY={"gemini-3.7-flash":0,"gemini-3.8-flash":0}
```

新默认策略为开放单账号并发，即 `ACCOUNT_MAX_CONCURRENCY=0`。这里的“无账号级上限”不等于整个服务无限并发；所有请求仍必须受 `GLOBAL_MAX_CONCURRENCY`、`MODEL_MAX_CONCURRENCY`、队列长度和超时限制。

调度策略建议优先级为：

1. 健康、当前模型可用、未 cooldown 且未 unsupported；
2. 未超过账号级或账号×模型并发上限；
3. 优先 `account + model inflight` 较少的账号；
4. 再使用 Least Recently Used / Least Used 打破平局。

当可用账号数量充足时，请求仍会自然分散；当只剩少量可用账号时，允许这些账号承接多个并发，避免因“一账号一在途”导致 worker 空闲和队列失控。

一旦某个 `account + model` 返回 429，立即停止向该资源槽发放新租约，但不强制中断已经开始输出的其他请求。同一批并发请求可能同时收到 429，这是吞吐优先策略可接受的代价；状态更新和计数必须保持幂等。

---

# 六、进一步增加“浏览器 Worker × 模型”资源调度

服务器资源比较充足，预计可以同时运行至少 6 个浏览器/浏览器 worker，未来可能更多。

因此不希望浏览器资源也完全平均、固定地服务所有模型。

现实流量高度倾斜。

例如公益站可能：

3.7 Flash：80%～90% 请求
3.8 Flash：10%～20% 请求

因此希望支持类似：

5 个 browser workers -> 3.7F
1 个 browser worker -> 3.8F

而不是所有模型竞争同样的浏览器资源。

请在理解现有 browser/context 架构后设计这一层。

需要区分“逻辑执行槽”与“浏览器 context/page”：一个已登录账号的 context/page 可以被多个逻辑 worker 同时复用。`MAX_BROWSER_WORKERS` 表示最大浏览器 context/page 数量，`GLOBAL_MAX_CONCURRENCY` 表示最大在途请求数，后者允许大于前者。

理想抽象：

Model
↓
Model Worker Pool
↓
Browser Worker / Context
↓
Eligible Accounts
↓
AI Studio

例如：

3.7F Worker Pool
- Worker 1
- Worker 2
- Worker 3
- Worker 4
- Worker 5

3.8F Worker Pool
- Worker 6

---

## 七、浏览器资源最好支持“动态调度”

不要强制永久写死：

3.7F = 5
3.8F = 1

希望至少支持配置，例如：

MODEL_WORKERS = {
  "gemini-3.7-flash": 5,
  "gemini-3.8-flash": 1
}

如果项目当前配置体系不适合 JSON，可以设计更符合现有项目风格的格式。

更进一步，如果实现成本合理，希望支持动态 worker 分配。

例如共有 6 个 workers：

正常状态：

3.7F -> 5
3.8F -> 1

但如果：

3.7F 当前无请求
3.8F 出现大量排队

可以允许部分空闲 worker 临时帮助 3.8F。

也就是说：

“模型专属 worker 数量”最好理解成：

minimum / preferred allocation

而不是绝对隔离。

可以设计：

3.7F:
- min_workers: 3
- preferred_workers: 5

3.8F:
- min_workers: 1
- preferred_workers: 1

Shared workers:
- 允许动态借用

具体算法不要求完全按照这个例子实现，但目标是避免：

3.7F 的 5 个 worker 全部空闲，
而 3.8F 只有 1 个 worker 排长队。

---

## 八、建议考虑队列

如果当前架构允许，希望每个模型有自己的 request queue。

例如：

3.7F queue
3.8F queue

worker 根据模型绑定/动态分配从队列取任务。

优先满足：

1. 模型最低 worker 保证
2. 模型 preferred worker
3. 空闲 worker work stealing

这样高峰时资源利用率会比固定 worker 池更好。

需要避免某个热门模型永久饿死其他模型。

只有当全局并发、模型并发或显式账号并发上限被占满时才应排队。不得仅因所有可用账号都已有一个在途请求就排队。

可以考虑：

- per-model concurrency
- global concurrency
- queue length
- weighted scheduling
- fair scheduling

不要求一开始实现非常复杂，但架构最好留下扩展空间。

---

## 九、账号与 Browser Worker 不应永久绑定

如果项目现有机制允许，请尽量避免：

Worker 1 永远绑定 Account A

更理想的是：

请求模型
↓
选择对应 worker
↓
从该模型当前 eligible account pool 选择账号
↓
使用对应 context/session

不过必须尊重 AIStudioToAPI 当前浏览器认证/context 的真实实现。

如果 Google 账号 session 必须和特定 browser context 长期绑定，则不要为了抽象漂亮而破坏已有登录机制。

优先保证稳定性。

请先阅读源码，再决定最合理的映射：

Browser
Account
Browser Context
Page
Worker

之间究竟应该如何组织。

---

## 十、额度状态不应依赖“猜 100 次”

虽然目前观察到某些 Flash 模型每账号大约有 100 次调用额度，但不要把“100”硬编码进系统。

系统应该主要根据真实返回状态工作：

请求成功 -> available
429 -> 当前 account + model rate limited
明确 permission error -> unsupported

request_count 只用于：

- 统计
- 调度
- 管理页面展示
- 辅助预测

而不是认为：

request_count == 100
=> 一定耗尽

因为 Google 未来可能调整额度。

---

## 十一、额度恢复

需要考虑每日额度恢复。

如果无法可靠知道 Google 的具体 reset 时间，不要永久 blacklist。

可以：

方案 A：
rate limited 后 cooldown 到可配置时间，再 probe

方案 B：
到每日指定时间自动清除 rate_limited 状态

方案 C：
rate limited 后指数退避并定期健康检查

请结合项目架构选择最稳妥方案。

最好支持手动 reset。

---

## 十二、状态持久化

如果服务重启，最好不要完全丢失所有：

- unsupported 状态
- rate limit 状态
- request counters
- last error
- cooldown

如果项目已经使用数据库/配置存储，请复用。

如果没有，不要为了这个功能引入过重组件。

SQLite / JSON 等轻量方案都可以考虑，但要注意并发安全和异常写入。

其中：

unsupported

比较适合持久化。

短期 cooldown 是否必须持久化可以自行判断。

---

## 十三、管理和可观察性

如果项目已有 Web UI / 管理接口，希望增加至少以下信息：

Account | Model | Status | Requests | Errors | Rate limited | Cooldown

例如：

account01
- 3.7F: RATE_LIMITED
- 3.8F: HEALTHY

account02
- 3.7F: HEALTHY
- 3.8F: UNSUPPORTED

并显示：

每模型：
- 总请求数
- 成功
- 失败
- 当前可用账号数
- rate limited 账号数
- queue length
- active workers
- configured workers

全局：
- active browser workers
- idle workers
- queued requests

这样公益站运营时才能知道到底是：

账号额度不够
还是 browser worker 不够
还是服务器性能不够。

---

## 十四、配置项

请尽量增加可配置项，而不是硬编码。

例如可考虑：

MAX_BROWSER_WORKERS

MODEL_WORKER_ALLOCATION

MODEL_MAX_CONCURRENCY

GLOBAL_MAX_CONCURRENCY

ACCOUNT_MAX_CONCURRENCY

ACCOUNT_MODEL_MAX_CONCURRENCY

MODEL_QUEUE_SIZE

RATE_LIMIT_COOLDOWN

TEMP_ERROR_COOLDOWN

MAX_RETRIES_PER_REQUEST

ACCOUNT_ROTATION_STRATEGY

ENABLE_DYNAMIC_WORKER_ALLOCATION

具体命名请遵循项目已有配置风格。

不要为了满足示例强行使用这些名字。

---

## 十五、并发安全

这是公益站场景，非常重要。

假设同时有几十个请求：

不能出现所有请求同时看到：

Account A available

然后全部选中 A。

调度账号时需要：

reservation / lease / inflight count

之类的并发保护。

至少记录：

account inflight

account + model + inflight

调度策略可以综合：

available
cooldown
inflight
last_used
request_count

来选择账号。

Browser Worker 同样不能被两个不兼容任务同时占用。

但对于不同 `request_id` 且消息队列、取消信号、重试 attempt 已完整隔离的普通模型请求，不应因为复用同一 browser context/page 就视为不兼容。一个 context 断线时可能影响其上的所有在途请求，实现需正确关闭和释放这些租约。

---

## 十六、重试原则

一次用户请求如果：

A + 3.7F -> 429

可以自动：

B + 3.7F

重试。

但必须设置最大次数，例如：

MAX_RETRIES_PER_REQUEST

避免：

A -> B -> C -> D -> ... -> A

无限循环。

同一个 request 已尝试失败的：

account + model

在这次请求生命周期内不要再次选择。

如果整个模型池全部耗尽，应尽快返回明确错误，而不是一直等待。

---

## 十七、兼容性要求

最重要：

尽可能不要破坏 AIStudioToAPI 已有：

- OpenAI API compatibility
- Gemini API compatibility
- Anthropic compatibility
- streaming
- tool calls
- authentication
- WebSocket
- AI Studio Build interaction
- current login workflow
- existing configuration

这次主要改造的是：

Account Scheduling
Model Quota State
Browser Worker Scheduling
Concurrency Management
Observability

不要无必要重写协议转换代码。

---

## 十八、实施方式

请先：

1. 阅读整个仓库；
2. 找出当前账号管理、账号切换、浏览器/context 管理、429/503 handling、并发控制的位置；
3. 解释当前架构；
4. 给出最小侵入式改造方案；
5. 再开始修改。

优先考虑：

简单
稳定
易维护

而不是过度工程化。

第一阶段必须实现：

- Account × Model 独立状态
- model-aware account selection
- 模型级 429
- 账号级错误和模型级错误区分
- 并发安全
- 多 browser worker
- 按模型配置 worker 数量
- 单账号多请求并发，默认不设账号级上限
- 解耦浏览器 context/page 数量与全局请求并发数

第二阶段如果不会明显增加复杂度，再实现：

- 动态 worker borrowing / work stealing
- per-model queue
- worker 自动再平衡
- 更完整 metrics/dashboard

如果动态 worker 调度会大幅破坏项目现有浏览器架构，可以先实现稳定的静态：

3.7F = 5 workers
3.8F = 1 worker

同时把接口设计成未来容易加入动态 worker 调度。

---

## 十九、最终目标

当前逻辑：

Account A
↓
任何模型 429
↓
换 Account B

目标逻辑：

Request(model=3.7F)
↓
3.7F Worker Pool
↓
选择当前有空闲执行能力的 Worker
↓
3.7F Eligible Account Pool
↓
选择健康、未 cooldown、inflight 合理的 Account
↓
执行请求
↓
只更新 Account × 3.7F 状态

与此同时：

Request(model=3.8F)

拥有独立的：

Worker allocation
Account availability
Quota state
Statistics

最终要做到：

“某账号某模型额度耗尽，不浪费这个账号其他模型的额度；某模型请求多，就能够分配更多逻辑执行资源；即使可用账号数少于全局并发数，也能通过单账号多请求并发尽量保障高峰期用户体验。”

服务器内存较充足，预计至少可以同时维持 6 个甚至更多 browser workers，所以相比极端节约浏览器资源，更优先：

吞吐量
高峰期用户可用性
模型间隔离
额度利用率
高并发稳定性

具体可支持多少 browser/context 不要硬编码，交给配置，并保留后续压力测试调整空间。
