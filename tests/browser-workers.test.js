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
            this.peak = Math.max(this.peak || 0, this.contexts.size);
        },
        async _startBackgroundWakeup() {},
        _startHealthMonitor() {},
        abortedContexts: new Set(),
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
        pendingContextClosures: new Map(),
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

test("disabled accounts are excluded from context demand and warm candidates", () => {
    const manager = browserFixture(2);
    manager.scheduler.config.contextPoolMinReady = 2;
    manager.scheduler.isAccountManuallyDisabled = index => index === 1;
    manager.requestContext(1, "flash");
    assert.equal(manager.contextDemand.has(1), false);
    manager.contextDemand.set(1, { model: "flash" });
    manager.contextDemand.set(2, { model: "flash" });
    assert.deepEqual(manager._poolCandidates(), [2, 0]);
    manager.scheduler.closed = true;
});

test("context eviction ranks disabled state, demand, and true request LRU", () => {
    const manager = browserFixture(3);
    const accounts = new Map(
        [0, 1, 2].map(index => [index, { disabled: false, healthy: true, inflight: 0, models: {} }])
    );
    manager.scheduler.account = index => accounts.get(index);
    manager.scheduler.isAccountManuallyDisabled = index => accounts.get(index).disabled;
    manager.contexts = new Map([
        [0, { createdAt: 10, lastRequestAt: 300, page: { isClosed: () => false }, state: "READY" }],
        [1, { createdAt: 20, lastRequestAt: 100, page: { isClosed: () => false }, state: "READY" }],
        [2, { createdAt: 30, lastRequestAt: 200, page: { isClosed: () => false }, state: "READY" }],
    ]);
    assert.deepEqual(
        [0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b)),
        [1, 2, 0]
    );
    manager.contextDemand.set(1, { model: "flash" });
    assert.deepEqual(
        [0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b)),
        [2, 0, 1]
    );
    accounts.get(0).disabled = true;
    assert.equal([0, 1, 2].sort((a, b) => manager._compareContextEviction(a, b))[0], 0);
    manager.markContextRequest(2, 400);
    assert.equal(manager.contexts.get(2).lastRequestAt, 400);
});

test("disabling a busy context drains without interrupting it and closes after release", async () => {
    const manager = browserFixture(1);
    const account = { disabled: true, healthy: true, inflight: 1, models: {} };
    manager.scheduler.account = () => account;
    manager.contexts.set(0, { page: { isClosed: () => false }, state: "READY" });
    manager.handleAccountDisabled(0);
    assert.equal(manager.contexts.get(0).draining, true);
    assert.equal(manager.pendingContextClosures.get(0), "account_disabled");
    assert.equal(manager.contexts.has(0), true);

    let pumps = 0;
    manager._isSystemBusyProvider = () => true;
    manager._pumpContextPool = () => pumps++;
    account.inflight = 0;
    manager.handleAccountLeaseReleased(0);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(manager.contexts.has(0), false);
    assert.equal(pumps, 1);
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
    await Promise.all(Array.from({ length: 20 }, () => manager.ensureWorkerContext(0)));
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

test("browser context creation is serialized while later initialization can remain parallel", async () => {
    const manager = Object.create(BrowserManager.prototype);
    const pending = [];
    let activeCreations = 0;
    let peakCreations = 0;
    manager._contextCreationQueue = Promise.resolve();
    manager.contextCreationTimeoutMs = 1000;
    manager.browser = {
        newContext() {
            activeCreations++;
            peakCreations = Math.max(peakCreations, activeCreations);
            return new Promise(resolve => {
                pending.push(() => {
                    activeCreations--;
                    resolve({ close: async () => {} });
                });
            });
        },
    };

    const first = manager._createBrowserContext({}, 0);
    const second = manager._createBrowserContext({}, 1);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);

    pending.shift()();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(pending.length, 1);

    pending.shift()();
    await Promise.all([first, second]);
    assert.equal(peakCreations, 1);
});

test("browser context creation timeout releases the lock and closes a late orphan", async () => {
    const manager = Object.create(BrowserManager.prototype);
    let resolveStalled;
    let lateContextClosed = false;
    let calls = 0;
    manager._contextCreationQueue = Promise.resolve();
    manager.contextCreationTimeoutMs = 10;
    manager.browser = {
        newContext() {
            calls++;
            if (calls === 1) {
                return new Promise(resolve => {
                    resolveStalled = resolve;
                });
            }
            return Promise.resolve({ close: async () => {} });
        },
    };

    await assert.rejects(manager._createBrowserContext({}, 0), error => {
        assert.equal(error.code, "CONTEXT_CREATION_TIMEOUT");
        return true;
    });
    await manager._createBrowserContext({}, 1);
    assert.equal(calls, 2);

    resolveStalled({
        async close() {
            lateContextClosed = true;
        },
    });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(lateContextClosed, true);
});

function singleFlightFixture() {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _contextInitSequence: 0,
        _contextInitTasks: new Map(),
        _wsInitState: new Map(),
        abortedContexts: new Set(),
        initializingContexts: new Set(),
        logger,
    });
    return manager;
}

