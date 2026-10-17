# 双通道兼容修复实施记录

日期：2026-10-17（Asia/Shanghai）。运行代码与离线测试已实施；生产 Camoufox 和真实账号验收尚未完成，不作为发布通过记录。

## 基线与范围

- 实际开发基线：`f73f26a4d5b815cfa3bbf19d0d17bf6f85276fe7`，开始时工作树干净，`main` 领先远端 4 个提交；保留这些已有提交。
- 开发分支：`feature/model-transport-routing`。
- 选择性恢复归档 `1dc1e306907d6a91a0ba28e561bfce04af88b78f` 的 MakerSuiteBridge、MakerSuiteCodec、MakerSuiteAuth 和四组测试，保留原授权与来源说明。没有整体合并归档或替换 BrowserManager / RequestHandler。
- 参考项目实际 HEAD：`914bc256b3c18f3e1b8ce33b12f3724e09bf18ef`，与方案中的对照版本一致；本次没有修改该项目。
- 未启动本项目服务或生产实例，未修改 Cookie、账号数据库、已保存 Build App、NewAPI 渠道或生产配置，未 commit / push。

## 实现

`ModelTransportPolicy` 统一精确模型路由和能力快照。默认 3.7 与其他模型使用 legacy，Argon 使用 makersuite。`MODEL_TRANSPORT_POLICY` 同时接入环境加载、配置校验、管理界面、持久化和重启生效；拒绝通配、指令后缀、原型键及未知传输。请求沿用接收时的配置快照，后续 attempt 不改变传输，不执行自动跨通道回退。

浏览器宿主页只安装一个生成 RPC 分派 route。legacy 沿用原始 URL、正文、认证与 WAA，并继续支持已授权的权益补头。makerSuite 分派只接受精确 Google origin、RPC pathname、POST、主 frame 及生成路径；模型目录、文件、embedding 和 countTokens 不进入桥接。桥接为转换后的载荷生成新 WAA，GenerateContent 使用当前页面真实认证与 tier/ext，且不从自产请求学习认证。客户端 Key 的排除属于当前调用，不能污染其他请求。

每个桥接请求在发送前登记 request/attempt、策略、页面 epoch 和单调 deadline。关联标记经过旧 Build 客户端已有的 query 传递能力到宿主页，并在转换时丢弃，不进入 GenerateContent。legacy RPC 上的本地取消标记在出站前移除。此兼容方式不要求编辑用户已保存的 App；新版脚本另通过内部 WebSocket 握手报告 `transportVersion=1`，识别策略和剩余预算。

Argon 保留 verified account + 当前页面 paid 的双重资格检查。unknown 只做预检，认证和权益失败受控返回。未确认的桥接认证错误不轮换或禁用账号；确认登录过期仍受 sessionVersion 保护。桥接 403/RPC 7 按模型资格处理；429 保留原错误与既有冷却，不清额度，不改 3.7 历史统计，也不推定 Argon 日额度。

四类入口保留 JSON/SSE 意图，桥接 real 请求走 unary 缓冲；Chat early 保留提前响应与心跳，其他入口保留当前已有的缓冲 SSE 行为。统一缓冲 deadline 覆盖桥接认证、WAA、fetch、正文读取和响应消息队列等待，后续 attempt 不重新起算。默认预算 300000 ms，桥接最多 295000 ms，并扣除已消耗时间和结算余量。心跳与收到的正文块均不续期。超过 300000 ms 的缓冲环境配置明确报不支持，管理配置同样拒绝越界值。

取消会终止对应页面 AbortController、原始 RPC 和 reader。证明生成挂起也会退出桥接等待并清除记录，不会在迟到的 proof 完成后发起生成。导航、context/session 替换和关闭使旧状态失效；页面 document ID 在执行前再次核对，防止旧请求在新文档生成。调度器释放租约前等待取消结算，Playwright 清理等待上限 2 秒，超限记录受控日志。

编解码继续拒绝未知或未支持字段，不静默删除参数。补齐当前转换器中 tool call ID 到函数名的关联，保留工具结果标量包装与真实 snake_case 思考签名。没有迁移账号等级 UI、额度估算、双槽协调器或保活策略，也没有新增静态“可用模型”。

