const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const RequestHandler = require("../src/core/RequestHandler");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const StatusRoutes = require("../src/routes/StatusRoutes");
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

function setupSchedulerResetRoute(scheduler) {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => {
            if (method === "post") routes.set(route, handlers);
        };
    const serverSystem = { config: {}, distIndexPath: "", logger, scheduler };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);
    return async authenticated => {
        const handlers = routes.get("/api/scheduler/reset-all");
        const response = {
            body: null,
            json(body) {
                this.body = body;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        let index = 0;
        const next = () => handlers[++index]({ authenticated }, response, next);
        await handlers[0]({ authenticated }, response, next);
        return response;
    };
}

test("reset-all scheduler route enforces authentication and reports legacy and change counts", async () => {
    const reset = setupSchedulerResetRoute({
        resetAllAccounts: () => ({ reset_account_count: 2, reset_model_count: 3 }),
    });
    let response = await reset(false);
    assert.equal(response.statusCode, 401);
    assert.deepEqual(response.body, { error: "Unauthorized" });
    response = await reset(true);
    assert.equal(response.statusCode, 200);
    assert.deepEqual(response.body, {
        reset_account_count: 2,
        reset_model_count: 3,
        success: true,
    });

    response = await setupSchedulerResetRoute(null)(true);
    assert.equal(response.statusCode, 409);
    assert.deepEqual(response.body, { error: "Scheduler is in legacy mode" });

    response = await setupSchedulerResetRoute({
        resetAllAccounts: () => ({ reset_account_count: 0, reset_model_count: 0 }),
    })(true);
    assert.deepEqual(response.body, {
        reset_account_count: 0,
        reset_model_count: 0,
        success: true,
    });
});

test("disable scheduler route authenticates, validates IDs, and is idempotent", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => {
            if (method === "post") routes.set(route, handlers);
        };
    let disabled = false;
    const scheduler = {
        disable(index) {
            const changed = !disabled;
            disabled = true;
            return { account_id: index, changed, disabled: true };
        },
    };
    const serverSystem = {
        authSource: { availableIndices: [0] },
        config: {},
        distIndexPath: "",
        logger,
        scheduler,
    };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);
    const invoke = async (authenticated, body) => {
        const handlers = routes.get("/api/scheduler/disable");
        const response = new Response();
        response.body = null;
        response.json = value => {
            response.body = value;
            return response;
        };
        let index = 0;
        const next = () => handlers[++index]({ authenticated, body }, response, next);
        await handlers[0]({ authenticated, body }, response, next);
        return response;
    };
    assert.equal((await invoke(false, { account_id: 0 })).statusCode, 401);
    assert.equal((await invoke(true, {})).statusCode, 400);
    assert.equal((await invoke(true, { account_id: 9 })).statusCode, 400);
    assert.deepEqual((await invoke(true, { account_id: 0 })).body, {
        account_id: 0,
        changed: true,
        disabled: true,
        success: true,
    });
    assert.equal((await invoke(true, { account_id: 0 })).body.changed, false);
});

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
        assert.equal(fixture.scheduler.snapshot().models.find(model => model.model === "flash").daily_requests, 2);
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
    assert.equal(res.statusCode, 200);
    assert.match(res.body, /^: accepted/);
    assert.match(res.body, /"error"/);
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

test("pre-output connection loss migrates a stream after early headers", async () => {
    const fixture = setup(index => (index === 0 ? [success[0]] : success));
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    await new Promise(resolve => setImmediate(resolve));
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.match(res.body, /^: accepted/);
    assert.match(res.body, /hello/);
    assert.equal(fixture.scheduler.account(0).models.a.cooldown_until, 0);
    fixture.scheduler.close();
});