function websocketWaitFixture(registry = null) {
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, {
        _backgroundPreloadAbort: false,
        _checkPageErrors: async () => ({}),
        _clickButtonByTextIfVisible: async () => false,
        _findAndClickButtonByText: async () => ({ clicked: false, found: false }),
        _simulateHumanMovement: async () => {},
        abortedContexts: new Set(),
        connectionRegistry: registry,
        consentRetryIntervalMs: 0,
        consentTimeoutGraceMs: 5,
        logger,
    });
    return manager;
}

function waitPage() {
    return {
        viewportSize: () => ({ height: 10, width: 10 }),
        async waitForTimeout() {
            await new Promise(resolve => setTimeout(resolve, 2));
        },
    };
}

test("single-flight publishes one exact Promise and result to 20 same-account callers", async () => {
    const manager = singleFlightFixture();
    let creations = 0;
    const result = { context: {}, page: {} };
    manager._initializeContext = async () => {
        creations++;
        await new Promise(resolve => setImmediate(resolve));
        return result;
    };

    const tasks = Array.from({ length: 20 }, () => manager._getOrStartContextInit(7));
    assert.ok(tasks.every(task => task === tasks[0]));
    assert.ok((await Promise.all(tasks)).every(value => value === result));
    assert.equal(creations, 1);
    assert.equal(manager.initializingContexts.size, 0);
});

test("pool warmup and foreground switch join the same account initialization", async () => {
    const manager = browserFixture(2);
    manager.connectionRegistry.getConnectionEpoch = () => null;
    manager.authSource.isExpired = () => false;
    manager.authSource.markAsExpired = async () => {};
    manager.authSource.unmarkAsExpired = async () => {};
    manager._cancelPendingContextClosure = () => {};
    manager._flushPendingContextClosures = async () => {};
    manager._updateAuthFile = async () => {};
    manager._activateContext = () => {};
    let creations = 0;
    manager._initializeContext = async index => {
        creations++;
        await new Promise(resolve => setImmediate(resolve));
        const context = {};
        const page = {
            isClosed: () => false,
            title: async () => "AI Studio",
            url: () => "https://ai.studio/apps/test",
        };
        manager.contexts.set(index, { context, page, state: "READY" });
        return { context, page };
    };

    const warmup = manager._startPooledContext(0);
    const foreground = manager.launchOrSwitchContext(0);
    await Promise.all([warmup, foreground]);
    assert.equal(creations, 1);
});

test("an account-level observability overwrite cannot replace an attempt's success state", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 3, id: "3:1", ws: { failed: false, success: true } };
    manager._wsInitState = new Map([[3, { failed: false, success: false }]]);
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), true);
});

