const { test } = require("node:test");
const assert = require("node:assert/strict");
const BrowserManager = require("../src/core/BrowserManager");
const ConnectionRegistry = require("../src/core/ConnectionRegistry");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
function browserFixture(limit) {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        async _ensureBrowser() {
            this.browser = {};
        },
        async _initializeContext(index) {
            assert.ok(this.browser);
            await new Promise(resolve => setImmediate(resolve));
            this.contexts.set(index, { page: { isClosed: () => false } });
            this.initializingContexts.delete(index);
            this.peak = Math.max(this.peak || 0, this.contexts.size);
        },
        async _startBackgroundWakeup() {},
        _startHealthMonitor() {},
        async closeContext(index, options) {
            this.contexts.delete(index);
            if (!this.contexts.size && !options?.keepBrowser) this.browser = null;
        },
        connectionRegistry: { getConnectionByAuth: index => manager.contexts.has(index) },
        contexts: new Map(),
        initializingContexts: new Set(),
        scheduler: {
            account: index => ({ inflight: index === 0 ? 1 : 0 }),
            closed: false,
            config: { maxWorkers: limit },
        },
    });
    return manager;
}
test("context setup is serialized and never evicts leased contexts", async () => {
    const manager = browserFixture(2);
    await Promise.all([manager.ensureWorkerContext(0), manager.ensureWorkerContext(1), manager.ensureWorkerContext(2)]);
    assert.equal(manager.peak, 2);
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