test("connection loss after model output sends an error without replaying", async () => {
    const fixture = setup(() => [success[0], success[1]]);
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    for (let i = 0; i < 5 && !res.body.includes("hello"); i++) {
        await new Promise(resolve => setImmediate(resolve));
    }
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.equal(fixture.sent.length, 1);
    assert.match(res.body, /hello/);
    assert.match(res.body, /Stream interrupted/);
    assert.equal(fixture.scheduler.account(0).models.a.cooldown_until, 0);
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

test("early streaming headers keep the connection alive while dispatch waits and clean up on disconnect", async () => {
    const fixture = setup(() => success, {
        scheduler: { globalConcurrency: 1, streamKeepaliveIntervalMs: 5 },
    });
    const blocker = await fixture.scheduler.acquire("a");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("a", true), res);
    await new Promise(resolve => setTimeout(resolve, 16));
    assert.match(res.body, /^: accepted\n\n/);
    assert.match(res.body, /: keep-alive/);
    res.destroyed = true;
    res.emit("close");
    await running;
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
        if (status === 403) {
            assert.equal(fixture.scheduler.account(0).models.a.unsupported, false);
            assert.ok(fixture.scheduler.account(0).models.a.cooldown_until > Date.now());
        }
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

test("hidden models reject every protocol before early stream headers or model discovery", async t => {
    const cases = [
        {
            body: { messages: [{ content: "hi", role: "user" }], model: "flash-high-real-search", stream: true },
            method: "processOpenAIRequest",
            path: "/v1/chat/completions",
        },
        {
            body: { input: "hi", model: "flash-high-real-code", stream: true },
            method: "processOpenAIResponseRequest",
            path: "/v1/responses",
        },
        {
            body: {
                max_tokens: 20,
                messages: [{ content: "hi", role: "user" }],
                model: "flash-high-real-search",
                stream: true,
            },
            method: "processClaudeRequest",
            path: "/v1/messages",
        },
        {
            body: { contents: [{ parts: [{ text: "hi" }], role: "user" }] },
            method: "processRequest",
            path: "/v1beta/models/flash-high-real-search:streamGenerateContent",
        },
        { body: { input: "hi", model: "flash" }, method: "processOpenAIEmbeddingsRequest", path: "/v1/embeddings" },
    ];
    for (const entry of cases)
        await t.test(entry.method, async () => {
            const fixture = setup(() => success, {
                scheduler: { allocation: { flash: { min: 0, preferred: 1 } }, streamEarlyHeaders: true },
            });
            fixture.scheduler.hideModel("flash");
            const res = new Response();
            const writes = [];
            const write = res.write.bind(res);
            res.write = value => {
                writes.push(value);
                return write(value);
            };
            const req = {
                ...request(),
                body: entry.body,
                path: entry.path,
                rawBody: Buffer.from(JSON.stringify(entry.body)),
            };
            await fixture.handler[entry.method](req, res);
            assert.equal(res.statusCode, 403, res.body);
            assert.deepEqual(writes, []);
            assert.deepEqual(fixture.sent, []);
            assert.equal(fixture.scheduler.pending.length, 0);
            assert.equal(
                [...fixture.scheduler.accounts.values()].some(account => Object.keys(account.models).length),
                false
            );
            fixture.scheduler.close();
        });
});

function completionChunks(res) {
    return res.body
        .split("\n")
        .filter(line => line.startsWith("data: {"))
        .map(line => JSON.parse(line.slice(6)));
}
function deliver(fixture, entry, messages) {
    for (const message of messages) {
        fixture.registry._handleIncomingMessage(
            JSON.stringify({
                ...message,
                request_attempt_id: entry.request.request_attempt_id,
                request_id: entry.request.request_id,
            }),
            entry.index
        );
    }
}
async function waitFor(predicate) {
    for (let i = 0; i < 100; i++) {
        if (predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 1));
    }
    assert.ok(predicate(), "condition was not reached");
}
function useLegacy(fixture) {
    delete fixture.handler.serverSystem.scheduler;
    fixture.handler.authSwitcher.currentAuthIndex = 0;
}

test("early sends one empty start before readiness/upstream completion in legacy and model modes", async t => {
    for (const legacy of [false, true])
        await t.test(legacy ? "legacy" : "model", async () => {
            const fixture = setup(() => [success[0]], {
                scheduler: { streamEarlyHeaders: false, streamKeepaliveIntervalMs: 5 },
                streamingMode: "early",
            });
            if (legacy) useLegacy(fixture);
            let releaseReady;
            const ready = new Promise(resolve => {
                releaseReady = resolve;
            });
            if (legacy) fixture.handler._ensureBrowserBackedRequestReady = () => ready;
            const res = new Response();
            const req = request("flash-high-early-search", true);
            req.body.stream_options = { include_usage: true };
            const running = fixture.handler.processOpenAIRequest(req, res);
            await waitFor(() => res.__streamStartSent);
            const start = completionChunks(res)[0];
            assert.deepEqual(start.choices, [
                { delta: { content: "", role: "assistant" }, finish_reason: null, index: 0 },
            ]);
            assert.equal(start.model, "flash");
            assert.equal(start.usage, undefined);
            assert.equal(res.__modelOutputStarted, false);
            assert.equal(res.body.includes("[DONE]"), false);
            if (legacy) {
                assert.equal(fixture.sent.length, 0);
                releaseReady(true);
            }
            await waitFor(() => fixture.sent.length === 1);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(fixture.sent[0].request.streaming_mode, "fake");
            assert.equal(fixture.sent[0].request.path, "/v1beta/models/flash:generateContent");
            // Headers alone do not stop waiting heartbeats or count as model output.
            assert.equal(completionChunks(res).length, 2);
            assert.deepEqual(completionChunks(res)[1].choices, [
                { delta: { content: "" }, finish_reason: null, index: 0 },
            ]);
            deliver(fixture, fixture.sent[0], success.slice(1));
            await running;
            const chunks = completionChunks(res);
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.role === "assistant").length, 1);
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "hello").length, 1);
            assert.ok(
                chunks.every(
                    chunk => chunk.id === start.id && chunk.created === start.created && chunk.model === start.model
                )
            );
            assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.finish_reason === "stop").length, 1);
            assert.equal(chunks.at(-1).usage.total_tokens, 2);
            assert.equal(res.body.split("data: [DONE]").length - 1, 1);
            const finalBody = res.body;
            await new Promise(resolve => setTimeout(resolve, 15));
            assert.equal(res.body, finalBody);
            assert.equal(fixture.registry.messageQueues.size, 0);
            assert.equal(fixture.scheduler.snapshot().active_workers, 0);
            fixture.scheduler.close();
        });
});

