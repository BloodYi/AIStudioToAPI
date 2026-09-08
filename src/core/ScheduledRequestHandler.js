const RequestHandler = require("./RequestHandler");
const { fileKeys, rememberUploadHeaders } = require("./FileAffinity");
const { classifyError } = require("./ModelScheduler");

// One handler per incoming request keeps the existing protocol/stream implementation
// while removing global account and retry state from the data path.
class ScheduledRequestHandler extends RequestHandler {
    constructor(parent, req, res) {
        super(
            parent.serverSystem,
            parent.connectionRegistry,
            parent.logger,
            parent.browserManager,
            parent.config,
            parent.authSource
        );
        this.scheduled = true;
        this.scheduler = parent.serverSystem.scheduler;
        this.excluded = new Set();
        this.controller = new AbortController();
        this.response = res;
        this.incomingRequest = req;
        this.onClose = () => {
            if (!res.writableFinished) this.controller.abort();
        };
        res.on("close", this.onClose);
        const registry = this.connectionRegistry;
        this.connectionRegistry = new Proxy(registry, {
            get: (target, property) => {
                if (property === "createMessageQueue")
                    return (...args) => {
                        const queue = target.createMessageQueue(...args);
                        const dequeue = queue.dequeue.bind(queue);
                        const lease = this.lease;
                        let fileBody = "";
                        queue.dequeue = async (...params) => {
                            const message = await dequeue(...params);
                            if (message.event_type === "error") this.scheduler.failure(lease, message);
                            if (lease.model === "__files__") {
                                if (message.headers)
                                    rememberUploadHeaders(this.scheduler, message.headers, lease.account.key);
                                if (message.data && fileBody.length < 1048576) fileBody += message.data;
                                if (message.type === "STREAM_END") {
                                    try {
                                        for (const key of fileKeys(JSON.parse(fileBody)))
                                            this.scheduler.fileAffinities.set(key, lease.account.key);
                                        this.scheduler.saveSoon();
                                    } catch {
                                        /* Non-JSON file operation response. */
                                    }
                                }
                            }
                            return message;
                        };
                        return queue;
                    };
                const value = target[property];
                return typeof value === "function" ? value.bind(target) : value;
            },
        });
        this.authSwitcher = {
            currentAuthIndex: -1,
            failureCount: 0,
            handleRequestFailureAndSwitch: async error => this.scheduler.failure(this.lease, error),
            incrementUsageCount: () => 0,
            isSystemBusy: false,
            shouldSwitchByUsage: () => false,
            usageCount: 0,
        };
    }

    async _ensureBrowserBackedRequestReady() {
        return !this.controller.signal.aborted;
    }

