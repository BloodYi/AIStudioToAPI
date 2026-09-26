const { getProxySummaryFromEnv, parseProxyFromEnv } = require("../utils/ProxyUtils");

class ProxyBindingService {
    constructor(store, manager, browserManager, authSource) {
        this.store = store;
        this.manager = manager;
        this.browserManager = browserManager;
        this.authSource = authSource;
    }

    accountKey(authIndex) {
        const name = this.authSource.accountNameMap.get(authIndex);
        return typeof name === "string" && name.trim() ? name.trim().toLowerCase() : `auth-${authIndex}`;
    }

    resolve(authIndex) {
        const snapshot = this.store.snapshot();
        const accountKey = this.accountKey(authIndex);
        const desiredNodeId = snapshot.bindings[accountKey]?.desiredNodeId || null;
        if (desiredNodeId) {
            const node = snapshot.nodes.find(entry => entry.id === desiredNodeId);
            if (!node)
                throw Object.assign(new Error(`Bound proxy node does not exist: ${desiredNodeId}`), {
                    code: "PROXY_POOL_NODE_MISSING",
                });
            if (node.type === "direct") {
                if (node.enabled === false)
                    throw Object.assign(new Error(`Bound direct node is disabled: ${node.name}`), {
                        code: "PROXY_POOL_NODE_UNAVAILABLE",
                    });
                return {
                    appliedNodeId: node.id,
                    display: "direct",
                    proxy: null,
                    source: "direct_node",
                };
            }
            if (!snapshot.settings.enabled)
                throw Object.assign(new Error("Proxy pool is disabled for a bound account"), {
                    code: "PROXY_POOL_DISABLED",
                });
            if (node.enabled === false || node.status === "missing")
                throw Object.assign(new Error(`Bound proxy node is unavailable: ${node.name}`), {
                    code: "PROXY_POOL_NODE_UNAVAILABLE",
                });
            if (!this.manager.status.ready)
                throw Object.assign(new Error("Mihomo is not ready for a bound account"), { code: "MIHOMO_NOT_READY" });
            return {
                appliedNodeId: node.id,
                display: `socks5://127.0.0.1:${node.localPort}`,
                proxy: { server: `socks5://127.0.0.1:${node.localPort}` },
                source: "mihomo_pool",
            };
        }
        const sticky = this.browserManager.stickyProxyManager.getProxyForAuth(authIndex);
        if (sticky) return { ...sticky, appliedNodeId: null, source: "sticky_proxy_file" };
        const environment = parseProxyFromEnv();
        if (environment)
            return {
                appliedNodeId: null,
                display: getProxySummaryFromEnv().server,
                proxy: environment,
                source: "environment",
            };
        return { appliedNodeId: null, display: "direct", proxy: null, source: "direct" };
    }

    list() {
        const snapshot = this.store.snapshot();
        return this.authSource.availableIndices.map(authIndex => {
            const accountKey = this.accountKey(authIndex);
            const desiredNodeId = snapshot.bindings[accountKey]?.desiredNodeId || null;
            const data = this.browserManager.contexts.get(authIndex);
            const appliedNodeId = data?.proxyInfo?.appliedNodeId || null;
            let source = data?.proxyInfo?.source || null;
            let error = this.browserManager.contextUnavailable.get(authIndex)?.error?.message || null;
            if (!source && !data) {
                try {
                    source = this.resolve(authIndex).source;
                } catch (cause) {
                    const desired = snapshot.nodes.find(node => node.id === desiredNodeId);
                    source = desired?.type === "direct" ? "direct_node" : "mihomo_pool";
                    error ||= cause.message;
                }
            }
            const inflight = this.browserManager.scheduler?.account(authIndex).inflight || 0;
            let state = desiredNodeId
                ? data
                    ? desiredNodeId === appliedNodeId
                        ? "applied"
                        : "pending"
                    : "offline"
                : data && appliedNodeId
                  ? "pending"
                  : "unbound";
            if (data?.proxyPoolState === "draining") state = "draining";
            if (data?.proxyPoolState === "rebuilding") state = "rebuilding";
            if (error && desiredNodeId) state = "error";
            return {
                accountKey,
                accountName: this.authSource.accountNameMap.get(authIndex) || `auth-${authIndex}`,
                appliedNodeId,
                authIndex,
                contextState:
                    data?.state || (this.browserManager.initializingContexts.has(authIndex) ? "INITIALIZING" : "COLD"),
                desiredNodeId,
                error,
                inflight,
                proxySource: source,
                state,
            };
        });
    }
}

module.exports = ProxyBindingService;