test("early start precedes account queue and uses one heartbeat timer that stops on disconnect", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(() => success, {
        scheduler: { globalConcurrency: 1, streamEarlyHeaders: false, streamKeepaliveIntervalMs: 5 },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const blocker = await fixture.scheduler.acquire("flash");
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.scheduler.pending.length, 1);
    assert.equal(completionChunks(res).length, 2);
    t.mock.timers.tick(1000);
    assert.equal(completionChunks(res).length, 3);
    assert.equal(fixture.sent.length, 0);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(fixture.scheduler.pending.length, 1);
    res.destroyed = true;
    res.emit("close");
    await running;
    assert.equal(fixture.scheduler.pending.length, 0);
    const body = res.body;
    t.mock.timers.tick(5000);
    assert.equal(res.body, body);
    fixture.scheduler.release(blocker);
});

test("early retries quota after start and preserves stream identity without duplicate starts", async t => {
    const fixture = setup(index => (index === 0 ? [{ event_type: "error", message: "quota", status: 429 }] : success), {
        scheduler: { streamEarlyHeaders: false },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    const chunks = completionChunks(res);
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "").length, 2);
    assert.equal(chunks.filter(chunk => chunk.choices?.[0]?.delta?.content === "hello").length, 1);
    assert.ok(chunks.every(chunk => chunk.id === chunks[0].id));
    assert.equal(chunks.at(-1).usage, undefined);
    assert.equal(res.__modelOutputStarted, true);
});

test("early resets buffered body when transport retry moves to another account", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const fixture = setup(
        index => (index === 0 ? [success[0], { data: '{"partial":', event_type: "chunk" }] : success),
        {
            fakeStreamTimeoutMs: 180000,
            scheduler: { streamEarlyHeaders: false },
            streamingMode: "early",
        }
    );
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.sent.length, 1);
    t.mock.timers.tick(1000);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
    fixture.registry.closeMessageQueuesForEpoch(0, 1, "connection_lost");
    await running;
    assert.deepEqual(
        fixture.sent.map(entry => entry.index),
        [0, 1]
    );
    assert.match(res.body, /hello/);
    assert.equal(completionChunks(res).filter(chunk => chunk.choices?.[0]?.delta?.content === "").length, 3);
    assert.equal(fixture.registry.messageQueues.size, 0);
});

