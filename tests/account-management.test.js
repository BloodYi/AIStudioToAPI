const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { performance } = require("node:perf_hooks");
const Service = require("../src/accounts/AccountLoginService");
const Totp = require("../src/accounts/TotpService");
const { parseImport, Payload } = require("../src/accounts/AuthenticatorImportService");
const AccountRoutes = require("../src/routes/AccountRoutes");
const ProxyBindingService = require("../src/proxy/ProxyBindingService");
const ProxyPoolService = require("../src/proxy/ProxyPoolService");
const ProxyPoolStore = require("../src/proxy/ProxyPoolStore");
const ProxyPoolRoutes = require("../src/routes/ProxyPoolRoutes");
const { ModelScheduler } = require("../src/core/ModelScheduler");
const schedulerConfig = require("../src/core/SchedulerConfig");
const logger = { debug() {}, error() {}, info() {}, warn() {} };
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, timeout = 4000) {
    const deadline = performance.now() + timeout;
    while (!predicate()) {
        if (performance.now() > deadline) throw new Error("Condition timed out");
        await wait(20);
    }
}
async function fixture(t, count = 0) {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "account-management-test-"));
    const authDir = path.join(directory, "auth");
    await fs.mkdir(authDir);
    for (let index = 0; index < count; index++)
        await fs.writeFile(
            path.join(authDir, `auth-${index}.json`),
            JSON.stringify({ accountName: `user${index}@example.com`, cookies: [], origins: [] })
        );
    const system = {
        authSource: { availableIndices: Array.from({ length: count }, (_, index) => index), reloadAuthSources() {} },
        logger,
        scheduler: { isAccountManuallyDisabled: () => false },
    };
    const options = {
        artifactDir: path.join(directory, "artifacts"),
        authDir,
        storePath: path.join(directory, "accounts.sqlite"),
        workerPath: path.join(__dirname, "fixtures/account-login-executor.js"),
    };
    const service = new Service(system, options);
    await service.initialize({ startQueue: false });
    let closed = false;
    t.after(async () => {
        if (!closed) await service.close();
        await fs.rm(directory, { force: true, recursive: true });
    });
    return {
        close: async () => {
            await service.close();
            closed = true;
        },
        directory,
        options,
        service,
        system,
    };
}
test("RFC 6238 SHA1 vectors and strict OTP parameter rejection", () => {
    const parameters = Totp.normalize(secret);
    for (const [epoch, expected] of [
        [59, "287082"],
        [1111111109, "081804"],
        [1111111111, "050471"],
        [1234567890, "005924"],
        [2000000000, "279037"],
        [20000000000, "353130"],
    ])
        assert.equal(Totp.code(parameters, epoch * 1000), expected);
    assert.equal(Totp.normalize("gezd gnbv gy3t qojq gezd gnbv gy3t qojq").secret, secret);
    for (const input of [
        `otpauth://hotp/test?secret=${secret}`,
        `otpauth://totp/test?secret=${secret}&digits=8`,
        `otpauth://totp/test?secret=${secret}&algorithm=SHA256`,
        "NOT-A-SECRET",
    ])
        assert.throws(() => Totp.normalize(input));
});
test("CSV preserves BOM, quoted commas, quotes, newlines and password whitespace", () => {
    const parsed = parseImport(
        "csv",
        '\ufeffemail,password,totpSecret\r\nUser@Example.com," p,a""ss\nword ",\r\nuser@example.com,second,\r\ninvalid,,'
    );
    assert.equal(parsed.rows[0].password, ' p,a"ss\nword ');
    assert.equal(parsed.rows[0].email, "user@example.com");
    assert.match(parsed.rows[1].error, /Duplicate/);
    assert.ok(parsed.rows[2].error);
});
function migration(batchIndex = 0, batchSize = 1, overrides = {}) {
    const bytes = Payload.encode(
        Payload.create({
            batchId: 9,
            batchIndex,
            batchSize,
            entries: [
                {
                    algorithm: 1,
                    digits: 1,
                    name: "Google:user@example.com",
                    secret: Buffer.from("12345678901234567890"),
                    type: 2,
                    ...overrides,
                },
            ],
            version: 1,
        })
    ).finish();
    return `otpauth-migration://offline?data=${Buffer.from(bytes).toString("base64")}`;
}
test("migration schema handles complete, missing, duplicate and unsupported batches", () => {
    assert.equal(parseImport("authenticator", migration()).rows[0].totp.secret, secret);
    assert.equal(parseImport("authenticator", migration(0, 2)).complete, false);
    const complete = parseImport(
        "authenticator",
        `${migration(0, 2)}\n${migration(0, 2)}\n${migration(1, 2, { name: "other@example.com" })}`
    );
    assert.equal(complete.complete, true);
    assert.equal(complete.rows.length, 2);
    assert.ok(parseImport("authenticator", migration(0, 1, { type: 1 })).rows[0].error);
    const uri = migration();
    assert.equal(
        parseImport("authenticator", uri.replace("data=", "data=").replace(/=$/, "%3D")).rows[0].email,
        "user@example.com"
    );
    assert.ok(parseImport("authenticator", "otpauth-migration://offline?data=%%%bad").rows[0].error);
});
test("150 existing Cookie accounts migrate without rewriting cookies or exposing secrets", async t => {
    const { service, directory } = await fixture(t, 150);
    assert.equal(service.list().length, 150);
    const account = service.state.accounts[0],
        before = await fs.readFile(path.join(directory, "auth/auth-0.json"), "utf8");
    await service.edit(account.accountId, {
        credentialVersion: account.credentialVersion,
        password: "synthetic-password",
        totpSecret: secret,
    });
    assert.equal(await fs.readFile(path.join(directory, "auth/auth-0.json"), "utf8"), before);
    assert.equal(account.sessionState, "valid");
    const metadata = JSON.stringify(service.list());
    assert.ok(!metadata.includes("synthetic-password"));
    assert.ok(!metadata.includes(secret));
    const stat = await fs.stat(service.store.dbPath);
    assert.equal(stat.mode & 0o777, 0o600);
});
test("credential edits reject empty values, distinguish clear and enforce optimistic versions", async t => {
    const { service } = await fixture(t);
    const created = await service.create(
        { email: "edit@example.com", password: "synthetic-password", totpSecret: secret },
        false
    );
    const id = created.account.accountId;
    await assert.rejects(service.edit(id, { credentialVersion: 1, password: "" }), { status: 400 });
    await service.edit(id, { autoRecovery: false, credentialVersion: 1 });
    assert.equal(service.credentials(id).password, "synthetic-password");
    await service.edit(id, { clearTotpSecret: true, credentialVersion: 1 });
    assert.equal(service.credentials(id).totpSecret, null);
    await assert.rejects(service.edit(id, { credentialVersion: 1, password: "new" }), { status: 409 });
});
test("same-account deduplication, queue capacity, pause and disabled auto recovery", async t => {
    const { service, system } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    system.scheduler.isAccountManuallyDisabled = () => true;
    await service.scanRecovery();
    assert.equal(service.state.tasks.length, 0);
    const first = await service.login(account.accountId),
        second = await service.login(account.accountId);
    assert.equal(first.taskId, second.taskId);
    service.state.config.queueLimit = 1;
    await assert.rejects(service.create({ email: "another@example.com", password: "synthetic" }), { status: 429 });
    service.state.config.paused = true;
    await service.queue.tick();
    assert.equal(service.queue.running.size, 0);
    await service.cancel(first.taskId);
    assert.equal(service.state.tasks[0].status, "cancelled");
});
test("per-attempt hard timeout kills hanging executor descendants and next account succeeds", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, {
        attemptTimeout: 300,
        cleanupTimeout: 100,
        maxAttempts: 1,
        screenshotTimeout: 50,
        stepTimeout: 50,
    });
    await service.create({ email: "hang@example.com", password: "synthetic" });
    const next = await service.create({ email: "success@example.com", password: "synthetic" });
    await service.queue.tick();
    assert.equal(service.queue.running.size, 1);
    await until(() => service.state.tasks.every(task => ["failed", "succeeded"].includes(task.status)));
    assert.equal(service.state.tasks[0].error, "attempt_timeout");
    assert.equal(service.state.tasks[1].status, "succeeded");
    assert.equal(service.account(next.account.accountId).authIndex, 0);
    assert.equal(service.queue.snapshot().faultSlots, 0);
});
test("temporary failure releases slot during retry, consumes at most three attempts", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, { attemptTimeout: 2000, cleanupTimeout: 100, stepTimeout: 20 });
    await service.create({ email: "network@example.com", password: "synthetic" });
    const task = service.state.tasks[0];
    await service.queue.tick();
    await until(() => task.status === "retry_wait");
    assert.equal(service.queue.running.size, 0);
    for (let attempt = 2; attempt <= 3; attempt++) {
        task.nextAttemptAt = Date.now();
        await service.queue.tick();
        await until(() => task.attempts === attempt && task.status !== "running");
    }
    assert.equal(task.status, "failed");
    assert.equal(task.attempts, 3);
});
test("wrong password immediately requires manual action without retry", async t => {
    const { service } = await fixture(t);
    Object.assign(service.state.config, { attemptTimeout: 2000, cleanupTimeout: 100, stepTimeout: 20 });
    const created = await service.create({ email: "wrong@example.com", password: "synthetic" });
    await service.queue.tick();
    await until(() => service.state.tasks[0].status === "failed");
    assert.equal(service.state.tasks[0].attempts, 1);
    assert.equal(service.account(created.account.accountId).recoveryState, "manual_required");
});
test("late success after credential mutation or cancellation cannot write auth files", async t => {
    const { service, directory } = await fixture(t);
    Object.assign(service.state.config, {
        attemptTimeout: 2000,
        cleanupTimeout: 100,
        screenshotTimeout: 50,
        stepTimeout: 20,
    });
    const created = await service.create({ email: "late@example.com", password: "synthetic" });
    await service.queue.tick();
    await service.exclusive(() =>
        service.edit(created.account.accountId, { credentialVersion: 1, password: "new-synthetic" })
    );
    await until(() => !service.queue.running.size);
    assert.equal(service.state.tasks[0].status, "cancelled");
    assert.deepEqual(await fs.readdir(path.join(directory, "auth")), []);
    await service.login(created.account.accountId);
    await service.queue.tick();
    await service.cancel(service.state.tasks[1].taskId);
    await until(() => !service.queue.running.size);
    assert.deepEqual(await fs.readdir(path.join(directory, "auth")), []);
});
test("old Context refresh and expiration cannot overwrite new Cookie; disabled state survives", async t => {
    const { service, system } = await fixture(t, 1);
    system.scheduler.isAccountManuallyDisabled = () => true;
    await service.upload({
        accountName: "user0@example.com",
        cookies: [{ name: "fresh", value: "synthetic-cookie" }],
        origins: [],
    });
    const account = service.state.accounts[0],
        version = account.sessionVersion;
    assert.equal(await service.markExpired(0, 0), false);
    assert.equal(await service.refreshSession(0, 0, { cookies: [], origins: [] }), false);
    assert.equal((await service.readAuth(0)).cookies[0].name, "fresh");
    assert.equal(service.list()[0].disabled, true);
    assert.equal(await service.markExpired(0, version), true);
    await service.removeIndex(0);
    await service.upload({ accountName: "replacement@example.com", cookies: [], origins: [] });
    assert.notEqual(service.state.accounts[0].accountId, account.accountId);
    assert.equal(await service.refreshSession(0, version, { cookies: [], origins: [] }), false);
});
test("account list and recovery use the real scheduler's administrative disable method", async t => {
    const { service, system } = await fixture(t, 1);
    system.authSource.accountNameMap = new Map();
    const scheduler = new ModelScheduler(
        { ...schedulerConfig({ SCHEDULER_DAILY_RESET_ENABLED: "false" }), statePath: null },
        system.authSource,
        logger
    );
    system.scheduler = scheduler;
    t.after(() => scheduler.close());
    assert.equal(service.list()[0].disabled, false);
    scheduler.disable(0);
    assert.equal(service.list()[0].disabled, true);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    account.recoveryState = "idle";
    await service.scanRecovery();
    assert.equal(service.state.tasks.length, 0);
    const task = service.enqueue(account, "expired");
    await service.queue.tick();
    assert.equal(task.status, "cancelled");
    assert.equal(service.queue.running.size, 0);
    assert.equal(service.list()[0].disabled, true);
});
test("import preview is secret-free, session-bound, versioned and idempotent", async t => {
    const { service } = await fixture(t, 1);
    const content = 'email,password\nuser0@example.com,"synthetic, password"\nnew@example.com,new-synthetic';
    const preview = service.preview("session-a", "csv", content);
    assert.ok(!JSON.stringify(preview).includes("synthetic"));
    await assert.rejects(service.importCommit("session-b", { previewId: preview.previewId, rows: [] }), {
        status: 409,
    });
    const result = await service.importCommit("session-a", {
        previewId: preview.previewId,
        rows: [{ index: 0 }, { create: true, index: 1 }],
    });
    assert.equal(result.updated, 1);
    assert.equal(result.created, 1);
    assert.equal(service.state.tasks.length, 0);
    assert.equal(service.state.accounts[0].password, "synthetic, password");
    assert.deepEqual(await service.importCommit("session-a", { previewId: preview.previewId, rows: [] }), result);
    const stale = service.preview("session-a", "csv", content);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: account.credentialVersion, password: "changed" });
    assert.equal(
        (await service.importCommit("session-a", { previewId: stale.previewId, rows: [{ index: 0, overwrite: true }] }))
            .failed,
        1
    );
});
test("queue state and consumed attempts survive manager restart; commit journal rolls forward", async t => {
    const { service, system, options, close } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    const task = service.enqueue(account, "manual");
    Object.assign(task, { attempts: 2, deadline: Date.now() + 900000, startedAt: Date.now(), status: "running" });
    await service.save();
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    await resumed.initialize({ startQueue: false });
    assert.equal(resumed.state.tasks[0].attempts, 2);
    assert.equal(resumed.state.tasks[0].status, "retry_wait");
    const target = resumed.state.accounts[0];
    resumed.state.commits.push({ accountId: target.accountId, authIndex: 0, sessionVersion: 10, taskId: task.taskId });
    await resumed.atomicAuth(0, { _accountSessionVersion: 10, accountName: target.email, cookies: [], origins: [] });
    await resumed.save();
    await resumed.close();
    const recovered = new Service(system, options);
    t.after(() => recovered.close());
    await recovered.initialize({ startQueue: false });
    assert.equal(recovered.state.accounts[0].sessionVersion, 10);
    assert.equal(recovered.state.tasks[0].status, "succeeded");
    await recovered.close();
});
test("failure artifacts expire as 410 without deleting attempt metadata", async t => {
    const { service } = await fixture(t);
    const artifact = await service.artifacts.save("synthetic-account", "synthetic-task", Buffer.from("synthetic-png"));
    service.state.artifacts.push(artifact);
    artifact.createdAt = Date.now() - 8 * 86400000;
    await service.cleanup();
    await assert.rejects(service.artifacts.read(artifact), { status: 410 });
    assert.equal(service.state.artifacts[0].id, artifact.id);
});
test("deduplication exposes conflicts without secrets and merges only explicit versioned choices", async t => {
    const { service } = await fixture(t, 2);
    const first = service.state.accounts[0],
        second = service.state.accounts[1];
    second.email = first.email;
    first.password = "synthetic-one";
    second.password = "synthetic-two";
    const groups = [{ email: first.email, keptIndex: 0, removedIndices: [1] }];
    const result = await service.prepareDeduplicate(groups);
    assert.equal(result.conflicts.length, 1);
    assert.ok(!JSON.stringify(result).includes("synthetic-one"));
    const choice = {
        [first.email]: {
            accountId: second.accountId,
            versions: { [first.accountId]: first.credentialVersion, [second.accountId]: second.credentialVersion },
        },
    };
    assert.equal((await service.prepareDeduplicate(groups, choice)).conflicts.length, 0);
    assert.equal(first.password, "synthetic-two");
    await assert.rejects(
        service.edit(first.accountId, { credentialVersion: first.credentialVersion, password: "other" }),
        { status: 409 }
    );
    await service.removeIndex(1, { dedup: true });
    service.deduplicating = false;
    assert.equal(service.state.accounts.length, 1);
    assert.equal(service.state.accounts[0].password, "synthetic-two");
});
test("every management route shares existing console authentication and no-store", () => {
    const registered = [],
        middleware = [],
        guard = () => {};
    const app = { use: (...args) => middleware.push(args) };
    for (const method of ["get", "post", "patch", "delete"]) app[method] = (...args) => registered.push(args);
    new AccountRoutes({}).setupRoutes(app, guard);
    assert.equal(middleware[0][0], "/api/account-management");
    assert.equal(middleware[0][1], guard);
    const headers = {};
    middleware[0][2](
        {},
        {
            set: (key, value) => {
                headers[key] = value;
            },
        },
        () => {}
    );
    assert.equal(headers["Cache-Control"], "no-store");
    assert.ok(registered.some(args => args[0] === "/accounts" && args[1] === guard));
    assert.ok(registered.length >= 14);
});

