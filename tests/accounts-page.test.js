/* eslint-env browser */
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");

test(
    "account page refreshes after upload and filter changes; unlogged accounts support proxy binding",
    { skip: !fs.existsSync(chromium.executablePath()) },
    async t => {
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0, strictPort: false },
        });
        t.after(() => server.close());
        await server.listen();
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage();
        await page.addInitScript(() => {
            window.__accountTestIntervals = [];
            const schedule = window.setInterval;
            window.setInterval = (...args) => {
                const id = schedule(...args);
                window.__accountTestIntervals.push(id);
                return id;
            };
        });
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const account = (email, recoveryState = "idle") => ({
            accountId: email,
            authIndex: null,
            autoRecovery: true,
            credentialVersion: 1,
            email,
            hasPassword: true,
            hasTotpSecret: false,
            recoveryState,
            sessionState: "missing",
        });
        const accounts = [account("first@example.com"), account("manual@example.com", "manual_required")];
        accounts[1].lastFailure = { error: "manual_challenge" };
        const queries = [];
        const proxyNodes = [
            { enabled: true, id: "login-node", name: "Login node", type: "socks5" },
            { enabled: true, id: "direct-node", name: "VPS Direct", type: "direct" },
        ];
        const proxyBindings = new Map();
        const bindingWrites = [];
        let releaseOld;
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/en.json"), "utf8"),
                contentType: "application/json",
            })
        );
        await page.route("**/api/**", async route => {
            const url = new URL(route.request().url());
            let result = {};
            if (url.pathname === "/api/status" || url.pathname === "/api/status/core") {
                result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "legacy" } };
            } else if (url.pathname === "/api/account-management/login-queue") {
                result = { attemptTimeout: 180000, autoRecovery: false, concurrency: 1 };
            } else if (url.pathname === "/api/account-management/accounts") {
                queries.push(url.searchParams);
                const search = url.searchParams.get("search") || "";
                const state = url.searchParams.get("state") || "";
                const matches = accounts.filter(
                    row =>
                        row.email.includes(search) &&
                        (!state ||
                            (state === "not_logged_in"
                                ? row.sessionState === "missing" && row.hasPassword
                                : row.recoveryState === state || row.sessionState === state))
                );
                result = { accounts: matches, total: matches.length };
                if (search === "first") await new Promise(resolve => (releaseOld = resolve));
            } else if (
                url.pathname.startsWith("/api/account-management/accounts/") &&
                url.pathname.endsWith("/login")
            ) {
                const id = decodeURIComponent(url.pathname.split("/").at(-2));
                Object.assign(
                    accounts.find(row => row.accountId === id),
                    {
                        authIndex: 0,
                        lastFailure: null,
                        recoveryState: "idle",
                        sessionState: "valid",
                    }
                );
                result = { taskId: "synthetic-login-task" };
            } else if (url.pathname === "/api/files") {
                accounts.push(account("uploaded@example.com"));
                result = { filename: "auth-2.json" };
            } else if (url.pathname === "/api/proxy-pool/nodes") {
                result = { nodes: proxyNodes };
            } else if (url.pathname === "/api/proxy-pool/status") {
                result = { enabled: true, mihomo: { ready: true } };
            } else if (url.pathname === "/api/proxy-pool/subscriptions") {
                result = { subscriptions: [] };
            } else if (url.pathname === "/api/proxy-pool/bindings") {
                result = {
                    bindings: accounts.map(row => ({
                        accountKey: row.email,
                        accountName: row.email,
                        authIndex: null,
                        desiredNodeId: proxyBindings.get(row.email) || null,
                        inflight: 0,
                        state: proxyBindings.has(row.email) ? "offline" : "unbound",
                    })),
                };
            } else if (url.pathname.startsWith("/api/proxy-pool/bindings/")) {
                const body = route.request().postDataJSON();
                const entries = body.bindings || [
                    { accountKey: decodeURIComponent(url.pathname.split("/").at(-1)), ...body },
                ];
                bindingWrites.push(...entries);
                for (const entry of entries) proxyBindings.set(entry.accountKey, entry.desiredNodeId);
            }
            await route.fulfill({ json: result });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/accounts`);
        const rows = page.locator(".accounts-panel .el-table__body-wrapper tbody tr");
        const waitRows = count =>
            page.waitForFunction(
                expected =>
                    document.querySelectorAll(".accounts-panel .el-table__body-wrapper tbody tr").length === expected,
                count
            );
        await waitRows(2);
        const search = page.getByPlaceholder("Search email / account index");
        await search.fill("manual");
        await waitRows(1);
        assert.match(await rows.innerText(), /manual@example.com/);
        await search.fill("");
        await waitRows(2);

        await search.fill("manual");
        await waitRows(1);
        await search.hover();
        await page.locator(".accounts-panel .el-input__clear").click();
        await waitRows(2);

        const filter = page.locator(".accounts-panel > .account-toolbar .el-select");
        await filter.click();
        await page.getByRole("option", { exact: true, name: "Manual required" }).click();
        await waitRows(1);
        await filter.hover();
        await filter.locator(".el-select__clear").click();
        await waitRows(2);
        assert.equal(queries.at(-1).get("state"), "");

        await filter.click();
        const notLoggedIn = page.waitForResponse(
            response => new URL(response.url()).searchParams.get("state") === "not_logged_in"
        );
        await page.getByRole("option", { exact: true, name: "Not logged in" }).click();
        await notLoggedIn;
        assert.equal(await rows.count(), 2);
        const manual = rows.filter({ hasText: "manual@example.com" });
        assert.match(await manual.innerText(), /manual_challenge/);
        await manual.getByRole("button", { exact: true, name: "Log in" }).click();
        await waitRows(1);
        assert.match(await rows.innerText(), /first@example.com/);
        await filter.hover();
        await filter.locator(".el-select__clear").click();
        await waitRows(2);
        assert.ok(!(await manual.innerText()).includes("manual_challenge"));
        assert.match(await manual.innerText(), /Valid/);

        // A slow search response must not overwrite the newer cleared query.
        const oldRequest = page.waitForRequest(
            request => new URL(request.url()).searchParams.get("search") === "first"
        );
        await search.fill("first");
        await oldRequest;
        await search.fill("");
        await waitRows(2);
        const oldResponse = page.waitForResponse(
            response => new URL(response.url()).searchParams.get("search") === "first"
        );
        releaseOld();
        await oldResponse;
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.equal(await rows.count(), 2);

        // Disable the child's interval so the upload must trigger its own immediate refresh.
        await page.evaluate(() => {
            for (const id of window.__accountTestIntervals) clearInterval(id);
        });
        await page.locator('input[type="file"][accept=".json,.zip"]').setInputFiles({
            buffer: Buffer.from(JSON.stringify({ accountName: "uploaded@example.com", cookies: [], origins: [] })),
            mimeType: "application/json",
            name: "auth.json",
        });
        await waitRows(3);
        assert.ok((await rows.allTextContents()).some(text => text.includes("uploaded@example.com")));

        await page.locator('button[title="节点池"]').click();
        const proxySection = page
            .locator(".pool-card")
            .filter({ has: page.getByRole("heading", { name: "账号出口" }) });
        const uploaded = proxySection.locator("tbody tr").filter({ hasText: "uploaded@example.com" });
        await uploaded.waitFor();
        assert.match(await uploaded.innerText(), /未登录/);
        assert.equal(await uploaded.getByRole("button", { exact: true, name: "应用" }).isDisabled(), true);
        await uploaded.locator(".el-select").click();
        const saved = page.waitForResponse(
            response => response.request().method() === "PUT" && response.url().includes("/api/proxy-pool/bindings/")
        );
        const bindingsRefreshed = page.waitForResponse(
            response => response.request().method() === "GET" && response.url().endsWith("/api/proxy-pool/bindings")
        );
        await page.getByRole("option", { exact: true, name: "Login node" }).click();
        await saved;
        await bindingsRefreshed;
        assert.deepEqual(bindingWrites.at(-1), { accountKey: "uploaded@example.com", desiredNodeId: "login-node" });
        await page.waitForFunction(() => document.querySelector(".proxy-pool")?.textContent.includes("Login node"));

        await uploaded.locator(".el-checkbox").click();
        const first = proxySection.locator("tbody tr").filter({ hasText: "first@example.com" });
        await first.locator(".el-checkbox").click();
        const batchSelect = proxySection.locator(".actions .el-select").last();
        await batchSelect.click();
        const dropdownId = await batchSelect.getByRole("combobox").getAttribute("aria-controls");
        await page.locator(`#${dropdownId}`).getByRole("option", { exact: true, name: "VPS Direct" }).click();
        const batchSaved = page.waitForResponse(
            response => response.request().method() === "POST" && response.url().endsWith("/bindings/batch")
        );
        await proxySection.getByRole("button", { name: "保存选中绑定" }).click();
        await batchSaved;
        assert.deepEqual(
            bindingWrites.slice(-2).sort((a, b) => a.accountKey.localeCompare(b.accountKey)),
            [
                { accountKey: "first@example.com", desiredNodeId: "direct-node" },
                { accountKey: "uploaded@example.com", desiredNodeId: "direct-node" },
            ]
        );
        assert.deepEqual(errors, []);
    }
);
