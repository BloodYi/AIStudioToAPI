/* global window */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const https = require("node:https");
const http = require("node:http");
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { firefox } = require("playwright");
const { BuildBenefitContext } = require("../src/core/BuildBenefitContext");
const RequestHandler = require("../src/core/RequestHandler");
const { ModelScheduler, getModelDailyQuota } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const auth = {
    authorization: "fixture-authorization",
    "x-goog-api-key": "fixture-service-key",
    "x-goog-authuser": "2",
};
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const listen = server => new Promise(resolve => server.listen(0, "127.0.0.1", resolve));

// A real TLS peer behind a loopback CONNECT proxy receives route.continue().
// No Google traffic leaves this fixture, including DNS resolution.
async function fixture(t) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "build-benefit-"));
    execFileSync(
        "openssl",
        [
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-keyout",
            path.join(directory, "key"),
            "-out",
            path.join(directory, "cert"),
            "-days",
            "1",
            "-subj",
            "/CN=fixture",
        ],
        { stdio: "ignore" }
    );
    const state = { body: "[1]", delay: 0, requests: [], status: 200 };
    const server = https.createServer(
        { cert: fs.readFileSync(path.join(directory, "cert")), key: fs.readFileSync(path.join(directory, "key")) },
        async (req, res) => {
            res.setHeader("access-control-allow-origin", "https://aistudio.google.com");
            res.setHeader("access-control-allow-credentials", "true");
            res.setHeader("access-control-allow-headers", req.headers["access-control-request-headers"] || "*");
            res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
            if (req.method === "OPTIONS") return res.end();
            if (req.method === "GET") {
                res.setHeader("content-type", "text/html");
                return res.end("<!doctype html><title>Local Build fixture</title>");
            }
            let body = "";
            for await (const chunk of req) body += chunk;
            state.requests.push({ body, headers: req.headers, url: req.url });
            if (req.url.startsWith(RPC + "GetAiStudioBenefitTier")) {
                if (state.delay) await new Promise(resolve => setTimeout(resolve, state.delay));
                res.statusCode = state.status;
                res.end(state.body);
            } else res.end("[]");
        }
    );
    await listen(server);
    const sockets = new Set();
    const proxy = http.createServer();
    proxy.on("connect", (req, socket, head) => {
        if (!["aistudio.google.com:443", "alkalimakersuite-pa.clients6.google.com:443"].includes(req.url))
            return socket.destroy();
        const upstream = net.connect(server.address().port, "127.0.0.1", () => {
            socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            socket.pipe(upstream).pipe(socket);
        });
        for (const peer of [socket, upstream]) {
            sockets.add(peer);
            peer.on("error", () => peer.destroy());
            peer.on("close", () => sockets.delete(peer));
        }
    });
    await listen(proxy);
    const runtime = { browser: null };
    t.after(async () => {
        await runtime.browser?.close();
        for (const socket of sockets) socket.destroy();
        server.closeAllConnections();
        await Promise.all([
            new Promise(resolve => server.close(resolve)),
            new Promise(resolve => proxy.close(resolve)),
        ]);
        fs.rmSync(directory, { force: true, recursive: true });
    });
    const browser = await firefox.launch({
        executablePath: process.env.BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH || undefined,
        headless: true,
        proxy: { server: `http://127.0.0.1:${proxy.address().port}` },
    });
    runtime.browser = browser;
    state.open = async (index = 0, timeoutMs = 1000) => {
        const context = await browser.newContext({ ignoreHTTPSErrors: true });
        const page = await context.newPage();
        const benefit = new BuildBenefitContext(page, { authIndex: index, timeoutMs, verified: true });
        await benefit.install();
        page._fixtureBenefit = benefit;
        await context.addCookies([
            {
                domain: "alkalimakersuite-pa.clients6.google.com",
                httpOnly: true,
                name: "fixture-session",
                path: "/",
                secure: true,
                value: `account-${index}`,
            },
        ]);
        await page.goto("https://aistudio.google.com/");
        return { benefit, context, page };
    };
    // Camoufox 135's Juggler does not complete Page.reload with this
    // Playwright version. Recreate its document through the production goto path.
    state.reload = page =>
        process.env.BUILD_BENEFIT_BROWSER_EXECUTABLE_PATH
            ? page.goto(`https://aistudio.google.com/?fixture_document=${Date.now()}`, {
                  waitUntil: "domcontentloaded",
              })
            : page.reload({ waitUntil: "domcontentloaded" });
    state.native = (page, headers = auth, method = "ListModels", body = "[]") =>
        page._fixtureBenefit._evaluate(
            async ({ body, headers, url }) =>
                (await fetch(url, { body, credentials: "include", headers, method: "POST" })).status,
            { body, headers, url: ORIGIN + RPC + method }
        );
    return state;
}