test("early final failure is a stream error with original status and no success completion", async t => {
    const fixture = setup(() => [{ event_type: "error", message: "quota", status: 429 }], {
        scheduler: { maxRetries: 1, streamEarlyHeaders: false },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    const chunks = completionChunks(res);
    assert.equal(res.statusCode, 200);
    assert.equal(chunks[0].choices[0].delta.content, "");
    assert.equal(chunks.at(-1).error.code, 429);
    assert.equal(res.__modelOutputStarted, false);
    assert.equal(res.body.includes("[DONE]"), false);
    assert.equal(res.writableEnded, true);
    assert.equal(fixture.scheduler.snapshot().active_workers, 0);
});

test("early preserves HTTP admission errors before starting a stream", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    fixture.scheduler.config.allocation.flash = { min: 0, preferred: 1 };
    fixture.scheduler.hideModel("flash");
    for (const req of [
        request("flash-early-search", true),
        { ...request("other", true), body: { model: "other", stream: true } },
    ]) {
        const res = new Response();
        await fixture.handler.processOpenAIRequest(req, res);
        assert.ok([400, 403].includes(res.statusCode));
        assert.equal(res.__streamStartSent, undefined);
        assert.equal(res.body.includes("chat.completion.chunk"), false);
    }
    assert.equal(fixture.sent.length, 0);
});

test("early non-stream requests remain JSON and suffix overrides global mode", async () => {
    for (const [globalMode, model, stream, expected] of [
        ["early", "flash", false, null],
        ["early", "flash-fake", true, "fake"],
        ["early", "flash-real", true, "real"],
        ["real", "flash-EARLY", true, "early"],
    ]) {
        const fixture = setup(() => success, { scheduler: { streamEarlyHeaders: false }, streamingMode: globalMode });
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request(model, stream), res);
        assert.equal(Boolean(res.__streamStartSent), expected === "early");
        assert.equal(res.__proxyResponseStreamMode, expected);
        if (!stream) assert.equal(JSON.parse(res.body).choices[0].message.content, "hello");
        fixture.scheduler.close();
    }
});

test("other protocols fall back to fake for global early and early suffix", async () => {
    for (const method of ["processOpenAIResponseRequest", "processClaudeRequest", "processRequest"]) {
        for (const suffix of ["", "-early-search"]) {
            const fixture = setup(() => success, { scheduler: { streamEarlyHeaders: false }, streamingMode: "early" });
            const req = request(`flash${suffix}`, true);
            if (method === "processOpenAIResponseRequest") req.body.input = "hi";
            if (method === "processRequest") {
                req.path = `/v1beta/models/flash${suffix}:streamGenerateContent`;
                req.body = { contents: [{ parts: [{ text: "hi" }], role: "user" }] };
                req.rawBody = Buffer.from(JSON.stringify(req.body));
            }
            const res = new Response();
            await fixture.handler[method](req, res);
            assert.equal(res.__proxyResponseStreamMode, "fake", method);
            assert.equal(fixture.sent[0].request.streaming_mode, "fake", method);
            assert.equal(res.__streamStartSent, undefined, method);
            assert.equal(res.body.includes("chat.completion.chunk"), false, method);
            assert.match(res.body, /hello/);
            fixture.scheduler.close();
        }
    }
});

test("legacy cancellation stops readiness wait and never forwards upstream", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    useLegacy(fixture);
    let release;
    fixture.handler._ensureBrowserBackedRequestReady = () =>
        new Promise(resolve => {
            release = resolve;
        });
    const res = new Response();
    const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
    await waitFor(() => release);
    res.destroyed = true;
    res.emit("close");
    await running;
    release(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fixture.sent.length, 0);
    assert.equal(res.__usageTrackingClientAborted, true);
});

