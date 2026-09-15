const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelScheduler, classifyError, getModelDailyQuota } = require("../src/core/ModelScheduler");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { error() {}, warn() {} };
function setup(overrides = {}, count = 8) {
    const config = { ...loadConfig({ MAX_BROWSER_WORKERS: "6" }), statePath: null, ...overrides };
    const auth = {
        accountNameMap: new Map(),
        availableIndices: Array.from({ length: count }, (_, i) => i),
        getRotationIndices() {
            return this.availableIndices;
        },
    };
    return new ModelScheduler(config, auth, logger);
}

test("concurrent reservations isolate accounts and cap global workers", async () => {
    const scheduler = setup();
    const leases = await Promise.all(Array.from({ length: 6 }, () => scheduler.acquire("flash")));
    assert.equal(new Set(leases.map(lease => lease.account.index)).size, 6);
    const queued = scheduler.acquire("other");
    assert.equal(scheduler.pending.length, 1);
    scheduler.release(leases[0]);
    const next = await queued;
    assert.equal(scheduler.snapshot().active_workers, 6);
    scheduler.release(next);
    leases.forEach(lease => scheduler.release(lease));
    assert.equal(scheduler.snapshot().active_workers, 0);
    scheduler.close();
});

test("429 only cools one model and recovers after deadline", async () => {
    const scheduler = setup({}, 1);
    const a = await scheduler.acquire("a");
    scheduler.startAttempt(a);
    scheduler.failure(a, { status: 429 });
    scheduler.release(a);
    await assert.rejects(scheduler.acquire("a"), /No eligible/);
    const b = await scheduler.acquire("b");
    assert.equal(b.account.healthy, true);
    scheduler.release(b);
    a.slot.cooldown_until = Date.now() - 1;
    const probe = await scheduler.acquire("a");
    assert.equal(probe.slot.rate_limited, false);
    scheduler.release(probe);
    scheduler.close();
});

test("permissions, account failures and manual recovery have distinct scope", async () => {
    const scheduler = setup({}, 1);
    const a = await scheduler.acquire("a");
    scheduler.failure(a, { message: "PERMISSION_DENIED", status: 403 });
    assert.equal(a.account.healthy, true);
    assert.equal(a.slot.unsupported, false);
    assert.ok(a.slot.cooldown_until > Date.now());
    scheduler.release(a);
    await assert.rejects(scheduler.acquire("a"));
    const b = await scheduler.acquire("b");
    scheduler.failure(b, { isAuthExpired: true });
    scheduler.release(b);
    await assert.rejects(scheduler.acquire("c"));
    scheduler.reset(0, "a");
    await assert.rejects(scheduler.acquire("a"));
    scheduler.reset(0);
    const recovered = await scheduler.acquire("a");
    scheduler.release(recovered);
    assert.equal(classifyError({ message: "Forbidden", status: 403 }), "risk_controlled");
    assert.equal(classifyError({ message: "PERMISSION_DENIED", status: 403 }), "risk_controlled");
    assert.equal(classifyError({ message: "model unsupported for account" }), "unsupported");
    assert.equal(classifyError({ message: "Invalid request", status: 400 }), "request");
    assert.equal(classifyError({ status: 503 }), "temporary");
    scheduler.close();
});

test("temporary failure backs off without disabling account", async () => {
    const scheduler = setup({ tempErrorCooldownMs: 1000 }, 1);
    for (let i = 0; i < 4; i++) {
        const lease = await scheduler.acquire("a");
        scheduler.failure(lease, { status: 503 });
        assert.equal(lease.account.healthy, true);
        assert.ok(lease.slot.cooldown_until - Date.now() <= 1000 * Math.min(4, 2 ** i));
        assert.ok(lease.slot.cooldown_until > Date.now());
        scheduler.release(lease);
        lease.slot.cooldown_until = 0;
    }
    scheduler.close();
});

