const fs = require("fs");
const path = require("path");
const { isUserAbortedError } = require("../utils/CustomErrors");

const schedulerError = (message, status = 503) => Object.assign(new Error(message), { status });

function classifyError(error = {}) {
    if (isUserAbortedError(error) || error.reason === "client_disconnect") return "aborted";
    if (error.accountUnhealthy) return "account";
    const status = Number(error.status ?? error.code);
    const message = String(error.message || "");
    if (/^unsupported$/i.test(message.trim())) return "unsupported";
    if (
        error.isAuthExpired ||
        status === 401 ||
        /account (?:suspended|disabled)|cookie.*(?:expired|invalid)|login (?:failed|required)/i.test(message)
    )
        return "account";
    if (status === 429 || /RESOURCE_EXHAUSTED/.test(message)) return "rate_limited";
    if (
        /PERMISSION_DENIED|model.*(?:unsupported|unavailable for account)|(?:unsupported|no access to).*model/i.test(
            message
        )
    )
        return "unsupported";
    if (status >= 500 || /websocket|network|connection|queue.*(?:closed|timeout)|upstream|timed out/i.test(message))
        return "temporary";
    return "request";
}

class ModelScheduler {
    constructor(config, authSource, logger) {
        this.config = config;
        this.authSource = authSource;
        this.logger = logger;
        this.accounts = new Map();
        this.fileAffinities = new Map();
        this.pending = [];
        this.workers = Array.from({ length: config.globalConcurrency }, (_, id) => ({ id, lease: null }));
        this.sequence = 0;
        this.closed = false;
        this.load();
    }

    account(index) {
        // Email survives auth file re-numbering; anonymous auth sources use their index.
        const key = this.authSource.accountNameMap.get(index) || `auth-${index}`;
        if (!this.accounts.has(key))
            this.accounts.set(key, { healthy: true, key, last_error: null, models: Object.create(null) });
        const account = this.accounts.get(key);
        account.index = index;
        account.inflight ??= 0;
        return account;
    }

    slot(account, model) {
        if (!Object.hasOwn(account.models, model))
            account.models[model] = {
                consecutive_failures: 0,
                cooldown_until: 0,
                failure_count: 0,
                inflight: 0,
                last_error: null,
                last_used_at: 0,
                rate_limited: false,
                request_count: 0,
                success_count: 0,
                unsupported: false,
            };
        const slot = account.models[model];
        if (slot.cooldown_until && slot.cooldown_until <= Date.now()) {
            slot.rate_limited = false;
            slot.cooldown_until = 0;
        }
        return slot;
    }

    candidates(model, excluded) {
        return this.authSource
            .getRotationIndices()
            .map(index => this.account(index))
            .filter(account => {
                const slot = this.slot(account, model);
                return (
                    account.healthy &&
                    !excluded.has(account.key) &&
                    !slot.unsupported &&
                    slot.cooldown_until <= Date.now()
                );
            });
    }

    active(model) {
        return this.workers.filter(worker => worker.lease?.model === model).length;
    }

    acquire(model, excluded = new Set(), signal) {
        if (this.closed) return Promise.reject(schedulerError("Scheduler is shutting down"));
        if (signal?.aborted) return Promise.reject(schedulerError("Client disconnected", 499));
        if (!this.candidates(model, excluded).length)
            return Promise.reject(schedulerError(`No eligible accounts for model ${model}`));
        return new Promise((resolve, reject) => {
            const item = { excluded, model, order: ++this.sequence, reject, resolve, signal };
            item.abort = () => {
                this.remove(item);
                reject(schedulerError("Client disconnected", 499));
                this.drain();
            };
            signal?.addEventListener("abort", item.abort, { once: true });
            this.pending.push(item);
            this.drain();
            if (this.pending.includes(item)) {
                if (this.pending.filter(entry => entry.model === model).length > this.config.queueSize) {
                    this.remove(item);
                    reject(schedulerError(`Queue full for model ${model}`, 429));
                } else {
                    item.timer = setTimeout(() => {
                        this.remove(item);
                        reject(schedulerError(`Queue timeout for model ${model}`, 504));
                    }, this.config.queueTimeoutMs);
                }
            }
        });
    }

    remove(item) {
        const index = this.pending.indexOf(item);
        if (index >= 0) this.pending.splice(index, 1);
        clearTimeout(item.timer);
        item.signal?.removeEventListener("abort", item.abort);
    }

