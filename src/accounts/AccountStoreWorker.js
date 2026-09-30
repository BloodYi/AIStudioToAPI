const { parentPort, workerData } = require("node:worker_threads");
const { DatabaseSync } = require("node:sqlite");
const fs = require("node:fs");
const path = require("node:path");
let db;
try {
    fs.mkdirSync(path.dirname(workerData.dbPath), { mode: 0o700, recursive: true });
    db = new DatabaseSync(workerData.dbPath);
    fs.chmodSync(workerData.dbPath, 0o600);
    db.exec(
        "PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS account_state(id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL)"
    );
    parentPort.postMessage({ ready: true });
} catch {
    parentPort.postMessage({ fatal: { message: "Account database unavailable" } });
}
parentPort.on("message", ({ id, command, payload }) => {
    try {
        let result;
        if (command === "load")
            result = JSON.parse(db.prepare("SELECT value FROM account_state WHERE id=1").get()?.value || "null");
        else if (command === "save")
            db.prepare("INSERT INTO account_state VALUES(1,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(
                JSON.stringify(payload)
            );
        else if (command === "close") db.close();
        else throw new Error("Unknown account storage operation");
        parentPort.postMessage({ id, result });
    } catch {
        parentPort.postMessage({ error: { message: "Account storage operation failed", status: 503 }, id });
    }
});
