const { firefox } = require("playwright");
const Totp = require("./TotpService");
const LoginInteraction = require("./LoginInteraction");
const TargetSessionValidator = require("./TargetSessionValidator");
const { performance } = require("node:perf_hooks");
/* eslint-env browser */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const totpSelector =
    'input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[type="text"], input[type="number"], input:not([type])';
let page,
    browser,
    context,
    token,
    config,
    interaction,
    validator,
    attemptDeadline,
    stopped = false,
    diagnosing = false;
function send(message) {
    if (process.connected) process.send({ token, ...message });
}
function fail(reason, retryable = false) {
    throw Object.assign(new Error(reason), { reason, retryable });
}
function guard() {
    if (stopped) fail("cancelled");
    if (attemptDeadline && performance.now() >= attemptDeadline) fail("attempt_timeout", true);
}
async function screenshot() {
    if (diagnosing) return;
    diagnosing = true;
    if (!page || page.isClosed()) {
        send({ screenshot: { reason: "page_closed" } });
        return;
    }
    try {
        const buffer = await page.screenshot({
            mask: [page.locator('input, textarea, [contenteditable="true"]')],
            maskColor: "#333333",
            timeout: config.screenshotTimeout,
        });
        send({ screenshot: { buffer } });
    } catch {
        send({ screenshot: { reason: "screenshot_timeout_or_page_closed" } });
    }
}
async function close() {
    try {
        await page?.close();
        await context?.close();
        await browser?.close();
    } catch {
        /* Supervisor enforces cleanup. */
    } finally {
        await validator?.close();
    }
}
async function visible(selector) {
    return page.locator(selector).filter({ visible: true }).first().isVisible();
}
async function waitForPage(predicate) {
    const deadline = Math.min(attemptDeadline, performance.now() + config.stepTimeout);
    while (performance.now() < deadline) {
        guard();
        if (await predicate()) return;
        await wait(250);
    }
    fail("page_transition_timeout", true);
}
async function totpReady() {
    return (
        (await visible('input[name="totpPin"], input[id="totpPin"]')) ||
        (/Google Authenticator|身份验证器|身分驗證器/i.test(await page.locator("body").innerText()) &&
            !(await visible("input#securityKeyOtpInputId")) &&
            (await visible(totpSelector)))
    );
}
async function clickForState(locator, ready) {
    try {
        // Let the click settle before moving on: racing it would leave an active
        // Playwright retry able to click the next page during code entry.
        await interaction.click(locator, { timeout: Math.min(config.stepTimeout, 5000) });
    } catch (cause) {
        guard();
        if ((cause.reason !== "ui_click_timeout" && cause.name !== "TimeoutError") || !(await ready())) throw cause;
    }
    guard();
    await waitForPage(ready);
}
async function nextButton() {
    const button = page.getByRole("button", { name: /^(Next|下一步|继续|Continue|Verify|验证)$/i }).first();
    await interaction.click(button);
}
async function run(input) {
    token = input.token;
    config = input.config;
    const deadline = performance.now() + config.attemptTimeout;
    attemptDeadline = deadline;
    interaction = new LoginInteraction({ config, guard });
    const phase = name => {
        guard();
        send({ phase: name });
    };
    const credentials = input.credentials;
    if (!input.targetUrl) fail("service_target_missing");
    phase("browser_launch");
    browser = await firefox.launch({
        headless: true,
        ...(input.executablePath ? { executablePath: input.executablePath } : {}),
        firefoxUserPrefs: {
            "network.proxy.allow_hijacking_localhost": true,
            "network.proxy.no_proxies_on": "",
            "network.trr.mode": 5,
        },
        timeout: config.stepTimeout,
    });
    guard();
    context = await browser.newContext({
        ...(input.proxy ? { proxy: input.proxy } : {}),
        bypassCSP: true,
        locale: "en-US",
        viewport: { height: 1000, width: 1440 },
    });
    context.setDefaultTimeout(config.stepTimeout);
    context.setDefaultNavigationTimeout(config.stepTimeout);
    page = await context.newPage();
    phase("email");
    await page.goto(
        "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com%2Fu%2F0%2Fprompts%2Fnew_chat",
        { waitUntil: "domcontentloaded" }
    );
    await interaction.pause(500, 1100);
    let emailSubmitted = false,
        passwordSubmitted = false,
        alternativeAttempted = false,
        totpSubmissions = 0,
        lastTotpWindow = -1;
    let transitionUntil = performance.now() + config.stepTimeout;
    while (performance.now() < deadline) {
        guard();
        const url = new URL(page.url());
        if (url.hostname === "aistudio.google.com") break;
        if (url.hostname !== "accounts.google.com") fail("workspace_sso_or_unknown_challenge");
        const text = await page.locator("body").innerText({ timeout: config.stepTimeout });
        if (/wrong password|incorrect password|密码错误|密码不正确/i.test(text)) fail("wrong_password");
        if (/couldn.t find your google account|找不到.*账号|找不到.*帐号/i.test(text)) fail("account_not_found");
        if (/account.*disabled|account.*suspended|账号.*停用|帐号.*停用/i.test(text)) fail("account_disabled");
        if (/couldn.t sign you in|could not sign you in|无法登录|browser or app may not be secure/i.test(text))
            fail("login_rejected");
        if (/change your password|更改密码|修改密码/i.test(text)) fail("password_change_required");
        const codeReady = await totpReady();
        if (credentials.totp && !codeReady && (await visible('[data-challengetype="6"]'))) {
            phase("choose_authenticator");
            await clickForState(page.locator('[data-challengetype="6"]').filter({ visible: true }).first(), totpReady);
            transitionUntil = performance.now() + config.stepTimeout;
            continue;
        }
        if (passwordSubmitted && credentials.totp && !alternativeAttempted && !codeReady) {
            const alternative = page.getByText(/^(Try another way|尝试其他方式|试试其他方式)$/i).first();
            if (await alternative.isVisible()) {
                phase("choose_authenticator");
                await clickForState(
                    alternative,
                    async () =>
                        (await totpReady()) ||
                        (!(await visible("input#securityKeyOtpInputId")) &&
                            (await visible(
                                '[data-challengetype="6"][role="link"], [data-challengetype="6"][role="button"], li[data-challengetype="6"]'
                            )))
                );
                alternativeAttempted = true;
                transitionUntil = performance.now() + config.stepTimeout;
                continue;
            }
        }
        if (
            (await visible(
                'input[type="tel"][name="phoneNumber"], input[name="knowledgePreregisteredEmailResponse"], input[name="ca"], input[name="captcha"]'
            )) ||
            /g\.co\/sc|check your phone|tap yes|确认.*设备|查看.*手机|enter.*recovery email|输入.*辅助邮箱|verify.*phone number|验证.*手机号/i.test(
                text
            )
        )
            fail("manual_challenge");
        if (
            (await visible('input[type="email"], input#identifierId, input[autocomplete="username"]')) &&
            !emailSubmitted
        ) {
            phase("email");
            await interaction.type(
                page
                    .locator('input[type="email"], input#identifierId, input[autocomplete="username"]')
                    .filter({ visible: true })
                    .first(),
                credentials.email
            );
            await nextButton();
            emailSubmitted = true;
            transitionUntil = performance.now() + config.stepTimeout;
        } else if ((await visible('input[type="password"]')) && !passwordSubmitted) {
            phase("password");
            await interaction.type(
                page.locator('input[type="password"]').filter({ visible: true }).first(),
                credentials.password
            );
            await nextButton();
            passwordSubmitted = true;
            transitionUntil = performance.now() + config.stepTimeout;
        } else if (codeReady) {
            phase("totp");
            if (!credentials.totp) fail("credentials_missing");
            const rejected = /wrong code|incorrect code|code.*expired|验证码.*错误|验证码.*过期/i.test(text);
            if (totpSubmissions && !rejected) {
                if (performance.now() > transitionUntil) fail("page_transition_timeout", true);
                await wait(250);
                continue;
            }
            if (totpSubmissions >= 2) fail("totp_rejected");
            await interaction.type(page.locator(totpSelector).filter({ visible: true }).first(), async () => {
                const period = credentials.totp.period * 1000;
                if (Math.floor(Date.now() / period) === lastTotpWindow || period - (Date.now() % period) < 5000)
                    await wait(period - (Date.now() % period) + 100);
                guard();
                lastTotpWindow = Math.floor(Date.now() / period);
                return Totp.code(credentials.totp);
            });
            await nextButton();
            totpSubmissions++;
            transitionUntil = performance.now() + config.stepTimeout;
        } else if (/choose how.*sign in|选择.*验证|2-step verification|两步验证/i.test(text) && !credentials.totp)
            fail("credentials_missing");
        else if (
            /terms of service|服务条款|i agree|我同意/i.test(text) &&
            passwordSubmitted &&
            !(await visible('input[type="password"]'))
        )
            fail("terms_or_consent_required");
        if (performance.now() > transitionUntil) fail("unknown_page");
        await wait(250);
    }
    guard();
    phase("aistudio_validation");
    if (new URL(page.url()).hostname !== "aistudio.google.com") fail("attempt_timeout", true);
    if (!page.url().includes("/prompts/new_chat"))
        await page.goto("https://aistudio.google.com/u/0/prompts/new_chat", { waitUntil: "domcontentloaded" });
    await waitForPage(
        async () =>
            /Failed to initialize applet|Available regions|not available in your country|地区.*不支持|Allow Drive access/i.test(
                await page.locator("body").innerText()
            ) || (await visible('textarea, [contenteditable="true"][role="textbox"]'))
    );
    const validation = await page.evaluate(() => {
        const body = document.body.innerText;
        const accountLabel = [...document.querySelectorAll("[aria-label]")]
            .map(node => node.getAttribute("aria-label"))
            .find(label => /Google Account:|Google 账号：|Google 帐号：/i.test(label));
        const email =
            accountLabel?.match(/[^\s()<>]+@[^\s()<>]+\.[^\s()<>]+/)?.[0] ||
            globalThis.WIZ_global_data?.oPEP7c ||
            [...document.scripts]
                .filter(script => script.textContent.includes("WIZ_global_data"))
                .map(script => script.textContent.match(/["']oPEP7c["']\s*:\s*"([^"\\]+)"/)?.[1])
                .find(Boolean);
        return {
            email: typeof email === "string" ? email.trim().toLowerCase() : null,
            initializationFailed: /Failed to initialize applet|snapshot.*failed|concurrent updates/i.test(body),
            permissionRequired: /Allow Drive access/i.test(body),
            unavailable: /Available regions|not available in your country|地区.*不支持/i.test(body),
        };
    });
    if (validation.unavailable) fail("service_region_restricted");
    if (validation.permissionRequired) fail("service_permission_required");
    if (validation.initializationFailed) fail("service_initialization_failed", true);
    if (validation.email !== credentials.email)
        fail(validation.email ? "account_mismatch" : "account_identity_unverified");
    // Reuse the request browser's initialization in this disposable executor.
    // No API pool contexts, registry or fixed-port listener are shared.
    if (input.targetUrl) {
        phase("target_service_initialization");
        const storageState = await context.storageState();
        guard();
        validator = new TargetSessionValidator({
            browser,
            onFailure: screenshot,
            onPage: targetPage => {
                page = targetPage;
            },
            onSignal: signal => send({ validationSignal: signal }),
            proxy: input.proxy,
            stepTimeout: config.stepTimeout,
            storageState,
            targetUrl: input.targetUrl,
            timeout: Math.max(1, deadline - performance.now()),
        });
        const result = await validator.validate();
        guard();
        await context.close();
        context = result.context;
        page = result.page;
        send({ validationSignal: "native_connection_verified" });
    }
    guard();
    phase("storage_state");
    const storageState = await context.storageState();
    guard();
    send({ result: { email: validation.email, storageState, targetInitialized: !!validator } });
    await close();
}
process.on("disconnect", () => {
    stopped = true;
    const terminateGroup = () => {
        try {
            process.kill(-process.pid, "SIGKILL");
        } catch {
            process.exit(1);
        }
    };
    setTimeout(terminateGroup, config?.cleanupTimeout || 10000);
    close().then(terminateGroup).catch(terminateGroup);
});
process.on("message", input => {
    if (input.abort && input.token === token) {
        stopped = true;
        screenshot()
            .then(close)
            .catch(() => {});
        return;
    }
    if (token) return;
    run(input).catch(async cause => {
        stopped = true;
        const reason =
            cause.reason ||
            (/net::|NS_ERROR|connection/i.test(cause.message)
                ? "network_timeout"
                : cause.name === "TimeoutError" || /timeout/i.test(cause.message)
                  ? "ui_operation_timeout"
                  : "browser_failure");
        await screenshot();
        let controls = [],
            frameKinds = [];
        if (page && !page.isClosed()) {
            try {
                frameKinds = await Promise.race([
                    Promise.all(
                        page
                            .frames()
                            .slice(0, 20)
                            .map(async frame => {
                                let protocol = "unknown";
                                try {
                                    protocol = new URL(frame.url()).protocol;
                                } catch {
                                    /* No URL disclosure. */
                                }
                                try {
                                    const info = await frame.evaluate(() => ({
                                        injected: [...document.scripts].some(script =>
                                            script.textContent.includes("__accountLoginValidationShim")
                                        ),
                                        installed: !!document.querySelector(
                                            '[data-account-login-shim-installed="true"]'
                                        ),
                                    }));
                                    return `${protocol}${info.installed ? "installed" : info.injected ? "injected" : "native"}`;
                                } catch {
                                    return protocol;
                                }
                            })
                    ),
                    wait(1000).then(() => []),
                ]);
            } catch {
                /* Only protocol names, never frame URLs or tokens. */
            }
            try {
                controls = await Promise.race([
                    page.evaluate(() =>
                        [...document.querySelectorAll("input")]
                            .filter(element => element.getClientRects().length > 0)
                            .slice(0, 10)
                            .map(element => ({
                                autocomplete: element.autocomplete,
                                id: /^[\w-]{0,64}$/.test(element.id) ? element.id : "redacted",
                                inputMode: element.inputMode,
                                name: /^[\w-]{0,64}$/.test(element.name) ? element.name : "redacted",
                                type: element.type,
                            }))
                    ),
                    wait(1000).then(() => []),
                ]);
            } catch {
                /* Diagnostic metadata is best effort and excludes values. */
            }
        }
        send({
            result: {
                controls: Array.isArray(controls) ? controls : [],
                error: reason,
                frameKinds,
                retryable:
                    cause.retryable ?? ["network_timeout", "ui_operation_timeout", "browser_failure"].includes(reason),
            },
        });
        await close();
    });
});
