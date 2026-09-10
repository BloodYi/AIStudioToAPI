const fs = require("fs");
const path = require("path");
const { isUserAbortedError } = require("../utils/CustomErrors");

const schedulerError = (message, status = 503) => Object.assign(new Error(message), { status });

function classifyError(error = {}) {
    if (isUserAbortedError(error) || error.reason === "client_disconnect") return "aborted";
    if (
        error.kind === "transport" ||
        error.code === "QUEUE_CLOSED" ||
        [
            "page_closed",
            "context_closed",
            "connection_lost",
            "reconnect_cleanup",
            "grace_period_timeout",
            "retry_replaced",
        ].includes(error.kind || error.reason)
    )
        return "transport";
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
        this.metrics = {
            dispatch_timeout: 0,
            local_transport: 0,
            samples: { context_wait_ms: [], http_headers_ms: [], model_first_output_ms: [], upstream_ttfb_ms: [] },
            upstream_error: 0,
        };
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

    eligibleAccounts(model, excluded = new Set()) {
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

    candidates(model, excluded = new Set()) {
        return this.eligibleAccounts(model, excluded);
    }

    readyCandidates(model, excluded = new Set()) {
        const eligible = this.eligibleAccounts(model, excluded);
        if (!this.config.readyContextOnly || !this.browserManager) return eligible;
        return eligible.filter(account => this.browserManager.isContextReady(account.index));
    }

    canLease(account, model) {
        if (account.key === this.drainingAccount) return false;
        const accountLimit = this.config.accountConcurrency || 0;
        const modelLimit = this.config.accountModelConcurrency?.[model] ?? accountLimit;
        if (accountLimit && account.inflight >= accountLimit) return false;
        if (modelLimit && this.slot(account, model).inflight >= modelLimit) return false;
        if (this.config.readyContextOnly && this.browserManager) {
            if (!this.browserManager.isContextReady(account.index)) return false;
            const contextLimit = this.config.contextMaxConcurrency || 0;
            return !contextLimit || account.inflight < contextLimit;
        }
        return (
            account.inflight > 0 ||
            [...this.accounts.values()].filter(entry => entry.inflight > 0).length < this.config.maxWorkers
        );
    }

    active(model) {
        return this.workers.filter(worker => worker.lease?.model === model).length;
    }

    acquire(model, excluded = new Set(), signal) {
        if (this.closed) return Promise.reject(schedulerError("Scheduler is shutting down"));
        if (signal?.aborted) return Promise.reject(schedulerError("Client disconnected", 499));
        if (!this.eligibleAccounts(model, excluded).length)
            return Promise.reject(schedulerError(`No eligible accounts for model ${model}`));
        return new Promise((resolve, reject) => {
            const item = { createdAt: Date.now(), excluded, model, order: ++this.sequence, reject, resolve, signal };
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
                        this.metrics.dispatch_timeout++;
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
            if (!this.eligibleAccounts(item.model, item.excluded).length) {
                this.remove(item);
                item.reject(schedulerError(`No eligible accounts for model ${item.model}`));
            }
        }
        this._signalContextDemand();
        // Stop replenishing one context when a waiting model needs a different account.
        // Existing streams finish normally; this prevents permanent starvation at capacity.
        const activeAccounts = [...this.accounts.values()].filter(account => account.inflight > 0);
        const waitingForContext = this.pending.some(item => {
            const candidates = this.candidates(item.model, item.excluded);
            return candidates.length && candidates.every(account => !account.inflight);
        });
        if (waitingForContext && activeAccounts.length >= this.config.maxWorkers) {
            if (!activeAccounts.some(account => account.key === this.drainingAccount)) {
                this.drainingAccount = activeAccounts.sort((a, b) => a.inflight - b.inflight)[0].key;
            }
        } else {
            this.drainingAccount = null;
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
                    this.readyCandidates(item.model, item.excluded).some(account => this.canLease(account, item.model))
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
            const accounts = this.readyCandidates(item.model, item.excluded).filter(account =>
                this.canLease(account, item.model)
            );
            accounts.sort((a, b) => {
                const x = this.slot(a, item.model),
                    y = this.slot(b, item.model);
                const recentTransportFailures = account =>
                    Date.now() - (account.last_transport_failure_at || 0) < 60000
                        ? account.local_transport_failures || 0
                        : 0;
                return (
                    x.inflight - y.inflight ||
                    a.inflight - b.inflight ||
                    recentTransportFailures(a) - recentTransportFailures(b) ||
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
            this.observe("context_wait_ms", Date.now() - item.createdAt);
            item.resolve(lease);
        }
    }

    _signalContextDemand() {
        if (!this.browserManager || !this.config.readyContextOnly) return;
        const demanded = new Set();
        for (const item of this.pending) {
            if (this.readyCandidates(item.model, item.excluded).some(account => this.canLease(account, item.model)))
                continue;
            const cold = this.eligibleAccounts(item.model, item.excluded).find(
                account => !demanded.has(account.index) && !this.browserManager.isContextReady(account.index)
            );
            if (cold && !demanded.has(cold.index)) {
                demanded.add(cold.index);
                this.browserManager.requestContext(cold.index, item.model);
            }
        }
    }

    startAttempt(lease) {
        if (!lease || lease.attempted || lease.released) return;
        lease.attempted = true;
        lease.slot.request_count++;
        lease.slot.last_used_at = Date.now();
        this.saveSoon();
    }

    failure(lease, error) {
        if (!lease || lease.recorded) return;
        const kind = classifyError(error);
        if (kind === "aborted") return;
        if (kind === "transport") {
            lease.recorded = true;
            lease.account.local_transport_failures = (lease.account.local_transport_failures || 0) + 1;
            lease.account.last_transport_failure_at = Date.now();
            this.metrics.local_transport++;
            return;
        }
        lease.recorded = true;
        const { account, slot } = lease;
        slot.failure_count++;
        this.metrics.upstream_error++;
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
        const contexts = this.browserManager?.getContextPoolSnapshot?.() || [];
        const contextCount = state => contexts.filter(context => context.state === state).length;
        const busyContexts = contextCount("BUSY");
        const readyContexts = contextCount("READY") + busyContexts;
        return {
            accounts,
            active_browser_workers: busyContexts,
            active_workers: this.workers.filter(worker => worker.lease).length,
            busy_browser_workers: busyContexts,
            contexts,
            idle_browser_workers: contextCount("READY"),
            idle_workers: this.workers.filter(worker => !worker.lease).length,
            initializing_browser_workers: contextCount("INITIALIZING"),
            max_browser_workers: this.config.maxWorkers,
            metrics: this.metricsSnapshot(),
            models: [...models].map(model => {
                const slots = accounts.map(account => account.models[model]).filter(Boolean);
                return {
                    active_workers: this.active(model),
                    available_accounts: this.eligibleAccounts(model, new Set()).length,
                    configured_workers: this.config.allocation[model] || { min: 0, preferred: 1 },
                    failures: slots.reduce((sum, slot) => sum + slot.failure_count, 0),
                    model,
                    queue_length: this.pending.filter(item => item.model === model).length,
                    rate_limited_accounts: slots.filter(slot => slot.rate_limited).length,
                    ready_accounts: this.readyCandidates(model, new Set()).length,
                    requests: slots.reduce((sum, slot) => sum + slot.request_count, 0),
                    success: slots.reduce((sum, slot) => sum + slot.success_count, 0),
                };
            }),
            queued_requests: this.pending.length,
            ready_browser_workers: readyContexts,
            reconnecting_browser_workers: contextCount("RECONNECTING"),
            unavailable_browser_workers: contextCount("UNAVAILABLE"),
            workers: this.workers.map(worker => ({
                account_id: worker.lease?.account.index ?? null,
                id: worker.id,
                model: worker.lease?.model ?? null,
            })),
        };
    }

    observe(name, value) {
        if (!Number.isFinite(value) || !this.metrics.samples[name]) return;
        const samples = this.metrics.samples[name];
        samples.push(Math.max(0, value));
        if (samples.length > 1000) samples.splice(0, samples.length - 1000);
    }

    metricsSnapshot() {
        const percentile = (values, fraction) => {
            if (!values.length) return null;
            const sorted = [...values].sort((a, b) => a - b);
            return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)];
        };
        return {
            dispatch_timeout: this.metrics.dispatch_timeout,
            local_transport: this.metrics.local_transport,
            timings: Object.fromEntries(
                Object.entries(this.metrics.samples).map(([name, samples]) => [
                    name,
                    {
                        count: samples.length,
                        p50: percentile(samples, 0.5),
                        p95: percentile(samples, 0.95),
                        p99: percentile(samples, 0.99),
                    },
                ])
            ),
            upstream_error: this.metrics.upstream_error,
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
