// Explicit real-account acceptance runner. Credentials enter over stdin only;
// temporary private storage is removed on exit. Never prints page text or cookies.
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const Service = require("../../src/accounts/AccountLoginService");
const { requireBuildAppUrl } = require("../../src/config/BuildAppSetup");
async function main() {
    const targetUrl = requireBuildAppUrl();
    const readline = require("node:readline").createInterface({ input: process.stdin });
    const input = await new Promise(resolve => readline.once("line", resolve));
    readline.close();
    const credentials = JSON.parse(input);
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "aistudio-real-login-"));
    const executablePath = process.env.CAMOUFOX_EXECUTABLE_PATH;
    const system = {
        authSource: { availableIndices: [], reloadAuthSources() {} },
        browserManager: {
            _getBrowserExecutablePath: () => executablePath,
            abortedContexts: new Set(),
            closeContext: async () => {},
            contextUnavailable: new Map(),
            rebalanceContextPool: async () => {},
            targetUrl,
        },
        logger: {
            debug() {},
            error: () => console.error("Account supervisor reported a failure"),
            info() {},
            warn() {},
        },
    };
    const service = new Service(system, {
        artifactDir: path.join(directory, "artifacts"),
        authDir: path.join(directory, "auth"),
        storePath: path.join(directory, "accounts.sqlite"),
        ...(process.env.ACCOUNT_TEST_WORKER_PATH ? { workerPath: process.env.ACCOUNT_TEST_WORKER_PATH } : {}),
    });
    let targetInitialized = false,
        termsVerified = false,
        identityMatched = false;
    const completeAttempt = service.completeAttempt.bind(service);
    service.completeAttempt = async (slot, result) => {
        targetInitialized = result.targetInitialized === true && !result.error;
        termsVerified = result.termsVerified === true && !result.error;
        identityMatched = result.email === service.state.accounts[0]?.email && !result.error;
        return completeAttempt(slot, result);
    };
    try {
        await service.initialize({ startQueue: false });
        const created = await service.create(credentials);
        delete credentials.password;
        delete credentials.recoveryEmail;
        delete credentials.totpSecret;
        const task = service.state.tasks.find(entry => entry.taskId === created.taskId);
        await service.queue.start();
        let last = "";
        while (["queued", "running", "retry_wait"].includes(task.status)) {
            const current = `${task.status}: ${task.phase} (attempt ${task.attempts})`;
            if (current !== last) {
                console.log(current);
                last = current;
            }
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        const account = service.account(created.account.accountId);
        const committed = task.status === "succeeded" ? await service.readAuth(account.authIndex) : null;
        const sessionCommitted =
            !!committed &&
            committed._accountSessionVersion === account.sessionVersion &&
            account.sessionState === "valid" &&
            committed.cookies.length > 0 &&
            Array.isArray(committed.origins);
        console.log(
            JSON.stringify({
                attempts: task.attempts,
                credentialFreeAuth:
                    !!committed &&
                    !["password", "totp", "totpSecret", "recoveryEmail", "recovery_email"].some(
                        key => key in committed
                    ),
                error: task.error || null,
                history: task.history,
                identityMatched,
                sessionBindingCount: service.state.accounts.filter(entry => entry.authIndex !== null).length,
                sessionCommitted,
                status: task.status,
                targetInitialized,
                termsVerified,
            })
        );
        process.exitCode =
            task.status === "succeeded" && sessionCommitted && targetInitialized && identityMatched && termsVerified
                ? 0
                : 1;
        if (process.env.ACCOUNT_TEST_KEEP_ARTIFACTS === "true")
            console.log(`Private diagnostic directory: ${directory}`);
    } finally {
        await service.close();
        if (process.env.ACCOUNT_TEST_KEEP_ARTIFACTS !== "true")
            await fs.rm(directory, { force: true, recursive: true });
        else {
            await fs.rm(path.join(directory, "auth"), { force: true, recursive: true });
            for (const file of ["accounts.sqlite", "accounts.sqlite-journal"])
                await fs.unlink(path.join(directory, file)).catch(() => {});
        }
    }
}
main().catch(() => {
    console.error("Real account test could not complete; check browser/network configuration");
    process.exitCode = 1;
});
