# 抗截断集成实施与验证记录

日期：2026-10-12（Asia/Shanghai）。依据外部项目 BUILD_ANTI_TRUNCATION_INTEGRATION.md 实施。

## 基线

| 项目                | Git HEAD                                 | 初始工作区 |
| ------------------- | ---------------------------------------- | ---------- |
| AIStudioToAPI       | 5770e83c95b711355e05f7321e19d9583144b57a | clean      |
| Antigravity-gateway | 882305ef40092537297d441ff0f0c37a3acc6643 | clean      |

本地 package.json 版本 1.3.7。生产镜像版本未核对，未执行部署或修改运行容器。网关参考算法采用 MIT，版权与许可原文保存于 docs/licenses/antigravity-gateway-MIT.txt，并由 Dockerfile 复制入镜像。项目原有许可证保持不变。

## 改造范围

- 新增 AntiTruncation 策略、随机注入、Gemini 结构化还原、有限修复、SSE 网络事件组装、choice 隔离和资源上限。
- FormatConverter 提供统一 anti 前缀解析，ModelScheduler 复用解析；RequestHandler 在准入、fake/early/real/非流式输出及重试尝试更新处接入。
- ScheduledRequestHandler 区分上游开始与客户端正文开始，限制已开始生成后的账号重试；取消和清理复用既有机制。
- 配置 definitions 与 ConfigLoader 支持持久化、校验、热更新、重置及启动参数；原配置页面根据 definitions 自动显示新项。
- 响应的真实工具 ID、推理、usage、length、安全拒绝均保留；没有移植网关错误事件忽略或 EOF 补成功 DONE 的行为。

## 验证命令与结果

| 命令                                                                                                                               | 结果                                                                     |
| ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `node --test tests/anti-truncation.test.js tests/scheduled-request.test.js tests/unified-configuration.test.js`                    | 75/75 通过，涵盖原有回归与新增行为                                   |
| `npm test`                                                                                                                         | 全部现有测试命令通过；可选真实浏览器测试按原测试条件跳过，未视为实测通过 |
| `npm run lint`                                                                                                                     | 通过；StatusPage.vue 原有 vue/no-v-html 警告 1 条                        |
| `npm run build:ui`                                                                                                                 | 管理 UI 和公开 UI 构建通过；Vite 原有 CJS/产物尺寸提示                   |
| `git diff --check`                                                                                                                 | 通过                                                                     |
| `ANTI_TEST_DELAY_MS=120000 node --test --test-name-pattern='anti early HTTP client receives live' tests/scheduled-request.test.js` | 1/1 通过，真实本地 HTTP 客户端验证                                       |

120 秒测试使用模拟 Gemini 上游和实际 Express/HTTP/fetch，客户端首批事件 29 ms 到达，共读取 121 批网络数据，等待阶段空事件持续到达，间隔断言 < 2 秒，最终只出现一次 DONE。该数据是客户端读到时间，不是服务端 write 日志；不能代表公网代理表现。

新增自动化覆盖策略优先级/总开关/非法字段/嵌套别名、模型修饰符和名单、配置保存重载重置、无工具/none/required/强制真实工具、正文冲突/SideBuffer=0 与非零、真实工具连续索引与 ID、推理/usage、多个 choice、Unicode/JSON 转义跨网络片段、有界修复和失败、真实模型调度、early 后 429 换账号且随机名称重建、流内错误和缺失 finish 无成功 DONE、取消清理、并发隔离、背压以及 early 客户端事件实际到达。

## 待完成的外部验收

未使用生产凭据或聊天记录。以下事项依赖真实部署与外部服务，本次没有完成，不能据此宣称生产已验收：

- 对上述各模型通过真实 Gemini/Build 浏览器采集函数参数形态，验证真实工具 auto/none/required 和推理。
- 使用同一模拟输入对照独立 Go 网关与集成版本的实际 HTTP 输出；本次使用其已阅读算法语义建立 JS 对照断言，未运行独立 Go 服务的端到端对照。
- 直连隔离部署、NewAPI、SillyTavern、实际公网入口分别执行 120 秒等待、429/超时/解析失败/断连与渠道错误识别测试。
- Docker 候选镜像构建及启动验收、核对生产镜像提交、灰度切换和两级回退演练。
- 并发性能基准：本次测试验证资源释放与隔离，尚未形成 CPU/内存峰值、TTFT、吞吐量与公网延迟测量报告。
- 搜索/代码执行/URL context 的真实模型能力矩阵；目前这些组合主动拒绝显式 anti 或跳过 prefer。

配置、请求格式、限制及上线步骤见 [使用说明](anti-truncation.md)。

## 错误透传修改（2026-10-12）

已按 [错误透传方案](anti-truncation-error-passthrough-plan.md) 修改运行代码，尚未部署。

- 浏览器读取 HTTP 失败响应时提取结构化上游错误，通过队列保留 code、message 和有效 type；不再将完整响应体拼进带代理前缀的 message。非 JSON 错误页面及无效字段使用明确回退信息。
- anti 还原器保留 HTTP 200 正文内嵌错误的业务字段。HTTP 状态与业务错误码分别保存，字符串业务码保持原始类型；内部分类仍使用独立的 `upstream_error`。
- JSON 与 SSE 错误出口复用归一化规则，取消按 anti 请求统一覆盖 message 的行为。覆盖 legacy、模型感知调度以及非流式、fake、early、real；early 已发出的 HTTP 200 保持不变，最终错误通过 SSE 返回并 flush、结束，不发送成功 DONE。
- 本地 anti 解码、协议和超限错误返回具体内部错误码；缓冲 JSON 解析失败在产生位置使用安全信息，避免 SyntaxError 携带正文片段。重试账号选择失败返回实际终止错误。
- 浏览器错误结构变化后，调度器通过结构化 Google `UNAUTHENTICATED` 状态保留会话过期处理和旧会话响应保护，同时兼容原有错误格式。

验证结果：`npm test` 全部测试命令通过，可选真实浏览器用例按现有条件跳过；`npm run lint` 通过。最后补充缺失/无效字段、统计状态和本地协议错误码断言后，`node tests/scheduled-request.test.js` 再次通过（53/53），相关文件 ESLint 检查通过。浏览器入口通过 VM 执行真实客户端代码、模拟 fetch 验证，真实本地 HTTP 测试通过；这些结果不代表真实 Gemini 或公网下游已经验收。

本次只修改代码、测试和文档，没有构建部署镜像、重启服务或更改运行容器。真实 Gemini、NewAPI、SillyTavern 的错误显示、识别及渠道处理仍属于上文的外部验收事项。
