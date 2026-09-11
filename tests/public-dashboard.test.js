const { test } = require("node:test");
const assert = require("node:assert/strict");

const { ModelScheduler } = require("../src/core/ModelScheduler");
const loadSchedulerConfig = require("../src/core/SchedulerConfig");
const ConfigLoader = require("../src/utils/ConfigLoader");
const PublicDashboardServer = require("../src/public/PublicDashboardServer");
const PublicDashboardService = require("../src/public/PublicDashboardService");
const UsageStatsService = require("../src/core/UsageStatsService");

const logger = { debug() {}, error() {}, info() {}, warn() {} };

test("public dashboard configuration is off by default and validates ports and origins", () => {
    const names = [
        "HOST",
        "PORT",
        "PUBLIC_DASHBOARD_CORS_ORIGINS",
        "PUBLIC_DASHBOARD_ENABLED",
        "PUBLIC_DASHBOARD_HOST",
        "PUBLIC_DASHBOARD_PORT",
    ];
    const original = Object.fromEntries(names.map(name => [name, process.env[name]]));
    const restore = () => {
        for (const name of names) {
            if (original[name] === undefined) delete process.env[name];
            else process.env[name] = original[name];
        }
    };
    try {
        for (const name of names) delete process.env[name];
        process.env.HOST = "127.0.0.1";
        let config = new ConfigLoader(logger).loadConfiguration();
        assert.deepEqual(config.publicDashboard, {
            corsOrigins: [],
            enabled: false,
            host: "127.0.0.1",
            port: 7861,
        });

        process.env.PUBLIC_DASHBOARD_ENABLED = "TRUE";
        process.env.PUBLIC_DASHBOARD_PORT = "7860";
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /must differ/);
        process.env.PUBLIC_DASHBOARD_PORT = "7862";
        process.env.PUBLIC_DASHBOARD_CORS_ORIGINS = "https://status.example.org/path";
        assert.throws(() => new ConfigLoader(logger).loadConfiguration(), /Invalid PUBLIC_DASHBOARD_CORS_ORIGINS/);
        process.env.PUBLIC_DASHBOARD_CORS_ORIGINS = "https://status.example.org";
        config = new ConfigLoader(logger).loadConfiguration();
        assert.equal(config.publicDashboard.enabled, true);
        assert.deepEqual(config.publicDashboard.corsOrigins, ["https://status.example.org"]);
    } finally {
        restore();
    }
});

test("public scheduler snapshot is side-effect-free and distinguishes unknown quota", () => {
    const authSource = {
        accountNameMap: new Map([[0, "PUBLIC_MUST_NOT_SEE_ACCOUNT"]]),
        getRotationIndices: () => [0],
    };
    const config = loadSchedulerConfig({
        GLOBAL_MAX_CONCURRENCY: "2",
        MAX_BROWSER_WORKERS: "1",
        MODEL_WORKER_ALLOCATION: JSON.stringify({ "gemini-flash": 1, "unknown-model": 1 }),
    });
    const scheduler = new ModelScheduler({ ...config, statePath: null }, authSource, logger);
    assert.equal(scheduler.accounts.size, 0);
    const snapshot = scheduler.publicSummarySnapshot();
    assert.equal(scheduler.accounts.size, 0);
    assert.equal(snapshot.limit, 2);
    assert.equal(snapshot.models.find(item => item.model === "gemini-flash").estimatedRemaining, 100);
    assert.equal(snapshot.models.find(item => item.model === "unknown-model").estimatedRemaining, null);
    scheduler.close();
});

