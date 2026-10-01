// Optional DOM integration against the deployed browser; every HTTP request is
// fulfilled locally, and only synthetic credentials are used.
const test = require("node:test");
const assert = require("node:assert/strict");
const { firefox } = require("playwright");
const { EventEmitter } = require("node:events");
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const Totp = require("../src/accounts/TotpService");
const workerPath = path.join(__dirname, "../src/accounts/AccountLoginWorker.js");
const workerRequire = createRequire(workerPath);
const executablePath = process.env.ACCOUNT_LOGIN_BROWSER_TEST_EXECUTABLE;

async function run(options = {}) {
    let browser,
        contextsCreated = 0;
    const processMock = new EventEmitter();
    processMock.connected = true;
    let resolveResult;
    const result = new Promise(resolve => {
        resolveResult = resolve;
    });
    processMock.send = message => {
        if (message.result) resolveResult(message.result);
    };
    const mockPlaywright = {
        firefox: {
            launch: async launchOptions => {
                browser = await firefox.launch({ ...launchOptions, executablePath });
                const original = browser.newContext.bind(browser);
                browser.newContext = async contextOptions => {
                    const context = await original(contextOptions);
                    const validationContext = contextsCreated++ > 0;
                    const htmlFor = address => {
                        const url = new URL(address);
                        let html;
                        if (url.pathname.includes("ServiceLogin"))
                            html =
                                "<input id=\"identifierId\" type=\"text\"><button onclick=\"if(document.querySelector('input').value==='user@example.com')location.href='/password'\">Next</button>";
                        else if (url.pathname === "/password")
                            html = `<input type="password"><button onclick="if(document.querySelector('input').value==='synthetic')location.href='${options.recovery ? "/recovery" : options.noTotp ? "https://aistudio.google.com/prompts/new" : "/security"}'">Next</button>`;
                        else if (url.pathname === "/recovery")
                            html = `<p>Confirm your recovery email</p><input name="knowledgePreregisteredEmailResponse"><button onclick="${options.wrongRecovery ? "document.querySelector('p').textContent='Incorrect recovery email'" : "if(document.querySelector('input').value==='recover@example.com')location.href='https://aistudio.google.com/prompts/new'"}">Next</button>`;
                        else if (url.pathname === "/security")
                            html =
                                '<p>Get your security code at g.co/sc</p><p>Google Authenticator is another option</p><div data-challengetype="13" role="link"><input id="securityKeyOtpInputId" type="tel"></div><button onclick="setTimeout(()=>location.href=\'/totp\',100)">Try another way</button>';
                        else if (url.pathname === "/totp" && options.split)
                            html = `<p>Google Authenticator</p>${Array.from({ length: options.split }, (_, index) => `<input type="tel" maxlength="1" ${options.autoSubmit && index === 5 ? `oninput="if([...document.querySelectorAll('input')].every(n=>n.value))location.href='https://aistudio.google.com/prompts/new'"` : ""}>`).join("")}<button onclick="if([...document.querySelectorAll('input')].every(n=>/^\\d$/.test(n.value)))location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.pathname === "/totp")
                            html = `<p>Get a verification code from the Google Authenticator app</p><input type="hidden" name="totpPin"><input id="newAuthenticatorCode" type="${options.codeType || "text"}" autocomplete="off"><button onclick="if(/^\\d{6}$/.test(document.getElementById('newAuthenticatorCode').value))location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.hostname === "aistudio.google.com" && !url.pathname.startsWith("/apps/"))
                            html =
                                options.terms || (options.finalTerms && validationContext)
                                    ? `<button aria-label="Google Account: user@example.com">Account</button><label><input id="unrelated" type="checkbox">Optional unrelated</label><button onclick="throw Error('unrelated clicked')">Continue</button><div role="dialog"><h2>AI Studio ${options.chinese ? "服务条款" : "Terms of service"}</h2>${options.aria ? `<div style="width:20px;height:20px" role="checkbox" aria-required="true" aria-checked="false" aria-label="I agree to the terms of service" onclick="this.setAttribute('aria-checked','true');document.getElementById('accept').disabled=false"></div>` : `<label><input type="checkbox" ${options.checked ? "checked" : ""} onchange="document.getElementById('accept').disabled=false">I agree to the terms of service</label>`}<label><input id="marketing" type="checkbox">Email newsletter updates</label><button aria-label="Continue to Google AI Studio after accepting terms" id="accept" ${options.checked ? "" : "disabled"} onclick="if(document.getElementById('marketing').checked || document.getElementById('unrelated').checked)throw Error('optional selected');document.cookie='termsAccepted=1;path=/';this.parentNode.remove();document.body.insertAdjacentHTML('beforeend','<textarea></textarea>')">${options.chinese ? "同意" : "I agree"}</button></div>`
                                    : options.permissionRequired
                                      ? "<p>Allow Drive access</p><button>Allow access</button>"
                                      : options.bootstrapIdentity
                                        ? '<script>var WIZ_global_data={"oPEP7c":"user@example.com"};</script><textarea placeholder="Prompt"></textarea>'
                                        : `<button aria-label="Google Account: ${options.mismatch ? "other@example.com" : "user@example.com"}">Account</button><textarea aria-label="Prompt"></textarea>`;
                        else if (url.hostname === "ai.studio" || url.pathname.startsWith("/apps/")) {
                            if (options.frameKind) {
                                const child =
                                    '<!doctype html><script>window.addEventListener("message", e=>{if(e.data?.type==="authIndexResponse" && e.data.authIndex===0)new WebSocket("ws://127.0.0.1:9998?authIndex=0")});parent.postMessage({type:"requestAuthIndex"},"*");<' +
                                    "/script>";
                                const encoded = JSON.stringify(child).replaceAll("</script>", "<\\/script>");
                                html = `<script>const frame=document.createElement('iframe');document.body.append(frame);${options.frameKind === "blob" ? `frame.src=URL.createObjectURL(new Blob([${encoded}],{type:'text/html'}))` : options.frameKind === "attribute" ? `frame.setAttribute('srcdoc',${encoded})` : `frame.srcdoc=${encoded}`};</script>`;
                            } else
                                html = options.consoleOnly
                                    ? '<script>console.log("[ProxyClient] Connection successful")</script>'
                                    : options.appFailure
                                      ? "<p>Failed to initialize applet</p>"
                                      : '<script>new WebSocket("ws://127.0.0.1:9998?authIndex=0")</script>';
                        } else html = "Unexpected request";
                        if (
                            options.delayedTerms &&
                            url.hostname === "aistudio.google.com" &&
                            !url.pathname.startsWith("/apps/")
                        )
                            html =
                                "<textarea></textarea>" +
                                html.replace(
                                    '<div role="dialog">',
                                    '<div role="dialog" style="display:none" id="late-terms">'
                                ) +
                                '<script>setTimeout(()=>document.getElementById("late-terms").style.display="block",700)</script>';
                        return `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}</body></html>`;
                    };
                    const originalRoute = context.route.bind(context);
                    await originalRoute("**/*", async route => {
                        await route.fulfill({
                            body: htmlFor(route.request().url()),
                            contentType: "text/html",
                        });
                    });
                    return context;
                };
                return browser;
            },
        },
    };
    const vm = require("node:vm");
    vm.runInNewContext(
        fs.readFileSync(workerPath, "utf8"),
        {
            Date,
            process: processMock,
            require: name => (name === "playwright" ? mockPlaywright : workerRequire(name)),
            setTimeout,
            URL,
        },
        { filename: workerPath }
    );
    processMock.emit("message", {
        config: { attemptTimeout: 90000, humanize: options.fast !== true, screenshotTimeout: 1000, stepTimeout: 10000 },
        credentials: {
            email: "user@example.com",
            password: "synthetic",
            recoveryEmail: options.missingRecovery ? null : "recover@example.com",
            totp: Totp.normalize("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"),
        },
        executablePath,
        targetUrl: "https://ai.studio/apps/synthetic",
        token: "synthetic",
    });
    try {
        return await result;
    } finally {
        await browser?.close();
    }
}
test(
    "real browser: asynchronous alternative verification, hidden old controls and changed PIN types",
    { skip: !executablePath },
    async () => {
        for (const codeType of ["text", "number", "tel"]) {
            const result = await run({ codeType });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.equal(result.targetInitialized, true);
        }
    }
);
test("real browser: no-two-step success and account/app verification failures", { skip: !executablePath }, async () => {
    assert.ok((await run({ noTotp: true })).storageState);
    assert.ok((await run({ bootstrapIdentity: true, noTotp: true })).storageState);
    assert.equal((await run({ noTotp: true, permissionRequired: true })).error, "service_permission_required");
    assert.equal((await run({ mismatch: true })).error, "account_mismatch");
    assert.equal((await run({ appFailure: true })).error, "service_initialization_failed");
});
test(
    "real browser: dynamically created srcdoc and blob previews stay outside the request pool",
    { skip: !executablePath },
    async () => {
        for (const frameKind of ["srcdoc", "attribute", "blob"]) {
            const result = await run({ frameKind, noTotp: true });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.equal(result.targetInitialized, true);
        }
    }
);

