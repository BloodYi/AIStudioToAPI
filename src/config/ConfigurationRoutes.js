class ConfigurationRoutes {
    constructor(system) {
        this.system = system;
    }
    setupRoutes(app, authenticated) {
        const service = this.system.configurationService;
        const route = (method, url, handler) =>
            app[method](url, authenticated, async (req, res) => {
                res.setHeader("Cache-Control", "no-store");
                try {
                    await handler(req, res);
                } catch (error) {
                    res.status(error.status || 500).json({ error: error.message });
                }
            });
        route("get", "/api/configuration", (req, res) => res.json(service.snapshot()));
        route("post", "/api/configuration/secrets", (req, res) =>
            res.json({
                apiKeys: [...this.system.config.apiKeys],
                defaultApiKeys: [...service.baseline.apiKeys],
                savedApiKeys: [...service.saved.apiKeys],
            })
        );
        route("patch", "/api/configuration", (req, res) => res.json(service.save(req.body)));
        route("post", "/api/configuration/undo-pending", (req, res) => res.json(service.undo(req.body?.version)));
        route("post", "/api/configuration/restart", (req, res) => {
            if (req.body?.version !== service.document.version)
                throw Object.assign(new Error("配置版本已变化，请刷新"), { status: 409 });
            if (!process.send)
                throw Object.assign(new Error("当前入口没有运行进程监督器，请使用 node main.js 启动"), { status: 503 });
            if (this.system.restarting) throw Object.assign(new Error("重启已在进行中"), { status: 409 });
            service.load(service.document.overrides);
            this.system.restarting = true;
            res.once("finish", () => process.send({ configuration: service.runningDocument(), type: "restart" }));
            res.status(202).json({ accepted: true, instanceId: service.instanceId, version: service.document.version });
        });
        // Older endpoints require explicit values and the same version check; toggles are never inferred.
        const aliases = {
            "debug-mode": "DEBUG_MODE",
            "enable-auth-update": "ENABLE_AUTH_UPDATE",
            "force-code-execution": "FORCE_CODE_EXECUTION",
            "force-thinking": "FORCE_THINKING",
            "force-url-context": "FORCE_URL_CONTEXT",
            "force-web-search": "FORCE_WEB_SEARCH",
            "log-max-count": "LOG_DISPLAY_LIMIT",
            "safety-settings-threshold": "SAFETY_SETTINGS_THRESHOLD",
            "streaming-mode": "STREAMING_MODE",
        };
        for (const [suffix, name] of Object.entries(aliases))
            route("put", `/api/settings/${suffix}`, (req, res) => {
                const value = req.body?.value ?? req.body?.mode ?? req.body?.count;
                res.json(service.save({ changes: { [name]: value }, version: req.body?.version }));
            });
    }
}
module.exports = ConfigurationRoutes;
