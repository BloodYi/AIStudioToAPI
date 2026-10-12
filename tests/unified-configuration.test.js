const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ConfigurationService, definitions, atomicWrite } = require("../src/config/ConfigurationService");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const RequestHandler = require("../src/core/RequestHandler");
const ConfigurationRoutes = require("../src/config/ConfigurationRoutes");
const logger = { debug() {}, error() {}, info() {}, setDisplayLimit() {}, warn() {} };
function setup(t, env = {}) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "managed-config-"));
    t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
    const system = { logger, ready: true };
    const service = new ConfigurationService(system, { env, file: path.join(directory, "managed-config.json") });
    system.configurationService = service;
    const save = changes => service.save({ changes, version: service.document.version });
    return { directory, save, service, system };
}
test("allowlist matches plan and excludes file-only queue timeout and usage enable switch", () => {
    const plan = fs.readFileSync(path.join(__dirname, "../docs/zh/unified-frontend-configuration-plan.md"), "utf8");
    const section = plan.split("\n## 4.")[1].split("\n## 5.")[0];
    const keys = [...section.matchAll(/^\| `([A-Z_]+)`\s+\|/gm)].map(match => match[1]);
    assert.deepEqual(new Set(definitions.map(d => d.name)), new Set([...keys, "LOG_DISPLAY_LIMIT", "DEBUG_MODE"]));
    assert.equal(new Set(definitions.map(d => d.name)).size, definitions.length);
});
test("save persists hot values, masks secrets and preserves restart differences on another instance", t => {
    const { service, save, system } = setup(t);
    const result = save({ API_KEYS: ["new-key"], FORCE_THINKING: true, PUBLIC_DASHBOARD_ENABLED: true });
    assert.equal(system.config.forceThinking, true);
    assert.equal(system.config.publicDashboard.enabled, false);
    assert.deepEqual(
        result.pending.map(p => p.name),
        ["PUBLIC_DASHBOARD_ENABLED"]
    );
    assert.equal(JSON.stringify(result).includes("new-key"), false);
    assert.equal(fs.statSync(service.file).mode & 0o777, 0o600);
    const restarted = new ConfigurationService({ logger }, { env: {}, file: service.file });
    assert.equal(restarted.running.publicDashboard.enabled, true);
    assert.equal(restarted.running.forceThinking, true);
    assert.deepEqual(restarted.running.apiKeys, ["new-key"]);
    assert.equal(restarted.snapshot().pending.length, 0);
});
test("versions reject stale pages and explicit targets never toggle twice", t => {
    const { service, save } = setup(t);
    const version = service.document.version;
    save({ FORCE_THINKING: true });
    assert.throws(() => service.save({ changes: { FORCE_THINKING: false }, version }), { status: 409 });
    save({ FORCE_THINKING: true });
    assert.equal(service.running.forceThinking, true);
    assert.throws(() => save({ FORCE_THINKING: "true" }), { status: 400 });
    assert.throws(() => save({ PORT: 80 }), { status: 400 });
});
test("strategy and dependent hot fields wait together; hidden values survive explicit saves", t => {
    const { service, save } = setup(t, { ACCOUNT_ROTATION_STRATEGY: "legacy" });
    save({ ACCOUNT_MAX_CONCURRENCY: 3, ACCOUNT_ROTATION_STRATEGY: "least_used", STREAM_KEEPALIVE_INTERVAL_MS: 13000 });
    assert.equal(service.running.scheduler.strategy, "legacy");
    assert.equal(service.running.scheduler.accountConcurrency, 0);
    assert.equal(service.running.scheduler.streamKeepaliveIntervalMs, 10000);
    save({ FORCE_WEB_SEARCH: true });
    assert.equal(service.saved.scheduler.accountConcurrency, 3);
    service.undo(service.document.version);
    assert.equal(service.snapshot().pending.length, 0);
    assert.equal(service.running.forceWebSearch, true);
});
test("resource growth defers related limits and validates both targets and the real runtime", t => {
    const { service, save } = setup(t);
    save({
        GLOBAL_MAX_CONCURRENCY: 4,
        MODEL_MAX_CONCURRENCY: { "gemini-custom": 4 },
        MODEL_WORKER_ALLOCATION: { "gemini-custom": { min_workers: 2, preferred_workers: 4 } },
    });
    assert.equal(service.running.scheduler.globalConcurrency, 1);
    assert.deepEqual(service.running.scheduler.modelConcurrency, {});
    assert.equal(service.saved.scheduler.modelConcurrency["gemini-custom"], 4);
    assert.throws(() => save({ MODEL_MAX_CONCURRENCY: { "gemini-custom": 1 } }), { status: 400 });
    assert.throws(
        () => save({ MODEL_WORKER_ALLOCATION: { "gemini-custom": { min_workers: 0, preferred_workers: 5 } } }),
        { status: 400 }
    );
});
test("model inputs round trip upstream IDs including unknown valid IDs, and deletion restores inheritance", t => {
    const { service, save } = setup(t);
    save({
        ACCOUNT_MODEL_MAX_CONCURRENCY: { "custom-upstream:preview": 0 },
        MODEL_MAX_CONCURRENCY: { "custom-upstream:preview": 2 },
    });
    assert.equal(service.snapshot().saved.ACCOUNT_MODEL_MAX_CONCURRENCY["custom-upstream:preview"], 0);
    assert.throws(() => save({ MODEL_MAX_CONCURRENCY: { "gemini-flash-search": 2 } }), { status: 400 });
    assert.throws(() => save({ MODEL_MAX_CONCURRENCY: { "custom-upstream:preview": 0 } }), { status: 400 });
    save({ MODEL_MAX_CONCURRENCY: {} });
    assert.deepEqual(service.running.scheduler.modelConcurrency, {});
});
test("file-only dependencies remain validated and dispatch timeout keeps existing override precedence", t => {
    const { service, save } = setup(t, { MODEL_QUEUE_TIMEOUT_MS: "54321", PORT: "7861" });
    assert.equal(service.running.scheduler.queueTimeoutMs, 54321);
    assert.throws(() => save({ PUBLIC_DASHBOARD_ENABLED: true }), { status: 400 });
    assert.throws(() => save({ CONTEXT_OPERATION_TIMEOUT_MS: 200000 }), { status: 400 });
    save({ REQUEST_DISPATCH_TIMEOUT_MS: 12345 });
    assert.equal(service.running.scheduler.queueTimeoutMs, 12345);
    service.save({ reset: ["REQUEST_DISPATCH_TIMEOUT_MS"], version: service.document.version });
    assert.equal(service.running.scheduler.queueTimeoutMs, 54321);
});
test("account database settings migrate once; stale database copies cannot override the authority", t => {
    const { service, system, save } = setup(t, { ACCOUNT_LOGIN_CONCURRENCY: "1" });
    const state = { config: { autoRecovery: false, concurrency: 4, paused: true } };
    system.accountLoginService = { state };
    service.initializeAccounts(state);
    assert.equal(service.running.login.concurrency, 4);
    assert.equal(service.running.login.autoRecovery, false);
    assert.equal(state.config.paused, true);
    save({ ACCOUNT_LOGIN_CONCURRENCY: 2, ACCOUNT_LOGIN_STEP_TIMEOUT_MS: 40000 });
    assert.equal(state.config.concurrency, 2);
    assert.equal(state.config.stepTimeout, 40000);
    const nextSystem = { logger };
    const next = new ConfigurationService(nextSystem, { env: {}, file: service.file });
    next.initializeAccounts({ config: { autoRecovery: true, concurrency: 8, paused: false } });
    assert.equal(next.running.login.concurrency, 2);
    assert.equal(next.running.login.autoRecovery, false);
});
test("failed persistence changes no runtime; failed hot application rolls back document and active state", t => {
    const { service, system, save, directory } = setup(t);
    const originalFile = service.file;
    const blocked = path.join(directory, "blocked");
    fs.writeFileSync(blocked, "not a directory");
    service.file = path.join(blocked, "config.json");
    assert.throws(() => save({ FORCE_THINKING: true }));
    assert.equal(service.running.forceThinking, false);
    service.file = originalFile;
    const version = service.document.version;
    let attempts = 0;
    system.requestHandler = {
        setBrowserLogLevel() {
            if (++attempts === 1) throw new Error("sync failed");
        },
    };
    assert.throws(() => save({ DEBUG_MODE: true, FORCE_THINKING: true }), /已恢复/);
    assert.equal(service.document.version, version);
    assert.equal(service.running.forceThinking, false);
    assert.equal(JSON.parse(fs.readFileSync(service.file)).version, version);
});
test("daily reset hot changes replace actual scheduled timers; existing cooldowns remain intact", t => {
    const { service, system, save } = setup(t);
    service.running.scheduler.statePath = null;
    system.scheduler = new ModelScheduler(
        service.running.scheduler,
        { accountNameMap: new Map(), getRotationIndices: () => [] },
        logger
    );
    t.after(() => system.scheduler.close());
    const initial = system.scheduler.dailyResetTimer;
    save({ RATE_LIMIT_COOLDOWN: 60, SCHEDULER_DAILY_RESET_ENABLED: false });
    assert.equal(system.scheduler.dailyResetTimer, null);
    assert.equal(initial._destroyed, true);
    save({ SCHEDULER_DAILY_RESET_ENABLED: true, SCHEDULER_DAILY_RESET_TIME: "07:30" });
    assert.ok(system.scheduler.dailyResetTimer);
    assert.equal(system.scheduler.config.dailyResetTime, "07:30");
});
test("accepted request snapshots retain timeouts and conversion settings while subsequent requests use saved values", async t => {
    const { system, service, save } = setup(t);
    const handler = new RequestHandler(system, {}, logger, {}, service.running, {});
    system.requestHandler = handler;
    // No active WebSockets in this unit fixture.
    handler.setBrowserLogLevel = () => 0;
    await handler.withConfigurationSnapshot(async () => {
        const original = handler.timeouts.FAKE_STREAM;
        save({ FAKE_STREAM_TIMEOUT_MS: 1000, FORCE_THINKING: true });
        await Promise.resolve();
        assert.equal(handler.timeouts.FAKE_STREAM, original);
        assert.equal(handler.config.forceThinking, false);
        assert.equal(handler.formatConverter.configProvider().forceThinking, false);
    });
    assert.equal(handler.timeouts.FAKE_STREAM, 1000);
    assert.equal(handler.config.forceThinking, true);
});
test("recovery uses actual last-good values while retaining the saved target and visible differences", t => {
    const { service, save, directory } = setup(t);
    const lastGood = service.runningDocument();
    save({ PUBLIC_DASHBOARD_ENABLED: true });
    atomicWrite(path.join(directory, "managed-config.last-good.json"), lastGood);
    atomicWrite(path.join(directory, "restart-status.json"), { error: "port unavailable" });
    const recovered = new ConfigurationService(
        { logger },
        { env: { AISTUDIO_CONFIG_RECOVERY: "1" }, file: service.file }
    );
    assert.equal(recovered.running.publicDashboard.enabled, false);
    assert.equal(recovered.saved.publicDashboard.enabled, true);
    assert.equal(recovered.snapshot().restartError, "port unavailable");
    assert.deepEqual(
        recovered.snapshot().pending.map(p => p.name),
        ["PUBLIC_DASHBOARD_ENABLED"]
    );
});
test("configuration routes reject unauthenticated access and legacy toggles require explicit targets", async t => {
    const express = require("express");
    const { system, service } = setup(t);
    const app = express();
    app.use(express.json());
    new ConfigurationRoutes(system).setupRoutes(app, (req, res, next) =>
        req.headers.authorization === "test" ? next() : res.sendStatus(401)
    );
    const server = app.listen(0, "127.0.0.1");
    await new Promise(resolve => server.once("listening", resolve));
    t.after(() => new Promise(resolve => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(url + "/api/configuration")).status, 401);
    const response = await fetch(url + "/api/settings/force-thinking", {
        body: JSON.stringify({ version: service.document.version }),
        headers: { authorization: "test", "Content-Type": "application/json" },
        method: "PUT",
    });
    assert.equal(response.status, 400);
    assert.equal(service.running.forceThinking, false);
});

