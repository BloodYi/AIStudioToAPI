const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const BrowserManager = require("../src/core/BrowserManager");
const loadConfig = require("../src/core/SchedulerConfig");
const logger = { error() {}, warn() {} };
function setup(count = 4, statePath = null) {
    const auth = {
        accountLoginService: {
            invalidated: new Set(),
            state: { accounts: Array.from({ length: count }, (_, i) => ({ authIndex: i, sessionVersion: 1 })) },
        },
        accountNameMap: new Map(),
        availableIndices: Array.from({ length: count }, (_, i) => i),
        getRotationIndices() {
            return this.availableIndices;
        },
        isExpired: () => false,
    };
    const scheduler = new ModelScheduler({ ...loadConfig({ MAX_BROWSER_WORKERS: "1" }), statePath }, auth, logger);
    return scheduler;
}

test("new Pro accounts add 50 each; Ultra/free do not get a fabricated Pro quota", t => {
    const s = setup();
    t.after(() => s.close());
    s.noteBenefitState(0, "ready-paid", "TIER1", 1);
    s.noteBenefitState(1, "ready-paid", "TIER1", 1);
    s.noteBenefitState(2, "ready-paid", "TIER2", 1);
    s.noteBenefitState(3, "ready-free", null, 1);
    Object.assign(s.slot(s.account(0), "gemini-4-argon"), { daily_request_count: 2 });
    Object.assign(s.slot(s.account(1), "gemini-4-argon"), { daily_request_count: 3 });
    assert.deepEqual(s.argonBenefitsSnapshot(), {
        pro_accounts: 2,
        pro_daily_limit: 50,
        pro_daily_requests: 5,
        pro_estimated_remaining: 95,
        ultra_accounts: 1,
    });
    assert.equal(s.isResourceEligible(s.account(3), "gemini-4-argon"), false);
    assert.equal(s.isResourceEligible(s.account(1), "gemini-4-argon"), true);
    assert.equal(s.getVisibleModels().has("gemini-4-argon"), true);
    s.account(1).disabled = true;
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 1);
    assert.equal(s.argonBenefitsSnapshot().pro_estimated_remaining, 48);
});

test("benefit cache survives restart but expires on new cookies, expiry, or invalidation", t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "auto-benefit-"));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const file = path.join(directory, "state.json");
    const first = setup(1, file);
    first.noteBenefitState(0, "ready-paid", "TIER1", 1);
    first.close();
    const s = setup(1, file);
    t.after(() => s.close());
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 1);
    s.authSource.accountLoginService.state.accounts[0].sessionVersion = 2;
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 0);
    assert.equal(s.needsBenefitDiscovery(0), true);
    s.noteBenefitState(0, "ready-paid", "TIER1", 1);
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 0, "late old-session callback ignored");
    s.noteBenefitState(0, "ready-paid", "TIER1", 2);
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 1);
    s.authSource.accountLoginService.invalidated.add(0);
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 0);
    s.authSource.accountLoginService.invalidated.clear();
    s.authSource.isExpired = () => true;
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 0);
});

test("automatic discovery checks imported accounts serially and waits while real requests are active", async t => {
    const s = setup(3);
    t.after(() => s.close());
    const manager = Object.create(BrowserManager.prototype);
    Object.assign(manager, { authSource: s.authSource, contexts: new Map(), scheduler: s });
    let running = 0,
        max = 0;
    const seen = [];
    manager.ensureWorkerContext = async index => {
        running++;
        max = Math.max(max, running);
        seen.push(index);
        await new Promise(resolve => setImmediate(resolve));
        running--;
        manager.contexts.clear();
        const tier = index === 0 ? "TIER1" : index === 1 ? "TIER2" : null;
        const state = tier ? "ready-paid" : "ready-free";
        manager.contexts.set(index, {
            page: { buildBenefit: { state, tier, ensure: async () => s.noteBenefitState(index, state, tier, 1) } },
        });
    };
    s.browserManager = manager;
    s.workers[0].lease = {};
    manager.discoverAccountBenefits();
    await manager._benefitDiscoveryTask;
    assert.deepEqual(seen, []);
    s.workers[0].lease = null;
    manager.discoverAccountBenefits();
    const task = manager._benefitDiscoveryTask;
    manager.discoverAccountBenefits();
    assert.equal(manager._benefitDiscoveryTask, task);
    await task;
    assert.deepEqual(seen, [0, 1, 2]);
    assert.equal(max, 1);
    assert.equal(s.argonBenefitsSnapshot().pro_accounts, 1);
    assert.equal(s.argonBenefitsSnapshot().ultra_accounts, 1);
    manager.discoverAccountBenefits();
    await manager._benefitDiscoveryTask;
    assert.equal(seen.length, 3, "known accounts not repeatedly probed");
});
