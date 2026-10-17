const { test } = require("node:test");
const assert = require("node:assert/strict");
const { spawnSync } = require("node:child_process");
const path = require("node:path");
const { requireBuildAppUrl, BUILD_APP_GUIDE } = require("../src/config/BuildAppSetup");

test("first run rejects missing, placeholder, and non-AI-Studio app URLs", () => {
    for (const value of [
        undefined,
        "",
        "  ",
        "https://aistudio.google.com/apps/YOUR_APP_ID",
        "https://aistudio.google.com/apps/REPLACE_WITH_YOUR_REAL_APP_ID",
        "https://example.com/apps/abc",
        "http://ai.studio/apps/abc",
        "https://aistudio.google.com/",
        "https://ai.studio/apps/abc/extra",
        "https://name:password@ai.studio/apps/abc",
    ]) {
        assert.throws(
            () => requireBuildAppUrl({ AI_STUDIO_APP_URL: value }),
            error => {
                assert.match(error.message, /First create your own/);
                assert.ok(error.message.includes(BUILD_APP_GUIDE));
                return true;
            }
        );
    }
});

test("accepts an explicitly configured app, preview queries, and Drive app paths", () => {
    for (const value of [
        "https://ai.studio/apps/fixture-app",
        "https://aistudio.google.com/apps/fixture-app?showPreview=true&showAssistant=true",
        "https://aistudio.google.com/apps/drive/fixture-file",
    ]) {
        assert.equal(requireBuildAppUrl({ AI_STUDIO_APP_URL: ` ${value} ` }), value);
    }
});

test("the service exits promptly with setup instructions before launching its supervisor", () => {
    const child = spawnSync(process.execPath, [path.join(__dirname, "../main.js")], {
        encoding: "utf8",
        env: { ...process.env, AI_STUDIO_APP_URL: "", AISTUDIO_SERVICE_CHILD: "", NODE_ENV: "production" },
        timeout: 15000,
    });
    assert.ifError(child.error);
    assert.equal(child.status, 1);
    assert.match(child.stderr, /Build App setup required/);
    assert.match(child.stderr, /No shared app is provided/);
    assert.ok(child.stderr.includes(BUILD_APP_GUIDE));
    assert.doesNotMatch(child.stdout + child.stderr, /Warm target=|WebSocket server is listening|init_started/);
});