test("403 risk control uses independent deterministic backoff and resets only on success", async () => {
    const scheduler = setup(
        {
            riskControlCooldownMs: 600000,
            riskControlJitter: false,
            riskControlMaxCooldownMs: 10800000,
            tempErrorCooldownMs: 1000,
        },
        1
    );
    const expected = [600000, 1800000, 3600000, 10800000, 10800000];
    for (let i = 0; i < expected.length; i++) {
        const lease = await scheduler.acquire("a");
        const before = Date.now();
        scheduler.failure(lease, { status: 403 });
        assert.ok(lease.slot.cooldown_until - before >= expected[i]);
        assert.ok(lease.slot.cooldown_until - before <= expected[i] + 20);
        assert.equal(lease.slot.risk_control_failures, i + 1);
        assert.equal(lease.slot.consecutive_failures, 0);
        assert.equal(lease.slot.last_error_kind, "risk_controlled");
        assert.equal(lease.account.healthy, true);
        assert.equal(lease.slot.unsupported, false);
        scheduler.release(lease);
        lease.slot.cooldown_until = 0;
    }
    const temporary = await scheduler.acquire("a");
    scheduler.failure(temporary, { status: 503 });
    assert.equal(temporary.slot.risk_control_failures, 5);
    assert.equal(temporary.slot.consecutive_failures, 1);
    scheduler.release(temporary);
    temporary.slot.cooldown_until = 0;
    const success = await scheduler.acquire("a");
    scheduler.startAttempt(success);
    scheduler.release(success, true);
    assert.equal(success.slot.risk_control_failures, 0);
    assert.equal(success.slot.last_error_kind, null);
    scheduler.close();
});

test("manual account disable is lease-safe and only account-wide recovery clears it", async () => {
    const scheduler = setup({ globalConcurrency: 2 }, 2);
    const active = await scheduler.acquire("a");
    const result = scheduler.disable(active.account.index);
    assert.deepEqual(result, { account_id: 0, changed: true, disabled: true });
    assert.equal(active.account.inflight, 1);
    assert.equal(scheduler.disable(0).changed, false);
    const replacement = await scheduler.acquire("a");
    assert.equal(replacement.account.index, 1);
    scheduler.release(replacement);
    scheduler.release(active, true);

    scheduler.reset(0, "a");
    assert.equal(scheduler.account(0).disabled, true);
    assert.equal(
        scheduler.eligibleAccounts("a").some(account => account.index === 0),
        false
    );
    scheduler.resetAllRateLimits();
    assert.equal(scheduler.account(0).disabled, true);
    scheduler.reset(0);
    assert.equal(scheduler.account(0).disabled, false);
    assert.equal(scheduler.account(0).disabled_at, null);
    scheduler.close();
});

test("manual account disable survives version 5 persistence and bulk enable clears it", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-disabled-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    first.disable(0);
    first.close();
    const persisted = JSON.parse(fs.readFileSync(statePath));
    assert.equal(persisted.version, 5);
    assert.equal(persisted.accounts[0].disabled, true);

    const second = setup({ statePath }, 1);
    assert.equal(second.account(0).disabled, true);
    assert.deepEqual(second.resetAllAccounts(), { reset_account_count: 1, reset_model_count: 0 });
    assert.equal(second.account(0).disabled, false);
    second.close();
    fs.rmSync(directory, { recursive: true });
});

