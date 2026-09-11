const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const UsageStatsService = require("../src/core/UsageStatsService");
const LoggingService = require("../src/utils/LoggingService");
const StatusRoutes = require("../src/routes/StatusRoutes");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("usage summary is bounded and records use stable opaque cursors", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-page-"));
    const service = new UsageStatsService({ accountNameMap: new Map() }, logger, directory);
    for (let index = 1; index <= 25; index++) {
        service.startRequest(`request-${index}`, { model: index % 2 ? "flash" : "pro" });
        service.finishRequest(`request-${index}`, { outcome: index % 3 ? "success" : "error", statusCode: 200 });
    }
    const summary = service.getSummarySnapshot();
    assert.equal(Object.hasOwn(summary, "records"), false);
    assert.equal(summary.summary.totalRequests, 25);
    assert.equal(summary.summary.successCount + summary.summary.errorCount, 25);
    assert.equal(
        summary.models.reduce((total, model) => total + model.totalRequests, 0),
        25
    );

    const first = service.queryRecords({ limit: 10 });
    const second = service.queryRecords({ cursor: first.next_cursor, limit: 10 });
    assert.equal(first.records.length, 10);
    assert.equal(second.records.length, 10);
    assert.equal(new Set([...first.records, ...second.records].map(record => record.requestId)).size, 20);
    assert.ok(first.records[0].sequence > first.records.at(-1).sequence);

    const deltaOne = service.queryRecords({ after_sequence: 0, dataset_revision: first.dataset_revision, limit: 10 });
    const deltaTwo = service.queryRecords({
        after_sequence: deltaOne.latest_sequence,
        dataset_revision: first.dataset_revision,
        limit: 10,
    });
    assert.equal(deltaOne.has_more, true);
    assert.equal(new Set([...deltaOne.records, ...deltaTwo.records].map(record => record.sequence)).size, 20);

    await service.importJsonl(service.records.map(record => JSON.stringify(record)).join("\n"));
    const stale = service.queryRecords({ cursor: first.next_cursor, limit: 10 });
    assert.equal(stale.reset, true);
    fs.rmSync(directory, { recursive: true });
});

test("log polling returns a recent window followed by cursor deltas", () => {
    const service = new LoggingService("test");
    service.info("one");
    const initial = service.getLogsAfter();
    assert.equal(initial.reset, true);
    assert.equal(initial.lines.length, 1);
    service.warn("two");
    const delta = service.getLogsAfter(initial.cursor);
    assert.equal(delta.reset, false);
    assert.equal(delta.lines.length, 1);
    assert.match(delta.lines[0], /two/);
    assert.throws(() => service.getLogsAfter("invalid"), /Invalid log cursor/);
});

