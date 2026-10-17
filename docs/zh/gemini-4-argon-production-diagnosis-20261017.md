# bero Gemini 4 Argon 生产问题定位与修复

日期：2026-10-17（Asia/Shanghai）。生产基线：`68ffcfd`，个人实例 `aistudio-bero`，其镜像仅另行替换了自建 Build App URL。

结论：生产日志中的权益预检失败和应用退出是项目缺陷。已完成本地修复，并在生产镜像的真实 Camoufox 中验证权益查询与旧 RPC 补头机制；修复尚未部署到生产。Argon 生成尚未验收通过，账号的目标模型资格仍不能据此确定。

## 1. 已实测的根因

### 1.1 观察器安装到了错误的 realm

通过 `ssh bero`，使用该个人账号的现有 storageState 在容器内启动临时诊断浏览器。只记录认证头是否存在、RPC 方法、权益状态等脱敏字段，不输出密钥、Cookie、ext 原值、proof、提示词或生成正文。

原版本同时出现：

- 12 个宿主页原生 MakerSuite 请求实际携带 Authorization 和服务 API Key。
- `window.wrappedJSObject` 存在，注入侧 fetch 与网页侧 fetch 不相同。
- 观察器只存在于注入侧；网页实际执行请求的 realm 中没有观察器。
- 因而 `state.auth` 始终为空，权益预检返回 `failed / auth_unavailable`。

这说明账号原生认证正常，失败发生在项目捕获认证的方式上，不能据此认定账号没有会员或 Argon 权限。

### 1.2 当前 Camoufox 的 binding 也不能按标准 Firefox 使用

该镜像的 Camoufox 135 与 Playwright 1.59.1 组合中，标准 Firefox fixture 可调用的 `page.exposeBinding()` 函数无法在页面/注入 realm 中正常取得。只把观察器移到网页 realm，还不足以保证原生权益变化能唤醒 Node 调度状态。

修复在 Camoufox 中通过 `wrappedJSObject.eval()` 安装观察器及执行状态读取；观察器以 console debug 标记通知 Node。标记只有随机实例 owner 和文档 ID，Node 收到后重新检查当前文档、实例所有权和会话有效性，才读取状态。认证及 ext 不经该通知通道传输。标准 Firefox 保留原有 binding 路径，销毁时移除新增监听器。

实测修复后的同账号能够捕获原生认证与 ext，`GetAiStudioBenefitTier` 返回 HTTP 200，状态为 `ready-paid`。没有写死 tier，也没有复活固定混淆属性读取。

### 1.3 legacy 预检异常没有进入外层错误处理

四类生成入口原有外层只有 `try/finally`；预检在内部队列处理的 `try/catch` 之前执行，异常会直接向上传播，而 Express 入口没有接住返回的异步拒绝。这与验收日志中的子进程退出、supervisor 拉起及 Nginx 502 对应。

修复为现有请求入口补上外层 `catch`，统一调用 `_handleRequestError()`，在结束请求记录前返回受控错误。权益未就绪返回 503，保留原有协议的错误格式，不发送生成、不创建遗留队列、不标记整个账号登录失效。

### 1.4 工具结果的 JSON 标量缺少对象包装

OpenAI 工具结果 `7` 是合法 JSON，解析得到数字后曾直接写入 Gemini `functionResponse.response`；对象 `{"number":7}` 则没有这个问题。

修复将解析后的标量或 null 包装为 `{ result: value }`，保留对象及既有 MCP 数组处理。测试覆盖数字、JSON 字符串、布尔、null、普通文本和对象。该修复尚未在生产执行真实工具后续轮次验收。

## 2. 验证结果与边界

- 本地完整 `npm test`：403 项，371 通过、32 按既有环境条件跳过、0 失败。
- 生产镜像内真实 Camoufox 的本地 TLS/CONNECT fixture：8 项全部通过，不访问 Google。检查实际 `route.continue()` 出站的旧 unary RPC、正文/proof 标记、认证和 Cookie 保持原样，补充同账号权益头；同时验证查询分类、通知、文档变化、账号隔离及调度预检。
- 新增四类 legacy 入口 stream/non-stream 的失败用例：预检异常受控返回，没有生成派发及遗留队列；新增工具结果标量归一化回归。
- 真实 Google 权益查询：同一账号已取得 `ready-paid`，不再是 `auth_unavailable`。
- 普通生产调用复验：`gemini-3.8-flash` HTTP 200、严格输出 OK、stop 和 usage 均存在，2.551 秒。
- Argon 隔离生成探针：预检通过，但在无真实 WebSocket 的模拟预览通道中超时，没有取得可确认的 ProxyUnaryCall 生成成功。没有使用直接 GenerateContent 回退，也没有把该超时解释为免费、403 或旧通道不支持。没有自动重放结果不确定的生成。

Camoufox 的原生 `Page.reload` 在 fixture 中等待导航事件超时；Camoufox fixture 的文档失效测试因此改用与生产 BrowserManager 相同的 `goto` 方式重建文档。标准 Firefox 仍测试原生 reload。本次不将 Camoufox 原生 reload 列为已验证通过。

## 3. 诊断期间的生产影响及最终状态

初版诊断使用 `page.routeWebSocket()` 隔离连接，但该 Camoufox 未执行这一拦截，曾短暂触发账号 #0 的 WebSocket 连接替换。发现后关闭这些诊断浏览器，原生产连接恢复；随后改用不创建真实 WebSocket 的模拟通道。该情况已向用户说明，不能称诊断完全无影响。

最终核对：

- 生产源码、镜像及配置未修改，`ARGON_VERIFIED_ACCOUNTS=[]` 保持禁用。
- 容器 running/healthy，`/health` HTTP 200、status=ok、browserConnected=true。
- 应用子进程仍为 PID 16，未重启；Docker restart count=0。
- 只有一个生产浏览器，临时诊断浏览器均已关闭。
- 账号 #0 为 valid，recovery 为 idle。
- `usage-stats.sqlite` 和 `accounts.sqlite` 均 quick_check=ok；没有清空账号、额度或调度状态。
- 未修改 NewAPI、CCS、其他实例或它们的渠道配置。

脱敏证据见 [诊断数据](fixtures/argon-production-diagnosis-20261017.json)。原始认证仅在生产容器内读取用于该账号的页面测试，没有复制到本地或写入报告。

## 4. 可执行的解决方案

1. 将本次源码修复构建为新镜像，保留现有个人 Build App URL、数据挂载、认证及备份，首次启动仍保持 Argon 禁用。
2. 在受控验收环境确认权益未就绪时返回明确 503，应用进程保持稳定；确认普通模型和工具标量结果的后续轮次正常。
3. 对同一账号临时设置目标模型验收集合，检查实时权益、精确模型 ID 和 Build 资格；单次执行 Argon 非流式生成，核对实际为 ProxyUnaryCall、没有直接 GenerateContent 回退。
4. 只有非流式成功后，再按原适配方案验证缓冲 SSE、文档重新导航、context 重建、取消和函数调用后续轮次。没有第二个合格账号前，不宣称并发双账号验收通过。
5. 若真实目标生成仍失败，保留 HTTP/RPC 脱敏证据，分别判断模型资格、Build 通道、参数、认证和限流；未通过就恢复禁用，不写死 tier、不清额度、不反复轮换。

本次交付是已复现根因、可审阅源码修复及对应验证；不是“Argon 已在生产恢复可用”的验收结论。