test("minimum allocation gets next free worker and idle capacity can be borrowed", async () => {
    const scheduler = setup({ allocation: { a: { min: 3, preferred: 5 }, b: { min: 1, preferred: 1 } } });
    const borrowed = await Promise.all(Array.from({ length: 6 }, () => scheduler.acquire("a")));
    const hot = scheduler.acquire("a");
    const minority = scheduler.acquire("b");
    scheduler.release(borrowed[0]);
    const b = await minority;
    assert.equal(scheduler.pending[0].model, "a");
    scheduler.release(b);
    const a = await hot;
    scheduler.release(a);
    borrowed.forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("static allocation and per-model concurrency limit active work", async () => {
    const scheduler = setup({
        allocation: { a: { min: 0, preferred: 1 } },
        dynamic: false,
        modelConcurrency: { b: 1 },
    });
    const a = await scheduler.acquire("a");
    const b = await scheduler.acquire("b");
    const controller = new AbortController();
    const waitingA = scheduler.acquire("a", new Set(), controller.signal);
    const waitingB = scheduler.acquire("b", new Set(), controller.signal);
    assert.equal(scheduler.pending.length, 2);
    controller.abort();
    await Promise.all([assert.rejects(waitingA), assert.rejects(waitingB)]);
    scheduler.release(a);
    scheduler.release(b);
    scheduler.close();
});

test("cancellation, queue bounds and timeout do not leak reservations", async () => {
    const scheduler = setup({ globalConcurrency: 1, queueSize: 1, queueTimeoutMs: 10 }, 1);
    const lease = await scheduler.acquire("a");
    const waiting = scheduler.acquire("a");
    await assert.rejects(scheduler.acquire("a"), /Queue full/);
    await assert.rejects(waiting, /Queue timeout/);
    const controller = new AbortController();
    const cancelled = scheduler.acquire("a", new Set(), controller.signal);
    controller.abort();
    await assert.rejects(cancelled, /Client disconnected/);
    assert.equal(scheduler.pending.length, 0);
    scheduler.release(lease);
    scheduler.release(lease);
    assert.equal(lease.account.inflight, 0);
    scheduler.close();
});

test("already attempted accounts are never reused", async () => {
    const scheduler = setup({}, 1);
    await assert.rejects(scheduler.acquire("a", new Set(["auth-0"])), /No eligible/);
    scheduler.close();
});

test("state persists across restart but leases never do", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "model-scheduler-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ statePath }, 1);
    const lease = await first.acquire("a");
    first.startAttempt(lease);
    first.failure(lease, { message: "quota", status: 429 });
    first.flush();
    const second = setup({ statePath }, 1);
    const slot = second.slot(second.account(0), "a");
    assert.equal(slot.request_count, 1);
    assert.equal(slot.daily_request_count, 1);
    assert.equal(slot.daily_request_date, first.getPacificDateKey());
    assert.equal(slot.failure_count, 1);
    assert.equal(slot.inflight, 0);
    assert.equal(slot.rate_limited, true);
    await assert.rejects(second.acquire("a"));
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true });
});

test("hidden models are filtered only from management snapshots and remain schedulable", async () => {
    const scheduler = setup(
        {
            allocation: {
                "gemini-3-flash": { min: 0, preferred: 1 },
                "gemini-3-pro": { min: 0, preferred: 1 },
            },
        },
        1
    );
    const account = scheduler.account(0);
    const slot = scheduler.slot(account, "gemini-3-flash");
    Object.assign(slot, {
        cooldown_until: Date.now() + 60000,
        daily_failure_count: 2,
        daily_request_count: 7,
        failure_count: 3,
        last_error: "quota",
        rate_limited: true,
        request_count: 9,
    });
    const before = { ...slot };

    const revision = scheduler.sequence;
    assert.deepEqual(scheduler.hideModel(" models/gemini-3-flash "), {
        changed: true,
        hidden: true,
        model: "gemini-3-flash",
    });
    assert.ok(scheduler.sequence > revision);
    assert.deepEqual(scheduler.hideModel("gemini-3-flash"), {
        changed: false,
        hidden: true,
        model: "gemini-3-flash",
    });
    assert.deepEqual(scheduler.hiddenModelsSnapshot(), ["gemini-3-flash"]);
    assert.equal(scheduler._snapshotModels().has("gemini-3-flash"), true);
    assert.equal(
        scheduler.summarySnapshot().models.some(model => model.model === "gemini-3-flash"),
        false
    );
    assert.equal(
        scheduler.summarySnapshot().quota_by_model.some(model => model.model === "gemini-3-flash"),
        false
    );
    assert.equal(Object.hasOwn(scheduler.snapshot().accounts[0].models, "gemini-3-flash"), false);
    assert.deepEqual(slot, before);

    slot.cooldown_until = 0;
    slot.rate_limited = false;
    const lease = await scheduler.acquire("gemini-3-flash");
    scheduler.startAttempt(lease);
    scheduler.release(lease, true);
    assert.equal(scheduler.isModelHidden("gemini-3-flash"), true);
    assert.equal(slot.request_count, 10);
    assert.equal(
        scheduler.summarySnapshot().models.some(model => model.model === "gemini-3-flash"),
        false
    );

    assert.deepEqual(scheduler.showModel("gemini-3-flash"), {
        changed: true,
        hidden: false,
        model: "gemini-3-flash",
    });
    assert.equal(scheduler.snapshot().accounts[0].models["gemini-3-flash"].request_count, 10);
    assert.equal(scheduler.showModel("gemini-3-flash").changed, false);
    assert.throws(
        () => scheduler.hideModel("__files__"),
        error => error.status === 400
    );
    assert.throws(
        () => scheduler.hideModel("missing-model"),
        error => error.status === 404
    );
    scheduler.hideModel("gemini-3-flash");
    scheduler.hideModel("gemini-3-pro");
    const emptySnapshot = scheduler.snapshot();
    assert.deepEqual(emptySnapshot.models, []);
    assert.deepEqual(emptySnapshot.quota_by_model, []);
    assert.equal(emptySnapshot.estimated_remaining_quota, 0);
    assert.equal(emptySnapshot.quota_tracked_models, 0);
    assert.deepEqual(emptySnapshot.accounts[0].models, {});
    scheduler.close();
});

