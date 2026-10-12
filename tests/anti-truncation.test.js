const { test } = require("node:test");
const assert = require("node:assert/strict");
const { Attempt, decode, identity, inject, resolve, MAX_BYTES, TEXT_MODELS } = require("../src/core/AntiTruncation");
const FormatConverter = require("../src/core/FormatConverter");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const converter = new FormatConverter(logger, { config: {} });
const model = "gemini-2.5-flash";
const response = (parts, finishReason = "STOP", index = 0) => ({
    candidates: [{ content: { parts }, finishReason, index }],
});
const synthetic = content => ({ functionCall: { args: { content }, name: "synthetic" } });
const events = output =>
    output
        .split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)));

test("policy precedence, canonical identity, disabled switch and protocol admission", () => {
    assert.equal(resolve({ model }, {}).enabled, false);
    assert.equal(resolve({ model: `anti-${model}` }, {}).enabled, true);
    assert.equal(resolve({ anti_truncation: false, model: `anti-${model}` }, {}).enabled, false);
    assert.equal(resolve({ model }, { antiTruncationDefault: "prefer" }).enabled, true);
    assert.equal(resolve({ anti_truncation: false, model }, { antiTruncationDefault: "prefer" }).enabled, false);
    assert.equal(resolve({ model }, { antiTruncationDefault: "prefer", antiTruncationEnabled: false }).enabled, false);
    for (const name of ["anti-", `anti-anti-${model}`]) assert.throws(() => identity(name), { status: 400 });
    for (const value of [null, "true", 1, {}])
        assert.throws(() => resolve({ anti_truncation: value, model }, {}), { status: 400 });
    assert.throws(() => resolve({ model: `anti-${model}` }, { antiTruncationEnabled: false }), {
        code: "anti_truncation_disabled",
    });
    for (const protocol of ["gemini", "claude", "response_api", "embedding"]) {
        assert.throws(() => resolve({ model: `anti-${model}` }, {}, protocol), { status: 400 });
        assert.equal(resolve({ model }, { antiTruncationDefault: "prefer" }, protocol).enabled, false);
    }
    const parsed = identity(`models/AnTi-${model}(minimal)-EARLY-search-code`);
    assert.equal(parsed.realModel, model);
    assert.equal(parsed.streamingMode, "early");
    assert.equal(parsed.forceCodeExecution, true);
    assert.equal(identity("anti-Gemini-2.5-Flash-real").realModel, "Gemini-2.5-Flash");
});

test("capability matrix excludes multimodal, hosted tools and unknown models", () => {
    for (const body of [
        { model: "anti-gemini-2.5-flash-preview-tts" },
        { model: `anti-${model}-search` },
        { model: `anti-${model}`, tools: [{ type: "google_search" }] },
        { modalities: ["audio"], model: `anti-${model}` },
        { messages: [{ content: [{ type: "image_url" }] }], model: `anti-${model}` },
        { model: `anti-${model}`, response_format: { type: "json_object" } },
    ])
        assert.throws(() => resolve(body, {}), { status: 400 });
    assert.equal(
        resolve({ model: `anti-${model}`, tool_choice: { function: { name: "weather" }, type: "function" } }, {})
            .reason,
        "forced_real_tool"
    );
});

test("injection is immutable, unique per attempt, closes assistant turn and respects none/required", async () => {
    const tool = { function: { name: "weather", parameters: { type: "object" } }, type: "function" };
    const baseline = {
        anti_truncation: true,
        messages: [{ content: "prefill", role: "assistant" }],
        model,
        tools: [tool],
    };
    const before = structuredClone(baseline);
    const first = inject(baseline),
        second = inject(baseline);
    assert.deepEqual(baseline, before);
    assert.match(first.name, /^agw_emit_[a-f0-9]{24}$/);
    assert.notEqual(first.name, second.name);
    assert.equal(first.body.tools.length, 2);
    assert.deepEqual(first.body.tools[0], tool);
    assert.equal(first.body.messages.at(-1).role, "user");
    assert.equal(first.body.anti_truncation, undefined);
    const none = inject({ ...baseline, tool_choice: "none" });
    const translated = await converter.translateOpenAIToGoogle(none.body);
    assert.equal(translated.googleRequest.tools[0].functionDeclarations.length, 1);
    assert.deepEqual(translated.googleRequest.toolConfig.functionCallingConfig, {
        allowedFunctionNames: [none.name],
        mode: "ANY",
    });
    assert.equal(inject({ ...baseline, tool_choice: "required" }).body.tool_choice, "required");
});

test("bounded deterministic repairs preserve received Unicode and reject invalid schemas/escapes", () => {
    assert.deepEqual(decode({ content: "中文😀\n\\" }), { content: "中文😀\n\\", repaired: false });
    assert.equal(decode('```json\n{"content":"ok"}\n```').content, "ok");
    assert.equal(decode('{"content":"\\uD83D\\uDE00').content, "😀");
    assert.equal(decode('{"content":"partial"').content, "partial");
    for (const args of [null, {}, { content: 1 }, '{"content":"bad\\u12', '{"content":"bad\\', '{"text":"answer"}'])
        assert.throws(() => decode(args), { status: 502 });
    assert.throws(() => decode({ content: "x".repeat(MAX_BYTES) }), { code: "anti_truncation_limit" });
});

