# Gemini 4 Argon 适配方案：保留旧版 Build 请求模式

日期：2026-10-17（Asia/Shanghai）。状态：运行代码及离线验证已实施；真实账号资格与 Google 上游验收尚未执行，未部署服务。

## 1. 目标与基线

用户已确认：旧版请求模式重新可用，因此主分支已回退；但 Gemini 4 Argon 仍无法调用。用户已自建 Build App，本次不创建或切换应用。

当前核对状态：

- 本地及远端 `main` 均为 `94b93edd7f9da16102e6566c618d90b664dda135`。
- 旧修复归档在 `archive/makersuite-protocol-1dc1e30`，不能把归档中的新 GenerateContent 桥接整体合入主分支。
- 参考仓库本地路径：`/home/dev/workspace/projects/AIStudioToAPI/ais2api`，核对版本为 `d879f41da4116608327ae726515609e78eba5f11`。
- 最相关参考提交：[694ccd8](https://github.com/yunx738/ais2api/commit/694ccd8)，新增会员权益查询与请求头，作者说明用于启用 `gemini-4-argon`。

本方案的明确模型 ID 是 `gemini-4-argon`。用户所称 gemini4、4agron、4argon 均在本文中指该模型，不据此将所有 `gemini-4-*` 模型视为相同能力。最终以目标账号实际可用模型 ID 为准。

目标是：继续使用 Build 宿主页发起的 `ProxyUnaryCall / ProxyStreamedCall`，只为目标模型补齐权益上下文和调用策略。保留标准 Gemini JSON、页面原有认证、WAA 生成和原响应解析；其他模型维持当前行为。

## 2. 已确认事实与待验证假设

### 2.1 从参考源码确认的变化

参考实现位于 `dual-runtime/code/unified-server.runtime.js`，主要增加：

1. 从页面原生 MakerSuite 请求观察 `x-aistudio-g1-tier` 和 `x-goog-ext-519733851-bin`。
2. 没有观察到 tier 时，调用 `MakerSuiteService/GetAiStudioBenefitTier`，请求体为 `[]`。
3. 返回数组首项 1 映射 `TIER1`，2 映射 `TIER2`；无对应值时不加会员头。
4. 生成请求带上取得的 tier，以及页面实际提供的 ext 头。

参考代码是在直接调用 `MakerSuiteService/GenerateContent` 的桥接上补这些信息，不是对旧 RPC 成功的直接证明。移植目标是权益上下文，不能同时带回其请求数组、缓冲桥接和全局页面引用。

### 2.2 旧 RPC 的调用策略依据

另一项独立实现的 [Build 协议记录](https://github.com/Mag1cFall/AIStudio2API/blob/main/docs/build.md#2-代理-rpc-与-waa) 记录：订阅权益模型经 `ProxyUnaryCall` 调用，权益头随 unary 发送；这类模型走 `ProxyStreamedCall` 可能返回 HTTP 403 / RPC Code 7。

本项目据此优先验证 `gemini-4-argon + generateContent + ProxyUnaryCall`。该记录属于第三方实现观察，不是 Google 官方保证，也不能替代本项目自己的真实验证。

当前尚未取得本项目失败请求的准确状态、RPC 错误和脱敏网络对比，不能断言“补头一定恢复”。必须区分：模型名不符、账号无资格、Build 通道未开放、错误流式入口、缺少权益上下文、认证失效及额度耗尽。

## 3. 保留的请求链路

```text
OpenAI / Anthropic / Gemini 客户端
  → 现有 RequestHandler / FormatConverter
  → 现有 WebSocket / Build 客户端
  → fetch(generativelanguage.googleapis.com/...)
  → Google 宿主页生成 WAA 与旧 Proxy RPC
  → 对目标生成 unary 请求补齐同账号权益头
  → route.continue() 发出原请求
  → 现有响应转换返回客户端
```

请求体仍由页面和现有客户端负责。不得新增上一轮的 `MakerSuiteCodec`，不得把生成请求改发到直接 GenerateContent RPC，不使用 `route.fulfill()` 收完整响应再模拟旧 RPC。

## 4. 浏览器层的权益上下文

建议新增独立模块 `src/core/BuildBenefitContext.js`，每个账号的 context/page 对应一个实例。

### 4.1 观察与查询

- 在账号 page 首次导航前安装原生请求观察和目标 RPC route，纳入 BrowserManager 的初始化 attempt、超时及取消管理。
- 用 URL 解析限定 `https://alkalimakersuite-pa.clients6.google.com` 和精确 MakerSuite RPC 路径；不从客户端传入的 HTTP 头采信会员身份。
- 只观察该账号当前页面的原生请求。通过页面 realm / 文档版本区分 reload 前后事件，旧文档迟到请求不能更新新页面缓存。
- 观察 tier 与 ext 时保留其来源，页面真实值优先。ext 按不透明值处理，不猜测内容、拼接或跨账号复制。
- 无 tier 观察结果时，在同账号页面内调用 GetAiStudioBenefitTier。使用页面当前实际服务 API Key、Authorization、authuser 和 Cookie，不使用客户端自己的 API Key，也不复活 `mb.jK` 等固定混淆属性读取。
- 若需要从归档参考 API Key 学习逻辑，只提取独立、最小的获取部分；必须排除另一类令牌服务 Key，以及本模块自己发出的请求，避免循环学习错误值。
- 并发首次请求共享一个查询 Promise，避免每个请求都重复查询。查询必须有 deadline，失败不能永久缓存成免费账号。

会员查询不需要生成请求的 WAA；不能用一个生成调用作为资格探测或保活操作。

### 4.2 状态与缓存

至少区分以下状态：

| 状态              | 含义                          | 目标模型行为                             |
| ----------------- | ----------------------------- | ---------------------------------------- |
| unknown / loading | 未取得可靠权益上下文          | 有界等待或返回未就绪，不向普通账号盲派发 |
| ready-paid        | 查询/页面观察确认对应会员等级 | 继续检查目标模型的 Build 可用性          |
| ready-free        | 权益查询明确无对应会员等级    | 不调度目标模型；不标账号登录失效         |
| failed            | 查询、认证获取或解析失败      | 返回清晰失败，允许有界刷新，不伪装为免费 |

`TIER1 / TIER2` 是请求头值，不是管理员给账号贴上的本地标签。不能通过手动标为 Pro/Ultra 或写死 `TIER2` 赋予上游权限。未知权益枚举不擅自映射为付费等级。

缓存绑定 `authIndex + sessionVersion + browserGeneration + page/document`。换号、reload、context 重建、会话替换和销毁时失效；清理定时器、监听器、挂起查询及 route，并确保旧实例不能清除新实例资源。

### 4.3 补头位置和范围

在最终发往 Google 的旧 `MakerSuiteService/ProxyUnaryCall` 上识别载荷中的目标模型和方法，只处理 `gemini-4-argon:generateContent`。

```js
// 示意：请求体与原生认证保持原样
const headers = { ...request.headers() };
headers["x-aistudio-g1-tier"] = currentAccountBenefit.tier;
if (currentAccountBenefit.ext) {
  headers["x-goog-ext-519733851-bin"] = currentAccountBenefit.ext;
}
await route.continue({ headers });
```

实际实现必须处理原头已包含正确值、缺少可靠值和来源冲突的情况。不得使用过期缓存覆盖当前页面原生值，也不得把 ext 缺失时伪造为空字符串。ext 是否对该模型必需，要靠真实请求对比确认，当前不把它等同于会员等级。

不修改 POST body、WAA proof、Authorization、Cookie、API Key、authuser、URL 和原生网络流。不全局改变其他模型、文件、embedding、模型列表或 countTokens 的请求。

只在最终宿主页 RPC 层补头；不要直接将这些头塞进 Build iframe 对 generativelanguage 的 fetch，不能假设 shim 会正确转发，且可能改变预检或认证行为。

## 5. 目标模型的 unary 分流与客户端流式

在 `RequestHandler` 构造上游 Gemini 请求时决定方法，早于页面生成 WAA。根据清理后的准确模型名判断，覆盖 Chat Completions、Responses、Anthropic、Gemini native 各入口。

| 客户端需求 | 目标模型上游                        | 对外响应                                         |
| ---------- | ----------------------------------- | ------------------------------------------------ |
| 非流式     | `:generateContent` → ProxyUnaryCall | 原有完整 JSON                                    |
| fake 流式  | 同上，清除 `alt=sse`                | 原有 fake SSE                                    |
| early 流式 | 同上，清除 `alt=sse`                | 原有提前开始及保活，完成后输出正文               |
| real 流式  | 初期仍使用 unary                    | 明确显示目标模型实际采用缓冲输出，不宣称实时增量 |

初期对目标模型统一使用 unary。客户端 `stream:true` 保持响应协议兼容，实际模式选择 fake 或 early；全局 real 配置不应迫使该模型走 ProxyStreamedCall。模型 `-real` 等后缀也要进入同一规则，避免绕过策略。日志、状态字段和 README 标明有效模式，其他模型的 real 流式不受影响。

原生 Gemini 的 `:streamGenerateContent` 入口尤其要保留客户端 wantsStream 判断与 SSE 输出，只改内部 proxyRequest 的上游 path/query。现有 `_handlePseudoStreamResponse()` 已包含改写非流式路径和删除 alt 的逻辑，可复用，但不要靠某一个响应分支的迟到改写作为唯一策略。

禁止在 route 中把已经生成 proof 的 ProxyStreamedCall 改名为 ProxyUnaryCall，或修改其内层路径和 JSON。旧 RPC 的 WAA 绑定包含目标路径与请求体；改变任一项都应由页面重新生成 proof。提前选择 unary 可以沿用页面原生机制，避免额外实现 WAA。

## 6. 模型资格、调度和额度

### 6.1 账号资格

会员等级是必要信息，不等于该模型在 Build 通道必然可用。先用同一账号确认网页可以调用，再核对 Build 目录或实际旧 RPC 资格；Playground 列出该模型不能单独证明 Build 也支持。

初期可使用明确配置的“已验证可用账号集合”限制派发，结合实时查询的权益判断；配置标签本身不能替代上游权限。没有可用账号时返回明确的模型不可用/无合格账号错误，不把整个账号池轮询一遍制造 403。

在 ModelScheduler 的资源资格判断中统一应用目标模型规则，readyCandidates、canLease、排队请求、重试及冷账号预热使用相同逻辑。legacy 模式也要检查最终选中账号，不能只保护调度模式。

必须区分“可进行权益预检的候选账号”和“可派发生成的账号”：unknown 状态允许按现有 context 初始化并发与容量限制进行只读查询，但不允许生成。不能把 unknown 账号从所有候选中永久删除，导致没有 context 可初始化、也永远无法取得权益的死锁。没有账号通过查询时，预检应在请求排队期限内结束并返回错误，不能无限换入 context。

资格更新与 sessionVersion 替换后，失效当前调度轮的资格缓存并唤醒必要的排队任务；继续保留近期 context 池残留需求修复的容量和淘汰约束。

### 6.2 本地额度

当前 `getModelDailyQuota()` 只识别 flash/pro 名称，`gemini-4-argon` 返回 null。这里的 null 表示现有逻辑没有可估算的额度，不能解释为高级账号无限调用。

本轮以恢复调用为主，不整体移植参考仓库的分档额度体系。若需要目标模型本地限额，应使用显式模型/账号策略，并在配置、持久状态和看板中保持一致；未知值继续显示未知。不得将参考项目的 Pro 50、Ultra 100/200 视为 Google 官方保证，或未经用户配置直接重置现有额度。

真实 429 仍按上游额度/冷却处理；会员头补齐不绕过额度。

## 7. 错误分类与诊断

- 缺少可靠权益、查询超时或认证上下文未准备好：返回本地未就绪错误，默认不触发账号登录过期或自动重放生成。
- 明确免费账号或模型无资格：只影响目标账号 × 模型的派发，不将账号整体判为失效。
- 上游 403 / RPC Code 7：检查目标是否误走 streamed、tier/ext 是否正确以及真实模型权限，不能仅凭 403 认定 IP 风控。
- 401：区分查询/头获取问题与真实会话失效。本分支已回退上一轮 401 修复，不能假设归档里的诊断标记和防连锁逻辑仍存在。实现时验证错误经过页面、Build、WebSocket 后的实际分类；不能自动禁用整个账号池。
- 400：保留结构化错误，检查模型参数和 WAA，不能无条件自动转入直接 GenerateContent。
- 429：保留限流和重试时间，不换成权限错误。
- 所有失败遵守现有请求/attempt、取消和结算语义；不在结果不确定时盲目重放生成请求。

日志仅记录账号内部 ID、请求/attempt、模型、实际旧 RPC、权益来源、有效流模式和状态。不要记录 API Key、Authorization、Cookie、ext 原值、WAA、提示词或回答。

## 8. 建议改动文件

| 文件                                                    | 改动职责                                                      |
| ------------------------------------------------------- | ------------------------------------------------------------- |
| `src/core/BuildBenefitContext.js`（新增）               | 每账号权益观察、只读查询、缓存、补头和清理                    |
| `src/core/BrowserManager.js`                            | 首次导航前安装；初始化取消、reload、会话替换及销毁管理        |
| `src/core/RequestHandler.js`                            | 四类入口共享目标模型 unary 策略，保留客户端响应模式           |
| `src/core/ScheduledRequestHandler.js`                   | 权益预检与租约派发衔接，按错误原因处理重试                    |
| `src/core/ModelScheduler.js`                            | 目标模型资格、预检候选与生成候选、资格缓存失效                |
| `src/core/SchedulerConfig.js` / 配置定义                | 如采用已验证账号集合或新策略，增加验证与明确配置说明          |
| `src/core/ProxyServerSystem.js` / `configs/models.json` | 在资格确认后展示准确模型 ID，不仅添加静态模型列表就宣称可调用 |
| 对应测试与 README                                       | 旧路径不变、会员头、响应兼容、资格和能力限制                  |

如实际验证证明只需原生头补齐即可，保持最小改动；不为参考仓库的双槽位、Pro/Ultra UI 或保活策略做无关重构。

## 9. 实施顺序与验证

### 9.1 先确定最小成功链路

1. 用明确有资格的账号，在网页验证准确模型名和调用权限。
2. 对比其原生请求与现有代理失败请求，只采集必要的脱敏方法、RPC、头是否存在及错误状态。
3. 仅接通目标模型非流式 unary，并补齐同账号权益上下文；验证是否恢复。
4. 成功后再接入 fake/early、模型路由及并发账号；单次失败不自动升级为全量重构。
5. 若补头后仍失败，按实际错误判断旧通道是否支持。不能将直接 GenerateContent 成功算作旧模式适配通过；需要改变范围时先记录证据和方案差异。

### 9.2 离线与真实浏览器 fixture

- 权益查询返回 1、2、免费、未知值、损坏 JSON、401/403/429 和超时，状态分类正确。
- 首次并发查询共享 Promise，查询失败可有界刷新；页面重载后重新查询，缓存和 ext 不串号。
- header-only route 的前后 URL、body、WAA、认证头完全不变；正确值不被旧缓存覆盖。
- 新上游调用始终是目标旧 ProxyUnaryCall，不产生直接 GenerateContent；其他模型、streamed、模型列表、文件等请求不被错误拦截。
- Chat、Responses、Anthropic、Gemini native 的 stream/non-stream 都选择正确上游方法；客户端 SSE/JSON 外形保持兼容。
- 全局 real、模型后缀和原生 `alt=sse` 都不能绕过目标模型 unary 策略，其他模型 real 路径不变。
- 普通、已验证付费、unknown、资格变更、旧 sessionVersion 和无可用账号的调度行为正确；冷账号预检不死锁、不触发残留需求换入循环。
- 取消、超时、reload、销毁和旧请求迟到均清理资源；403 资格错误不误伤整个账号，429 冷却保持原规则。

使用真实 Firefox 的本地 fixture 校验浏览器原生请求补头和取消；固定 Google 域名通过受控拦截模拟，不访问真实 Google。mock 测试不能只断言“调用了补头函数”，还要检查实际出站请求保持旧 wire。

运行新测试、相关 request/scheduler/browser 回归，再运行 `npm test`、改动 JS lint、格式检查和 `git diff --check`。

### 9.3 真实上游验收

由具备权限的账号测试：冷启动第一次调用、reload 后第一次调用、context 重建、两个账号并发、客户端取消，以及一次函数调用后续轮次。

通过条件是：目标模型确实成功、网络请求仍为 ProxyUnaryCall、没有直接 GenerateContent 回退、已有模型不回归、账号状态和额度没有异常变化。明确记录 4-argon 的客户端流式为缓冲输出，不写成“已恢复真实流式”。

未通过时保留脱敏错误证据，区分权限、通道、参数、认证和限流。不能用重复轮换、批量重新登录、写死 tier 或清除额度作为成功标准。

## 10. 实施记录（2026-10-17）

- 运行代码：新增 `BuildBenefitContext`，首次导航前安装 fetch/XHR 原生请求观察和精确 unary RPC route。权益、认证与 ext 绑定账号页面及文档；原生请求正文需匹配当前文档记录，旧文档事件不能更新缓存或补新权益。
- 权益查询：同页面并发共享 Promise，5 秒 deadline；独立记录 unknown/loading/ready-paid/ready-free/failed、脱敏失败原因及 HTTP 状态。失败允许 30 秒后重新预检，重载立即失效；查询的 401/403/429 不进入生成错误或账号过期流程。API Key 仅从该宿主页原生 MakerSuite 请求获取，排除本模块查询及其他服务。
- 补头范围：仅当前宿主页的目标 `gemini-4-argon:generateContent` 旧 ProxyUnaryCall。保留原请求已有的有效 tier/ext，缺失时从当前文档补充；不更改 URL、body、WAA、Authorization、Cookie 或其他 RPC，不引入直接 GenerateContent 桥接。
- 调用策略：Chat Completions、Responses、Anthropic、Gemini native 提前选择 unary；全局 real、模型 `-real` 后缀及原生 `alt=sse` 不能绕过。对外保留 JSON/SSE，目标模型输出为缓冲模式；其他模型继续原策略。
- 资格配置：新增环境变量 `ARGON_VERIFIED_ACCOUNTS`，严格验证为非负整数 authIndex 的 JSON 数组，默认 `[]`。这是已有 Build 资格的人工核验集合，不能替代实时付费权益；更换账号或重编号后须重新核验。配置经 `.env` 设置并重启，本轮不新增账号等级 UI，也不静态宣称模型已可调用。
- 调度：unknown 允许受现有容量与初始化并发约束的预检，只有 ready-paid 可以租约生成；免费/失败预检从当前排队请求排除，避免淘汰后重复换入；覆盖 readyContextOnly 开启/关闭及 legacy 最终账号检查。会话版本、browserGeneration、page ownership 与文档变更均检查失效。
- 错误处理：目标 403/RPC Code 7 作用于账号×模型，不作为 IP 风控或整个账号过期；真实 429 保持额度冷却。unary 断线、超时及权益本地错误不盲目重放生成。客户端权益头不能作为目标生成的会员依据。没有修改现有日额度或持久用量。
- 诊断：上下文状态提供 `build_benefit` 的状态、来源、失败原因、查询 HTTP 状态及核验标志；生成日志包含内部账号 ID、request/attempt、实际 RPC 与有效缓冲模式，不记录密钥、ext、proof 或内容。
- 新增测试：`tests/build-benefit.test.js`，并接入 `npm test`；扩展 scheduled request 端到端测试，更新使用新增 page API 的旧 browser mocks。
- 真实 Firefox fixture：已通过。使用本地 TLS 服务和受限 CONNECT 代理接收真实 `route.continue()` 出站请求，不访问 Google；断言旧 RPC URL、正文及 proof 标记、认证、Cookie 保持原样，覆盖 tier 1/2/免费/未知枚举、损坏 JSON、401/403/429、超时、刷新、重载、迟到文档通知、账号隔离与双账号并发。未添加的 ext 保持缺失。
- 账号与 Build 模型资格核对：未执行；没有替用户填写核验集合或授予账号标签。
- 真实 Google 验收：未执行。仍需使用具备权限的账号按 9.3 验证冷启动、reload、context 重建、并发、取消与函数调用后续轮次；离线通过不能视为旧通道上游成功。
- commit / push / 生产部署：未执行。

验证结果：新增权益/Firefox 测试 8 项通过；scheduled request 回归 65 项通过（含四入口 stream/non-stream、403、429 和断线不重放）；完整 `npm test` 通过（共 393 项：361 通过、32 按现有环境条件跳过、0 失败）；改动 JS lint、Prettier 与 `git diff --check` 通过。现有需要额外环境开关的真实登录浏览器用例保持其原有 skip 条件。
