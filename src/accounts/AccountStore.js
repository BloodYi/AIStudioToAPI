const { Worker } = require("node:worker_threads");
const path = require("node:path");
const fs = require("node:fs/promises");

class AccountStore {
    constructor(dbPath) {
        this.dbPath = path.resolve(dbPath);
        this.pending = new Map();
        this.nextId = 0;
        this.ready = this.initialize();
    }
    async initialize() {
        await fs.mkdir(path.dirname(this.dbPath), { mode: 0o700, recursive: true });
        this.lockPath = `${this.dbPath}.lock`;
        try {
            this.lock = await fs.open(this.lockPath, "wx", 0o600);
        } catch (error) {
            if (error.code !== "EEXIST") throw error;
            const saved = JSON.parse(await fs.readFile(this.lockPath, "utf8"));
            const pid = typeof saved === "number" ? saved : saved.pid;
            if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("Invalid account database lock");
            try {
                process.kill(pid, 0);
                if (typeof saved === "object") {
                    const identity = await this.processIdentity(pid);
                    if (identity.startTime !== saved.startTime || identity.bootId !== saved.bootId)
                        throw Object.assign(new Error("Stale account consumer identity"), { code: "ESRCH" });
                }
                throw new Error("Account database already has a consumer");
            } catch (cause) {
                if (!["ESRCH", "ENOENT"].includes(cause.code)) throw cause;
            }
            await fs.unlink(this.lockPath);
            this.lock = await fs.open(this.lockPath, "wx", 0o600);
        }
        await this.lock.writeFile(JSON.stringify({ pid: process.pid, ...(await this.processIdentity(process.pid)) }));
        this.worker = new Worker(path.join(__dirname, "AccountStoreWorker.js"), {
            workerData: { dbPath: this.dbPath },
        });
        await new Promise((resolve, reject) => {
            this.worker.on("message", message => {
                if (message.ready) return resolve();
                if (message.fatal) return reject(new Error(message.fatal.message));
                const pending = this.pending.get(message.id);
                if (!pending) return;
                this.pending.delete(message.id);
                if (message.error) pending.reject(Object.assign(new Error(message.error.message), { status: 503 }));
                else pending.resolve(message.result);
                if (!this.pending.size) this.worker.unref();
            });
            const fail = () => {
                this.failed = true;
                const error = Object.assign(new Error("Account storage unavailable"), { status: 503 });
                reject(error);
                for (const request of this.pending.values()) request.reject(error);
                this.pending.clear();
            };
            this.worker.on("error", fail);
            this.worker.on("exit", fail);
        });
        this.worker.unref();
    }
    async processIdentity(pid) {
        const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
        return {
            bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            startTime: stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19],
        };
    }
    async call(command, payload) {
        await this.ready;
        if (this.failed || this.pending.size >= 1000)
            throw Object.assign(new Error("Account storage unavailable"), { status: 503 });
        this.worker.ref();
        const id = ++this.nextId;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { reject, resolve });
            this.worker.postMessage({ command, id, payload });
        });
    }
    async close() {
        try {
            if (this.worker && !this.failed) await this.call("close");
        } finally {
            await this.worker?.terminate();
            await this.lock?.close();
            if (this.lock) await fs.unlink(this.lockPath);
        }
    }
}
module.exports = AccountStore;