test("buffered and real restoration preserve text, reasoning, tools, token usage and finish reasons", () => {
    const input = response([
        { text: "discard" },
        { text: "reason", thought: true },
        synthetic("中文😀"),
        { functionCall: { args: { city: "上海" }, id: "call_preserved", name: "weather" } },
    ]);
    input.usageMetadata = { candidatesTokenCount: 30, promptTokenCount: 20, totalTokenCount: 50 };
    const non = new Attempt("synthetic").nonStream(input, converter, model);
    const stream = new Attempt("synthetic");
    const shared = {};
    const chunks = events(stream.stream(input, converter, model, shared, true) + stream.usageEvent(shared));
    assert.equal(non.choices[0].message.content, "中文😀");
    assert.equal(chunks.map(chunk => chunk.choices[0]?.delta.content || "").join(""), non.choices[0].message.content);
    assert.equal(non.choices[0].message.reasoning_content, "reason");
    assert.equal(non.choices[0].message.tool_calls[0].function.name, "weather");
    assert.equal(non.choices[0].message.tool_calls[0].index, 0);
    assert.equal(non.choices[0].message.tool_calls[0].id, "call_preserved");
    assert.equal(chunks.find(chunk => chunk.choices[0]?.delta.tool_calls)?.choices[0].delta.tool_calls[0].index, 0);
    assert.equal(non.choices[0].finish_reason, "tool_calls");
    assert.equal(chunks.filter(chunk => chunk.usage).length, 1);
    assert.deepEqual(chunks.at(-1).usage, non.usage);
    assert.equal(stream.usageEvent(shared), "");
    for (const reason of ["STOP", "MAX_TOKENS", "SAFETY"]) {
        const result = new Attempt("synthetic").nonStream(response([synthetic("partial")], reason), converter, model);
        assert.equal(result.choices[0].finish_reason, converter._mapFinishReason(reason));
    }
});

test("each choice isolates source conflicts, real-tool indices and role; side buffers have explicit latency", () => {
    for (const limit of [0, 100]) {
        const attempt = new Attempt("synthetic", () => {}, limit);
        const first = attempt.restore(response([{ text: "prior" }], undefined));
        // response helper defaults STOP for undefined, use an explicit missing field instead.
        assert.equal(first.candidates[0].content.parts.map(part => part.text).join(""), "prior");
        const stream = new Attempt("synthetic", () => {}, limit);
        const state = {};
        const initial = response([{ text: "prior" }]);
        delete initial.candidates[0].finishReason;
        const before = events(stream.stream(initial, converter, model, state));
        const later = events(
            stream.stream(response([synthetic("answer"), { text: "after" }]), converter, model, state)
        );
        assert.equal(before.map(e => e.choices[0].delta.content || "").join(""), limit ? "" : "prior");
        assert.equal(later.map(e => e.choices[0].delta.content || "").join(""), "answer");
    }
    const stream = new Attempt("synthetic");
    const input = {
        candidates: [
            response([synthetic("one")], "STOP", 0).candidates[0],
            response([{ text: "two" }], "STOP", 1).candidates[0],
        ],
    };
    const chunks = events(stream.stream(input, converter, model, {}));
    assert.deepEqual(
        chunks.filter(e => e.choices[0].delta.role).map(e => e.choices[0].index),
        [0, 1]
    );
    stream.assertComplete();
});

test("transport assembler handles every JSON/Unicode/escape boundary, mixed usage, comments and EOF errors", () => {
    const input = response([synthetic('中😀\n"\\')]);
    const raw = `: ping\r\n\r\ndata: ${JSON.stringify(input)}\r\n\r\ndata: ${JSON.stringify({ usageMetadata: { totalTokenCount: 10 } })}\n\n`;
    for (let split = 1; split < raw.length; split++) {
        const attempt = new Attempt("synthetic");
        const parsed = [...attempt.read(raw.slice(0, split)), ...attempt.read(raw.slice(split))];
        assert.deepEqual(parsed, [input, { usageMetadata: { totalTokenCount: 10 } }]);
    }
    const attempt = new Attempt("synthetic");
    assert.deepEqual(attempt.read('data: {"candidates":'), []);
    assert.throws(() => attempt.read("", true), { status: 502 });
    assert.throws(() => new Attempt("synthetic").read("x".repeat(MAX_BYTES + 1)), { status: 502 });
    assert.throws(() => new Attempt("synthetic").nonStream(response([synthetic("answer")], null), converter, model), {
        code: "anti_truncation_incomplete_stream",
    });
    assert.throws(() => new Attempt("synthetic").restore({ error: { code: 429, message: "private" } }), {
        status: 429,
    });
});

test("catalog text allowlist supports modifier parsing and Gemini injection in isolated conversion", async () => {
    for (const name of TEXT_MODELS) {
        const policy = resolve({ model: `anti-${name}-minimal-real` }, {});
        assert.equal(policy.enabled, true);
        assert.equal(policy.realModel, name);
        const injected = inject({ messages: [{ content: "test", role: "user" }], model: policy.model });
        const translated = await converter.translateOpenAIToGoogle(injected.body, { privateTransport: true });
        assert.equal(translated.cleanModelName, name);
        assert.equal(translated.modelStreamingMode, "real");
        assert.equal(translated.googleRequest.tools[0].functionDeclarations[0].name, injected.name);
        assert.equal(translated.googleRequest.contents.at(-1).role, "user");
    }
});

test("upstream safety block remains a safety finish and batch DONE does not duplicate output", () => {
    const blocked = new Attempt("synthetic").nonStream({ promptFeedback: { blockReason: "SAFETY" } }, converter, model);
    assert.equal(blocked.choices[0].finish_reason, "content_filter");
    const attempt = new Attempt("synthetic");
    const responses = attempt.read(`data: ${JSON.stringify(response([synthetic("answer")]))}\n\ndata: [DONE]\n\n`);
    assert.equal(responses.length, 1);
    attempt.stream(responses[0], converter, model, {});
    attempt.assertComplete();
});
