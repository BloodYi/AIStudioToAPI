const definitions = {
    attemptTimeout: ["ACCOUNT_LOGIN_ATTEMPT_TIMEOUT_MS", 180000, 1800000],
    cleanupTimeout: ["ACCOUNT_LOGIN_CLEANUP_TIMEOUT_MS", 10000, 60000],
    concurrency: ["ACCOUNT_LOGIN_CONCURRENCY", 1, 32],
    logDays: ["ACCOUNT_LOGIN_LOG_RETENTION_DAYS", 30, 365],
    maxAttempts: ["ACCOUNT_LOGIN_MAX_ATTEMPTS", 3, 10],
    queueLimit: ["ACCOUNT_LOGIN_QUEUE_LIMIT", 1000, 10000],
    recoveryTimeout: ["ACCOUNT_LOGIN_RECOVERY_TIMEOUT_MS", 900000, 86400000],
    screenshotDays: ["ACCOUNT_LOGIN_SCREENSHOT_RETENTION_DAYS", 7, 365],
    screenshotsPerAccount: ["ACCOUNT_LOGIN_SCREENSHOTS_PER_ACCOUNT", 10, 100],
    screenshotTimeout: ["ACCOUNT_LOGIN_SCREENSHOT_TIMEOUT_MS", 5000, 30000],
    stepTimeout: ["ACCOUNT_LOGIN_STEP_TIMEOUT_MS", 30000, 300000],
};
function config() {
    const result = {};
    for (const [key, [name, fallback, maximum]] of Object.entries(definitions)) {
        const value = process.env[name] === undefined ? fallback : Number(process.env[name]);
        if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) throw new Error(`Invalid ${name}`);
        result[key] = value;
    }
    result.autoRecovery = process.env.ACCOUNT_AUTO_RELOGIN_ENABLED !== "false";
    result.paused = false;
    return result;
}
module.exports = { config };
