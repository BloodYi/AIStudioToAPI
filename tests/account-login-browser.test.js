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
                                '<input id="identifierId" type="text"><button onclick="location.href=\'/password\'">Next</button>';
                        else if (url.pathname === "/password")
                            html = `<input type="password"><button onclick="location.href='${options.noTotp ? "https://aistudio.google.com/prompts/new" : "/security"}'">Next</button>`;
                        else if (url.pathname === "/security")
                            html =
                                '<p>Get your security code at g.co/sc</p><input type="number"><button onclick="setTimeout(()=>location.href=\'/totp\',100)">Try another way</button>';
                        else if (url.pathname === "/totp")
                            html = `<p>Get a verification code from the Google Authenticator app</p><input type="hidden" name="totpPin"><input id="newAuthenticatorCode" type="${options.codeType || "text"}" autocomplete="off"><button onclick="location.href='https://aistudio.google.com/prompts/new'">Next</button>`;
                        else if (url.hostname === "aistudio.google.com")
                            html = `<button aria-label="Google Account: ${options.mismatch ? "other@example.com" : "user@example.com"}">Account</button><textarea aria-label="Prompt"></textarea>`;
                        else if (url.hostname === "ai.studio")
                            html = options.appFailure
                                ? "<p>Failed to initialize applet</p>"
                                : '<script>new WebSocket("ws://127.0.0.1:9998?authIndex=0")</script>';
                        else html = "Unexpected request";
                        return `<!doctype html><html><body>${html}</body></html>`;
                    };
                    const originalRoute = context.route.bind(context);
                    await originalRoute("**/*", async route => {
                        await route.fulfill({
                            body: htmlFor(route.request().url()),
                            contentType: "text/html",
                        });
                    });
                    // Keep response interception completely offline too.
                    context.route = (pattern, handler) =>
                        originalRoute(pattern, route => {
                            route.fetch = async () => ({
                                headers: () => ({ "content-type": "text/html" }),
                                text: async () => htmlFor(route.request().url()),
                            });
                            const fulfill = route.fulfill.bind(route);
                            route.fulfill = ({ response, ...parameters }) =>
                                fulfill({
                                    contentType: "text/html",
                                    ...parameters,
                                });
                            return handler(route);
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
        config: { attemptTimeout: 30000, screenshotTimeout: 1000, stepTimeout: 5000 },
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
        }
    }
);
test("real browser: no-two-step success and account/app verification failures", { skip: !executablePath }, async () => {
    assert.ok((await run({ noTotp: true })).storageState);
    assert.equal((await run({ mismatch: true })).error, "account_mismatch");
    assert.equal((await run({ appFailure: true })).error, "service_initialization_failed");
});