    async _acquireScheduledLease(proxyRequest) {
        this.proxyRequest = proxyRequest;
        this.model = this._extractModelFromPath(proxyRequest.path);
        if (!this.model && proxyRequest.body) {
            try {
                this.model = JSON.parse(proxyRequest.body).model?.replace(/^models\//, "");
            } catch {
                /* Non-JSON upload */
            }
        }
        this.model ||= "__files__";
        let body;
        try {
            body = JSON.parse(proxyRequest.body || "{}");
        } catch {
            body = {};
        }
        const affinityKeys = fileKeys([proxyRequest.path, proxyRequest.query_params, body]);
        const owners = new Set([...affinityKeys].map(key => this.scheduler.fileAffinities.get(key)).filter(Boolean));
        if (owners.size > 1)
            throw Object.assign(new Error("Files from different accounts cannot be combined"), { status: 400 });
        this.affinity = [...owners][0] || null;
        await this.selectNext();
        this._updateTrackedRequest(proxyRequest.request_id, {
            initialAccountName: this._getAccountNameForIndex(this.currentAuthIndex),
            initialAuthIndex: this.currentAuthIndex,
        });
    }

    async selectNext() {
        while (this.excluded.size <= this.scheduler.config.maxRetries) {
            const excluded = new Set(this.excluded);
            if (this.affinity) {
                for (const index of this.authSource.getRotationIndices()) {
                    const account = this.scheduler.account(index);
                    if (account.key !== this.affinity) excluded.add(account.key);
                }
            }
            this.lease = await this.scheduler.acquire(this.model, excluded, this.controller.signal);
            this.excluded.add(this.lease.account.key);
            this.authSwitcher.currentAuthIndex = this.lease.account.index;
            try {
                await this.browserManager.ensureWorkerContext(this.currentAuthIndex);
                if (this.controller.signal.aborted)
                    throw Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" });
                this.browserManager.notifyUserActivity(this.currentAuthIndex);
                return;
            } catch (error) {
                this.scheduler.failure(this.lease, error);
                this.scheduler.release(this.lease);
                this.lease = null;
                if (this.controller.signal.aborted || this.excluded.size > this.scheduler.config.maxRetries)
                    throw error;
            }
        }
        throw Object.assign(new Error(`Retry budget exhausted for model ${this.model}`), { status: 503 });
    }

    _shouldRetryError(error) {
        return ["account", "rate_limited", "unsupported", "temporary"].includes(classifyError(error));
    }

    async _prepareImmediateStatusRetry(error, requestId, tracker, sourceAuthIndex) {
        if (this.lease?.account.index !== sourceAuthIndex) return false;
        this.scheduler.failure(this.lease, error);
        if (
            !this._shouldRetryError(error) ||
            this.controller.signal.aborted ||
            this.response.headersSent ||
            this.excluded.size > this.scheduler.config.maxRetries
        )
            return false;
        this.scheduler.release(this.lease);
        this.lease = null;
        try {
            await this.selectNext();
            tracker.attemptedAuthIndices.add(this.currentAuthIndex);
            return true;
        } catch (selectionError) {
            this.logger.info(`[Scheduler] Retry stopped: ${selectionError.message}`);
            return false;
        }
    }

    _forwardRequest(proxyRequest, authIndex = this.currentAuthIndex) {
        if (this.controller.signal.aborted)
            throw Object.assign(new Error("Client disconnected"), { reason: "client_disconnect" });
        this.scheduler.startAttempt(this.lease);
        return super._forwardRequest(proxyRequest, authIndex);
    }

    async _sendAndReadInitial(proxyRequest, queue, authIndex) {
        try {
            this._forwardRequest(proxyRequest, authIndex);
            return await this._readInitialMessage(queue);
        } catch (error) {
            return { event_type: "error", message: error.message, reason: error.reason, status: 503 };
        }
    }

    async _readInitialMessage(queue, timeout = this.timeouts.FAKE_STREAM) {
        try {
            const message = await queue.dequeue(timeout);
            if (message.event_type === "error") this.scheduler.failure(this.lease, message);
            return message;
        } catch (error) {
            return {
                event_type: "error",
                message: error.message,
                reason: error.reason,
                status: error.reason === "client_disconnect" ? 499 : 503,
            };
        }
    }

    async _executeRequestWithRetries(proxyRequest, messageQueue) {
        let queue = messageQueue;
        const tracker = this._createImmediateSwitchTracker();
        // eslint-disable-next-line no-constant-condition
        while (true) {
            let result;
            this._getUsageStatsService()?.recordAttempt(
                proxyRequest.request_id,
                this.currentAuthIndex,
                this._getAccountNameForIndex(this.currentAuthIndex)
            );
            try {
                this._forwardRequest(proxyRequest);
                result = await this._readInitialMessage(queue);
                if (result.event_type !== "error" && result.event_type !== "timeout")
                    return { message: result, queue, success: true };
                if (result.event_type === "timeout")
                    result = { ...result, message: "Browser request timed out", status: 504 };
            } catch (error) {
                result = { message: error.message, reason: error.reason, status: 503 };
            }
            this._cancelCurrentAttemptBeforeRetry(proxyRequest, this.currentAuthIndex);
            if (
                !(await this._prepareImmediateStatusRetry(
                    result,
                    proxyRequest.request_id,
                    tracker,
                    this.currentAuthIndex
                ))
            ) {
                return { error: { ...result, skipAccountSwitch: true }, success: false };
            }
            queue.close("retry_creating_new_queue");
            this._advanceProxyRequestAttempt(proxyRequest);
            queue = this.connectionRegistry.createMessageQueue(
                proxyRequest.request_id,
                this.currentAuthIndex,
                proxyRequest.request_attempt_id
            );
        }
    }

    _markTrackedResponseError(res, message, statusCode, outcome) {
        if (this.lease?.attempted) this.scheduler.failure(this.lease, { message, status: statusCode });
        return super._markTrackedResponseError(res, message, statusCode, outcome);
    }

    finish() {
        this.response.removeListener("close", this.onClose);
        const success =
            !this.controller.signal.aborted && !this.response.__usageTrackingOutcome && this.response.statusCode < 400;
        this.scheduler.release(this.lease, success);
    }
}

async function dispatch(parent, method, req, res) {
    const handler = new ScheduledRequestHandler(parent, req, res);
    try {
        await handler[method](req, res);
    } catch (error) {
        if (!handler.controller.signal.aborted) handler._sendErrorResponse(res, error.status || 503, error.message);
    } finally {
        handler.finish();
    }
}
module.exports = { dispatch, ScheduledRequestHandler };