test("hidden models persist in version 5 state and legacy states default to visible", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-hidden-"));
    const statePath = path.join(directory, "state.json");
    const first = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    first.hideModel("flash");
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 5);
    const second = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    assert.deepEqual(second.hiddenModelsSnapshot(), ["flash"]);
    first.close();
    second.close();

    const legacy = JSON.parse(fs.readFileSync(statePath));
    legacy.version = 3;
    delete legacy.hiddenModels;
    fs.writeFileSync(statePath, JSON.stringify(legacy));
    const third = setup({ allocation: { flash: { min: 0, preferred: 1 } }, statePath }, 1);
    assert.deepEqual(third.hiddenModelsSnapshot(), []);
    third.close();
    fs.rmSync(directory, { recursive: true });
});

test("Pacific date keys honor PST, PDT and daylight-saving transitions", () => {
    const scheduler = setup({}, 1);
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-01-01T07:59:59Z")), "2025-12-31");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-01-01T08:00:00Z")), "2026-01-01");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-07-01T06:59:59Z")), "2026-06-30");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-07-01T07:00:00Z")), "2026-07-01");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-03-08T07:59:59Z")), "2026-03-07");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-03-08T08:00:00Z")), "2026-03-08");
    assert.equal(scheduler.getPacificDateKey(Date.parse("2026-11-01T09:30:00Z")), "2026-11-01");
    scheduler.close();
});

test("daily attempts count once per lease and roll over without changing cumulative usage", async () => {
    const scheduler = setup({ allocation: { flash: { min: 0, preferred: 1 } } }, 1);
    const lease = await scheduler.acquire("flash");
    scheduler.startAttempt(lease);
    scheduler.startAttempt(lease);
    assert.equal(lease.slot.daily_request_count, 1);
    assert.equal(lease.slot.request_count, 1);
    scheduler.release(lease);

    lease.slot.daily_request_date = "2000-01-01";
    lease.slot.daily_request_count = 9;
    lease.slot.request_count = 10;
    const snapshot = scheduler.snapshot();
    assert.equal(lease.slot.daily_request_count, 0);
    assert.equal(lease.slot.request_count, 10);
    assert.equal(snapshot.models.find(model => model.model === "flash").daily_requests, 0);
    assert.equal(snapshot.accounts[0].models.flash.daily_requests, 0);
    scheduler.close();
});

test("upstream failures use the Pacific daily window while aborts and transport errors do not", async () => {
    const scheduler = setup({}, 1);
    const lease = await scheduler.acquire("gemini-3-flash");
    scheduler.startAttempt(lease);
    scheduler.failure(lease, { message: "quota", status: 429 });
    assert.equal(lease.slot.daily_failure_count, 1);
    assert.equal(scheduler.accountsSnapshot([lease.account.index]).accounts[0].models[0].daily_failures, 1);
    scheduler.release(lease);

    const aborted = { account: lease.account, recorded: false, slot: lease.slot };
    scheduler.failure(aborted, { reason: "client_disconnect" });
    assert.equal(aborted.slot.daily_failure_count, 1);

    aborted.slot.daily_request_date = "2000-01-01";
    const cumulativeFailures = aborted.slot.failure_count;
    scheduler.summarySnapshot();
    assert.equal(aborted.slot.daily_failure_count, 0);
    assert.equal(aborted.slot.failure_count, cumulativeFailures);
    scheduler.close();
});

