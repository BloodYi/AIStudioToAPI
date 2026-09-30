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
    let browser;
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
                    const htmlFor = address => {
                        const url = new URL(address);
                        let html;
                        if (url.pathname.includes("ServiceLogin"))
                            html =
                                "<input id=\"identifierId\" type=\"text\"><button onclick=\"if(document.querySelector('input').value==='user@example.com')location.href='/password'\">Next</button>";
                        else if (url.pathname === "/password")
                            html = `<input type="password"><button onclick="if(document.querySelector('input').value==='synthetic')location.href='${options.noTotp ? "https://aistudio.google.com/prompts/new" : "/security"}'">Next</button>`;
                        else if (url.pathname === "/security")
                            html =
                                '<p>Get your security code at g.co/sc</p><p>Google Authenticator is another option</p><div data-challengetype="13" role="link"><input id="securityKeyOtpInputId" type="tel"></div><button onclick="setTimeout(()=>location.href=\'/totp\',100)">Try another way</button>';
                        else if (url.pathname === "/totp")
                            html = `<p>Get a verification code from the Google Authenticator app</p><input type="hidden" name="totpPin"><input id="newAuthenticatorCode" type="${options.codeType || "text"}" autocomplete="off"><button onclick="if(/^\\d{6}$/.test(document.getElementById('newAuthenticatorCode').value))location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.hostname === "aistudio.google.com" && !url.pathname.startsWith("/apps/"))
                            html = options.permissionRequired
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
                        return `<!doctype html><html><body>${html}</body></html>`;
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
        config: { attemptTimeout: 90000, humanize: true, screenshotTimeout: 1000, stepTimeout: 10000 },
        credentials: {
            email: "user@example.com",
            password: "synthetic",
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
