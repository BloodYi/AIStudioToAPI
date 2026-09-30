const BrowserManager = require("../core/BrowserManager");
const ConnectionRegistry = require("../core/ConnectionRegistry");
const TargetValidationTransport = require("./TargetValidationTransport");

class TargetSessionValidator {
    constructor({ browser, storageState, proxy, targetUrl, timeout, stepTimeout, onPage, onSignal, onFailure }) {
        // Never forward page text, URLs, cookies or exception messages to logs.
        const signals = ["Privacy protection layer active", "Received authIndex request", "Connection successful"];
        const logger = Object.fromEntries(
            ["info", "debug", "warn", "error", "success"].map(level => [
                level,
                message => {
                    const signal = signals.find(value => String(message).includes(value));
                    if (signal) onSignal?.(signal);
                },
            ])
        );
        const authSource = {
            getAuth: index => (index === 0 ? storageState : null),
            markAsExpired: async () => {},
        };
        this.manager = new BrowserManager(
            logger,
            {
                enableAuthUpdate: false,
                scheduler: {
                    contextCleanupTimeoutMs: stepTimeout,
                    contextCreationTimeoutMs: stepTimeout,
                    contextInitTotalTimeoutMs: timeout,
                    contextOperationTimeoutMs: stepTimeout,
                },
            },
            authSource
        );
        this.manager.browser = browser;
        this.manager.targetUrl = targetUrl;
        this.registry = new ConnectionRegistry(logger, null, () => 0, this.manager);
        this.manager.setConnectionRegistry(this.registry);
        this.transport = new TargetValidationTransport(this.registry, proxy, stepTimeout);
        const create = this.manager._createBrowserContext.bind(this.manager);
        this.manager._createBrowserContext = async (...args) => {
            const context = await create(...args);
            context.on("page", onPage);
            return context;
        };
        // BrowserManager's raw HTML debug artifacts are unsuitable for a login
        // executor. Its supervisor owns masked screenshots and bounded cleanup.
        this.manager._saveDebugArtifacts = async () => onFailure?.();
        const critical = this.manager._isCriticalPageError.bind(this.manager);
        this.manager._isCriticalPageError = error =>
            ["service_permission_required", "manual_challenge", "service_initialization_failed"].includes(
                error.reason
            ) || critical(error);
        const check = this.manager._checkPageErrors.bind(this.manager);
        this.manager._checkPageErrors = async (...args) => {
            const body = await args[0].locator("body").innerText({ timeout: stepTimeout });
            const reason = /Allow Drive access/i.test(body)
                ? "service_permission_required"
                : /captcha|verify you are human/i.test(body)
                  ? "manual_challenge"
                  : null;
            if (reason) throw Object.assign(new Error(reason), { reason, retryable: false });
            const errors = await check(...args);
            if (Object.values(errors).some(Boolean))
                throw Object.assign(new Error("service_initialization_failed"), {
                    reason: "service_initialization_failed",
                    retryable: true,
                });
            return errors;
        };
    }

    async validate() {
        const proxy = await this.transport.start();
        this.manager.setProxyResolver(async () => ({ proxy, source: "login_validation" }));
        const result = await this.manager._getOrStartContextInit(0);
        await this.manager._checkPageErrors(result.page);
        // BrowserManager also accepts a console message. Login commits require
        // a native connection actually accepted by this executor's own server.
        if (this.registry.getConnectionByAuth(0, false)?.readyState !== 1)
            throw Object.assign(new Error("service_initialization_unverified"), {
                reason: "service_initialization_unverified",
                retryable: true,
            });
        return result;
    }

    async close() {
        this.manager.isClosingIntentionally = true;
        await this.transport.close();
        for (const timer of this.registry.reconnectGraceTimers.values()) clearTimeout(timer);
    }
}
module.exports = TargetSessionValidator;
