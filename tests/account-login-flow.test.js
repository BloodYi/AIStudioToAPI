const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const Totp = require("../src/accounts/TotpService");
const workerPath = path.join(__dirname, "../src/accounts/AccountLoginWorker.js");
const workerRequire = createRequire(workerPath);
const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";

async function simulate(options = {}) {
    let clock = options.nearExpiry ? 58000 : 30000,
        state = "email",
        url = "about:blank",
        rejected = 0,
        websocket;
    const pins = [],
        phases = [],
        screenshots = [];
    const visible = selector =>
        selector.includes('type="email"')
            ? state === "email"
            : selector.includes('type="password"')
              ? state === "password"
              : selector.includes("totpPin")
                ? state === "totp"
                : selector.includes("challengetype")
                  ? state === "choose"
                  : false;
    const text = () =>
        state === "email"
            ? "Sign in"
            : state === "password"
              ? options.wrongPassword
                  ? "Wrong password"
                  : "Enter your password"
              : state === "sms"
                ? "Check your phone"
                : state === "totp"
                  ? rejected
                      ? "Wrong code"
                      : "Enter authenticator code"
                  : "AI Studio";
    const next = async () => {
        if (state === "email") state = "password";
        else if (state === "password") {
            if (options.wrongPassword) return;
            if (options.sms) {
                state = "sms";
                return;
            }
            if (options.sso) {
                url = "https://sso.example.com/";
                return;
            }
            if (options.totp) {
                state = options.choose ? "choose" : "totp";
                return;
            }
            state = "studio";
            url = "https://aistudio.google.com/prompts/new";
        } else if (state === "totp") {
            if (rejected < (options.rejectCodes || 0)) {
                rejected++;
                return;
            }
            state = "studio";
            url = "https://aistudio.google.com/prompts/new";
        }
    };
    const page = {
        close: async () => {},
        evaluate: async callback =>
            callback.name === "pageErrors"
                ? { appletFailed: !!options.initializationFailed, concurrentUpdates: false, snapshotFailed: false }
                : {
                      email: options.noIdentity
                          ? null
                          : options.mismatch
                            ? "different@example.com"
                            : "user@example.com",
                      initializationFailed: false,
                      unavailable: !!options.unavailable,
                  },
        frames: () => [],
        getByRole: () => ({ first: () => ({ click: next, isVisible: async () => false }) }),
        getByText: () => ({ first: () => ({ isVisible: async () => false }) }),
        goto: async target => {
            if (target.includes("ServiceLogin")) url = "https://accounts.google.com/signin";
            else if (target.includes("/apps/")) {
                url = target;
                if (!options.initializationFailed) websocket?.();
            } else url = target;
        },
        isClosed: () => false,
        locator: selector => {
            const locator = {
                click: async () => {
                    if (state === "choose") state = "totp";
                    else await next();
                },
                fill: async value => {
                    if (selector.includes("totpPin")) pins.push({ time: clock, value });
                },
                filter: () => locator,
                first: () => locator,
                innerText: async () => text(),
                isVisible: async () => visible(selector),
            };
            return locator;
        },
        screenshot: async parameters => {
            screenshots.push(parameters);
            return Buffer.from("synthetic-screenshot");
        },
        url: () => url,
        waitForFunction: async () => {},
    };
    const context = {
        addInitScript: async () => {},
        close: async () => {},
        newPage: async () => page,
        route: async () => {},
        routeWebSocket: async (match, callback) => {
            websocket = callback;
        },
        setDefaultNavigationTimeout() {},
        setDefaultTimeout() {},
        storageState: async () => ({ cookies: [], origins: [] }),
    };
    const browser = { close: async () => {}, newContext: async () => context };
    const processMock = new EventEmitter();
    processMock.connected = true;
    let resolveResult;
    const result = new Promise(resolve => {
        resolveResult = resolve;
    });
    processMock.send = message => {
        if (message.phase) phases.push(message.phase);
        if (message.result) resolveResult(message.result);
    };
    class FakeDate extends Date {
        static now() {
            return clock;
        }
    }
    vm.runInNewContext(
        fs.readFileSync(workerPath, "utf8"),
        {
            Date: FakeDate,
            process: processMock,
            require: name =>
                name === "playwright"
                    ? { firefox: { launch: async () => browser } }
                    : name === "node:perf_hooks"
                      ? { performance: { now: () => clock - 30000 } }
                      : workerRequire(name),
            setTimeout: (callback, ms) =>
                setImmediate(() => {
                    clock += ms;
                    callback();
                }),
            URL,
        },
        { filename: workerPath }
    );
    processMock.emit("message", {
        config: { attemptTimeout: 180000, screenshotTimeout: 5000, stepTimeout: 30000 },
        credentials: {
            email: "user@example.com",
            password: "synthetic-password",
            totp: options.missingSecret ? null : options.totp ? Totp.normalize(secret) : null,
        },
        targetUrl: "https://ai.studio/apps/synthetic",
        token: "synthetic-token",
    });
    return { phases, pins, result: await result, screenshots };
}
test("no two-step login verifies account and target app before saving complete storageState", async () => {
    const { result, phases } = await simulate();
    assert.ok(result.storageState);
    assert.equal(result.email, "user@example.com");
    assert.ok(phases.includes("target_service_initialization"));
});
test("TOTP challenge selection, fresh-window submission and one bounded code refresh", async () => {
    const successful = await simulate({ choose: true, totp: true });
    assert.ok(successful.result.storageState);
    assert.equal(successful.pins.length, 1);
    const boundary = await simulate({ nearExpiry: true, totp: true });
    assert.ok(boundary.result.storageState);
    assert.ok(boundary.pins[0].time >= 60000);
    const refreshed = await simulate({ rejectCodes: 1, totp: true });
    assert.ok(refreshed.result.storageState);
    assert.equal(refreshed.pins.length, 2);
    assert.notEqual(Math.floor(refreshed.pins[0].time / 30000), Math.floor(refreshed.pins[1].time / 30000));
    const rejected = await simulate({ rejectCodes: 2, totp: true });
    assert.equal(rejected.result.error, "totp_rejected");
    assert.equal(rejected.pins.length, 2);
});
test("missing secret, password failure and manual challenge stop without success", async () => {
    for (const [options, reason] of [
        [{ missingSecret: true, totp: true }, "credentials_missing"],
        [{ wrongPassword: true }, "wrong_password"],
        [{ sms: true }, "manual_challenge"],
        [{ sso: true }, "workspace_sso_or_unknown_challenge"],
    ]) {
        const { result, screenshots } = await simulate(options);
        assert.equal(result.error, reason);
        assert.ok(!result.storageState);
        assert.ok(screenshots[0].mask.length);
    }
});
test("Google login alone cannot commit mismatched, unidentified or unusable accounts", async () => {
    for (const [options, reason] of [
        [{ mismatch: true }, "account_mismatch"],
        [{ noIdentity: true }, "account_identity_unverified"],
        [{ unavailable: true }, "service_region_restricted"],
        [{ initializationFailed: true }, "service_initialization_failed"],
    ]) {
        const { result } = await simulate(options);
        assert.equal(result.error, reason);
        assert.ok(!result.storageState);
    }
});