test("restart health distinguishes listening from healthy contexts and supports binding or lazy initialization", t => {
    const { service, system } = setup(t);
    system.authSource = { availableIndices: [0] };
    system.browserManager = { getContextInitHealth: () => ({ ready: 0, staleInitializing: 0 }) };
    assert.equal(service.snapshot().ready, true);
    assert.equal(service.snapshot().operational, false);
    system.browserManager.getContextInitHealth = () => ({ ready: 1, staleInitializing: 0 });
    assert.equal(service.snapshot().operational, true);
    system.browserManager.getContextInitHealth = () => ({ ready: 1, staleInitializing: 1 });
    assert.equal(service.snapshot().operational, false);
    system.authSource.availableIndices = [];
    assert.equal(service.snapshot().operational, true);
    system.authSource.availableIndices = [0];
    system.scheduler = {};
    service.running.scheduler.contextPoolMinReady = 0;
    assert.equal(service.snapshot().operational, true);
});

test("proxy settings restore Mihomo after a persistence failure", async () => {
    const ProxyPoolService = require("../src/proxy/ProxyPoolService");
    const pool = Object.create(ProxyPoolService.prototype);
    const previous = { settings: { basePort: 10801, enabled: true } };
    const next = { settings: { basePort: 10802, enabled: true } };
    const reloads = [];
    pool.manager = { reload: async config => reloads.push(config), status: { running: true } };
    pool.store = {
        replace: async () => {
            throw new Error("disk full");
        },
        snapshot: () => previous,
    };
    await assert.rejects(pool._commit(next), /disk full/);
    assert.deepEqual(reloads, [next, previous]);
});
