# anti 模型错误码与错误信息透传修改方案

状态：代码已实施，隔离验证结果见 [实施记录](anti-truncation-implementation.md)。未部署，真实 Gemini、NewAPI/SillyTavern 链路尚未验收。下文保留修改要求及验收标准，便于后续维护。

## 目标与范围

下游使用 `anti-` 前缀的 OpenAI Chat Completions 模型时，上游失败应返回上游提供的错误码和错误信息，不再统一替换成 `Upstream or anti-truncation protocol failure`。

重点覆盖 `anti-模型名-early` 且 `stream: true` 的请求，同时保证 anti 的 real、fake 和非流式请求使用一致的错误信息规则。覆盖 legacy 与模型感知调度两条路径。

本次透传指保留错误字段的值，并转换成现有 OpenAI 错误对象；不是将任意上游响应体直接作为下游响应。重试策略、账号选择和成功响应格式继续沿用现有逻辑。经过允许的重试后仍失败，应返回最后一次实际失败的错误；如果重试因本地调度或超时失败而终止，则返回该终止错误，不伪装成上游业务错误。

## 修改前的问题

1. `src/core/AntiTruncation.js` 的 `Attempt.restore()` 遇到 `response.error` 时，将其转换为 `upstream_error`，message 固定为 `Upstream generation failed`。此时原始 message 已丢失。
2. `src/core/RequestHandler.js` 的 `_handleRequestError()` 只要发现 `res.__antiAttempt`，就将 message 替换为 `Upstream or anti-truncation protocol failure`，流内错误还会增加 `Processing failed:` 等前缀。
3. 同一文件的 `_sendErrorResponse()` 也会按 `res.__antiAttempt` 强制替换 message。
4. `_sendErrorResponse()` 和 `_sendErrorChunkToClient()` 当前把 HTTP 状态作为 OpenAI `error.code`，无法独立保留上游字符串业务错误码。
5. `src/core/ScheduledRequestHandler.js` 重写了 `_sendErrorResponse()`。已经发送响应头时直接调用 `_sendErrorChunkToClient()`，需要与基类一起调整，否则不同调度路径可能返回不同结果。

现有文档要求协议失败使用安全信息，以避免输出内部工具名和完整正文。当前实现把此规则扩大到了所有 anti 请求的错误，连普通上游业务错误也被覆盖。本方案取消这种按请求模式统一覆盖的行为。

## 错误字段约定

后续实现应在错误进入代理时统一提取字段，并贯穿解析、重试和最终发送，避免只修改出口但入口已经丢失信息。

| 字段                 | 要求                                                         |
| -------------------- | ------------------------------------------------------------ |
| HTTP 状态            | 独立保存；仅合法的 400–599 整数可用作失败响应状态            |
| 下游 `error.code`    | 保留上游提供的字符串或数字错误码，不强制转为数字             |
| 下游 `error.message` | 保留上游提供的非空字符串，不增加代理前缀，不因 anti 模式覆盖 |
| 下游 `error.type`    | 上游提供有效字符串时保留，否则使用现有按协议和状态推导的类型 |
| 上游其他字段         | 本次不要求完整透传，不展开任意对象、原始响应体或异常堆栈     |

建议内部使用独立属性，例如 `status` 表示 HTTP 状态，`upstreamCode` 表示原始业务错误码，`upstreamError` 保存提取后的错误字段。现有内部 `error.code` 还用于 `QUEUE_TIMEOUT`、连接错误和 anti 协议分类，不能直接被业务码覆盖而改变重试判断。最终属性名可按项目惯例确定，但这些语义必须分开。

字段选择规则：

1. 对明确的上游错误对象，优先读取其 `error.code`、`error.message`、`error.type`；浏览器队列传来的错误则在入口保留相应字段。不得把 `event_type: "error"` 当作业务错误类型。
2. HTTP 状态优先使用实际失败的上游 HTTP 状态；没有可用状态时，可使用上游错误对象中的合法数字 HTTP 错误码；仍不可用则上游失败回退为 502。
3. 上游没有有效业务错误码时，下游 `error.code` 回退为已归一化的 HTTP 状态。字符串业务码即使类似数字，也保留原始字符串类型。
4. 上游没有有效 message 时，才使用明确的回退信息，如 `Upstream generation failed`。不得把对象转换成 `[object Object]`，也不得用完整原始响应体作为回退信息。
5. 本地超时、断连及 anti 解码/协议错误没有上游业务错误对象时，返回其现有明确错误信息和内部错误码，例如 `anti_truncation_incomplete_stream`。这些错误继续使用现有的 502、503、504 等状态规则。
6. 对确需隐藏的内部数据，在错误产生位置构造不包含内部工具名、参数和正文片段的 message。不得再次以 `res.__antiAttempt` 为条件覆盖所有错误。

## early 流式行为

`early` 完成本地准入后已发送 HTTP 200 和空首块。发生上游错误时，HTTP 状态不能再修改，应在 SSE 事件中返回错误码和错误信息：

```text
data: {"error":{"code":429,"message":"Resource exhausted. Please try again later.","type":"api_error"}}

```

上述 message 为示例；实际返回上游提供的文本。如果上游提供字符串业务码，应保留：

```text
data: {"error":{"code":"RESOURCE_EXHAUSTED","message":"Quota exceeded for this model.","type":"api_error"}}

```

具体要求：

