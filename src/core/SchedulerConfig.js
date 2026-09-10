const path = require("path");

function loadSchedulerConfig(env = process.env) {
    const integer = (name, fallback, min = 1) => {
        if (env[name] === undefined) return fallback;
        const value = Number(env[name]);
        if (!Number.isSafeInteger(value) || value < min) throw new Error(`Invalid ${name}`);
        return value;
    };
    const object = name => {
        const value = JSON.parse(env[name] || "{}");
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid ${name}`);
        return Object.assign(Object.create(null), value);
    };
    const strategy = env.ACCOUNT_ROTATION_STRATEGY || "least_recently_used";
    if (!["least_recently_used", "least_used", "legacy"].includes(strategy)) {
        throw new Error("Invalid ACCOUNT_ROTATION_STRATEGY");
    }
    const legacyContexts = Number.parseInt(env.MAX_CONTEXTS, 10);
    const maxWorkers = integer(
        "MAX_BROWSER_WORKERS",
        Number.isSafeInteger(legacyContexts) && legacyContexts > 0 ? legacyContexts : 1
    );
    const globalConcurrency = integer("GLOBAL_MAX_CONCURRENCY", maxWorkers);
    const contextMaxConcurrency = integer("CONTEXT_MAX_CONCURRENCY", 0, 0);
    const contextPoolMinReady = integer("CONTEXT_POOL_MIN_READY", maxWorkers, 0);
    if (contextPoolMinReady > maxWorkers) throw new Error("CONTEXT_POOL_MIN_READY exceeds MAX_BROWSER_WORKERS");
    const accountConcurrency = integer("ACCOUNT_MAX_CONCURRENCY", 0, 0);
    const accountModelConcurrency = object("ACCOUNT_MODEL_MAX_CONCURRENCY");
    for (const value of Object.values(accountModelConcurrency)) {
        if (!Number.isSafeInteger(value) || value < 0) throw new Error("Invalid ACCOUNT_MODEL_MAX_CONCURRENCY");
    }
    const allocation = object("MODEL_WORKER_ALLOCATION");
    let preferredTotal = 0;
    for (const [model, value] of Object.entries(allocation)) {
        const preferred = typeof value === "number" ? value : value?.preferred_workers;
        const minimum = typeof value === "number" ? 0 : (value?.min_workers ?? 0);
        if (
            !model ||
            !Number.isSafeInteger(preferred) ||
            preferred < 1 ||
            !Number.isSafeInteger(minimum) ||
            minimum < 0 ||
            minimum > preferred
        ) {
            throw new Error(`Invalid MODEL_WORKER_ALLOCATION for ${model}`);
        }
        allocation[model] = { min: minimum, preferred };
        preferredTotal += preferred;
    }
    if (preferredTotal > globalConcurrency) throw new Error("Model preferred allocations exceed global concurrency");
    const modelConcurrency = object("MODEL_MAX_CONCURRENCY");
    for (const value of Object.values(modelConcurrency)) {
        if (!Number.isSafeInteger(value) || value < 1) throw new Error("Invalid MODEL_MAX_CONCURRENCY");
    }
    for (const [model, value] of Object.entries(allocation)) {
        if ((modelConcurrency[model] ?? globalConcurrency) < value.min)
            throw new Error(`Concurrency below minimum for ${model}`);
    }
    return {
        accountConcurrency,
        accountModelConcurrency,
        allocation,
        contextInitConcurrency: integer("CONTEXT_INIT_CONCURRENCY", 2),
        contextMaxConcurrency,
        contextPoolMinReady,
        dynamic: env.ENABLE_DYNAMIC_WORKER_ALLOCATION !== "false",
        enabled: strategy !== "legacy",
        globalConcurrency,
        maxRetries: integer("MAX_RETRIES_PER_REQUEST", Math.max(0, (Number(env.MAX_RETRIES) || 3) - 1), 0),
        maxWorkers,
        modelConcurrency,
        queueSize: integer("MODEL_QUEUE_SIZE", 100, 0),
        queueTimeoutMs: integer("REQUEST_DISPATCH_TIMEOUT_MS", integer("MODEL_QUEUE_TIMEOUT_MS", 120000)),
        rateLimitCooldownMs: integer("RATE_LIMIT_COOLDOWN", 3600) * 1000,
        readyContextOnly: env.SCHEDULER_READY_CONTEXT_ONLY !== "false",
        statePath: env.SCHEDULER_STATE_PATH || path.join(process.cwd(), "data", "scheduler-state.json"),
        strategy,
        streamEarlyHeaders: env.STREAM_EARLY_HEADERS !== "false",
        streamKeepaliveIntervalMs: integer("STREAM_KEEPALIVE_INTERVAL_MS", 10000, 1000),
        tempErrorCooldownMs: integer("TEMP_ERROR_COOLDOWN", 30) * 1000,
    };
}
module.exports = loadSchedulerConfig;