test(
    "real browser: a success console message cannot replace a native connection",
    { skip: !executablePath },
    async () => {
        const result = await run({ consoleOnly: true, noTotp: true });
        assert.equal(result.error, "service_initialization_unverified");
        assert.ok(!result.storageState);
    }
);

test("real browser: first terms leave optional controls untouched", { skip: !executablePath }, async () => {
    for (const options of [{}, { chinese: true }, { aria: true }, { checked: true }]) {
        const result = await run({ ...options, fast: true, noTotp: true, terms: true });
        assert.ok(result.storageState, JSON.stringify({ options, result }));
    }
});
test("real browser: recovery confirmation and manual failure boundaries", { skip: !executablePath }, async () => {
    assert.ok((await run({ fast: true, recovery: true })).storageState);
    assert.equal((await run({ fast: true, missingRecovery: true, recovery: true })).error, "recovery_email_missing");
    assert.equal((await run({ fast: true, recovery: true, wrongRecovery: true })).error, "recovery_email_rejected");
});
test("real browser: six digit code, automatic submission and ambiguous counts", { skip: !executablePath }, async () => {
    assert.ok((await run({ fast: true, split: 6 })).storageState);
    assert.ok((await run({ autoSubmit: true, fast: true, split: 6 })).storageState);
    assert.equal((await run({ fast: true, split: 5 })).error, "manual_challenge");
});

