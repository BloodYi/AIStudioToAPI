/* eslint-env browser */
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { chromium } = require("playwright");
const { createServer } = require("vite");
const { ConfigurationService } = require("../src/config/ConfigurationService");

test(
    "configuration form stages drafts, preserves hidden fields, saves structured rows and detects concurrent pages",
    { skip: !fs.existsSync(chromium.executablePath()), timeout: 30000 },
    async t => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "configuration-ui-"));
        t.after(() => fs.rmSync(directory, { force: true, recursive: true }));
        const logger = { error() {}, info() {}, setDisplayLimit() {}, warn() {} };
        const system = { logger, ready: true };
        let service = new ConfigurationService(system, {
            env: {},
            file: path.join(directory, "managed-config.json"),
        });
        const server = await createServer({
            configFile: path.resolve(__dirname, "../vite.config.js"),
            logLevel: "error",
            server: { host: "127.0.0.1", port: 0 },
        });
        t.after(() => server.close());
        await server.listen();
        const browser = await chromium.launch({ args: ["--no-sandbox"] });
        t.after(() => browser.close());
        const page = await browser.newPage();
        page.setDefaultTimeout(8000);
        const errors = [],
            writes = [];
        page.on("pageerror", error => errors.push(error.message));
        await page.route("**/locales/*.json", route =>
            route.fulfill({
                body: fs.readFileSync(path.resolve(__dirname, "../ui/locales/zh.json"), "utf8"),
                contentType: "application/json",
            })
        );
        await page.route("**/api/**", async route => {
            const request = route.request(),
                url = new URL(request.url());
            let result = {},
                status = 200;
            try {
                if (url.pathname === "/api/configuration") {
                    if (request.method() === "PATCH") {
                        writes.push(request.postDataJSON());
                        result = service.save(request.postDataJSON());
                    } else result = service.snapshot();
                } else if (url.pathname === "/api/configuration/restart") {
                    result = { accepted: true, instanceId: service.instanceId, version: service.document.version };
                    status = 202;
                    setTimeout(() => {
                        service = new ConfigurationService(system, {
                            env: {},
                            file: path.join(directory, "managed-config.json"),
                        });
                    }, 100);
                } else if (url.pathname === "/api/configuration/undo-pending")
                    result = service.undo(request.postDataJSON().version);
                else if (url.pathname === "/api/configuration/secrets")
                    result = { defaultApiKeys: service.baseline.apiKeys, savedApiKeys: service.saved.apiKeys };
                else if (url.pathname.startsWith("/api/status"))
                    result = { status: { accountDetails: [], currentAuthIndex: -1, schedulingMode: "model-aware" } };
                else if (url.pathname === "/api/scheduler") result = { enabled: false };
                else if (url.pathname.endsWith("/accounts")) result = { accounts: [], total: 0 };
                else if (url.pathname.endsWith("/login-queue")) result = { autoRecovery: true, concurrency: 1 };
            } catch (error) {
                status = error.status || 500;
                result = { error: error.message };
            }
            await route.fulfill({ json: result, status });
        });
        await page.goto(`http://127.0.0.1:${server.httpServer.address().port}/`);
        await page.locator(".sidebar-menu button").nth(2).click();
        const panel = page.locator(".configuration-panel");
        await panel.getByRole("button", { exact: true, name: "保存" }).waitFor();
        await panel.locator("#config-FORCE_THINKING").locator("..").click();
        assert.equal(service.running.forceThinking, false);
        assert.equal(writes.length, 0);
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("已保存。立即生效：强制启用思考")
        );
        assert.equal(service.running.forceThinking, true);
        assert.deepEqual(Object.keys(writes.at(-1).changes), ["FORCE_THINKING"]);
        const initialKeepalive = service.saved.scheduler.streamKeepaliveIntervalMs;
        await panel.locator("#config-STREAM_EARLY_HEADERS").locator("..").click();
        assert.equal(await panel.locator("#config-STREAM_KEEPALIVE_INTERVAL_MS").count(), 0);
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：提前发送流式响应头")
        );
        assert.equal(service.saved.scheduler.streamKeepaliveIntervalMs, initialKeepalive);
        const field = panel
            .locator(".configuration-field")
            .filter({ has: page.locator('label[for="config-ACCOUNT_MODEL_MAX_CONCURRENCY"]') });
        await field.getByRole("button", { name: "增加模型" }).click();
        await field.getByPlaceholder("可手动输入上游模型 ID").fill("unknown-upstream-id");
        await field.locator(".el-input-number input").fill("0");
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：单账号各模型并发上限")
        );
        assert.equal(service.saved.scheduler.accountModelConcurrency["unknown-upstream-id"], 0);
        await panel.locator("#config-FORCE_WEB_SEARCH").locator("..").click();
        service.save({ changes: { FORCE_CODE_EXECUTION: true }, version: service.document.version });
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("配置已被其他页面修改。草稿已保留，请刷新并处理差异后再保存。").waitFor();
        assert.equal(service.running.forceWebSearch, false);
        assert.equal(await panel.locator("#config-FORCE_WEB_SEARCH").getAttribute("aria-checked"), "true");
        await panel.getByRole("button", { exact: true, name: "刷新配置" }).click();
        await page.getByRole("button", { name: "保留草稿并更新版本" }).click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await page.waitForFunction(() =>
            document.querySelector(".configuration-panel")?.textContent.includes("立即生效：强制启用联网搜索")
        );
        assert.equal(service.running.forceCodeExecution, true);
        assert.equal(service.running.forceWebSearch, true);
        assert.deepEqual(Object.keys(writes.at(-1).changes), ["FORCE_WEB_SEARCH"]);
        await panel.locator("#config-PUBLIC_DASHBOARD_ENABLED").locator("..").click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        assert.equal(service.running.publicDashboard.enabled, false);
        await page.reload();
        await page.locator(".sidebar-menu button").nth(2).click();
        await panel.getByText("查看待重启变更").waitFor();
        await panel.locator("#config-FORCE_URL_CONTEXT").locator("..").click();
        const writesBeforeRestart = writes.length;
        await panel.getByRole("button", { exact: true, name: "重启" }).click();
        await page.locator(".el-message-box").getByRole("button", { exact: true, name: "重启" }).click();
        await panel.getByText("新实例启动成功，已确认保存配置实际生效。").waitFor();
        assert.equal(writes.length, writesBeforeRestart);
        assert.equal(service.running.publicDashboard.enabled, true);
        assert.equal(service.saved.forceUrlContext, false);
        assert.equal(await panel.locator("#config-FORCE_URL_CONTEXT").getAttribute("aria-checked"), "true");
        await panel.getByRole("button", { exact: true, name: "放弃草稿" }).click();
        await panel.locator("#config-PUBLIC_DASHBOARD_ENABLED").locator("..").click();
        await panel.getByRole("button", { exact: true, name: "保存" }).click();
        await panel.getByText("查看待重启变更").waitFor();
        await panel.getByRole("button", { exact: true, name: "撤销待重启变更" }).click();
        await page.waitForFunction(() => !document.querySelector(".configuration-panel details"));
        assert.equal(service.snapshot().pending.length, 0);
        assert.equal(await panel.getByText("MODEL_QUEUE_TIMEOUT_MS", { exact: true }).count(), 0);
        assert.deepEqual(errors, []);
    }
);