test("account details expose one model list with aggregate 403 and 429 flags", () => {
    const scheduler = setup({}, 1);
    const account = scheduler.account(0);
    const riskControlled = scheduler.slot(account, "risk-model");
    riskControlled.last_error_kind = "risk_controlled";
    riskControlled.risk_control_failures = 1;
    riskControlled.cooldown_until = Date.now() + 60_000;
    const rateLimited = scheduler.slot(account, "rate-model");
    rateLimited.rate_limited = true;
    rateLimited.cooldown_until = Date.now() + 60_000;

    const details = scheduler.accountsSnapshot([0]).accounts[0];
    assert.equal(details.has_403, true);
    assert.equal(details.has_429, true);
    assert.deepEqual(
        details.models.map(slot => [slot.model, slot.status]),
        [
            ["rate-model", "RATE_LIMITED"],
            ["risk-model", "RISK_CONTROLLED"],
        ]
    );
    scheduler.close();
});

test("version 1 state preserves cumulative values and initializes daily usage at zero", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-v1-"));
    const statePath = path.join(directory, "state.json");
    fs.writeFileSync(
        statePath,
        JSON.stringify({
            accounts: [
                {
                    healthy: true,
                    key: "auth-0",
                    last_error: null,
                    models: { flash: { inflight: 3, request_count: 42 } },
                },
            ],
            fileAffinities: [],
            version: 1,
        })
    );
    const scheduler = setup({ statePath }, 1);
    const slot = scheduler.slot(scheduler.account(0), "flash");
    assert.equal(slot.request_count, 42);
    assert.equal(slot.daily_request_count, 0);
    assert.equal(slot.daily_request_date, scheduler.getPacificDateKey());
    assert.equal(slot.inflight, 0);
    scheduler.close();
    fs.rmSync(directory, { recursive: true });
});

test("quota estimates use valid accounts, hyphen segments and clamp each slot at zero", () => {
    assert.equal(getModelDailyQuota("gemini-3-flash"), 100);
    assert.equal(getModelDailyQuota("gemini-3-flash-lite"), 100);
    assert.equal(getModelDailyQuota("gemini-3-pro-preview"), 10);
    assert.equal(getModelDailyQuota("gemini-profile"), null);
    assert.equal(getModelDailyQuota("flashlight"), null);
    assert.equal(getModelDailyQuota("imagen-flash"), null);
    assert.equal(getModelDailyQuota("__files__"), null);

    const auth = {
        accountNameMap: new Map([
            [0, "first@example.com"],
            [2, "second@example.com"],
        ]),
        availableIndices: [0, 1, 2, 3],
        getRotationIndices: () => [0, 2],
    };
    const config = {
        ...loadConfig({ MAX_BROWSER_WORKERS: "4" }),
        allocation: {
            "gemini-3-flash": { min: 0, preferred: 1 },
            "gemini-3-flash-lite": { min: 0, preferred: 1 },
            "gemini-3-pro-preview": { min: 0, preferred: 1 },
            "text-embedding": { min: 0, preferred: 1 },
        },
        statePath: null,
    };
    const scheduler = new ModelScheduler(config, auth, logger);
    const firstFlash = scheduler.slot(scheduler.account(0), "gemini-3-flash");
    const secondFlash = scheduler.slot(scheduler.account(2), "gemini-3-flash");
    firstFlash.daily_request_count = 120;
    secondFlash.daily_request_count = 3;
    scheduler.account(0).healthy = false;
    firstFlash.rate_limited = true;
    const snapshot = scheduler.snapshot();
    assert.equal(snapshot.quota_tracked_accounts, 2);
    assert.equal(snapshot.quota_tracked_models, 3);
    assert.equal(snapshot.estimated_remaining_quota, 317);
    assert.deepEqual(
        snapshot.quota_by_model.map(item => item.model),
        ["gemini-3-flash", "gemini-3-flash-lite", "gemini-3-pro-preview"]
    );
    assert.equal(snapshot.quota_by_model.find(item => item.model === "gemini-3-flash").estimated_remaining_quota, 97);
    assert.equal(snapshot.models.find(model => model.model === "gemini-3-flash").daily_requests, 123);
    scheduler.close();
});