test("real Firefox preserves legacy wire and isolates entitlement documents/accounts", { timeout: 60000 }, async t => {
    const f = await fixture(t);
    const { page, benefit, context } = await f.open();
    await f.native(page);
    f.delay = 40;
    const first = benefit.ensure();
    assert.equal(first, benefit.ensure());
    assert.equal(await first, "ready-paid");
    const queries = f.requests.filter(request => request.url.includes("GetAiStudioBenefitTier"));
    assert.equal(queries.length, 1);
    assert.equal(queries[0].body, "[]");
    assert.equal(queries[0].headers.cookie, "fixture-session=account-0");
    assert.equal(queries[0].headers.authorization, auth.authorization);
    assert.equal(queries[0].headers["x-goog-authuser"], "2");
    assert.equal(queries[0].headers["x-goog-api-key"], auth["x-goog-api-key"]);
    await f.native(page, { ...auth, "x-aistudio-g1-tier": "TIER2", "x-goog-ext-519733851-bin": "opaque-native-value" });
    const body = JSON.stringify([
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-4-argon:generateContent",
        '{"contents":[]}',
        "waa-proof",
    ]);
    const headers = { ...auth, "content-type": "application/json+protobuf", "x-native-proof": "keep-proof" };
    assert.equal(await f.native(page, headers, "ProxyUnaryCall?authuser=2", body), 200);
    const outbound = f.requests.at(-1);
    assert.equal(outbound.url, RPC + "ProxyUnaryCall?authuser=2");
    assert.equal(outbound.body, body);
    assert.equal(outbound.headers["x-aistudio-g1-tier"], "TIER2");
    assert.equal(outbound.headers["x-goog-ext-519733851-bin"], "opaque-native-value");
    for (const [name, value] of Object.entries(headers)) assert.equal(outbound.headers[name], value);
    await f.native(
        page,
        { ...headers, "x-aistudio-g1-tier": "TIER1", "x-goog-ext-519733851-bin": "current-request-ext" },
        "ProxyUnaryCall",
        body
    );
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], "TIER1");
    assert.equal(f.requests.at(-1).headers["x-goog-ext-519733851-bin"], "current-request-ext");
    const otherBody = JSON.stringify([
        "/v1beta/models/gemini-2.5-flash:generateContent",
        JSON.stringify({ contents: [{ text: "/v1beta/models/gemini-4-argon:generateContent" }] }),
        "proof",
    ]);
    await f.native(page, headers, "ProxyUnaryCall", otherBody);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], undefined);
    await f.native(page, headers, "ProxyStreamedCall", body);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], undefined);
    assert.ok(f.requests.every(request => !request.url.startsWith(RPC + "GenerateContent")));
    const retiredId = await benefit._evaluate(() => window.__buildBenefit.documentId);
    await f.reload(page);
    if (benefit.usesMainWorldBridge) {
        await benefit._evaluate(({ owner, id }) => console.debug(`BuildBenefitChange:${owner}:${id}`), {
            id: retiredId,
            owner: benefit.owner,
        });
        await page.waitForTimeout(20);
    } else await page.evaluate(id => window.__buildBenefitChanged(id), retiredId);
    assert.equal(benefit.state, "unknown");
    await f.native(page);
    f.body = "[0]";
    assert.equal(await benefit.ensure(), "ready-free");
    const second = await f.open(1);
    await f.native(second.page);
    f.body = "[2]";
    assert.equal(await second.benefit.ensure(), "ready-paid");
    await f.native(second.page, headers, "ProxyUnaryCall", body);
    assert.equal(f.requests.at(-1).headers["x-aistudio-g1-tier"], "TIER2");
    assert.equal(f.requests.at(-1).headers["x-goog-ext-519733851-bin"], undefined);
    await f.native(page, { ...auth, "x-aistudio-g1-tier": "TIER1", "x-goog-ext-519733851-bin": "account-zero-ext" });
    for (let attempt = 0; attempt < 100 && benefit.state !== "ready-paid"; attempt++) await page.waitForTimeout(10);
    assert.equal(benefit.state, "ready-paid", "native tier notification must wake the owning Node context");
    const beforeConcurrent = f.requests.length;
    await Promise.all([
        f.native(page, headers, "ProxyUnaryCall", body),
        f.native(second.page, headers, "ProxyUnaryCall", body),
    ]);
    const concurrent = f.requests.slice(beforeConcurrent);
    assert.equal(concurrent.length, 2);
    assert.equal(
        concurrent.find(request => request.headers.cookie === "fixture-session=account-0").headers[
            "x-goog-ext-519733851-bin"
        ],
        "account-zero-ext"
    );
    assert.equal(
        concurrent.find(request => request.headers.cookie === "fixture-session=account-1").headers[
            "x-goog-ext-519733851-bin"
        ],
        undefined
    );
    await context.close();
    assert.equal(benefit.disposed, true);
    assert.equal(second.benefit.disposed, undefined);
});