test("dashboard and scheduler detail routes keep heavy fields out of realtime responses", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"]) {
        app[method] = (route, ...handlers) => {
            if (method === "get") routes.set(route, handlers);
        };
    }
    const logService = new LoggingService("route-test");
    const scheduler = {
        account: index => ({ healthy: true, index, inflight: 0, key: `auth-${index}` }),
        accountsSnapshot: ids => ({ accounts: ids.map(index => ({ index, models: [] })), revision: "accounts:1" }),
        contextsSnapshot: () => ({ contexts: [], revision: "contexts:1" }),
        sequence: 1,
        summarySnapshot: () => ({
            active_workers: 0,
            contexts_summary: { busy: 0, initializing: 0, max: 1, ready: 0, reconnecting: 0, unavailable: 0 },
            idle_workers: 1,
            models: [],
            queued_requests: 0,
            quota_by_model: [],
            usage_window: { date: "2026-09-11", timezone: "America/Los_Angeles" },
        }),
        workers: [],
    };
    const authSource = {
        accountNameMap: new Map([[0, "one@example.com"]]),
        availableIndices: [0],
        duplicateIndices: [],
        expiredIndices: [],
        getCanonicalIndex: index => index,
        getRotationIndices: () => [0],
        initialIndices: [0],
    };
    const serverSystem = {
        authSource,
        browserManager: { contexts: new Map() },
        config: {
            apiKeySource: "test",
            checkUpdate: false,
            enableAuthUpdate: false,
            failureThreshold: 0,
            forceCodeExecution: false,
            forceThinking: false,
            forceUrlContext: false,
            forceWebSearch: false,
            immediateSwitchStatusCodes: [],
            maxContexts: 1,
            maxRetries: 1,
            safetySettingsThreshold: "OFF",
            streamingMode: "real",
            switchOnUses: 0,
        },
        connectionRegistry: { connectionsByAuth: new Map() },
        distIndexPath: "",
        logger: logService,
        requestHandler: { currentAuthIndex: 0, failureCount: 0, isSystemBusy: false, usageCount: 0 },
        scheduler,
    };
    new StatusRoutes(serverSystem).setupRoutes(app, (req, res, next) => next());

    const invoke = (route, query = {}, headers = {}) => {
        const response = {
            body: null,
            end() {
                return this;
            },
            headers: {},
            json(body) {
                this.body = body;
                return this;
            },
            setHeader(name, value) {
                this.headers[name] = value;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        const handlers = routes.get(route);
        let index = 0;
        const next = () => handlers[++index]({ headers, query }, response, next);
        handlers[0]({ headers, query }, response, next);
        return response;
    };

    const dashboard = invoke("/api/dashboard/realtime");
    assert.equal(dashboard.statusCode, 200);
    assert.equal(typeof dashboard.body.generated_at, "string");
    for (const field of ["accounts", "contexts", "logs", "records", "workers"])
        assert.equal(Object.hasOwn(dashboard.body.scheduler, field), false);
    const cached = invoke("/api/dashboard/realtime", {}, { "if-none-match": dashboard.headers.ETag });
    assert.equal(cached.statusCode, 304);
    assert.deepEqual(invoke("/api/scheduler/accounts", { ids: "0" }).body.accounts[0].models, []);
    assert.equal(invoke("/api/scheduler/accounts", { ids: "bad" }).statusCode, 400);
});

test("scheduler model visibility routes authenticate and return stable results", async () => {
    const routes = new Map();
    const app = {};
    for (const method of ["delete", "get", "post", "put", "use"])
        app[method] = (route, ...handlers) => routes.set(`${method}:${route}`, handlers);
    const hidden = new Set(["z-model", "a-model"]);
    const scheduler = {
        hiddenModelsSnapshot: () => [...hidden].sort(),
        hideModel(model) {
            if (model === "missing") throw Object.assign(new Error("Unknown scheduler model missing"), { status: 404 });
            const changed = !hidden.has(model);
            hidden.add(model);
            return { changed, hidden: true, model };
        },
        showModel(model) {
            const changed = hidden.delete(model);
            return { changed, hidden: false, model };
        },
        workers: [],
    };
    const serverSystem = { config: {}, distIndexPath: "", logger, requestHandler: {}, scheduler };
    const isAuthenticated = (req, res, next) =>
        req.authenticated ? next() : res.status(401).json({ error: "Unauthorized" });
    new StatusRoutes(serverSystem).setupRoutes(app, isAuthenticated);

    const invoke = async (method, route, { authenticated = true, body } = {}) => {
        const response = {
            json(value) {
                this.body = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
        };
        const handlers = routes.get(`${method}:${route}`);
        let index = 0;
        const request = { authenticated, body };
        const next = () => handlers[++index](request, response, next);
        await handlers[0](request, response, next);
        return response;
    };

    assert.equal((await invoke("post", "/api/scheduler/models/hide", { authenticated: false })).statusCode, 401);
    assert.deepEqual((await invoke("get", "/api/scheduler/models/hidden")).body.models, ["a-model", "z-model"]);
    assert.deepEqual((await invoke("post", "/api/scheduler/models/hide", { body: { model: "new-model" } })).body, {
        changed: true,
        hidden: true,
        model: "new-model",
        success: true,
    });
    assert.equal((await invoke("post", "/api/scheduler/models/hide", { body: { model: "missing" } })).statusCode, 404);
    assert.deepEqual((await invoke("post", "/api/scheduler/models/show", { body: { model: "new-model" } })).body, {
        changed: true,
        hidden: false,
        model: "new-model",
        success: true,
    });
});