- 对上游业务错误，不能添加 `Processing failed:`、`Proxy error:` 等前缀，也不能替换为 anti 通用提示。
- 终止请求时停止保活，发送并 flush 错误事件，然后关闭连接。
- 不发送成功结束块或成功 `[DONE]`。
- 空首块及心跳仍不视为模型实际输出；原有允许的重试继续执行，不能把每次可重试失败都提前发送到下游。
- 已交付实际模型内容后仍遵循现有禁止重放的规则。最终失败通过流内错误结束，不拼接第二次生成的内容。
- 客户端已经断开时只执行现有清理，不再尝试写入错误事件。

非流式或尚未发送响应头时，返回归一化的 HTTP 错误状态及同样的 OpenAI `error` 对象。HTTP 状态与 `error.code` 可以不同，例如 HTTP 429 对应业务码 `RESOURCE_EXHAUSTED`。

## 建议修改位置

### 1. 上游错误入口与 anti 还原器

修改 `src/core/AntiTruncation.js` 的 `Attempt.restore()`：识别 `response.error` 时保留原始 code、message、type，并单独归一化 HTTP 状态，替代当前只保留数字 code、丢弃 message 的处理。

检查 `scripts/client/build.js`、浏览器转发和消息队列的错误生产路径，以及 `RequestHandler` 的首个响应、缓冲读取和重试返回路径。确认 HTTP 失败和 HTTP 200 内嵌错误均能到达统一错误处理，不在入口或重试期间丢弃业务字段。上游非 JSON 错误体走已有错误提取逻辑，不原样输出完整 HTML。

### 2. 统一发送逻辑

修改 `src/core/RequestHandler.js`：

- `_handleRequestError()`：取消 anti 条件下的 message 覆盖；明确上游错误与本地错误，避免对上游 message 增加前缀。
- `_sendErrorResponse()`：取消 anti 条件下的 message 覆盖；支持 HTTP 状态与下游业务错误码分别传递。
- `_sendErrorChunkToClient()`：支持独立的业务错误码，并与非流式出口采用同一字段选择规则。
- 检查所有调用点，尤其是仅传递 `status` 和 `message` 的路径，补充业务码及 type 的传递，避免中途降级丢失字段。
- 请求统计、错误分类和重试仍使用归一化 HTTP 状态及内部分类字段，不用字符串业务码代替状态。

可引入统一错误归一化辅助方法，再让 JSON 与 SSE 出口复用。不要为 anti 或 early 创建第二套重试循环。

### 3. 模型感知调度

同步修改 `src/core/ScheduledRequestHandler.js` 中 `_sendErrorResponse()` 的覆盖实现，以及错误包装、重试终止和异常捕获路径，保留新增字段。验证调度器的 failure 分类、账号冷却和指标仍依据正确状态执行。

### 4. 文档更新

实现完成后，更新 `docs/zh/anti-truncation.md` 关于错误安全信息的约定，明确上游 code/message 透传，本地协议错误在产生位置控制内容。同步更新 `docs/zh/early-empty-chunk-streaming.md` 的流内错误说明，并在实施记录中注明验证范围及真实下游验收情况。

## 验收用例

| 场景                                      | 预期                                                         |
| ----------------------------------------- | ------------------------------------------------------------ |
| anti + early，上游 HTTP 429，重试最终失败 | HTTP 保持 200；SSE 保留最终错误 code/message；无成功 DONE    |
| anti + early，上游 HTTP 403 或 500        | 使用同一透传规则，不被 anti 通用提示覆盖                     |
| 上游 HTTP 200，正文含 `error` 对象        | anti 还原器抛出的错误仍保留原始 code/message/type            |
| 上游 code 为 `RESOURCE_EXHAUSTED`         | 下游保留字符串业务码；HTTP 状态仍使用独立的合法状态          |
| 上游 message 含中文、引号、换行           | JSON 序列化后能准确还原原文，不手工拼接 JSON                 |
| 上游缺少 code/message 或字段类型无效      | 使用明确的回退值，不返回 undefined、NaN 或对象字符串         |
| anti real、fake、非流式                   | 与 early 使用相同错误字段规则；HTTP 状态符合是否已发头的约束 |
| legacy 与模型感知调度                     | 相同输入错误返回相同 code/message/type                       |
| 429 后重试成功                            | 下游没有中间错误事件，只收到最终成功响应                     |
| 上游失败后，本地调度超时终止重试          | 返回实际终止错误，保留本地超时分类                           |
| anti 解码失败、超限、缺少 finish          | 返回具体本地错误码和安全 message，不暴露工具参数或正文       |
| 客户端断连                                | 清理保活和上游请求，不继续发送错误                           |
| 普通无 anti 请求                          | 成功路径不变；共享错误出口的改动不破坏既有错误分类           |

在 `tests/anti-truncation.test.js` 增加对上游 code/message/type 的明确断言，当前仅检查 status 的用例不足以验证透传。在 `tests/scheduled-request.test.js` 补充 early 流内错误及两类调度路径的验证，并覆盖非流式 HTTP 状态与业务码不同的情况。

实施后执行相关测试和项目要求的检查。最后分别通过直连、NewAPI、SillyTavern 验证流内错误的显示与识别；记录下游版本及实际接收事件。代理发出 SSE 错误不等于所有下游界面都会显示该错误，需要分别验收。

## 完成标准

上游错误信息从入口到最终 JSON/SSE 出口均未因 anti 模式丢失；业务错误码与 HTTP 状态分别保留；没有通用 anti 提示覆盖正常上游业务错误；legacy、模型感知调度和各响应模式的相关测试通过，文档同步更新。
