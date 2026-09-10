const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
function browserFixture(limit) {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _contextInitTasks: new Map(),
        async _ensureBrowser() {
            this.browser = {};
        },
        async _initializeContext(index) {
            assert.ok(this.browser);
            this.activeInitializations = (this.activeInitializations || 0) + 1;
            this.peakInitializations = Math.max(this.peakInitializations || 0, this.activeInitializations);
            await new Promise(resolve => setImmediate(resolve));
            this.contexts.set(index, { page: { isClosed: () => false }, state: "READY" });
            this.activeInitializations--;
            this.initializingContexts.delete(index);
            this.peak = Math.max(this.peak || 0, this.contexts.size);
        },
        async _startBackgroundWakeup() {},
        _startHealthMonitor() {},
        authSource: { getRotationIndices: () => [0, 1, 2] },
        async closeContext(index, options) {
            this.contexts.delete(index);
            if (!this.contexts.size && !options?.keepBrowser) this.browser = null;
        },
        connectionRegistry: { getConnectionByAuth: index => (manager.contexts.has(index) ? {} : null) },
        contextDemand: new Map(),
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        logger,
        scheduler: {
            account: index => ({ inflight: index === 0 ? 1 : 0 }),
            closed: false,
            config: {
                contextInitConcurrency: 2,
                contextPoolMinReady: 0,
                maxWorkers: limit,
                queueTimeoutMs: 100,
            },
            drain() {},
        },
    });
    return manager;
}
test("context setup is bounded parallel and never evicts leased contexts", async () => {
    const manager = browserFixture(2);
    manager.requestContext(0);
    manager.requestContext(1);
    manager.requestContext(2);
    while (manager._contextInitTasks.size || manager.initializingContexts.size) {
        await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(manager.peak, 2);
    assert.equal(manager.peakInitializations, 2);
    assert.deepEqual([...manager.contexts.keys()], [0, 2]);
});
test("one-worker account rotation keeps browser alive while replacing last context", async () => {
    const manager = browserFixture(1);
    await manager.ensureWorkerContext(1);
    await manager.ensureWorkerContext(2);
    assert.ok(manager.browser);
    assert.deepEqual([...manager.contexts.keys()], [2]);
});
test("shutdown prevents queued context launches", async () => {
    const manager = browserFixture(1);
    manager.scheduler.closed = true;
    await assert.rejects(manager.ensureWorkerContext(1), /shutting down/);
    assert.equal(manager.contexts.size, 0);
});
test("a delayed WebSocket close cannot remove a replacement connection", () => {
    const registry = new ConnectionRegistry(logger);
    const replacement = { _authIndex: 0 };
    registry.connectionsByAuth.set(0, replacement);
    registry._removeConnection({ _authIndex: 0 });
    assert.equal(registry.connectionsByAuth.get(0), replacement);
});

test("message queues are isolated by WebSocket connection epoch", async () => {
    const registry = new ConnectionRegistry(logger);
    const socket = () => {
        const ws = new (require("node:events").EventEmitter)();
        ws.readyState = 1;
        ws.close = () => {};
        return ws;
    };
    const first = socket();
    registry.addConnection(first, { address: "test", authIndex: 0 });
    const oldQueue = registry.createMessageQueue("old", 0, "attempt-1");
    const oldWait = oldQueue.dequeue(100);
    const second = socket();
    registry.addConnection(second, { address: "test", authIndex: 0 });
    await assert.rejects(oldWait, error => error.reason === "connection_lost");
    const newQueue = registry.createMessageQueue("new", 0, "attempt-2");
    registry._removeConnection(first);
    assert.equal(newQueue.closed, false);
    assert.equal(registry.getConnectionEpoch(0), 2);
    registry.removeMessageQueue("new");
});

test("same account concurrent initialization creates only one context", async () => {
    const manager = browserFixture(1);
    let launches = 0;
    const initialize = manager._initializeContext.bind(manager);
    manager._initializeContext = async index => {
        launches++;
        await initialize(index);
    };
    await Promise.all(Array.from({ length: 12 }, () => manager.ensureWorkerContext(0)));
    assert.equal(launches, 1);
    assert.equal(manager.contexts.size, 1);
});

test("context initialization failure stays local and marks only the context unavailable", async () => {
    const manager = browserFixture(1);
    manager._initializeContext = async () => {
        throw new Error("Build initialization failed");
    };
    manager.requestContext(0);
    await manager._contextInitTasks.get(0);
    assert.equal(manager.contextUnavailable.get(0).error.message, "Build initialization failed");
    assert.equal(manager.scheduler.account(0).healthy, undefined);
});