test("early has exactly one heartbeat source throughout buffered waiting and none after finish", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const legacy of [true, false]) {
        const fixture = setup(() => [success[0]], {
            fakeStreamTimeoutMs: 180000,
            scheduler: { streamEarlyHeaders: true, streamKeepaliveIntervalMs: 15000 },
            streamingMode: "early",
        });
        if (legacy) useLegacy(fixture);
        const res = new Response();
        const forwarded = [];
        let buffered;
        const write = res.write.bind(res);
        res.write = value => {
            for (const event of String(value).split("\n\n").filter(Boolean)) {
                if (buffered !== undefined) forwarded.push(buffered);
                buffered = event;
            }
            return write(value);
        };
        const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.sent.length, 1);
        assert.equal(res.body.includes(": accepted"), false);
        const start = completionChunks(res)[0];
        assert.equal(completionChunks(res).length, 2);
        assert.equal(forwarded.length, 1);
        assert.deepEqual(JSON.parse(forwarded[0].slice(6)), start);
        assert.equal(res.__keepaliveSent, true);
        t.mock.timers.tick(999);
        assert.equal(completionChunks(res).length, 2);
        t.mock.timers.tick(1);
        assert.equal(completionChunks(res).length, 3);
        // Hold the isolated upstream for two minutes of simulated time.
        for (let second = 1; second < 120; second++) {
            t.mock.timers.tick(1000);
            assert.equal(completionChunks(res).length, second + 3);
        }
        const emptyChunks = completionChunks(res);
        assert.equal(emptyChunks.length, 122);
        assert.equal(forwarded.length, 121);
        assert.equal(res.__modelOutputStarted, false);
        assert.equal(res.__modelFirstOutputAt, undefined);
        assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
        assert.equal(res.body.includes(": keep-alive"), false);
        for (const chunk of emptyChunks.slice(1)) {
            assert.deepEqual(chunk, {
                choices: [{ delta: { content: "" }, finish_reason: null, index: 0 }],
                created: start.created,
                id: start.id,
                model: start.model,
                object: "chat.completion.chunk",
            });
        }
        deliver(fixture, fixture.sent[0], success.slice(1));
        await running;
        const body = res.body;
        t.mock.timers.tick(30000);
        assert.equal(res.body, body);
        fixture.scheduler.close();
    }
});

test("early delivers reasoning and complete tool inputs with usage and tool finish reason", async t => {
    const payload = {
        candidates: [
            {
                content: {
                    parts: [
                        { text: "thinking", thought: true },
                        { functionCall: { args: { city: "上海" }, name: "weather" } },
                    ],
                },
                finishReason: "STOP",
            },
        ],
        usageMetadata: { candidatesTokenCount: 3, promptTokenCount: 2, totalTokenCount: 5 },
    };
    const fixture = setup(() => [success[0], { data: JSON.stringify(payload), event_type: "chunk" }, success[2]], {
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const req = request("flash", true);
    req.body.stream_options = { include_usage: true };
    const res = new Response();
    await fixture.handler.processOpenAIRequest(req, res);
    const chunks = completionChunks(res);
    assert.equal(chunks[0].choices[0].delta.tool_calls, undefined);
    assert.equal(chunks[2].choices[0].delta.reasoning_content, "thinking");
    const tool = chunks[3].choices[0].delta.tool_calls[0];
    assert.deepEqual(JSON.parse(tool.function.arguments), { city: "上海" });
    assert.equal(tool.function.name, "weather");
    assert.equal(chunks.at(-1).choices[0].finish_reason, "tool_calls");
    assert.equal(chunks.at(-1).usage.total_tokens, 5);
    assert.equal(fixture.scheduler.metrics.samples.stream_start_ms.length, 1);
    assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 1);
    assert.equal(fixture.scheduler.metrics.samples.request_complete_ms.length, 1);
});

test("early reports late upstream errors and malformed buffered JSON without success DONE", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const messages of [
        [success[0], { error: { type: "upstream_error" }, event_type: "error", message: "late error", status: 418 }],
        [success[0], { data: "invalid JSON", event_type: "chunk" }, success[2]],
    ]) {
        const fixture = setup(() => messages, { streamingMode: "early" });
        const res = new Response();
        await fixture.handler.processOpenAIRequest(request("flash", true), res);
        const error = completionChunks(res).at(-1).error;
        assert.ok(error);
        if (messages[1].status) {
            assert.equal(error.code, 418);
            assert.equal(error.type, "upstream_error");
        }
        assert.equal(res.body.includes("[DONE]"), false);
        assert.equal(res.__modelOutputStarted, false);
        assert.equal(fixture.scheduler.metrics.samples.model_first_output_ms.length, 0);
        assert.equal(fixture.registry.messageQueues.size, 0);
        const body = res.body;
        t.mock.timers.tick(5000);
        assert.equal(res.body, body);
        fixture.scheduler.close();
    }
});