async function handlerFixture(t, html, child = html) {
    const browser = await firefox.launch({ executablePath, headless: true });
    t.after(() => browser.close());
    const page = await browser.newPage();
    await page.route("**/*", route =>
        route.fulfill({
            body: `<meta charset="utf-8">${route.request().url().includes("/child") ? child : html}`,
            contentType: "text/html; charset=utf-8",
        })
    );
    await page.goto("https://aistudio.google.com/test");
    const guard = () => {};
    const interaction = new (require("../src/accounts/LoginInteraction"))({
        config: { humanize: false, stepTimeout: 3000 },
        guard,
    });
    const handler = new (require("../src/accounts/LoginPageHandlers"))({
        deadline: performance.now() + 10000,
        guard,
        interaction,
        page,
        phase() {},
        stepTimeout: 3000,
    });
    return { handler, interaction, page };
}
test("real browser: same-service iframe, delayed button and multi-step consent", { skip: !executablePath }, async t => {
    const child = `<div role="dialog"><h2>AI Studio Terms of service</h2><label><input type="checkbox" required checked>Accept terms</label><button disabled onclick="this.parentNode.remove()">Accept</button></div><script>setTimeout(()=>document.querySelector('button').disabled=false,150)</script>`;
    const { handler, page } = await handlerFixture(
        t,
        '<iframe src="https://aistudio.google.com/child"></iframe>',
        child
    );
    await page.frames()[1].waitForLoadState();
    assert.equal(await handler.terms(), true);
    const frame = page.frames()[1];
    assert.equal(await frame.locator('[role="dialog"]').count(), 0);
    await page.route("**/*", route =>
        route.fulfill({
            body: `<div role="dialog"><h2>AI Studio Terms of service</h2><button onclick="if(this.textContent==='Accept'){this.textContent='Continue';this.previousSibling.textContent='Gemini additional terms'}else this.parentNode.remove()">Accept</button></div>`,
            contentType: "text/html; charset=utf-8",
        })
    );
    await page.goto("https://aistudio.google.com/steps");
    assert.equal(await handler.terms(), true);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
});
test(
    "real browser: unknown and foreign consent stay untouched; summaries use enums",
    { skip: !executablePath },
    async t => {
        const html = `<div role="dialog">Unknown Drive authorization<input type="checkbox"><button>Continue</button></div><iframe src="https://untrusted.example/child"></iframe><input name="private@example.com" id="password-secret" value="recovery@example.com"><button>private@example.com 123456 cookie-secret</button>`;
        const { handler, page } = await handlerFixture(
            t,
            html,
            '<div role="dialog">AI Studio Terms of service<input type="checkbox"><button>I agree</button></div>'
        );
        await page.frames()[1].waitForLoadState();
        assert.equal(await handler.terms(), false);
        assert.equal(await page.locator('input[type="checkbox"]').isChecked(), false);
        const summary = JSON.stringify(await handler.structure());
        for (const secret of [
            "private@example.com",
            "password-secret",
            "recovery@example.com",
            "123456",
            "cookie-secret",
        ])
            assert.equal(summary.includes(secret), false);
    }
);
test(
    "real browser: cancellation and deadlines prevent subsequent consent clicks",
    { skip: !executablePath },
    async t => {
        const html = `<div role="dialog">AI Studio Terms of service<label><input type="checkbox" required>Accept terms</label><button>Accept</button></div>`;
        const { handler, interaction, page } = await handlerFixture(t, html);
        let cancelled = false;
        handler.guard = interaction.guard = () => {
            if (cancelled) throw Object.assign(new Error("cancelled"), { reason: "cancelled" });
        };
        const click = interaction.click.bind(interaction);
        interaction.click = async (...args) => {
            await click(...args);
            cancelled = true;
        };
        await assert.rejects(handler.terms(), { reason: "cancelled" });
        assert.equal(await page.locator('[role="dialog"]').isVisible(), true);
        cancelled = false;
        handler.deadline = performance.now() - 1;
        await assert.rejects(handler.terms(), { reason: "terms_or_consent_required" });
    }
);

test(
    "real browser: delayed terms and final-context consent must finish before commit",
    { skip: !executablePath },
    async () => {
        for (const options of [{ delayedTerms: true, terms: true }, { finalTerms: true }]) {
            const result = await run({ ...options, fast: true, noTotp: true });
            assert.ok(result.storageState, JSON.stringify(result));
            assert.ok(result.storageState.cookies.some(cookie => cookie.name === "termsAccepted"));
        }
    }
);

test("real browser: observed optional cost hint never opens spending settings", { skip: !executablePath }, async t => {
    const html = `<div role="dialog" style="width:230px;height:120px"><p>新功能：控制 API 费用</p><p>设置每月支出上限，以防止意外超支</p><button onclick="throw Error('settings action')">创建支出上限</button><button aria-label="Close" onclick="this.parentNode.remove()">X</button></div><textarea></textarea>`;
    const { handler, page } = await handlerFixture(t, html);
    assert.equal(await handler.transition(), true);
    assert.equal(await page.locator('[role="dialog"]').count(), 0);
    assert.equal(handler.transitionClicks, 1);
});
