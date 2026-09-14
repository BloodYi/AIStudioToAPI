const fs = require("fs");
const path = require("path");
const { isUserAbortedError } = require("../utils/CustomErrors");

const schedulerError = (message, status = 503) => Object.assign(new Error(message), { status });
const PACIFIC_TIMEZONE = "America/Los_Angeles";
const PACIFIC_DATE_FORMATTER = new Intl.DateTimeFormat("en-US", {
    day: "2-digit",
    month: "2-digit",
    timeZone: PACIFIC_TIMEZONE,
    year: "numeric",
});
const DAILY_QUOTAS = Object.freeze({ flash: 100, pro: 10 });
const MAX_MODEL_NAME_LENGTH = 200;

function normalizeModelName(model) {
    if (typeof model !== "string") throw schedulerError("Model must be a non-empty string", 400);
    const normalized = model.trim().replace(/^models\//, "");
    if (!normalized || normalized.length > MAX_MODEL_NAME_LENGTH)
        throw schedulerError(`Model must contain 1-${MAX_MODEL_NAME_LENGTH} characters`, 400);
    if (normalized.startsWith("__") || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(normalized))
        throw schedulerError("Invalid model name", 400);
    return normalized;
}

function getModelDailyQuota(model) {
    const normalized = String(model || "").toLowerCase();
    if (normalized.startsWith("__") || normalized.includes("embedding") || normalized.includes("imagen")) return null;
    const segments = normalized.split("-");
    if (segments.includes("flash")) return DAILY_QUOTAS.flash;
    if (segments.includes("pro")) return DAILY_QUOTAS.pro;
    return null;
}

function isValidDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
    if (!match) return false;
    const [, year, month, day] = match.map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

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
    const status = Number(error.status ?? error.code);
    const message = String(error.message || "");
    if (status === 403) return "risk_controlled";
    if (error.accountUnhealthy) return "account";
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
        this.hiddenModels = new Set();
        this.pending = [];
        this.workers = Array.from({ length: config.globalConcurrency }, (_, id) => ({ id, lease: null }));
        this.sequence = 0;
        this.closed = false;
        this.random = typeof config.random === "function" ? config.random : Math.random;
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
            this.accounts.set(key, {
                disabled: false,
                disabled_at: null,
                disabled_reason: null,
                healthy: true,
                key,
                last_error: null,
                models: Object.create(null),
            });
        const account = this.accounts.get(key);
        account.index = index;
        account.inflight ??= 0;
        account.disabled ??= false;
        account.disabled_at ??= null;
        account.disabled_reason ??= null;
        return account;
    }

    getPacificDateKey(now = Date.now()) {
        const parts = Object.fromEntries(
            PACIFIC_DATE_FORMATTER.formatToParts(new Date(now))
                .filter(part => part.type !== "literal")
                .map(part => [part.type, part.value])
        );
        return `${parts.year}-${parts.month}-${parts.day}`;
    }

    rolloverDailyUsage(slot, now = Date.now()) {
        const date = this.getPacificDateKey(now);
        if (slot.daily_request_date === date) return false;
        slot.daily_request_count = 0;
        slot.daily_failure_count = 0;
        slot.daily_request_date = date;
        return true;
    }

    slot(account, model, now = Date.now()) {
        if (!Object.hasOwn(account.models, model))
            account.models[model] = {
                consecutive_failures: 0,
                cooldown_until: 0,
                daily_failure_count: 0,
                daily_request_count: 0,
                daily_request_date: this.getPacificDateKey(now),
                failure_count: 0,
                inflight: 0,
                last_error: null,
                last_error_kind: null,
                last_used_at: 0,
                rate_limited: false,
                request_count: 0,
                risk_control_failures: 0,
                success_count: 0,
                unsupported: false,
            };
        const slot = account.models[model];
        if (this.rolloverDailyUsage(slot, now)) this.saveSoon();
        if (slot.cooldown_until && slot.cooldown_until <= now) {
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
                    !account.disabled &&
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
                const draining = activeAccounts.sort((a, b) => {
                    const ranked = this.browserManager?.compareAccountsForDraining?.(a.index, b.index);
                    return ranked || a.inflight - b.inflight || a.index - b.index;
                })[0];
                this.drainingAccount = draining.key;
                this.browserManager?.beginAccountDrain?.(draining.index, "context_capacity");
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
        const now = Date.now();
        lease.attempted = true;
        this.rolloverDailyUsage(lease.slot, now);
        lease.slot.daily_request_count++;
        lease.slot.request_count++;
        lease.slot.last_used_at = now;
        this.browserManager?.markContextRequest?.(lease.account.index, now);
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
        this.rolloverDailyUsage(slot);
        slot.daily_failure_count++;
        slot.failure_count++;
        this.metrics.upstream_error++;
        if (kind === "risk_controlled") slot.risk_control_failures = (slot.risk_control_failures || 0) + 1;
        else slot.consecutive_failures++;
        slot.last_error = String(error.message || "Request failed").slice(0, 2000);
        slot.last_error_kind = kind;
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
        if (kind === "risk_controlled") {
            const multipliers = [1, 3, 6, 18];
            const multiplier = multipliers[Math.min(slot.risk_control_failures - 1, multipliers.length - 1)];
            const jitter = this.config.riskControlJitter === false ? 1 : 0.9 + this.random() * 0.2;
            const cooldown = Math.min(
                this.config.riskControlMaxCooldownMs,
                Math.round(this.config.riskControlCooldownMs * multiplier * jitter)
            );
            slot.cooldown_until = Date.now() + cooldown;
            this.logger.warn?.(
                `[Scheduler] Risk control account #${account.index}, model ${lease.model}, consecutive=${slot.risk_control_failures}, cooldown_until=${slot.cooldown_until}`
            );
        }
        this.saveSoon();
    }

    release(lease, success = false) {
        if (!lease || lease.released) return;
        lease.released = true;
        if (success && lease.attempted && !lease.recorded) {
            lease.slot.success_count++;
            lease.slot.consecutive_failures = 0;
            lease.slot.risk_control_failures = 0;
            lease.slot.last_error = null;
            lease.slot.last_error_kind = null;
        }
        lease.account.inflight--;
        lease.slot.inflight--;
        lease.worker.lease = null;
        this.saveSoon();
        this.drain();
        this.browserManager?.handleAccountLeaseReleased?.(lease.account.index);
    }

    isAccountManuallyDisabled(index) {
        return this.account(index).disabled === true;
    }

    disable(index, reason = "manual") {
        const account = this.account(index);
        if (account.disabled) return { account_id: index, changed: false, disabled: true };
        account.disabled = true;
        account.disabled_at = Date.now();
        account.disabled_reason = reason;
        this.sequence++;
        this.flush();
        this.browserManager?.handleAccountDisabled?.(index);
        this.drain();
        return { account_id: index, changed: true, disabled: true };
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

    resetAllAccounts() {
        let resetAccountCount = 0;
        let resetModelCount = 0;
        // Limit the override to accounts that are currently valid rotation candidates.
        for (const index of this.authSource.getRotationIndices()) {
            const account = this.account(index);
            if (account.disabled || !account.healthy || account.last_error !== null) {
                account.disabled = false;
                account.disabled_at = null;
                account.disabled_reason = null;
                account.healthy = true;
                account.last_error = null;
                resetAccountCount++;
            }
            for (const slot of Object.values(account.models)) {
                if (
                    !slot.unsupported &&
                    !slot.rate_limited &&
                    !slot.cooldown_until &&
                    !slot.consecutive_failures &&
                    !slot.risk_control_failures &&
                    slot.last_error === null
                )
                    continue;
                Object.assign(slot, {
                    consecutive_failures: 0,
                    cooldown_until: 0,
                    last_error: null,
                    last_error_kind: null,
                    rate_limited: false,
                    risk_control_failures: 0,
                    unsupported: false,
                });
                resetModelCount++;
            }
        }
        this.flush();
        this.drain();
        this.browserManager?.handleAccountsEnabled?.();
        return { reset_account_count: resetAccountCount, reset_model_count: resetModelCount };
    }

    reset(index, model) {
        const account = this.account(index);
        if (account.inflight) throw schedulerError("Account has active requests", 409);
        if (!model) {
            account.healthy = true;
            account.last_error = null;
            account.disabled = false;
            account.disabled_at = null;
            account.disabled_reason = null;
        }
        const slots = model ? [this.slot(account, model)] : Object.values(account.models);
        for (const slot of slots)
            Object.assign(slot, {
                consecutive_failures: 0,
                cooldown_until: 0,
                last_error: null,
                last_error_kind: null,
                rate_limited: false,
                risk_control_failures: 0,
                unsupported: false,
            });
        this.flush();
        this.drain();
        if (!model) this.browserManager?.handleAccountEnabled?.(index);
    }

    _snapshotModels() {
        return new Set([
            ...Object.keys(this.config.allocation),
            ...this.pending.map(item => item.model),
            ...[...this.accounts.values()].flatMap(account => Object.keys(account.models)),
        ]);
    }

    _visibleSnapshotModels() {
        return new Set([...this._snapshotModels()].filter(model => !this.hiddenModels.has(model)));
    }

    hideModel(model) {
        const normalized = normalizeModelName(model);
        if (!this._snapshotModels().has(normalized)) throw schedulerError(`Unknown scheduler model ${normalized}`, 404);
        if (this.hiddenModels.has(normalized)) return { changed: false, hidden: true, model: normalized };
        this.hiddenModels.add(normalized);
        this.sequence++;
        this.flush();
        return { changed: true, hidden: true, model: normalized };
    }

    showModel(model) {
        const normalized = normalizeModelName(model);
        const changed = this.hiddenModels.delete(normalized);
        if (changed) {
            this.sequence++;
            this.flush();
        }
        return { changed, hidden: false, model: normalized };
    }

    isModelHidden(model) {
        return this.hiddenModels.has(normalizeModelName(model));
    }

    hiddenModelsSnapshot() {
        return [...this.hiddenModels].sort((a, b) => a.localeCompare(b));
    }

    _slotStatus(account, slot, rotationIndices) {
        if (account.disabled) return "ACCOUNT_DISABLED";
        if (!account.healthy || !rotationIndices.includes(account.index)) return "UNHEALTHY";
        if (slot.unsupported) return "UNSUPPORTED";
        if (slot.rate_limited) return "RATE_LIMITED";
        if (slot.cooldown_until) return "COOLDOWN";
        return "HEALTHY";
    }

    summarySnapshot() {
        const now = Date.now();
        const indices = this.authSource.getRotationIndices();
        for (const index of indices) this.account(index);
        const models = this._visibleSnapshotModels();
        const quotaModels = [...models]
            .map(model => ({ limit: getModelDailyQuota(model), model }))
            .filter(entry => entry.limit !== null)
            .sort((a, b) => a.model.localeCompare(b.model));
        const quotaAccounts = indices.map(index => this.account(index));
        const quotaByModel = quotaModels.map(({ limit, model }) => {
            let dailyRequests = 0;
            let estimatedRemainingQuota = 0;
            for (const account of quotaAccounts) {
                const slot = this.slot(account, model, now);
                dailyRequests += slot.daily_request_count;
                estimatedRemainingQuota += Math.max(0, limit - slot.daily_request_count);
            }
            return {
                daily_requests: dailyRequests,
                estimated_remaining_quota: estimatedRemainingQuota,
                model,
                quota_per_account: limit,
                tracked_accounts: quotaAccounts.length,
            };
        });
        const contexts = this.browserManager?.getContextPoolSnapshot?.() || [];
        const contextCount = state => contexts.filter(context => context.state === state).length;
        const busyContexts = contextCount("BUSY");
        const readyContexts = contextCount("READY");
        return {
            active_browser_workers: busyContexts,
            active_workers: this.workers.filter(worker => worker.lease).length,
            busy_browser_workers: busyContexts,
            contexts_summary: {
                busy: busyContexts,
                initializing: contextCount("INITIALIZING"),
                max: this.config.maxWorkers,
                ready: readyContexts,
                reconnecting: contextCount("RECONNECTING"),
                unavailable: contextCount("UNAVAILABLE"),
            },
            idle_browser_workers: readyContexts,
            idle_workers: this.workers.filter(worker => !worker.lease).length,
            initializing_browser_workers: contextCount("INITIALIZING"),
            max_browser_workers: this.config.maxWorkers,
            metrics: this.metricsSnapshot(),
            models: [...models]
                .map(model => {
                    const slots = [...this.accounts.values()]
                        .map(account => (Object.hasOwn(account.models, model) ? this.slot(account, model, now) : null))
                        .filter(Boolean);
                    return {
                        active_workers: this.active(model),
                        available_accounts: this.eligibleAccounts(model, new Set()).length,
                        configured_workers: this.config.allocation[model] || { min: 0, preferred: 1 },
                        daily_requests: slots.reduce((sum, slot) => sum + slot.daily_request_count, 0),
                        model,
                        queue_length: this.pending.filter(item => item.model === model).length,
                        rate_limited_accounts: slots.filter(slot => slot.rate_limited).length,
                        ready_accounts: this.readyCandidates(model, new Set()).length,
                    };
                })
                .sort((a, b) => a.model.localeCompare(b.model)),
            queued_requests: this.pending.length,
            quota_by_model: quotaByModel,
            ready_browser_workers: readyContexts + busyContexts,
            reconnecting_browser_workers: contextCount("RECONNECTING"),
            unavailable_browser_workers: contextCount("UNAVAILABLE"),
            usage_window: {
                date: this.getPacificDateKey(now),
                timezone: PACIFIC_TIMEZONE,
            },
        };
    }

    /**
     * Side-effect-free scheduler projection for the anonymous dashboard.
     * Missing accounts and slots are interpreted as their default state rather
     * than being materialized through account() / slot().
     */
    publicSummarySnapshot() {
        const now = Date.now();
        const date = this.getPacificDateKey(now);
        const indices = this.authSource.getRotationIndices();
        const models = [...this._visibleSnapshotModels()].sort((a, b) => a.localeCompare(b));
        const accountFor = index => {
            const key = this.authSource.accountNameMap.get(index) || `auth-${index}`;
            return this.accounts.get(key) || null;
        };
        const slotFor = (account, model) => account?.models?.[model] || null;
        const dailyRequests = slot => (slot?.daily_request_date === date ? slot.daily_request_count || 0 : 0);
        const isRateLimited = slot =>
            Boolean(slot?.rate_limited && (!slot.cooldown_until || slot.cooldown_until > now));
        const isAvailable = (account, slot) =>
            (account?.healthy ?? true) &&
            !account?.disabled &&
            !slot?.unsupported &&
            (!slot?.cooldown_until || slot.cooldown_until <= now);

        return {
            active: this.workers.filter(worker => worker.lease).length,
            limit: this.workers.length,
            models: models.map(model => {
                const accountSlots = indices.map(index => {
                    const account = accountFor(index);
                    return { account, slot: slotFor(account, model) };
                });
                const quotaPerAccount = getModelDailyQuota(model);
                const today = accountSlots.reduce((sum, item) => sum + dailyRequests(item.slot), 0);
                return {
                    active: this.active(model),
                    availableAccounts: accountSlots.filter(item => isAvailable(item.account, item.slot)).length,
                    estimatedRemaining:
                        quotaPerAccount === null
                            ? null
                            : accountSlots.reduce(
                                  (sum, item) => sum + Math.max(0, quotaPerAccount - dailyRequests(item.slot)),
                                  0
                              ),
                    model,
                    queued: this.pending.filter(item => item.model === model).length,
                    rateLimitedAccounts: accountSlots.filter(item => isRateLimited(item.slot)).length,
                    todayRequests: today,
                };
            }),
            queued: this.pending.length,
            usageWindow: { date, timezone: PACIFIC_TIMEZONE },
        };
    }

    contextsSnapshot() {
        const contexts = this.browserManager?.getContextPoolSnapshot?.() || [];
        return {
            contexts: contexts.map(context => ({
                auth_index: context.auth_index,
                connection_epoch: context.connection_epoch || null,
                created_at: context.created_at || null,
                draining: Boolean(context.draining),
                eviction_priority: context.eviction_priority || null,
                inflight: context.inflight || 0,
                last_disconnect_reason: context.last_disconnect_reason
                    ? String(context.last_disconnect_reason).slice(0, 500)
                    : null,
                last_request_at: context.last_request_at || null,
                state: context.state,
            })),
            revision: `contexts:${this.sequence}:${contexts.length}`,
        };
    }

    accountsSnapshot(indices) {
        const rotationIndices = this.authSource.getRotationIndices();
        const requested = indices === undefined ? rotationIndices : indices;
        const now = Date.now();
        return {
            accounts: requested.map(index => {
                const account = this.account(index);
                return {
                    disabled: account.disabled,
                    disabled_at: account.disabled_at,
                    disabled_reason: account.disabled_reason,
                    healthy: account.healthy,
                    index: account.index,
                    inflight: account.inflight,
                    key: account.key,
                    models: Object.keys(account.models)
                        .filter(model => !this.hiddenModels.has(model))
                        .sort()
                        .map(model => {
                            const slot = this.slot(account, model, now);
                            return {
                                cooldown_until: slot.cooldown_until || null,
                                daily_failures: slot.daily_failure_count,
                                daily_requests: slot.daily_request_count,
                                inflight: slot.inflight,
                                last_error: slot.last_error ? String(slot.last_error).slice(0, 500) : null,
                                last_error_kind: slot.last_error_kind || null,
                                model,
                                risk_control_failures: slot.risk_control_failures || 0,
                                status: this._slotStatus(account, slot, rotationIndices),
                            };
                        }),
                };
            }),
            revision: `accounts:${this.sequence}`,
        };
    }

    snapshot() {
        const summary = this.summarySnapshot();
        const details = this.accountsSnapshot([...this.accounts.values()].map(account => account.index));
        const accounts = details.accounts.map(account => ({
            ...account,
            models: Object.fromEntries(
                account.models.map(slot => {
                    const internal = this.account(account.index).models[slot.model];
                    return [slot.model, { ...internal, ...slot }];
                })
            ),
        }));
        const quotaTotal = summary.quota_by_model.reduce((sum, item) => sum + item.estimated_remaining_quota, 0);
        return {
            ...summary,
            accounts,
            contexts: this.contextsSnapshot().contexts,
            estimated_remaining_quota: quotaTotal,
            models: summary.models.map(model => {
                const slots = [...this.accounts.values()].map(account => account.models[model.model]).filter(Boolean);
                return {
                    ...model,
                    failures: slots.reduce((sum, slot) => sum + slot.failure_count, 0),
                    requests: slots.reduce((sum, slot) => sum + slot.request_count, 0),
                    success: slots.reduce((sum, slot) => sum + slot.success_count, 0),
                };
            }),
            quota_tracked_accounts: this.authSource.getRotationIndices().length,
            quota_tracked_models: summary.quota_by_model.length,
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
            if (![1, 2, 3, 4, 5].includes(data.version) || !Array.isArray(data.accounts))
                throw new Error("Unsupported scheduler state");
            if (data.version >= 4) {
                if (!Array.isArray(data.hiddenModels) || data.hiddenModels.some(model => typeof model !== "string"))
                    throw new Error("Invalid hidden scheduler models");
                this.hiddenModels = new Set(data.hiddenModels.map(normalizeModelName));
            }
            this.fileAffinities = new Map(data.fileAffinities || []);
            for (const account of data.accounts) {
                if (typeof account.key !== "string" || !account.models || typeof account.models !== "object")
                    throw new Error("Invalid account state");
                account.models = Object.assign(Object.create(null), account.models);
                account.inflight = 0;
                account.disabled ??= false;
                account.disabled_at ??= null;
                account.disabled_reason ??= null;
                for (const slot of Object.values(account.models)) {
                    slot.risk_control_failures ??= 0;
                    slot.last_error_kind ??= null;
                    if (data.version === 1) {
                        slot.daily_request_count = 0;
                        slot.daily_failure_count = 0;
                        slot.daily_request_date = this.getPacificDateKey();
                    } else if (
                        !Number.isInteger(slot.daily_request_count) ||
                        slot.daily_request_count < 0 ||
                        !isValidDateKey(slot.daily_request_date)
                    ) {
                        throw new Error("Invalid daily scheduler state");
                    }
                    if (data.version === 2) slot.daily_failure_count = 0;
                    if (!Number.isInteger(slot.daily_failure_count) || slot.daily_failure_count < 0)
                        throw new Error("Invalid daily scheduler failure state");
                    slot.inflight = 0;
                }
                this.accounts.set(account.key, account);
            }
            if (data.version === 1)
                this.logger.warn(
                    "[Scheduler] Upgraded version 1 state: today's Pacific-time request counts start at zero; cumulative statistics were preserved."
                );
            if (data.version === 2)
                this.logger.warn(
                    "[Scheduler] Upgraded version 2 state: today's Pacific-time failure counts start at zero; cumulative statistics were preserved."
                );
        } catch (error) {
            if (error.code !== "ENOENT") {
                this.accounts.clear();
                this.fileAffinities.clear();
                this.hiddenModels.clear();
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
                    hiddenModels: this.hiddenModelsSnapshot(),
                    version: 5,
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
module.exports = { classifyError, getModelDailyQuota, ModelScheduler, normalizeModelName };