    drain() {
        if (this.closed || this.paused) return;
        // Reservation and selection are synchronous: there is no await between checking and leasing.
        for (const item of [...this.pending]) {
            if (!this.candidates(item.model, item.excluded).length) {
                this.remove(item);
                item.reject(schedulerError(`No eligible accounts for model ${item.model}`));
            }
        }
        for (const worker of this.workers.filter(entry => !entry.lease)) {
            const options = this.pending.filter(item => {
                const active = this.active(item.model);
                const allocation = this.config.allocation[item.model];
                const staticLimit =
                    allocation?.preferred ??
                    Math.max(
                        1,
                        this.config.globalConcurrency -
                            Object.values(this.config.allocation).reduce((sum, entry) => sum + entry.preferred, 0)
                    );
                return (
                    active < (this.config.modelConcurrency[item.model] ?? this.config.globalConcurrency) &&
                    (this.config.dynamic || active < staticLimit) &&
                    this.candidates(item.model, item.excluded).some(account => !account.inflight)
                );
            });
            const priority = item => {
                const active = this.active(item.model);
                const allocation = this.config.allocation[item.model] || { min: 0, preferred: 1 };
                return active < allocation.min ? 0 : active < allocation.preferred ? 1 : 2;
            };
            options.sort((a, b) => priority(a) - priority(b) || a.order - b.order);
            const item = options[0];
            if (!item) break;
            const accounts = this.candidates(item.model, item.excluded).filter(account => !account.inflight);
            accounts.sort((a, b) => {
                const x = this.slot(a, item.model),
                    y = this.slot(b, item.model);
                return (
                    (this.config.strategy === "least_used" ? x.request_count - y.request_count : 0) ||
                    x.last_used_at - y.last_used_at ||
                    (x.last_selected || 0) - (y.last_selected || 0) ||
                    a.index - b.index
                );
            });
            const account = accounts[0];
            const slot = this.slot(account, item.model);
            account.inflight++;
            slot.inflight++;
            slot.last_used_at = Date.now();
            slot.last_selected = ++this.sequence;
            const lease = {
                account,
                attempted: false,
                model: item.model,
                recorded: false,
                released: false,
                slot,
                worker,
            };
            worker.lease = lease;
            this.remove(item);
            item.resolve(lease);
        }
    }

    startAttempt(lease) {
        lease.attempted = true;
        lease.slot.request_count++;
        lease.slot.last_used_at = Date.now();
        this.saveSoon();
    }

    failure(lease, error) {
        if (!lease || lease.recorded) return;
        const kind = classifyError(error);
        if (kind === "aborted") return;
        lease.recorded = true;
        const { account, slot } = lease;
        slot.failure_count++;
        slot.consecutive_failures++;
        slot.last_error = String(error.message || "Request failed").slice(0, 2000);
        account.last_error = slot.last_error;
        if (kind === "account") account.healthy = false;
        if (kind === "unsupported") slot.unsupported = true;
        if (kind === "rate_limited") {
            slot.rate_limited = true;
            slot.cooldown_until = Date.now() + this.config.rateLimitCooldownMs;
        }
        if (kind === "temporary")
            slot.cooldown_until =
                Date.now() + this.config.tempErrorCooldownMs * Math.min(4, 2 ** (slot.consecutive_failures - 1));
        this.saveSoon();
    }

    release(lease, success = false) {
        if (!lease || lease.released) return;
        lease.released = true;
        if (success && lease.attempted && !lease.recorded) {
            lease.slot.success_count++;
            lease.slot.consecutive_failures = 0;
            lease.slot.last_error = null;
        }
        lease.account.inflight--;
        lease.slot.inflight--;
        lease.worker.lease = null;
        this.saveSoon();
        this.drain();
    }

    resetAllRateLimits() {
        let resetCount = 0;
        // Synchronous update preserves active leases; later 429 responses can set a new cooldown.
        for (const account of this.accounts.values()) {
            for (const slot of Object.values(account.models)) {
                if (!slot.rate_limited) continue;
                slot.rate_limited = false;
                slot.cooldown_until = 0;
                resetCount++;
            }
        }
        this.flush();
        this.drain();
        return resetCount;
    }

    reset(index, model) {
        const account = this.account(index);
        if (account.inflight) throw schedulerError("Account has active requests", 409);
        if (!model) {
            account.healthy = true;
            account.last_error = null;
        }
        const slots = model ? [this.slot(account, model)] : Object.values(account.models);
        for (const slot of slots)
            Object.assign(slot, {
                consecutive_failures: 0,
                cooldown_until: 0,
                last_error: null,
                rate_limited: false,
                unsupported: false,
            });
        this.flush();
        this.drain();
    }