test("configuration validates capacity and honors legacy mode", () => {
    assert.equal(loadConfig({ ACCOUNT_ROTATION_STRATEGY: "legacy" }).enabled, false);
    assert.throws(() => loadConfig({ MAX_BROWSER_WORKERS: "0" }));
    assert.throws(() => loadConfig({ MODEL_WORKER_ALLOCATION: '{"a":2}' }));
    assert.throws(() => loadConfig({ MODEL_MAX_CONCURRENCY: '{"a":0}' }));
    assert.equal(loadConfig({ MAX_RETRIES_PER_REQUEST: "0" }).maxRetries, 0);
});

test("corrupt state is backed up and inflight reset does not persist a lock", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "scheduler-corrupt-"));
    const statePath = path.join(directory, "state.json");
    fs.writeFileSync(statePath, "{partial");
    const scheduler = setup({ statePath });
    assert.equal(scheduler.accounts.size, 0);
    assert.ok(fs.readdirSync(directory).some(name => name.includes(".corrupt-")));
    scheduler.close();
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 5);
    fs.rmSync(directory, { recursive: true });
});

test("bulk 429 reset preserves other failures, statistics and active leases", async () => {
    const scheduler = setup({}, 2);
    const active = await scheduler.acquire("running");
    for (const index of [0, 1]) {
        const slot = scheduler.slot(scheduler.account(index), "limited");
        Object.assign(slot, {
            cooldown_until: Date.now() + 60000,
            failure_count: 4,
            last_error: "quota",
            rate_limited: true,
        });
    }
    const other = scheduler.slot(scheduler.account(0), "temporary");
    Object.assign(other, { cooldown_until: Date.now() + 30000, unsupported: true });
    scheduler.account(1).healthy = false;
    const before = { ...other };
    assert.equal(scheduler.resetAllRateLimits(), 2);
    for (const index of [0, 1]) {
        const slot = scheduler.account(index).models.limited;
        assert.equal(slot.rate_limited, false);
        assert.equal(slot.cooldown_until, 0);
        assert.equal(slot.failure_count, 4);
        assert.equal(slot.last_error, "quota");
    }
    assert.deepEqual(other, before);
    assert.equal(scheduler.account(1).healthy, false);
    assert.equal(active.account.inflight, 1);
    assert.equal(scheduler.resetAllRateLimits(), 0);
    scheduler.startAttempt(active);
    scheduler.failure(active, { status: 429 });
    assert.equal(active.slot.rate_limited, true);
    scheduler.release(active);
    scheduler.close();
});

test("enabling all rotation accounts clears scheduler blocks but preserves usage and active leases", async () => {
    const scheduler = setup({ globalConcurrency: 2, maxWorkers: 1 }, 2);
    const active = await scheduler.acquire("flash");
    scheduler.startAttempt(active);
    Object.assign(active.account, { healthy: false, last_error: "login failed" });
    Object.assign(active.slot, {
        consecutive_failures: 3,
        cooldown_until: Date.now() + 60000,
        failure_count: 7,
        last_error: "risk",
        rate_limited: true,
        success_count: 5,
        unsupported: true,
    });
    const second = scheduler.slot(scheduler.account(1), "pro");
    second.cooldown_until = Date.now() + 30000;
    second.consecutive_failures = 1;
    second.last_error = "temporary";
    const usageBefore = {
        daily: active.slot.daily_request_count,
        failures: active.slot.failure_count,
        requests: active.slot.request_count,
        success: active.slot.success_count,
    };

    assert.deepEqual(scheduler.resetAllAccounts(), { reset_account_count: 1, reset_model_count: 2 });
    assert.equal(active.account.healthy, true);
    assert.equal(active.account.last_error, null);
    assert.equal(active.account.inflight, 1);
    assert.equal(active.slot.inflight, 1);
    assert.equal(active.worker.lease, active);
    assert.equal(active.slot.unsupported, false);
    assert.equal(active.slot.rate_limited, false);
    assert.equal(active.slot.cooldown_until, 0);
    assert.equal(active.slot.consecutive_failures, 0);
    assert.equal(active.slot.last_error, null);
    assert.deepEqual(
        {
            daily: active.slot.daily_request_count,
            failures: active.slot.failure_count,
            requests: active.slot.request_count,
            success: active.slot.success_count,
        },
        usageBefore
    );
    assert.deepEqual(scheduler.resetAllAccounts(), { reset_account_count: 0, reset_model_count: 0 });

    scheduler.failure(active, { status: 403 });
    assert.ok(active.slot.cooldown_until > Date.now());
    scheduler.release(active);
    scheduler.close();
});

