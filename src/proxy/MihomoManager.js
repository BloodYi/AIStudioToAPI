const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const MihomoConfigGenerator = require("./MihomoConfigGenerator");

class MihomoManager {
    constructor(logger, options = {}) {
        this.logger = logger;
        this.dataDir = path.resolve(
            options.dataDir || process.env.MIHOMO_DATA_DIR || path.join(process.cwd(), "data", "mihomo")
        );
        this.runtimePath = path.join(this.dataDir, "runtime.yaml");
        this.process = null;
        this.secret = null;
        this.snapshot = null;
        this.status = { lastAppliedAt: null, lastError: null, ready: false, running: false, version: null };
    }

    resolveBinary(settings = {}) {
        const candidates = [
            settings.binaryPath,
            process.env.MIHOMO_PATH,
            path.join(process.cwd(), "mihomo"),
            path.join(process.cwd(), process.platform === "win32" ? "mihomo.exe" : "mihomo"),
            path.join(process.cwd(), "bin", process.platform === "win32" ? "mihomo.exe" : "mihomo"),
            "/usr/local/bin/mihomo",
        ].filter(Boolean);
        for (const candidate of candidates) if (fs.existsSync(candidate)) return path.resolve(candidate);
        const system = spawnSync(process.platform === "win32" ? "where" : "which", ["mihomo"], { encoding: "utf8" });
        return system.status === 0 ? system.stdout.trim().split(/\r?\n/)[0] : null;
    }

    inspect(settings = {}) {
        const binaryPath = this.resolveBinary(settings);
        return {
            ...this.status,
            binaryFound: Boolean(binaryPath),
            binaryPath: binaryPath || null,
            pid: this.process?.pid || null,
        };
    }

    async start(snapshot) {
        if (this.process) return this.inspect(snapshot.settings);
        const binary = this.resolveBinary(snapshot.settings);
        if (!binary) throw this._failure("Mihomo binary not found; configure MIHOMO_PATH or settings.binaryPath");
        await fs.promises.mkdir(this.dataDir, { recursive: true });
        this.secret = crypto.randomBytes(24).toString("base64url");
        await this._writeAndValidate(binary, snapshot);
        const logPath = path.join(this.dataDir, "mihomo.log");
        if (fs.existsSync(logPath) && fs.statSync(logPath).size > 5 * 1024 * 1024) {
            const rotated = `${logPath}.1`;
            await fs.promises.rm(rotated, { force: true });
            await fs.promises.rename(logPath, rotated);
        }
        const log = fs.openSync(logPath, "a", 0o600);
        const child = spawn(binary, ["-d", this.dataDir, "-f", this.runtimePath], { stdio: ["ignore", log, log] });
        this.process = child;
        this.snapshot = structuredClone(snapshot);
        this.status.running = true;
        child.once("exit", (code, signal) => {
            fs.closeSync(log);
            const unexpected = this.process === child;
            if (unexpected) this.process = null;
            this.status.running = false;
            this.status.ready = false;
            if (unexpected) {
                this.status.lastError = `Mihomo exited (${code ?? signal})`;
                this.logger.warn(`[ProxyPool] ${this.status.lastError}`);
            }
        });
        child.once("error", error => {
            this.status.lastError = error.message;
        });
        await this._waitReady(snapshot.settings.controllerPort);
        return this.inspect(snapshot.settings);
    }

    async _writeAndValidate(binary, snapshot) {
        const content = MihomoConfigGenerator.generate(snapshot, this.secret);
        const temp = `${this.runtimePath}.tmp`;
        await fs.promises.writeFile(temp, content, { mode: 0o600 });
        const checked = spawnSync(binary, ["-t", "-d", this.dataDir, "-f", temp], { encoding: "utf8", timeout: 15000 });
        if (checked.status !== 0) {
            await fs.promises.rm(temp, { force: true });
            throw this._failure(
                `Mihomo config validation failed: ${(checked.stderr || checked.stdout || "unknown error").trim()}`
            );
        }
        await fs.promises.rename(temp, this.runtimePath);
        this.status.lastAppliedAt = new Date().toISOString();
        return content;
    }

    async _request(port, endpoint, init = {}) {
        return fetch(`http://127.0.0.1:${port}${endpoint}`, {
            ...init,
            headers: { Authorization: `Bearer ${this.secret}`, "Content-Type": "application/json", ...init.headers },
            signal: AbortSignal.timeout(3000),
        });
    }

    async _waitReady(port) {
        let last;
        for (let i = 0; i < 30; i++) {
            if (!this.process) throw this._failure(this.status.lastError || "Mihomo exited during startup");
            try {
                const response = await this._request(port, "/version");
                if (response.ok) {
                    const body = await response.json();
                    this.status.version = body.version || body.meta || "unknown";
                    this.status.ready = true;
                    this.status.lastError = null;
                    return;
                }
            } catch (error) {
                last = error;
            }
            await new Promise(resolve => setTimeout(resolve, 200));
        }
        await this.stop();
        throw this._failure(`Mihomo controller did not become ready: ${last?.message || "timeout"}`);
    }

    async reload(snapshot) {
        if (!this.process) return this.start(snapshot);
        const binary = this.resolveBinary(snapshot.settings);
        const before = fs.existsSync(this.runtimePath) ? await fs.promises.readFile(this.runtimePath, "utf8") : "";
        const generated = MihomoConfigGenerator.generate(snapshot, this.secret);
        if (MihomoConfigGenerator.hash(before) === MihomoConfigGenerator.hash(generated))
            return this.inspect(snapshot.settings);
        await this._writeAndValidate(binary, snapshot);
        const currentControllerPort = this.snapshot?.settings?.controllerPort || snapshot.settings.controllerPort;
        const response = await this._request(currentControllerPort, "/configs?force=true", {
            body: JSON.stringify({ path: this.runtimePath }),
            method: "PUT",
        });
        if (!response.ok) throw this._failure(`Mihomo reload failed with HTTP ${response.status}`);
        this.snapshot = structuredClone(snapshot);
        await this._waitReady(snapshot.settings.controllerPort);
        return this.inspect(snapshot.settings);
    }

    async testProxy(node, url, timeout, controllerPort) {
        const name = encodeURIComponent(MihomoConfigGenerator.nodeName(node));
        const response = await this._request(
            controllerPort,
            `/proxies/${name}/delay?url=${encodeURIComponent(url)}&timeout=${Number(timeout)}`
        );
        if (!response.ok) throw this._failure(`Node test failed with HTTP ${response.status}`);
        const body = await response.json();
        if (!Number.isFinite(body.delay)) throw this._failure("Node test did not return latency");
        return body.delay;
    }

    async stop() {
        const child = this.process;
        if (!child) return;
        this.process = null;
        child.kill("SIGTERM");
        await Promise.race([
            new Promise(resolve => child.once("exit", resolve)),
            new Promise(resolve =>
                setTimeout(() => {
                    if (child.exitCode === null) child.kill("SIGKILL");
                    resolve();
                }, 5000)
            ),
        ]);
        this.status.running = false;
        this.status.ready = false;
    }

    _failure(message) {
        this.status.lastError = message;
        return Object.assign(new Error(message), { status: 503 });
    }
}

module.exports = MihomoManager;