    snapshot() {
        const indices = this.authSource.getRotationIndices();
        for (const index of this.authSource.availableIndices) this.account(index);
        const models = new Set([
            ...Object.keys(this.config.allocation),
            ...this.pending.map(item => item.model),
            ...[...this.accounts.values()].flatMap(account => Object.keys(account.models)),
        ]);
        const accounts = [...this.accounts.values()].map(account => ({
            ...account,
            models: Object.fromEntries(
                Object.keys(account.models).map(model => {
                    const slot = this.slot(account, model);
                    const available =
                        account.healthy && indices.includes(account.index) && !slot.unsupported && !slot.cooldown_until;
                    return [
                        model,
                        {
                            ...slot,
                            available,
                            status:
                                !account.healthy || !indices.includes(account.index)
                                    ? "UNHEALTHY"
                                    : slot.unsupported
                                      ? "UNSUPPORTED"
                                      : slot.rate_limited
                                        ? "RATE_LIMITED"
                                        : slot.cooldown_until
                                          ? "COOLDOWN"
                                          : "HEALTHY",
                        },
                    ];
                })
            ),
        }));
        return {
            accounts,
            active_workers: this.workers.filter(worker => worker.lease).length,
            idle_workers: this.workers.filter(worker => !worker.lease).length,
            models: [...models].map(model => {
                const slots = accounts.map(account => account.models[model]).filter(Boolean);
                return {
                    active_workers: this.active(model),
                    available_accounts: this.candidates(model, new Set()).length,
                    configured_workers: this.config.allocation[model] || { min: 0, preferred: 1 },
                    failures: slots.reduce((sum, slot) => sum + slot.failure_count, 0),
                    model,
                    queue_length: this.pending.filter(item => item.model === model).length,
                    rate_limited_accounts: slots.filter(slot => slot.rate_limited).length,
                    requests: slots.reduce((sum, slot) => sum + slot.request_count, 0),
                    success: slots.reduce((sum, slot) => sum + slot.success_count, 0),
                };
            }),
            queued_requests: this.pending.length,
            workers: this.workers.map(worker => ({
                account_id: worker.lease?.account.index ?? null,
                id: worker.id,
                model: worker.lease?.model ?? null,
            })),
        };
    }

    load() {
        if (!this.config.statePath) return;
        try {
            const data = JSON.parse(fs.readFileSync(this.config.statePath, "utf8"));
            if (data.version !== 1 || !Array.isArray(data.accounts)) throw new Error("Unsupported scheduler state");
            this.fileAffinities = new Map(data.fileAffinities || []);
            for (const account of data.accounts) {
                if (typeof account.key !== "string" || !account.models || typeof account.models !== "object")
                    throw new Error("Invalid account state");
                account.models = Object.assign(Object.create(null), account.models);
                account.inflight = 0;
                for (const slot of Object.values(account.models)) slot.inflight = 0;
                this.accounts.set(account.key, account);
            }
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.accounts.clear();
                this.fileAffinities.clear();
                this.logger.warn(`[Scheduler] Cannot load state: ${error.message}`);
                // Preserve malformed state for diagnosis before a new snapshot replaces it.
                try {
                    fs.copyFileSync(this.config.statePath, `${this.config.statePath}.corrupt-${Date.now()}`);
                } catch (backupError) {
                    this.logger.error(`[Scheduler] Cannot back up corrupt state: ${backupError.message}`);
                }
            }
        }
    }

    saveSoon() {
        if (!this.config.statePath || this.saveTimer || this.closed) return;
        this.saveTimer = setTimeout(() => this.flush(), 250);
        this.saveTimer.unref();
    }

    flush() {
        clearTimeout(this.saveTimer);
        this.saveTimer = null;
        if (!this.config.statePath) return;
        try {
            fs.mkdirSync(path.dirname(this.config.statePath), { recursive: true });
            const temporary = `${this.config.statePath}.${process.pid}.tmp`;
            fs.writeFileSync(
                temporary,
                JSON.stringify({
                    accounts: [...this.accounts.values()],
                    fileAffinities: [...this.fileAffinities],
                    version: 1,
                }),
                {
                    mode: 0o600,
                }
            );
            fs.renameSync(temporary, this.config.statePath);
        } catch (error) {
            this.logger.error(`[Scheduler] Cannot persist state: ${error.message}`);
        }
    }

    close() {
        this.closed = true;
        for (const item of [...this.pending]) {
            this.remove(item);
            item.reject(schedulerError("Scheduler is shutting down"));
        }
        this.flush();
    }
}
module.exports = { classifyError, ModelScheduler };
