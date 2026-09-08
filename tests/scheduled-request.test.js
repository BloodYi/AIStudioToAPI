const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
class Response extends EventEmitter {
    constructor() {
        super();
        this.statusCode = 200;
        this.body = "";
        this.headersSent = false;
        this.writableEnded = false;
        this.writableFinished = false;
        this.destroyed = false;
        this.socket = { destroyed: false, writable: true };
    }
    status(status) {
        this.statusCode = status;
        return this;
    }
    set() {
        return this;
    }
    get() {
        return "application/json";
    }
    getHeader() {
        return "application/json";
    }
    setHeader() {
        return this;
    }
    type() {
        return this;
    }
    write(value) {
        this.headersSent = true;
        this.body += value;
        return true;
    }
    end(value = "") {
        this.body += value;
        this.headersSent = true;
        this.writableEnded = true;
        this.writableFinished = true;
        this.emit("finish");
    }
    send(value) {
        this.end(value);
        return this;
    }
    json(value) {
        return this.send(JSON.stringify(value));
    }
}
function setup(reply, overrides = {}) {
    const config = {
        fakeStreamTimeoutMs: 100,
        immediateSwitchStatusCodes: [429, 503],
        maxRetries: 3,
        retryDelay: 1,
        streamingMode: "real",
        streamTimeoutMs: 100,
        ...overrides,
    };
    const auth = {
        accountNameMap: new Map(),
        availableIndices: [0, 1, 2, 3],
        getRotationIndices() {
            return this.availableIndices;
        },
    };
    const scheduler = new ModelScheduler(
        { ...loadConfig({ MAX_BROWSER_WORKERS: "4" }), statePath: null, ...overrides.scheduler },
        auth,
        logger
    );
    const registry = new ConnectionRegistry(logger);
    const sent = [];
    const browser = { currentAuthIndex: 99, async ensureWorkerContext() {}, notifyUserActivity() {} };
    for (const index of auth.availableIndices)
        registry.connectionsByAuth.set(index, {
            readyState: 1,
            send(raw) {
                const request = JSON.parse(raw);
                if (request.event_type !== "proxy_request") return;
                sent.push({ index, request });
                const messages = reply(index, request);
                setImmediate(() => {
                    for (const message of messages)
                        registry._handleIncomingMessage(
                            JSON.stringify({
                                ...message,
                                request_attempt_id: request.request_attempt_id,
                                request_id: request.request_id,
                            }),
                            index
                        );
                });
            },
        });
    const system = { config, scheduler, webRoutes: { authRoutes: { getClientIP: () => "test" } } };
    const handler = new RequestHandler(system, registry, logger, browser, config, auth);
    return { browser, handler, registry, scheduler, sent };
}
const success = [
    { event_type: "response_headers", headers: { "content-type": "application/json" }, status: 200 },
    {
        data: JSON.stringify({
            candidates: [{ content: { parts: [{ text: "hello" }], role: "model" }, finishReason: "STOP" }],
            usageMetadata: { candidatesTokenCount: 1, promptTokenCount: 1, totalTokenCount: 2 },
        }),
        event_type: "chunk",
    },
    { event_type: "stream_close" },
];
function request(model = "flash", stream = false, path = "/v1/chat/completions") {
    const body = { max_tokens: 20, messages: [{ content: "hi", role: "user" }], model, stream };
    return {
        body,
        headers: { "content-type": "application/json" },
        method: "POST",
        path,
        query: {},
        rawBody: Buffer.from(JSON.stringify(body)),
    };
}
for (const stream of [false, true]) {
    test(`OpenAI ${stream ? "real stream" : "buffered"} retries quota on another account and keeps global account unchanged`, async () => {
        const fixture = setup(index =>
            index === 0 ? [{ event_type: "error", message: "quota", status: 429 }] : success
        );
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("flash-high-real-search", stream), res);
        assert.equal(res.statusCode, 200, res.body);
        assert.match(res.body, /hello/);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 1]
        );
        assert.ok(fixture.sent.every(entry => entry.request.path.includes("/flash:")));
        assert.equal(fixture.scheduler.account(0).models.flash.rate_limited, true);
        assert.equal(fixture.scheduler.account(1).models.flash.success_count, 1);
        assert.equal(fixture.browser.currentAuthIndex, 99);
        assert.equal(fixture.scheduler.snapshot().active_workers, 0);
        fixture.scheduler.close();
    });
}

test("retry budget is enforced for real streaming, with no repeated account", async () => {
    const fixture = setup(() => [{ event_type: "error", message: "quota", status: 429 }], {
        scheduler: { maxRetries: 1 },
    });
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("a", true), res);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.equal(res.statusCode, 429);
    assert.equal(fixture.scheduler.snapshot().active_workers, 0);
    fixture.scheduler.close();
});

test("late streaming errors mark the actual model status without replaying output", async () => {
    const fixture = setup(() => [success[0], success[1], { event_type: "error", message: "late quota", status: 429 }]);
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("a", true), res);
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /hello/);
    assert.equal(fixture.scheduler.account(0).models.a.rate_limited, true);
    assert.equal(fixture.scheduler.account(0).models.a.success_count, 0);
    fixture.scheduler.close();
});