test(
    "benefit parse/auth/HTTP/deadline failures stay failed and permit explicit refresh",
    { timeout: 60000 },
    async t => {
        const f = await fixture(t);
        for (const [body, status] of [
            ["[3]", 200],
            ["{}", 200],
            ["bad json", 200],
            ["[]", 401],
            ["[]", 403],
            ["[]", 429],
        ]) {
            const { benefit, page, context } = await f.open();
            await f.native(page);
            Object.assign(f, { body, status });
            assert.equal(await benefit.ensure(), "failed");
            Object.assign(f, { body: "[1]", status: 200 });
            assert.equal(await benefit.ensure({ refresh: true }), "ready-paid");
            await context.close();
        }
        const { benefit, page, context } = await f.open(0, 50);
        assert.equal(await benefit.ensure(), "failed");
        await f.native(page);
        f.delay = 200;
        assert.equal(await benefit.ensure({ refresh: true }), "failed");
        f.delay = 0;
        benefit.timeoutMs = 1000;
        assert.equal(await benefit.ensure({ refresh: true }), "ready-paid");
        await f.reload(page);
        await f.native(page);
        f.delay = 100;
        const pending = benefit.ensure();
        await f.reload(page);
        await pending;
        assert.equal(benefit.state, "unknown");
        await context.close();
    }
);

test("Argon policy applies before WAA and native SSE intent remains separate", () => {
    const handler = Object.create(RequestHandler.prototype);
    Object.assign(handler, {
        config: { streamingMode: "real" },
        formatConverter: { ensureServerSideToolInvocations() {} },
        logger,
    });
    for (const model of ["gemini-4-argon", "gemini-4-argon-real", "gemini-4-argon-fake"]) {
        const req = {
            body: {},
            headers: {},
            method: "POST",
            path: `/v1beta/models/${model}:streamGenerateContent`,
            query: { alt: "sse", key: "client-key" },
        };
        const request = handler._buildProxyRequest(req, "test");
        assert.equal(request.path, "/v1beta/models/gemini-4-argon:generateContent");
        assert.equal(request.streaming_mode, "fake");
        assert.deepEqual(request.query_params, { key: "client-key" });
        assert.equal(req.query.alt, "sse");
        assert.ok(req.path.includes(":streamGenerateContent"));
    }
    const untrusted = {
        headers: {
            "content-type": "application/json",
            "X-Aistudio-G1-Tier": "TIER2",
            "x-goog-ext-519733851-bin": "client-ext",
        },
        is_generative: true,
        path: "/v1beta/models/gemini-4-argon:generateContent",
        request_id: "client",
    };
    handler._initializeProxyRequestAttempt(untrusted);
    assert.deepEqual(untrusted.headers, { "content-type": "application/json" });
    assert.equal(handler._effectiveStreamMode("gemini-4-argon", "real"), "fake");
    assert.equal(handler._effectiveStreamMode("gemini-4-argon", "early"), "early");
    assert.equal(handler._effectiveStreamMode("gemini-4-other", "real"), "real");
    assert.equal(getModelDailyQuota("gemini-4-argon"), null);
    assert.throws(() => loadConfig({ ARGON_VERIFIED_ACCOUNTS: '["TIER2"]' }), /Invalid ARGON/);
    assert.deepEqual(loadConfig({ ARGON_VERIFIED_ACCOUNTS: "[0,2,2]" }).argonVerifiedAccounts, [0, 2]);
});

