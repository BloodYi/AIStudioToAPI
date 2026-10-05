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
        alternativeChecks = 0,
        reentries = 0;
    const pins = [],
        phases = [],
        screenshots = [],
        dialogObservations = [];
    const visible = selector =>
        selector.includes("textarea")
            ? state === "studio"
            : selector.includes('type="email"')
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
                state = options.alternative ? "alternative" : options.choose ? "choose" : "totp";
                return;
            }
            state = "studio";
            url = "https://aistudio.google.com/prompts/new";
        } else if (state === "totp") {
            if (reentries < (options.reentries || 0)) {
                reentries++;
                state = "choose";
                return;
            }
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
        getByRole: () => ({
            filter() {
                return this;
            },
            first: () => ({ click: next, isVisible: async () => false }),
        }),
        getByText: () => ({
            first: () => ({
                click: async () => {
                    state = options.loadingAlternative ? "alternative_loading" : "totp";
                },
                isVisible: async () => state === "alternative",
            }),
        }),
        goto: async target => {
            if (target.includes("ServiceLogin")) url = "https://accounts.google.com/signin";
            else if (target.includes("/apps/")) {
                url = target;
            } else url = target;
        },
        isClosed: () => false,
        locator: selector => {
            const locator = {
                click: async () => {
                    if (state === "choose") {
                        if (!options.choiceDoesNotNavigate) state = "totp";
                        if (options.choiceTimeout)
                            throw Object.assign(new Error("intercepts pointer events"), { name: "TimeoutError" });
                    } else await next();
                },
                count: async () => (visible(selector) ? 1 : 0),
                elementHandle: async () => locator,
                evaluate: async () => true,
                evaluateAll: async (_callback, mode) => {
                    if (mode !== "business") return { count: 0, dialogs: [] };
                    const states = options.dialogStates || ["clear"];
                    const dialogState = states[Math.min(dialogObservations.length, states.length - 1)];
                    dialogObservations.push(dialogState);
                    if (options.observationFails) throw new Error("password-secret private@example.com");
                    return {
                        dialogs: [],
                        dialogState,
                        knownHintCount: dialogState === "known_hint_only" ? 1 : 0,
                        termsCount: 0,
                        unknownCount: dialogState === "unknown_present" ? 1 : 0,
                    };
                },
                fill: async value => {
                    if (selector.includes("totpPin")) pins.push({ time: clock, value });
                },
                filter: () => locator,
                first: () => locator,
                innerText: async () => text(),
                isEditable: async () => true,
                isEnabled: async () => true,
                isVisible: async () => {
                    if (state === "alternative_loading") {
                        if (++alternativeChecks >= 4) state = "choose";
                        return selector === "[data-challengetype]";
                    }
                    return visible(selector);
                },
                locator: nested => (nested.startsWith("xpath") ? { count: async () => 0 } : page.locator(nested)),
                nth: () => locator,
            };
            return locator;
        },
        screenshot: async parameters => {
            screenshots.push(parameters);
            return Buffer.from("synthetic-screenshot");
        },
        url: () => url,
        waitForFunction: async () => {
            throw new Error("Page-world polling is unavailable");
        },
    };
    const context = {
        addInitScript: async () => {},
        close: async () => {},
        newPage: async () => page,
        route: async () => {},
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
                    : name === "./TargetSessionValidator"
                      ? class {
                            async validate() {
                                if (options.initializationFailed)
                                    throw Object.assign(new Error("service_initialization_failed"), {
                                        reason: "service_initialization_failed",
                                        retryable: true,
                                    });
                                if (options.unverifiedSocket)
                                    throw Object.assign(new Error("service_initialization_unverified"), {
                                        reason: "service_initialization_unverified",
                                        retryable: true,
                                    });
                                return { context, page };
                            }
                            async close() {}
                        }
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
        config: {
            attemptTimeout: options.attemptTimeout || 180000,
            humanize: false,
            screenshotTimeout: 5000,
            stepTimeout: options.stepTimeout || 30000,
        },
        credentials: {
            email: "user@example.com",
            password: "synthetic-password",
            totp: options.missingSecret ? null : options.totp ? Totp.normalize(secret) : null,
        },
        targetUrl: options.missingTarget ? null : "https://ai.studio/apps/synthetic",
        token: "synthetic-token",
    });
    return { dialogObservations, phases, pins, result: await result, screenshots };
}
test("no two-step login verifies account and target app before saving complete storageState", async () => {
    const { result, phases } = await simulate();
    assert.ok(result.storageState);
    assert.equal(result.email, "user@example.com");
    assert.ok(phases.includes("target_service_initialization"));
});
test("choice click timeout is accepted only after TOTP readiness is confirmed", async () => {
    const changed = await simulate({ choiceTimeout: true, choose: true, totp: true });
    assert.ok(changed.result.storageState);
    assert.equal(changed.pins.length, 1);
    const unchanged = await simulate({ choiceDoesNotNavigate: true, choiceTimeout: true, choose: true, totp: true });
    assert.equal(unchanged.result.error, "ui_click_timeout");
    assert.ok(!unchanged.result.storageState);
    assert.equal(unchanged.pins.length, 0);
});
test("TOTP challenge selection, fresh-window submission and one bounded code refresh", async () => {
    const successful = await simulate({ choose: true, totp: true });
    assert.ok(successful.result.storageState);
    assert.equal(successful.pins.length, 1);
    const alternative = await simulate({ alternative: true, totp: true });
    assert.ok(alternative.result.storageState);
    assert.equal(alternative.pins.length, 1);
    assert.ok(alternative.phases.includes("choose_authenticator"));
    const loading = await simulate({ alternative: true, loadingAlternative: true, totp: true });
    assert.ok(loading.result.storageState);
    assert.equal(loading.pins.length, 1);
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
        [{ unverifiedSocket: true }, "service_initialization_unverified"],
    ]) {
        const { result } = await simulate(options);
        assert.equal(result.error, reason);
        assert.ok(!result.storageState);
    }
});

