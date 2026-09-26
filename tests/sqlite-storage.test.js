const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const UsageStatsService = require("../src/core/UsageStatsService");

const logger = { error() {}, info() {}, warn() {} };
const DAY_MS = 86400000;

const record = (requestId, finishedAtMs) => ({
    accountKey: "0:test@example.com",
    apiFormat: "openai",
    attemptCount: 1,
    attempts: [{ accountKey: "0:test@example.com" }],
    durationMs: 10,
    finalAccountName: "test@example.com",
    finalAuthIndex: 0,
    finishedAt: new Date(finishedAtMs).toISOString(),
    model: "flash",
    outcome: "success",
    requestCategory: "generation",
    requestId,
    startedAt: new Date(finishedAtMs - 10).toISOString(),
    streamMode: "real",
});

test("JSONL migration, cleanup watermark and cumulative aggregates survive restart", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-sqlite-"));
    const now = Date.now();
    const expired = record("expired", now - 40 * DAY_MS);
    const current = record("current", now - 1000);
    fs.writeFileSync(
        path.join(directory, "usage-stats.jsonl"),
        `${JSON.stringify(expired)}\n${JSON.stringify(current)}\n`
    );
    const options = {
        cleanupBatchSize: 1,
        cleanupIntervalMinutes: 60,
        dbPath: path.join(directory, "usage-stats.sqlite"),
        retentionDays: 30,
    };

    let service = new UsageStatsService(null, logger, directory, true, options);
    await service.ready;
    assert.equal((await service.getSummarySnapshotAsync()).summary.totalRequests, 2);
    assert.deepEqual(
        (await service.queryRecordsAsync({ limit: 10 })).records.map(item => item.requestId),
        ["current"]
    );
    const imported = await service.importJsonl(JSON.stringify(expired));
    assert.equal(imported.purgedHistorySkipped, 1);
    await service.close();

    service = new UsageStatsService(null, logger, directory, true, options);
    await service.ready;
    assert.equal((await service.getSummarySnapshotAsync()).summary.totalRequests, 2);
    assert.equal((await service.getStorageSnapshot()).retained_records, 1);
    await service.close();
    fs.rmSync(directory, { force: true, recursive: true });
});

test("forever retention returns null expiry and disables cleanup", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "usage-forever-"));
    const service = new UsageStatsService(null, logger, directory, true, {
        cleanupBatchSize: 10,
        cleanupIntervalMinutes: 60,
        dbPath: path.join(directory, "usage-stats.sqlite"),
        retentionDays: 0,
    });
    await service.ready;
    service.startRequest("forever");
    service.finishRequest("forever", { outcome: "success" });
    const result = await service.queryRecordsAsync({ limit: 10 });
    assert.equal(result.records[0].expires_at, null);
    assert.equal((await service.getStorageSnapshot()).cleanup_status, "disabled");
    await service.close();
    fs.rmSync(directory, { force: true, recursive: true });
});