test("a failed old attempt closes only its local context and preserves a newer map entry", async () => {
    const manager = singleFlightFixture();
    let localClosed = false;
    const localContext = {
        addInitScript: async () => {},
        close: async () => {
            localClosed = true;
        },
        newPage: async () => ({
            bringToFront: async () => {},
            evaluate: async () => {},
            isClosed: () => true,
            on: () => {},
            viewportSize: () => ({ height: 10, width: 10 }),
        }),
    };
    Object.assign(manager, {
        _backgroundPreloadAbort: false,
        _createBrowserContext: async () => localContext,
        _getPrivacyProtectionScript: () => "",
        _navigateAndWakeUpPage: async () => {
            throw new Error("navigation failed");
        },
        _saveDebugArtifacts: async () => {},
        _simulateHumanMovement: async () => {},
        authSource: { getAuth: () => ({}) },
        contexts: new Map([[0, { attemptId: "0:2", context: {}, page: {} }]]),
        stickyProxyManager: { getProxyForAuth: () => null },
    });
    await assert.rejects(
        manager._initializeContext(0, true, {
            authIndex: 0,
            connectionEpoch: null,
            id: "0:1",
            ws: { failed: false, success: false },
        }),
        error => error.reason === "navigation_timeout"
    );
    assert.equal(manager.contexts.get(0).attemptId, "0:2");
    assert.equal(localClosed, true);
});

test("a newer OPEN registry epoch succeeds even when the console event is missing", async () => {
    const registry = {
        getConnectionByAuth: () => ({ readyState: 1 }),
        getConnectionEpoch: () => 2,
    };
    const manager = websocketWaitFixture(registry);
    const attempt = { authIndex: 0, connectionEpoch: 1, id: "0:1", ws: { failed: false, success: false } };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), true);
});

test("an old registry epoch is not accepted as initialization success", async () => {
    const registry = {
        getConnectionByAuth: () => ({ readyState: 1 }),
        getConnectionEpoch: () => 4,
    };
    const manager = websocketWaitFixture(registry);
    const attempt = { authIndex: 0, connectionEpoch: 4, id: "0:1", ws: { failed: false, success: false } };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 5, attempt, false), false);
    assert.equal(attempt.failureReason, "ws_connection_timeout");
});

test("consent is retried after an ineffective click and succeeds on the second click", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    let clicks = 0;
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => {
        if (text !== "Continue to the app") return { clicked: false, found: false };
        if (click) clicks++;
        if (clicks === 2) attempt.ws.success = true;
        return { clicked: click, found: true };
    };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 20, attempt, false), true);
    assert.equal(clicks, 2);
});

test("consent appearing at the timeout boundary can connect during the bounded grace period", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    let checks = 0;
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => {
        if (text !== "Continue to the app") return { clicked: false, found: false };
        checks++;
        const found = checks >= 2;
        if (found && click && checks >= 3) attempt.ws.success = true;
        return { clicked: found && click, found };
    };
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 3, attempt, false), true);
});

test("a consent dialog that never closes reports consent_dialog_timeout", async () => {
    const manager = websocketWaitFixture();
    const attempt = { authIndex: 0, connectionEpoch: null, id: "0:1", ws: { failed: false, success: false } };
    manager._findAndClickButtonByText = async (_page, text, _prefix, _name, click) => ({
        clicked: text === "Continue to the app" && click,
        found: text === "Continue to the app",
    });
    assert.equal(await manager._waitForWebSocketInit(waitPage(), "[Test]", 3, attempt, false), false);
    assert.equal(attempt.failureReason, "consent_dialog_timeout");
});

test("100 cold accounts with 16-worker capacity and two launchers never overlap attempts per account", async () => {
    const manager = singleFlightFixture();
    manager.scheduler = { config: { contextInitConcurrency: 2, maxWorkers: 16 } };
    const active = new Map();
    const peak = new Map();
    manager._initializeContext = async index => {
        active.set(index, (active.get(index) || 0) + 1);
        peak.set(index, Math.max(peak.get(index) || 0, active.get(index)));
        await new Promise(resolve => setImmediate(resolve));
        active.set(index, active.get(index) - 1);
        return index;
    };
    const accounts = Array.from({ length: 100 }, (_, index) => index);
    let cursor = 0;
    const launcher = async () => {
        while (cursor < accounts.length) {
            const index = accounts[cursor++];
            await Promise.all([manager._getOrStartContextInit(index), manager._getOrStartContextInit(index)]);
        }
    };
    await Promise.all([launcher(), launcher()]);
    assert.ok([...peak.values()].every(value => value === 1));
    assert.equal(peak.size, 100);
});