test("credential exports round-trip CSV and keep single Cookie downloads free of credentials", async t => {
    const { credentialsCsv, accountBundle, cookieState } = require("../src/accounts/AccountExport");
    const JSZip = require("jszip");
    const { service, system } = await fixture(t, 1);
    const account = service.state.accounts[0];
    account.password = ' synthetic,p"ass\nword ';
    account.totp = Totp.normalize(secret);
    const missing = (await service.create({ email: "unbound@example.com", password: "synthetic" }, false)).account;
    const exported = credentialsCsv(service.selectedAccounts({ all: true }));
    const imported = parseImport("csv", exported);
    assert.equal(imported.rows[0].password, account.password);
    assert.equal(imported.rows[0].totp.secret, secret);
    assert.equal(imported.rows[1].email, missing.email);
    const state = { accountName: account.email, cookies: [], origins: [], password: "hidden", totpSecret: secret };
    assert.deepEqual(cookieState(state), { accountName: account.email, cookies: [], origins: [] });
    const zip = await JSZip.loadAsync(await accountBundle(service.selectedAccounts({ all: true }), () => state));
    assert.deepEqual(Object.keys(zip.files).sort(), ["auth-0.json", "credentials.csv"]);
    assert.equal(await zip.file("credentials.csv").async("string"), exported);
    assert.deepEqual(JSON.parse(await zip.file("auth-0.json").async("string")), cookieState(state));
    await assert.rejects(
        accountBundle([account], () => null),
        { status: 409 }
    );
    assert.throws(() => service.selectedAccounts({ accountIds: [] }), { status: 400 });
    assert.equal(service.selectedAccounts({ accountIds: [account.accountId, account.accountId] }).length, 1);
    const handlers = new Map(),
        app = { use() {} };
    for (const method of ["get", "post", "patch", "delete"])
        app[method] = (endpoint, ...middleware) => handlers.set(`${method} ${endpoint}`, middleware.at(-1));
    system.accountLoginService = service;
    new AccountRoutes(system).setupRoutes(app, () => {});
    const response = () => ({
        attachment(value) {
            this.filename = value;
            return this;
        },
        headersSent: false,
        json(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
        send(value) {
            this.body = value;
            this.headersSent = true;
            return this;
        },
        status(value) {
            this.code = value;
            return this;
        },
        type(value) {
            this.contentType = value;
            return this;
        },
    });
    const csvResponse = response();
    await handlers.get("post /api/account-management/export/credentials")(
        { body: { accountIds: [account.accountId] } },
        csvResponse
    );
    assert.equal(csvResponse.filename, "credentials.csv");
    assert.equal(parseImport("csv", csvResponse.body).rows[0].password, account.password);
    const cookieResponse = response();
    await handlers.get("get /api/account-management/accounts/:id/download")(
        { params: { id: account.accountId } },
        cookieResponse
    );
    assert.equal(cookieResponse.filename, "auth-0.json");
    assert.ok(!cookieResponse.body.includes(account.password));
    system.authSource.duplicateIndices = [0];
    const listResponse = response();
    await handlers.get("get /api/account-management/accounts")(
        { query: { search: "#0", state: "duplicate" } },
        listResponse
    );
    assert.equal(listResponse.body.total, 1);
    assert.equal(listResponse.body.accounts[0].isDuplicate, true);
    const invalidSwitch = response();
    const originalConcurrency = service.state.config.concurrency;
    await handlers.get("patch /api/account-management/login-queue")(
        { body: { autoRecovery: "false", concurrency: 2 } },
        invalidSwitch
    );
    assert.equal(invalidSwitch.code, 400);
    assert.equal(service.state.config.concurrency, originalConcurrency);
});

test("batch recovery validates all credential versions before making changes", async t => {
    const { service } = await fixture(t, 2);
    const accounts = service.state.accounts;
    const entries = accounts.map(account => ({
        accountId: account.accountId,
        credentialVersion: account.credentialVersion,
    }));
    await assert.rejects(
        service.setRecovery({ accounts: [entries[0], { ...entries[1], credentialVersion: -1 }], autoRecovery: false }),
        { status: 409 }
    );
    assert.ok(accounts.every(account => account.autoRecovery));
    assert.equal((await service.setRecovery({ accounts: entries, autoRecovery: false })).updated, 2);
    assert.ok(accounts.every(account => !account.autoRecovery));
    await service.setRecovery({ accounts: entries, autoRecovery: true });
    assert.ok(accounts.every(account => account.autoRecovery));
});

test("global automatic login switch persists and holds recovery without blocking manual login", async t => {
    const { service, system, options, close } = await fixture(t, 1);
    const account = service.state.accounts[0];
    await service.edit(account.accountId, { credentialVersion: 1, password: "synthetic" });
    account.sessionState = "expired";
    const automatic = service.enqueue(account, "expired");
    service.state.config.autoRecovery = false;
    await service.queue.tick();
    assert.equal(automatic.status, "queued");
    assert.equal(automatic.attempts, 0);
    const manualAccount = await service.create({ email: "manual@example.com", password: "synthetic" }, false);
    await service.login(manualAccount.account.accountId);
    await service.queue.tick();
    await until(() => service.state.tasks.some(task => task.source === "manual" && task.status === "succeeded"));
    assert.equal(automatic.status, "queued");
    service.state.config.autoRecovery = true;
    account.autoRecovery = false;
    await service.queue.tick();
    assert.equal(automatic.attempts, 0);
    service.state.config.autoRecovery = false;
    await service.save();
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    await resumed.initialize({ startQueue: false });
    assert.equal(resumed.state.config.autoRecovery, false);
    resumed.state.config.autoRecovery = true;
    resumed.state.accounts.find(item => item.accountId === account.accountId).autoRecovery = true;
    await resumed.queue.tick();
    await until(() => resumed.state.tasks.find(task => task.taskId === automatic.taskId).status === "succeeded");
    await resumed.close();
});

test("disabled automatic login saves new credentials and authenticator before manual batch login", async t => {
    const { service } = await fixture(t);
    service.state.config.autoRecovery = false;
    service.state.config.queueLimit = 1;
    const created = await service.create({ email: "first@example.com", password: "synthetic" });
    const second = await service.create({ email: "second@example.com", password: "synthetic" });
    assert.equal(created.taskId, undefined);
    assert.equal(created.account.recoveryState, "idle");
    assert.equal(service.state.tasks.length, 0);
    const preview = service.preview(
        "session",
        "authenticator",
        `otpauth://totp/first@example.com?secret=${secret}\notpauth://totp/second@example.com?secret=${secret}`
    );
    const result = await service.importCommit("session", {
        previewId: preview.previewId,
        rows: preview.rows.map(row => ({ index: row.index })),
    });
    assert.equal(result.updated, 2);
    await service.queue.tick();
    assert.equal(service.state.tasks.length, 0);
    service.state.config.queueLimit = 2;
    for (const { account } of [created, second]) await service.login(account.accountId);
    await service.queue.tick();
    await until(() => service.state.tasks.every(task => task.status === "succeeded"));
    assert.equal(service.state.tasks.length, 2);
    assert.ok(service.state.tasks.every(task => task.source === "manual"));
});

test("global switch holds already queued new logins and manual login releases held automatic tasks", async t => {
    const { service } = await fixture(t);
    const created = await service.create({ email: "held@example.com", password: "synthetic" });
    service.state.config.autoRecovery = false;
    await service.queue.tick();
    const task = service.state.tasks[0];
    assert.equal(task.status, "queued");
    assert.equal(task.attempts, 0);
    assert.equal((await service.login(created.account.accountId)).taskId, task.taskId);
    await service.queue.tick();
    await until(() => task.status === "succeeded");

    const account = service.account(created.account.accountId);
    account.sessionState = "expired";
    const recovery = service.enqueue(account, "expired");
    await service.login(account.accountId);
    await service.queue.tick();
    await until(() => recovery.status === "succeeded");
});

test("authenticator imports match existing emails, skip unknown and duplicate entries, and require overwrite", async t => {
    const { service } = await fixture(t);
    const { account } = await service.create({ email: "known@example.com", password: "synthetic" }, false);
    const uri = email => `otpauth://totp/${email}?secret=${secret}`;
    const preview = service.preview(
        "session",
        "authenticator",
        [uri("known@example.com"), uri("unknown@example.com"), uri("known@example.com")].join("\n")
    );
    assert.equal(preview.rows[0].accountId, account.accountId);
    assert.equal(preview.rows[1].accountId, null);
    assert.match(preview.rows[2].error, /Duplicate/);
    const result = await service.importCommit("session", {
        previewId: preview.previewId,
        rows: [{ index: 0 }, { index: 1 }, { index: 2, skip: true }],
    });
    assert.deepEqual(result, { created: 0, errors: [], failed: 0, skipped: 2, updated: 1 });
    assert.equal(service.state.accounts.length, 1);
    const unchanged = service.preview("session", "authenticator", uri("known@example.com"));
    assert.equal(unchanged.rows[0].unchanged, true);
    assert.equal(
        (await service.importCommit("session", { previewId: unchanged.previewId, rows: [{ index: 0 }] })).skipped,
        1
    );
    const otherSecret = Totp.encode(Buffer.from("different-secret"));
    const content = `otpauth://totp/known@example.com?secret=${otherSecret}`;
    const conflict = service.preview("session", "authenticator", content);
    assert.equal(conflict.rows[0].conflict, true);
    assert.equal(
        (await service.importCommit("session", { previewId: conflict.previewId, rows: [{ index: 0 }] })).failed,
        1
    );
    assert.equal(service.credentials(account.accountId).totpSecret, secret);
    const overwrite = service.preview("session", "authenticator", content);
    assert.equal(
        (
            await service.importCommit("session", {
                previewId: overwrite.previewId,
                rows: [{ index: 0, overwrite: true }],
            })
        ).updated,
        1
    );
    assert.equal(service.credentials(account.accountId).totpSecret, otherSecret);
    assert.equal(service.state.tasks.length, 0);
});

test("unlogged accounts keep persisted proxy bindings across first login and service restart", async t => {
    const { service, system, options, directory, close } = await fixture(t);
    system.authSource.accountLoginService = service;
    system.authSource.accountNameMap = new Map();
    const browser = {
        contexts: new Map(),
        contextUnavailable: new Map(),
        initializingContexts: new Set(),
        stickyProxyManager: {
            getProxyForAuth(index) {
                assert.notEqual(index, null);
                return null;
            },
        },
    };
    const storePath = path.join(directory, "proxy-pool.json");
    let store = new ProxyPoolStore(logger, storePath);
    const data = store.snapshot();
    data.settings.enabled = true;
    data.nodes.push({
        enabled: true,
        host: "127.0.0.1",
        id: "node-login",
        localPort: 10801,
        name: "Login",
        port: 1080,
        type: "socks5",
    });
    await store.replace(data);
    const manager = { status: { ready: true } };
    let bindings = new ProxyBindingService(store, manager, browser, system.authSource);
    const pool = Object.assign(Object.create(ProxyPoolService.prototype), { bindings, store });
    system.proxyPoolService = pool;
    const { account: created } = await service.create({ email: "Proxy@Example.com", password: "synthetic" }, false);
    const account = service.account(created.accountId);
    assert.equal(bindings.list()[0].authIndex, null);
    assert.equal(bindings.list()[0].contextState, "NOT_LOGGED_IN");
    await pool.setBinding("proxy@example.com", "node-login");
    const before = service.resolveProxy(account);
    assert.equal(before.server, "socks5://127.0.0.1:10801");
    assert.throws(() => pool.apply(account.email), { status: 409 });
    manager.status.ready = false;
    assert.throws(() => service.resolveProxy(account), { code: "MIHOMO_NOT_READY" });
    manager.status.ready = true;

    // Both stores survive restart before the account has a Cookie index.
    await close();
    const resumed = new Service(system, options);
    t.after(() => resumed.close());
    system.authSource.accountLoginService = resumed;
    await resumed.initialize({ startQueue: false });
    store = new ProxyPoolStore(logger, storePath);
    bindings = new ProxyBindingService(store, manager, browser, system.authSource);
    Object.assign(pool, { bindings, store });
    const restored = resumed.account(account.accountId);
    assert.deepEqual(resumed.resolveProxy(restored), before);
    await resumed.login(restored.accountId);
    await resumed.queue.tick();
    await until(() => resumed.state.tasks[0].status === "succeeded");
    const auth = await resumed.readAuth(restored.authIndex);
    system.authSource.availableIndices = [restored.authIndex];
    system.authSource.accountNameMap.set(restored.authIndex, auth.accountName);
    assert.deepEqual(resumed.resolveProxy(restored), before);
    assert.deepEqual(bindings.resolve(restored.authIndex).proxy, before);
    assert.equal(bindings.list().length, 1);
    assert.equal(bindings.list()[0].accountKey, "proxy@example.com");
    browser.contexts.set(restored.authIndex, { proxyInfo: bindings.resolve(restored.authIndex), state: "READY" });
    assert.equal(bindings.list()[0].state, "applied");
    await resumed.close();
});

test("bulk proxy application skips accounts without Cookie indices", async () => {
    const handlers = new Map();
    const applied = [];
    const service = {
        apply(accountKey, waitForIdle) {
            applied.push({ accountKey, waitForIdle });
            return { accountKey };
        },
        bindings: {
            list: () => [
                { accountKey: "unlogged@example.com", authIndex: null, state: "offline" },
                { accountKey: "logged@example.com", authIndex: 0, state: "offline" },
            ],
        },
    };
    const app = { use() {} };
    for (const method of ["get", "post", "put", "delete"])
        app[method] = (endpoint, handler) => handlers.set(`${method} ${endpoint}`, handler);
    new ProxyPoolRoutes({ proxyPoolService: service }).setupRoutes(app, () => {});
    const res = {
        json() {},
        status(code) {
            assert.equal(code, 202);
            return this;
        },
    };
    await handlers.get("post /api/proxy-pool/bindings/apply-idle")({}, res);
    await handlers.get("post /api/proxy-pool/bindings/apply-pending")({}, res);
    assert.deepEqual(applied, [
        { accountKey: "logged@example.com", waitForIdle: false },
        { accountKey: "logged@example.com", waitForIdle: true },
    ]);
});
