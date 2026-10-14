const { fork } = require("child_process");
const path = require("path");
const PublicDashboardService = require("./PublicDashboardService");

// Only the public DTO crosses IPC. Account pools, authentication and mutations
// remain owned by the application process.
class IsolatedPublicDashboard {
    constructor({ config, logger, scheduler, usageStatsService, browserManager }) {
        this.config = config;
        this.logger = logger;
        this.browserManager = browserManager;
        this.service = new PublicDashboardService(scheduler, usageStatsService);
    }
    async start() {
        this.child = fork(path.join(__dirname, "dashboard-process.js"), [], {
            stdio: ["ignore", "inherit", "inherit", "ipc"],
        });
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.child.kill("SIGKILL");
                reject(new Error("Public dashboard startup timeout"));
            }, 10000);
            this.child.once("error", error => {
                clearTimeout(timer);
                reject(error);
            });
            this.child.once("exit", () => {
                clearTimeout(timer);
                reject(new Error("Public dashboard process exited"));
            });
            this.child.on("message", message => {
                if (message.type === "ready") {
                    this.address = message.address;
                    clearTimeout(timer);
                    resolve();
                }
                if (message.type === "startup-error") {
                    clearTimeout(timer);
                    reject(new Error(message.error));
                }
            });
            this.child.send({ config: this.config, type: "configure" });
        });
        this.child.on("exit", () => {
            if (!this.stopping) this.browserManager?._requestApplicationRecovery("public_dashboard_process_exited");
        });
        this.timer = setInterval(() => this.publish(), 1000);
        this.timer.unref();
        await this.publish();
    }
    async publish() {
        if (this.publishing || !this.child?.connected || this.stopping) return;
        this.publishing = true;
        try {
            const body = await this.service.getSnapshot();
            if (this.stopping || !this.child.connected) return;
            const health = this.browserManager?.getContextInitHealth();
            const snapshot = {
                ...body,
                service_status: health?.recovering || !health?.ready ? "unavailable" : "ready",
            };
            if (Buffer.byteLength(JSON.stringify(snapshot)) > 256 * 1024)
                throw new Error("Public dashboard response too large");
            await new Promise(resolve => this.child.send({ body: snapshot, type: "snapshot" }, () => resolve()));
        } catch (error) {
            this.logger.warn(`[PublicDashboard] Snapshot failed: ${error.message}`);
        } finally {
            this.publishing = false;
        }
    }
    async close() {
        this.stopping = true;
        clearInterval(this.timer);
        const child = this.child;
        if (!child || child.exitCode !== null || child.signalCode !== null) return;
        await new Promise(resolve => {
            const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
            child.once("exit", () => {
                clearTimeout(timer);
                resolve();
            });
            if (child.connected) child.send({ type: "shutdown" }, () => {});
            else child.kill("SIGTERM");
        });
    }
}
module.exports = IsolatedPublicDashboard;