## 验证

- `npm test`：最终结果见下方验收统计；包含新增策略、客户端、认证、编解码和桥接测试及既有 request / scheduler / browser 回归。
- 四入口 JSON/SSE 的可控时钟测试：全局 real / `-real` 进入缓冲，59、61、90 秒仍等待并在预算内输出，只有一次派发，队列与租约清理完成。
- 浏览器客户端测试：旧模式保留五分钟保护；非法预算拒绝；正文持续到达不能延长总 deadline；超时返回 504 并取消 reader 与 fetch。
- 本地真实 TLS/CONNECT：Firefox 148.0.2，Playwright 1.59.1。检查实际出站 URL、body、认证、Cookie、权益和新 proof；3.7 保留原始 streamed RPC；Argon 实际出站 GenerateContent；超时与主动取消观察到 TLS 上游连接关闭；文档重建后重新调用成功。
- 真实长等待 fixture：`npm run test:transport:long`，GenerateContent 在 61 秒后返回正文，处于 75 秒外层预算内。常规浏览器命令跳过此长用例，单独的长命令必须通过，不能用跳过代替。
- TLS fixture 只允许两个预设主机的 CONNECT，并将其映射到回环 TLS 服务；其他目标（包括生产 9998）拒绝。不使用 Google 或生产账号。
- `npm run build:ui`：管理界面与公示页构建通过。
- 改动 JS/Vue ESLint、Prettier（忽略无 parser 的 `.env.example`）与 `git diff --check`：最终结果见验收统计。

## 尚未完成的发布门槛

当前环境未找到 Camoufox 可执行文件，因此没有声称生产 Camoufox 已通过。TLS fixture 支持 `BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH=/path/to/camoufox`；使用与 BrowserManager 一致的 `goto(..., { waitUntil: "domcontentloaded" })` 重建文档。生产版本的 realm、取消和长等待仍须用实际可执行文件验证，不能用标准 Firefox 结果替代。

阶段 D 需要另行部署/切换授权。本次没有读取或切换活跃生产实例，没有真实账号生成验收或 NewAPI 网络验收，没有真实双账号并发结论。将来验收前须重新读取最新活跃实例与数据状态，先备份并停止共享 Cookie 的参考实例，确认浏览器关闭，再按修复方案执行最小范围验收。

离线 fixture 不证明 Google 长期保持模块名或位置协议，也不证明目标账号当前有生成额度。桥接不支持的功能明确返回错误，不能因为恢复 codec 就宣称所有 Gemini 参数均可用。

## 最终验收统计

| 检查                                                                                                                      | 实际结果                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                | 退出码 0；TAP 汇总 462 项，430 通过、0 失败、0 取消、32 条件跳过；跳过来自未设置 `ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE` 的既有可选登录浏览器测试 |
| `node --test tests/makersuite-browser.test.js tests/makersuite-transport-browser.test.js tests/makersuite-bridge.test.js` | 24 通过、0 失败、1 条件跳过（61 秒用例另行执行）                                                                                                  |
| `npm run test:transport:long`                                                                                             | 2 通过、0 失败、0 跳过；真实 TLS GenerateContent 等待 **61027 ms**，包含新 proof、权益、原始 legacy query 编码与取消回归                          |
| `npm run build:ui`                                                                                                        | 管理界面和公示页构建通过；仅有已有的 Vite CJS / bundle 大小提示                                                                                   |
| 改动 `.js` / `.vue` ESLint                                                                                                | 通过                                                                                                                                              |
| 改动文件 Prettier，使用 `--ignore-unknown`                                                                                | 通过；`.env.example` 无 parser，另经 diff 检查                                                                                                    |
| `git diff --check`                                                                                                        | 通过                                                                                                                                              |
| 生产 Camoufox / Google / NewAPI / 实例切换                                                                                | 未执行，不作为通过结论                                                                                                                            |
| commit / push                                                                                                             | 未执行；修改保留在开发分支工作树                                                                                                                  |

补充修复：本地取消标记通过原始 query 字符串追加与移除，避免 URLSearchParams 将 legacy URL 中的 `%20`、`%2f`、`~` 重编码。TLS peer 对带这些字符的真实出站 query 做了逐字检查。