test("early disconnect cancels active upstream and stops heartbeats in both runtime modes", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    for (const legacy of [true, false]) {
        const fixture = setup(() => [success[0]], {
            scheduler: { streamKeepaliveIntervalMs: 5 },
            streamingMode: "early",
        });
        if (legacy) useLegacy(fixture);
        const cancelled = [];
        for (const connection of fixture.registry.connectionsByAuth.values()) {
            const send = connection.send;
            connection.send = raw => {
                const message = JSON.parse(raw);
                if (message.event_type === "cancel_request") cancelled.push(message);
                send(raw);
            };
        }
        const res = new Response();
        const running = fixture.handler.processOpenAIRequest(request("flash", true), res);
        for (let i = 0; i < 5; i++) await new Promise(resolve => setImmediate(resolve));
        assert.equal(fixture.sent.length, 1);
        t.mock.timers.tick(1000);
        assert.equal(completionChunks(res).length, 3);
        res.destroyed = true;
        res.emit("close");
        await running;
        const body = res.body;
        t.mock.timers.tick(5000);
        assert.equal(res.body, body);
        assert.equal(fixture.registry.messageQueues.size, 0);
        assert.equal(fixture.scheduler.snapshot().active_workers, 0);
        assert.equal(cancelled.length, 1);
        assert.equal(res.body.includes("[DONE]"), false);
        fixture.scheduler.close();
    }
});

test("early queued timeout preserves stream error status and cleans up the queue", async t => {
    const fixture = setup(() => success, {
        scheduler: {
            globalConcurrency: 1,
            queueTimeoutMs: 10,
            streamEarlyHeaders: false,
            streamKeepaliveIntervalMs: 5,
        },
        streamingMode: "early",
    });
    t.after(() => fixture.scheduler.close());
    const blocker = await fixture.scheduler.acquire("flash");
    const res = new Response();
    await fixture.handler.processOpenAIRequest(request("flash", true), res);
    assert.equal(res.statusCode, 200);
    assert.equal(completionChunks(res).at(-1).error.code, 504);
    assert.equal(res.body.includes("[DONE]"), false);
    assert.equal(fixture.sent.length, 0);
    assert.equal(fixture.scheduler.pending.length, 0);
    fixture.scheduler.release(blocker);
});

test("configuration changes apply to new requests while accepted early requests keep their snapshot", async t => {
    const fixture = setup(() => success, { streamingMode: "early" });
    t.after(() => fixture.scheduler.close());
    useLegacy(fixture);
    let release;
    let waiting = true;
    fixture.handler._ensureBrowserBackedRequestReady = () =>
        waiting
            ? new Promise(resolve => {
                  release = resolve;
              })
            : Promise.resolve(true);
    const first = new Response();
    const running = fixture.handler.withConfigurationSnapshot(() =>
        fixture.handler.processOpenAIRequest(request("flash", true), first)
    );
    await waitFor(() => release);
    fixture.handler.config = { ...fixture.handler.config, streamingMode: "real" };
    waiting = false;
    release(true);
    await running;
    assert.equal(first.__proxyResponseStreamMode, "early");
    const second = new Response();
    await fixture.handler.withConfigurationSnapshot(() =>
        fixture.handler.processOpenAIRequest(request("flash", true), second)
    );
    assert.equal(second.__proxyResponseStreamMode, "real");
    assert.equal(second.__streamStartSent, undefined);
    assert.deepEqual(
        fixture.sent.map(entry => entry.request.streaming_mode),
        ["fake", "real"]
    );
});
