const { fork } = require("child_process");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { atomicWrite, storagePath } = require("./ConfigurationService");

// Stable parent owns service lifetime for both `node main.js` and the Docker CMD.
function supervise(entry) {
    const data = path.dirname(storagePath());
    const goodPath = path.join(data, "managed-config.last-good.json");
    const errorPath = path.join(data, "restart-status.json");
    let child,
        bootTimer,
        killTimer,
        restarting = false,
        stopping = false,
        recovering = false,
        healthy = false;
    const sessionSecret = crypto.randomBytes(32).toString("hex");
    const killGroup = () => {
        try {
            if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
        } catch (error) {
            if (error.code !== "ESRCH") console.error("Failed to terminate service process group:", error.message);
        }
    };
    const launch = recovery => {
        recovering = recovery;
        healthy = false;
        child = fork(entry, [], {
            detached: process.platform !== "win32",
            env: {
                ...process.env,
                AISTUDIO_CONFIG_RECOVERY: recovery ? "1" : "0",
                AISTUDIO_SERVICE_CHILD: "1",
                AISTUDIO_SESSION_SECRET: sessionSecret,
            },
            stdio: ["inherit", "inherit", "inherit", "ipc"],
        });
        bootTimer = setTimeout(() => {
            atomicWrite(errorPath, { error: "服务启动超时", failedAt: new Date().toISOString() });
            killGroup();
        }, 300000);
        child.on("message", message => {
            if (message?.type === "ready") {
                healthy = true;
                clearTimeout(bootTimer);
                restarting = false;
                atomicWrite(goodPath, message.configuration);
                if (!recovery) atomicWrite(errorPath, { error: null });
            }
            if (message?.type === "startup-error")
                atomicWrite(errorPath, { error: message.error, failedAt: new Date().toISOString() });
            if (message?.type === "restart" && !restarting && !stopping) {
                restarting = true;
                if (message.configuration && healthy) atomicWrite(goodPath, message.configuration);
                child.send({ type: "shutdown" });
                killTimer = setTimeout(() => killGroup(), 45000);
            }
        });
        child.once("exit", code => {
            clearTimeout(bootTimer);
            clearTimeout(killTimer);
            killGroup();
            if (stopping) {
                process.exit(code || 0);
                return;
            }
            if (restarting) {
                restarting = false;
                launch(false);
                return;
            }
            if (code !== 0 && fs.existsSync(goodPath) && !recovering) {
                console.error("Service startup failed; restoring last usable configuration once.");
                launch(true);
                return;
            }
            process.exit(code || 0);
        });
    };
    for (const signal of ["SIGTERM", "SIGINT"])
        process.on(signal, () => {
            if (stopping) return;
            stopping = true;
            child.kill(signal);
            killTimer = setTimeout(() => killGroup(), 45000);
        });
    launch(false);
}
module.exports = { supervise };
