const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelScheduler, classifyError } = require("../src/core/ModelScheduler");
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
    assert.equal(classifyError({ message: "Forbidden", status: 403 }), "request");
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
    assert.equal(slot.failure_count, 1);
    assert.equal(slot.inflight, 0);
    assert.equal(slot.rate_limited, true);
    await assert.rejects(second.acquire("a"));
    first.close();
    second.close();
    fs.rmSync(directory, { recursive: true });
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
    assert.equal(JSON.parse(fs.readFileSync(statePath)).version, 1);
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
