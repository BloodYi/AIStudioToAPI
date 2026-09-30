const { firefox } = require("playwright");
const Totp = require("./TotpService");
const { performance } = require("node:perf_hooks");
const { pageErrors } = require("../auth/TargetServiceValidation");
/* eslint-env browser */
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const totpSelector =
    'input[name="totpPin"], input[id="totpPin"], input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[type="text"], input[type="number"], input:not([type])';
let page,
    browser,
    context,
    token,
    config,
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
    }
}
async function visible(selector) {
    return page.locator(selector).filter({ visible: true }).first().isVisible();
}
async function nextButton() {
    const button = page.getByRole("button", { name: /^(Next|下一步|继续|Continue|Verify|验证)$/i }).first();
    await button.click();
}
async function run(input) {
    token = input.token;
    config = input.config;
    const deadline = performance.now() + config.attemptTimeout;
    const phase = name => {
        guard();
        send({ phase: name });
    };
    const credentials = input.credentials;
    phase("browser_launch");
    browser = await firefox.launch({
        headless: true,
        ...(input.executablePath ? { executablePath: input.executablePath } : {}),
        firefoxUserPrefs: { "network.trr.mode": 5 },
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
        "https://accounts.google.com/ServiceLogin?continue=https%3A%2F%2Faistudio.google.com%2Fprompts%2Fnew",
        { waitUntil: "domcontentloaded" }
    );
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
        if (credentials.totp && (await visible('[data-challengetype="6"]'))) {
            phase("choose_authenticator");
            await page.locator('[data-challengetype="6"]').first().click();
            await page.waitForFunction(previous => document.body.innerText !== previous, text, {
                polling: 250,
                timeout: config.stepTimeout,
            });
            transitionUntil = performance.now() + config.stepTimeout;
            continue;
        }
        if (passwordSubmitted && credentials.totp && !alternativeAttempted) {
            const alternative = page.getByText(/^(Try another way|尝试其他方式|试试其他方式)$/i).first();
            if (await alternative.isVisible()) {
                phase("choose_authenticator");
                await alternative.click();
                await page.waitForFunction(
                    () => {
                        const visible = selector =>
                            [...document.querySelectorAll(selector)].some(
                                element => element.getClientRects().length > 0
                            );
                        return (
                            visible('[data-challengetype], input[name="totpPin"]') ||
                            (/Google Authenticator|身份验证器|身分驗證器/i.test(document.body.innerText) &&
                                visible(
                                    'input[autocomplete="one-time-code"], input[inputmode="numeric"], input[type="tel"], input[type="text"], input[type="number"], input:not([type])'
                                ))
                        );
                    },
                    null,
                    { polling: 250, timeout: config.stepTimeout }
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
            await page
                .locator('input[type="email"], input#identifierId, input[autocomplete="username"]')
                .first()
                .fill(credentials.email);
            await nextButton();
            emailSubmitted = true;
            transitionUntil = performance.now() + config.stepTimeout;
        } else if ((await visible('input[type="password"]')) && !passwordSubmitted) {
            phase("password");
            await page.locator('input[type="password"]').first().fill(credentials.password);
            await nextButton();
            passwordSubmitted = true;
            transitionUntil = performance.now() + config.stepTimeout;
        } else if (
            (await visible('input[name="totpPin"], input[id="totpPin"]')) ||
            (/Google Authenticator|身份验证器|身分驗證器/i.test(text) && (await visible(totpSelector)))
        ) {
            phase("totp");
            if (!credentials.totp) fail("credentials_missing");
            const rejected = /wrong code|incorrect code|code.*expired|验证码.*错误|验证码.*过期/i.test(text);
            if (totpSubmissions && !rejected) {
                if (performance.now() > transitionUntil) fail("page_transition_timeout", true);
                await wait(250);
                continue;
            }
            if (totpSubmissions >= 2) fail("totp_rejected");
            const period = credentials.totp.period * 1000;
            if (Math.floor(Date.now() / period) === lastTotpWindow || period - (Date.now() % period) < 5000)
                await wait(period - (Date.now() % period) + 100);
            guard();
            lastTotpWindow = Math.floor(Date.now() / period);
            await page.locator(totpSelector).filter({ visible: true }).first().fill(Totp.code(credentials.totp));
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
    if (!page.url().includes("/prompts/"))
        await page.goto("https://aistudio.google.com/prompts/new", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
        () => {
            const errors =
                /Failed to initialize applet|Available regions|not available in your country|地区.*不支持/i.test(
                    document.body.innerText
                );
            return (
                errors ||
                !!document.querySelector(
                    'ms-prompt-box textarea, ms-prompt-input textarea, textarea[aria-label], [contenteditable="true"][role="textbox"]'
                )
            );
        },
        null,
        { polling: 250, timeout: config.stepTimeout }
    );
    const validation = await page.evaluate(() => {
        const body = document.body.innerText;
        const accountLabel = [...document.querySelectorAll("[aria-label]")]
            .map(node => node.getAttribute("aria-label"))
            .find(label => /Google Account:|Google 账号：|Google 帐号：/i.test(label));
        const email =
            accountLabel?.match(/[^\s()<>]+@[^\s()<>]+\.[^\s()<>]+/)?.[0] || globalThis.WIZ_global_data?.oPEP7c;
        return {
            email: typeof email === "string" ? email.trim().toLowerCase() : null,
            initializationFailed: /Failed to initialize applet|snapshot.*failed|concurrent updates/i.test(body),
            unavailable: /Available regions|not available in your country|地区.*不支持/i.test(body),
        };
    });
    if (validation.unavailable) fail("service_region_restricted");
    if (validation.initializationFailed) fail("service_initialization_failed", true);
    if (validation.email !== credentials.email)
        fail(validation.email ? "account_mismatch" : "account_identity_unverified");
    // Validate the same app initialization used by the request browser, with an
    // intercepted local socket so the login worker never joins the API pool.
    if (input.targetUrl) {
        phase("target_service_initialization");
        let initialized = false;
        await context.routeWebSocket(/^ws:\/\/127\.0\.0\.1:9998(?:\/|\?)/, () => {
            initialized = true;
        });
        // Camoufox isolates Playwright init scripts, including websocket routing.
        // Inject the validation shim into document responses, before site scripts,
        // so no application connection can reach the production request pool.
        await context.route("**/*", async route => {
            if (route.request().resourceType() !== "document") return route.fallback();
            const response = await route.fetch({ maxRedirects: 0, timeout: config.stepTimeout });
            if (!/text\/html/i.test(response.headers()["content-type"] || "")) return route.fulfill({ response });
            const shim = `<script>(${function () {
                const NativeSocket = window.WebSocket;
                class ValidationSocket extends EventTarget {
                    constructor(url) {
                        super();
                        this.url = String(url);
                        this.readyState = 0;
                        this.bufferedAmount = 0;
                        this.protocol = this.extensions = "";
                        setTimeout(() => {
                            this.readyState = 1;
                            document.documentElement.setAttribute("data-account-login-initialized", "true");
                            const event = new Event("open");
                            this.dispatchEvent(event);
                            this.onopen?.(event);
                        }, 0);
                    }
                    send() {}
                    close() {
                        this.readyState = 3;
                    }
                }
                for (const [key, value] of Object.entries({ CLOSED: 3, CLOSING: 2, CONNECTING: 0, OPEN: 1 })) {
                    ValidationSocket[key] = value;
                    ValidationSocket.prototype[key] = value;
                }
                window.WebSocket = new Proxy(NativeSocket, {
                    construct(Target, args) {
                        const url = new URL(args[0], location.href);
                        if (["127.0.0.1", "localhost"].includes(url.hostname) && url.port === "9998")
                            return new ValidationSocket(args[0]);
                        return Reflect.construct(Target, args);
                    },
                });
                window.addEventListener("message", event => {
                    if (event.data?.type === "requestAuthIndex")
                        event.source.postMessage({ authIndex: 0, type: "authIndexResponse" }, "*");
                });
            }.toString()})();</script>`;
            const html = await response.text();
            const headers = { ...response.headers() };
            delete headers["content-encoding"];
            delete headers["content-length"];
            const doctype = html.match(/^\s*<!doctype[^>]*>/i)?.[0] || "";
            await route.fulfill({ body: doctype + shim + html.slice(doctype.length), headers, response });
        });
        await context.addInitScript(() => {
            window.addEventListener("message", event => {
                if (event.data?.type === "requestAuthIndex")
                    event.source.postMessage({ authIndex: 0, type: "authIndexResponse" }, "*");
            });
        });
        await page.goto(input.targetUrl, { waitUntil: "domcontentloaded" });
        const initDeadline = Math.min(deadline, performance.now() + config.stepTimeout);
        while (!initialized && performance.now() < initDeadline) {
            guard();
            if (new URL(page.url()).hostname === "accounts.google.com") fail("session_expired_during_validation");
            const errors = await page.evaluate(pageErrors);
            if (Object.values(errors).some(Boolean)) fail("service_initialization_failed", true);
            for (const frame of page.frames()) {
                try {
                    if (await frame.locator('[data-account-login-initialized="true"]').count()) initialized = true;
                } catch {
                    /* A navigating frame will be checked on the next tick. */
                }
            }
            for (const name of [/^Continue to the app$|^继续使用应用$/, /^Skip$|^跳过$/, /^Launch$|^启动$/]) {
                const button = page.getByRole("button", { name }).first();
                if (await button.isVisible()) {
                    await button.click();
                    break;
                }
            }
            await wait(250);
        }
        if (!initialized) fail("service_initialization_timeout", true);
    }
    guard();
    phase("storage_state");
    const storageState = await context.storageState();
    guard();
    send({ result: { email: validation.email, storageState } });
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
            (/timeout|net::|NS_ERROR|connection/i.test(cause.message) ? "network_timeout" : "browser_failure");
        await screenshot();
        let controls = [];
        if (page && !page.isClosed()) {
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
                retryable: cause.retryable ?? ["network_timeout", "browser_failure"].includes(reason),
            },
        });
        await close();
    });
});