test("scheduler automatically preflights new accounts but leases only confirmed paid accounts", () => {
    const scheduler = Object.create(ModelScheduler.prototype);
    const benefit = { state: "unknown" };
    Object.assign(scheduler, {
        authSource: { isExpired: () => false },
        browserManager: { contexts: new Map([[0, { page: { buildBenefit: benefit } }]]), isContextReady: () => true },
        config: { argonVerifiedAccounts: [0], readyContextOnly: true },
        hiddenModels: new Set(),
        isAccountQuotaExhausted: () => false,
        now: () => 0,
    });
    const account = { healthy: true, index: 0, inflight: 0, key: "auth-0", models: {} };
    assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), true);
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), false);
    benefit.state = "ready-paid";
    assert.equal(scheduler.canLease(account, "gemini-4-argon"), true);
    for (const state of ["ready-free", "failed"]) {
        benefit.state = state;
        assert.equal(scheduler.isResourceEligible(account, "gemini-4-argon"), false);
        assert.equal(scheduler.canLease(account, "gemini-4-argon"), false);
        assert.equal(account.healthy, true);
    }
    assert.equal(scheduler.isResourceEligible({ ...account, index: 1 }, "gemini-4-argon"), true);
    assert.equal(scheduler.isResourceEligible({ ...account, index: 1 }, "gemini-2.5-flash"), true);
});

test("cold Argon preflight remains bounded and settles without reloading rejected accounts", async t => {
    for (const readyContextOnly of [true, false]) {
        await t.test(`readyContextOnly=${readyContextOnly}`, async t => {
            const scheduler = new ModelScheduler(
                {
                    ...loadConfig({
                        ARGON_VERIFIED_ACCOUNTS: "[0,1]",
                        CONTEXT_INIT_CONCURRENCY: "1",
                        CONTEXT_POOL_MIN_READY: "0",
                        MAX_BROWSER_WORKERS: "1",
                        REQUEST_DISPATCH_TIMEOUT_MS: "1000",
                    }),
                    readyContextOnly,
                    statePath: null,
                },
                { accountNameMap: new Map(), getRotationIndices: () => [0, 1, 2] },
                logger
            );
            t.after(() => scheduler.close());
            const seen = [];
            const browser = {
                _contextInitTasks: new Map(),
                contexts: new Map(),
                initializingContexts: new Set(),
                isContextReady(index) {
                    return this.contexts.has(index);
                },
                requestContexts(requests) {
                    for (const { authIndex } of requests) {
                        assert.ok(
                            !seen.includes(authIndex),
                            "failed preflight must not reload during the same queued request"
                        );
                        seen.push(authIndex);
                        this.initializingContexts.add(authIndex);
                        setImmediate(() => {
                            this.contexts.clear();
                            const state = authIndex === 0 ? "ready-free" : "failed";
                            this.contexts.set(authIndex, { page: { buildBenefit: { state } }, state: "READY" });
                            this.initializingContexts.delete(authIndex);
                            scheduler.noteBenefitState(authIndex, state);
                            scheduler._eligibleRound = null;
                            scheduler.drain();
                        });
                    }
                },
            };
            scheduler.browserManager = browser;
            await assert.rejects(scheduler.acquire("gemini-4-argon"), /No eligible accounts/);
            assert.deepEqual(seen, [0, 1, 2]);
            assert.equal(scheduler.pending.length, 0);
            assert.equal(
                [...scheduler.accounts.values()].some(account => account.inflight),
                false
            );
            assert.equal(scheduler.account(0).healthy, true);
            assert.equal(scheduler.account(1).healthy, true);
        });
    }
});

test("Argon eligibility rejects stale sessions and preflight cancellation releases the queue", async t => {
    const scheduler = new ModelScheduler(
        { ...loadConfig({ ARGON_VERIFIED_ACCOUNTS: "[0]", CONTEXT_POOL_MIN_READY: "0" }), statePath: null },
        { accountNameMap: new Map(), getRotationIndices: () => [0] },
        logger
    );
    t.after(() => scheduler.close());
    const benefit = { isCurrent: () => false, state: "ready-paid", verified: true };
    scheduler.browserManager = {
        contexts: new Map([[0, { page: { buildBenefit: benefit } }]]),
        isContextReady: () => true,
    };
    assert.equal(scheduler.canLease(scheduler.account(0), "gemini-4-argon"), false);
    await assert.rejects(scheduler.acquire("gemini-4-argon"), /No eligible/);
    scheduler.browserManager.contexts.clear();
    scheduler.browserManager.initializingContexts = new Set([0]);
    scheduler.browserManager.isContextReady = () => false;
    scheduler.browserManager.requestContexts = () => {};
    const controller = new AbortController();
    const request = scheduler.acquire("gemini-4-argon", new Set(), controller.signal);
    controller.abort();
    await assert.rejects(request, /Client disconnected/);
    assert.equal(scheduler.pending.length, 0);
});