test("concurrent HTTP handlers never share request-local account state", async () => {
    const fixture = setup(() => success);
    const responses = Array.from({ length: 4 }, () => new Response());
    await Promise.all(responses.map((res, i) => fixture.handler.processOpenAIRequest(request(i % 2 ? "a" : "b"), res)));
    assert.equal(new Set(fixture.sent.map(entry => entry.index)).size, 4);
    assert.ok(responses.every(res => res.statusCode === 200 && res.body.includes("hello")));
    assert.equal(fixture.registry.messageQueues.size, 0);
    fixture.scheduler.close();
});

test("Claude and Gemini preserve streaming and non-streaming conversion", async () => {
    for (const stream of [false, true]) {
        for (const method of ["processClaudeRequest", "processRequest", "processOpenAIResponseRequest"]) {
            const fixture = setup(() => success);
            const req = request("a", stream);
            if (method === "processRequest") {
                req.path = `/v1beta/models/a:${stream ? "streamGenerateContent" : "generateContent"}`;
                req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                req.rawBody = Buffer.from(JSON.stringify(req.body));
            }
            if (method === "processOpenAIResponseRequest") req.body.input = "hi";
            const res = new Response();
            await fixture.handler[method](req, res);
            assert.equal(res.statusCode, 200, `${method}: ${res.body}`);
            assert.match(res.body, /hello/);
            assert.equal(fixture.scheduler.snapshot().active_workers, 0);
            fixture.scheduler.close();
        }
    }
});

test("client disconnect while queued is removed without upstream work", async () => {
    const fixture = setup(() => success, { scheduler: { globalConcurrency: 1 } });
    const blocker = await fixture.scheduler.acquire("a");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a"), res);
    await new Promise(resolve => setImmediate(resolve));
    res.destroyed = true;
    res.emit("close");
    await running;
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.scheduler.pending.length, 0);
    fixture.scheduler.release(blocker);
    fixture.scheduler.close();
});

test("count-token endpoints use bounded model-aware retries", async () => {
    for (const method of ["processClaudeCountTokens", "processOpenAIResponseInputTokens"]) {
        const fixture = setup(index =>
            index === 0
                ? [{ event_type: "error", message: "quota", status: 429 }]
                : [success[0], { data: '{"totalTokens":7}', event_type: "chunk" }, success[2]]
        );
        const req = request("a");
        req.body.input = "hi";
        const res = new Response();
        await fixture.handler[method](req, res);
        assert.equal(res.statusCode, 200, res.body);
        assert.match(res.body, /7/);
        assert.deepEqual(
            fixture.sent.map(entry => entry.index),
            [0, 1]
        );
        fixture.scheduler.close();
    }
});

test("file references keep their issuing account even when another account is less used", async () => {
    const fixture = setup(() => success);
    fixture.scheduler.fileAffinities.set("file:abc", "auth-2");
    const req = request("a");
    req.path = "/v1beta/models/a:generateContent";
    req.body = {
        contents: [
            {
                parts: [
                    {
                        fileData: {
                            fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc",
                            mimeType: "text/plain",
                        },
                    },
                ],
            },
        ],
    };
    req.rawBody = Buffer.from(JSON.stringify(req.body));
    const res = new Response();
    await fixture.handler.processRequest(req, res);
    assert.equal(res.statusCode, 200, res.body);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [2]
    );
    fixture.scheduler.close();
});

test("503 and model permissions retry but malformed client requests do not", async () => {
    for (const [status, message, expected] of [
        [503, "upstream", 2],
        [403, "PERMISSION_DENIED", 2],
        [400, "bad input", 1],
    ]) {
        const fixture = setup(index => (index === 0 ? [{ event_type: "error", message, status }] : success));
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("a", true), res);
        assert.equal(fixture.sent.length, expected);
        assert.equal(fixture.scheduler.account(0).healthy, true);
        fixture.scheduler.close();
    }
});

test("concurrent streams on one account keep request IDs and response queues isolated", async () => {
    const fixture = setup(
        (index, req) => [
            success[0],
            { ...success[1], data: success[1].data.replace("hello", req.request_id) },
            success[2],
        ],
        { scheduler: { globalConcurrency: 8, maxWorkers: 1 } }
    );
    const responses = Array.from({ length: 8 }, () => new Response());
    await Promise.all(responses.map(res => fixture.handler.processOpenAIRequest(request("a", true), res)));
    assert.equal(new Set(fixture.sent.map(entry => entry.index)).size, 1);
    assert.equal(new Set(fixture.sent.map(entry => entry.request.request_id)).size, 8);
    for (const { request: req } of fixture.sent) {
        assert.equal(responses.filter(res => res.body.includes(req.request_id)).length, 1);
    }
    assert.equal(fixture.registry.messageQueues.size, 0);
    assert.equal(fixture.scheduler.account(0).inflight, 0);
    assert.equal(fixture.scheduler.account(0).models.a.success_count, 8);
    fixture.scheduler.close();
});