test("missing target configuration stops before submitting credentials", async () => {
    const { result, phases } = await simulate({ missingTarget: true });
    assert.equal(result.error, "service_target_missing");
    assert.deepEqual(phases, []);
    assert.ok(!result.storageState);
});

test("TOTP challenge reentry resets local submissions but has an attempt-wide bound", async () => {
    const recovered = await simulate({ reentries: 1, totp: true });
    assert.ok(recovered.result.storageState);
    assert.equal(recovered.pins.length, 2);
    const bounded = await simulate({ reentries: 10, totp: true });
    assert.equal(bounded.result.error, "totp_challenge_limit");
    assert.equal(bounded.pins.length, 3);
    assert.equal(bounded.result.diagnostics.pageStateBefore, "totp_input");
    assert.ok(!JSON.stringify(bounded.result.diagnostics).includes(secret));
});

test("Studio unknown events allow exactly two rechecks, including replaced nodes and incomplete reads", async () => {
    for (const options of [
        { dialogStates: ["unknown_present"] },
        { dialogStates: ["unknown_present", "incomplete", "unknown_present"] },
        { observationFails: true },
    ]) {
        const { result, dialogObservations, phases } = await simulate(options);
        assert.equal(result.error, "manual_challenge");
        assert.equal(result.diagnostics.unknownRecheckCount, 2);
        assert.equal(dialogObservations.length, 3);
        assert.ok(!result.storageState);
        assert.ok(!phases.includes("target_service_initialization"));
        assert.ok(!JSON.stringify(result).includes("password-secret"));
    }
});
test("Studio recovery restarts the stable interval and a later unknown event has its own bounded rechecks", async () => {
    const recovered = await simulate({ dialogStates: ["unknown_present", "unknown_present", "clear"] });
    assert.ok(recovered.result.storageState);
    assert.ok(recovered.dialogObservations.length >= 10);
    const interrupted = await simulate({
        dialogStates: ["clear", "clear", "clear", "clear", "clear", "unknown_present"],
    });
    assert.equal(interrupted.result.error, "manual_challenge");
    assert.equal(interrupted.dialogObservations.length, 8);
    const newEvent = await simulate({ dialogStates: ["unknown_present", "clear", "unknown_present"] });
    assert.equal(newEvent.dialogObservations.length, 5);
    assert.equal(newEvent.result.diagnostics.unknownRecheckCount, 2);
});
test("Studio rechecks preserve step and attempt timeout precedence", async () => {
    const step = await simulate({ dialogStates: ["unknown_present"], stepTimeout: 400 });
    assert.equal(step.result.error, "page_transition_timeout");
    assert.ok(!step.result.storageState);
    assert.ok(!step.result.diagnostics.failureSource);
    const attempt = await simulate({ attemptTimeout: 400, dialogStates: ["unknown_present"] });
    assert.equal(attempt.result.error, "attempt_timeout");
    assert.ok(!attempt.result.storageState);
});