test("one account fills global concurrency independently of context capacity", async () => {
    const scheduler = setup({ globalConcurrency: 12, maxWorkers: 1 }, 1);
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.equal(scheduler.account(0).inflight, 12);
    assert.equal(scheduler.pending.length, 0);
    scheduler.startAttempt(leases[0]);
    scheduler.startAttempt(leases[0]);
    scheduler.failure(leases[0], { status: 429 });
    scheduler.failure(leases[0], { status: 429 });
    scheduler.release(leases[1], true);
    await assert.rejects(scheduler.acquire("a"), /No eligible/);
    const other = await scheduler.acquire("b");
    assert.equal(other.account.index, 0);
    assert.equal(leases[0].slot.request_count, 1);
    assert.equal(leases[0].slot.failure_count, 1);
    assert.equal(leases[0].slot.rate_limited, true);
    scheduler.release(other);
    leases.forEach(lease => scheduler.release(lease));
    assert.equal(scheduler.account(0).inflight, 0);
    scheduler.close();
});

test("account and model caps queue independently and zero model cap overrides inheritance", async () => {
    const scheduler = setup({ accountConcurrency: 3, accountModelConcurrency: { a: 1, b: 0 } }, 1);
    const a = await scheduler.acquire("a");
    const queued = scheduler.acquire("a");
    const b = await scheduler.acquire("b");
    const c = await scheduler.acquire("b");
    assert.equal(scheduler.pending.length, 1);
    scheduler.release(a);
    const next = await queued;
    [b, c, next].forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("context reservations reuse busy accounts instead of overbooking browser capacity", async () => {
    const scheduler = setup({ globalConcurrency: 12, maxWorkers: 2 });
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.equal(new Set(leases.map(lease => lease.account.index)).size, 2);
    assert.equal(scheduler.account(0).inflight, 6);
    assert.equal(scheduler.account(1).inflight, 6);
    leases.forEach(lease => scheduler.release(lease));
    const rotated = await scheduler.acquire("a");
    assert.equal(rotated.account.index, 2);
    scheduler.release(rotated);
    scheduler.close();
});

test("concurrency config accepts independent capacities and rejects invalid account limits", () => {
    const config = loadConfig({ GLOBAL_MAX_CONCURRENCY: "24", MAX_BROWSER_WORKERS: "1" });
    assert.equal(config.globalConcurrency, 24);
    assert.equal(config.accountConcurrency, 0);
    assert.throws(() => loadConfig({ ACCOUNT_MAX_CONCURRENCY: "-1" }));
    assert.throws(() => loadConfig({ ACCOUNT_MODEL_MAX_CONCURRENCY: '{"a":-1}' }));
    assert.throws(() => loadConfig({ ACCOUNT_MODEL_MAX_CONCURRENCY: '{"a":"2"}' }));
});

test("a model needing a cold account eventually gets a context under sustained hot traffic", async () => {
    const scheduler = setup({ globalConcurrency: 3, maxWorkers: 1 }, 2);
    scheduler.slot(scheduler.account(0), "b").unsupported = true;
    const running = await Promise.all([scheduler.acquire("a"), scheduler.acquire("a")]);
    const minority = scheduler.acquire("b");
    const hot = scheduler.acquire("a");
    assert.equal(scheduler.pending.length, 2);
    scheduler.release(running[0]);
    assert.equal(scheduler.pending.length, 2);
    scheduler.release(running[1]);
    const b = await minority;
    assert.equal(b.account.index, 1);
    const a = await hot;
    scheduler.release(a);
    scheduler.release(b);
    scheduler.close();
});

test("ready-only scheduling spreads leases and signals cold context demand", async () => {
    const scheduler = setup(
        { contextMaxConcurrency: 0, globalConcurrency: 12, maxWorkers: 3, readyContextOnly: true },
        4
    );
    const ready = new Set([0, 1, 2]);
    const demands = [];
    scheduler.browserManager = {
        isContextReady: index => ready.has(index),
        requestContext: (index, model) => demands.push({ index, model }),
    };
    const leases = await Promise.all(Array.from({ length: 12 }, () => scheduler.acquire("a")));
    assert.deepEqual(
        [0, 1, 2].map(index => scheduler.account(index).inflight),
        [4, 4, 4]
    );
    leases.forEach(lease => scheduler.release(lease));
    ready.clear();
    const controller = new AbortController();
    const waiting = scheduler.acquire("cold", new Set(), controller.signal);
    assert.deepEqual(demands.at(-1), { index: 0, model: "cold" });
    controller.abort();
    await assert.rejects(waiting, /Client disconnected/);
    scheduler.close();
});

test("local queue and WebSocket failures never cool account-model state", async () => {
    const scheduler = setup({}, 1);
    for (const reason of ["page_closed", "connection_lost", "grace_period_timeout"]) {
        const lease = await scheduler.acquire("a");
        scheduler.failure(lease, { code: "QUEUE_CLOSED", reason });
        assert.equal(lease.slot.cooldown_until, 0);
        assert.equal(lease.slot.failure_count, 0);
        scheduler.release(lease);
    }
    assert.equal(scheduler.metrics.local_transport, 3);
    scheduler.close();
});

test("new context configuration validates pool and capacity limits", () => {
    const defaults = loadConfig({});
    assert.equal(defaults.contextCreationTimeoutMs, 120000);
    assert.equal(defaults.riskControlCooldownMs, 600000);
    assert.equal(defaults.riskControlMaxCooldownMs, 10800000);
    const config = loadConfig({
        CONTEXT_CREATION_TIMEOUT_MS: "90000",
        CONTEXT_INIT_CONCURRENCY: "3",
        CONTEXT_MAX_CONCURRENCY: "5",
        CONTEXT_POOL_MIN_READY: "4",
        MAX_BROWSER_WORKERS: "6",
        REQUEST_DISPATCH_TIMEOUT_MS: "25000",
    });
    assert.equal(config.contextCreationTimeoutMs, 90000);
    assert.equal(config.contextInitConcurrency, 3);
    assert.equal(config.contextMaxConcurrency, 5);
    assert.equal(config.contextPoolMinReady, 4);
    assert.equal(config.queueTimeoutMs, 25000);
    assert.throws(() => loadConfig({ CONTEXT_POOL_MIN_READY: "3", MAX_BROWSER_WORKERS: "2" }));
    assert.throws(() => loadConfig({ CONTEXT_CREATION_TIMEOUT_MS: "0" }), /Invalid CONTEXT_CREATION_TIMEOUT_MS/);
});

test("100 requests spread across 12 ready contexts without header-style serialization", async () => {
    const scheduler = setup(
        { contextMaxConcurrency: 0, globalConcurrency: 100, maxWorkers: 12, readyContextOnly: true },
        12
    );
    scheduler.browserManager = { isContextReady: () => true, requestContext() {} };
    const leases = await Promise.all(Array.from({ length: 100 }, () => scheduler.acquire("a")));
    const distribution = Array.from({ length: 12 }, (_, index) => scheduler.account(index).inflight);
    assert.equal(
        distribution.reduce((sum, value) => sum + value, 0),
        100
    );
    assert.ok(Math.max(...distribution) - Math.min(...distribution) <= 1);
    leases.forEach(lease => scheduler.release(lease));
    scheduler.close();
});

test("cold model demand does not block requests using an existing ready context", async () => {
    const scheduler = setup({ contextPoolMinReady: 1, globalConcurrency: 2, maxWorkers: 2, readyContextOnly: true }, 2);
    scheduler.slot(scheduler.account(0), "cold-model").unsupported = true;
    const demanded = [];
    scheduler.browserManager = {
        isContextReady: index => index === 0,
        requestContext: index => demanded.push(index),
    };
    const controller = new AbortController();
    const cold = scheduler.acquire("cold-model", new Set(), controller.signal);
    const hot = await scheduler.acquire("hot-model");
    assert.equal(hot.account.index, 0);
    assert.ok(demanded.includes(1));
    controller.abort();
    await assert.rejects(cold);
    scheduler.release(hot);
    scheduler.close();
});