test("public history projection whitelists visible models and merges failures", () => {
    const service = new UsageStatsService(null, logger, null, false);
    service.enabled = true;
    service.summary = { abortedCount: 1, errorCount: 1, successCount: 2, totalDurationMs: 1000, totalRequests: 4 };
    service.modelStats = new Map([
        [
            "visible",
            {
                abortedCount: 1,
                accountCounts: { leaked: "public-must-not-see@example.com" },
                errorCount: 0,
                successCount: 1,
                totalDurationMs: 500,
                totalRequests: 2,
            },
        ],
        ["hidden", { abortedCount: 0, errorCount: 0, successCount: 10, totalDurationMs: 10, totalRequests: 10 }],
    ]);
    const snapshot = service.getPublicSummarySnapshot(["visible", "empty"]);
    assert.equal(snapshot.summary.failedRequests, 2);
    assert.deepEqual(
        snapshot.models.map(item => item.modelKey),
        ["empty", "visible"]
    );
    assert.equal(snapshot.models[0].successRate, null);
    assert.doesNotMatch(JSON.stringify(snapshot), /hidden|public-must-not-see/);
});

test("dashboard DTO and isolated routes expose only public data", () => {
    const scheduler = {
        publicSummarySnapshot: () => ({
            active: 1,
            limit: 2,
            models: [
                {
                    active: 1,
                    availableAccounts: 3,
                    estimatedRemaining: 99,
                    model: "gemini-flash",
                    queued: 0,
                    rateLimitedAccounts: 1,
                    secret: "PUBLIC_MUST_NOT_SEE_KEY",
                    todayRequests: 1,
                },
            ],
            queued: 0,
            usageWindow: { date: "2026-09-11", timezone: "America/Los_Angeles" },
        }),
    };
    const usageStatsService = {
        getPublicSummarySnapshot: () => ({
            enabled: true,
            models: [
                {
                    averageDurationMs: 50,
                    failedRequests: 0,
                    modelKey: "gemini-flash",
                    successRate: 100,
                    totalRequests: 1,
                },
            ],
            summary: { averageDurationMs: 50, failedRequests: 0, successRate: 100, totalRequests: 1 },
        }),
    };
    const projection = new PublicDashboardService(scheduler, usageStatsService, { cacheTtlMs: 0 }).getSnapshot();
    assert.equal(projection.models[0].quota.estimated_remaining, 99);
    assert.doesNotMatch(JSON.stringify(projection), /PUBLIC_MUST_NOT_SEE_KEY|secret/);

    const publicServer = new PublicDashboardServer({
        config: { corsOrigins: ["https://status.example.org"], host: "127.0.0.1", port: 0 },
        logger,
        scheduler,
        usageStatsService,
    });
    const app = publicServer.createApp();
    const routes = app._router.stack.filter(layer => layer.route).map(layer => layer.route);
    const paths = routes.map(route => route.path);
    assert.deepEqual(paths.sort(), ["/", "/api/public/dashboard", "/api/public/dashboard", "/healthz"].sort());
    assert.equal(paths.includes("/api/status"), false);
    assert.equal(paths.includes("/v1/models"), false);
    const dashboardRoute = routes.find(route => route.path === "/api/public/dashboard" && route.methods.get);
    assert.equal(dashboardRoute.methods.post, undefined);

    const invokeDashboard = headers => {
        const response = {
            body: null,
            end() {
                return this;
            },
            headers: {},
            json(body) {
                this.body = JSON.stringify(body);
                return this;
            },
            send(body) {
                this.body = body;
                return this;
            },
            set(name, value) {
                if (typeof name === "object") Object.assign(this.headers, name);
                else this.headers[name] = value;
                return this;
            },
            status(code) {
                this.statusCode = code;
                return this;
            },
            statusCode: 200,
            type() {
                return this;
            },
        };
        dashboardRoute.stack[0].handle(
            { get: name => headers?.[name.toLowerCase()], headers: headers || {} },
            response
        );
        return response;
    };
    const dashboard = invokeDashboard();
    assert.equal(dashboard.statusCode, 200);
    assert.ok(dashboard.headers.ETag);
    const cached = invokeDashboard({ "if-none-match": dashboard.headers.ETag });
    assert.equal(cached.statusCode, 304);
});
