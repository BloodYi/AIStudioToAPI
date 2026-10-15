const { MAX_AGENT_BYTES, validateEnvelope } = require("./DashboardProtocol");

class PublicDashboardCollector {
    constructor({ config, nodeId, onUpdate, fetchImpl = fetch }) {
        this.config = config;
        this.onUpdate = onUpdate;
        this.fetch = fetchImpl;
        this.entries = new Map(
            config.agents.map(agent => {
                if (agent.nodeId === nodeId) throw new Error("Public dashboard cannot collect itself");
                return [agent.nodeId, { agent, body: null, etag: null, failed: false }];
            })
        );
        this.controllers = new Set();
    }
    start() {
        this.poll();
        this.timer = setInterval(() => this.poll(), this.config.pollIntervalMs);
        this.timer.unref();
    }
    async poll() {
        if (this.stopped || this.polling) return;
        this.polling = true;
        const pending = [...this.entries.values()];
        try {
            await Promise.all(
                Array.from({ length: Math.min(4, pending.length) }, async () => {
                    while (pending.length && !this.stopped) await this.collect(pending.shift());
                })
            );
        } finally {
            this.polling = false;
        }
    }
    async collect(entry) {
        const controller = new AbortController();
        this.controllers.add(controller);
        const timer = setTimeout(() => controller.abort(), this.config.fetchTimeoutMs);
        try {
            const response = await this.fetch(`${entry.agent.url}/api/agent/dashboard`, {
                headers: {
                    Accept: "application/json",
                    Authorization: `Bearer ${entry.agent.token}`,
                    ...(entry.etag ? { "If-None-Match": entry.etag } : {}),
                },
                redirect: "error",
                signal: controller.signal,
            });
            if (response.status === 304 && entry.body) {
                // Keep the original source timestamp, even if every HTTP request succeeds.
                entry.failed = false;
            } else {
                if (!response.ok) throw new Error("Agent query failed");
                const reader = response.body.getReader();
                let size = 0;
                const chunks = [];
                while (!controller.signal.aborted) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    size += value.byteLength;
                    if (size > MAX_AGENT_BYTES) {
                        await reader.cancel();
                        throw new Error("Agent snapshot too large");
                    }
                    chunks.push(Buffer.from(value));
                }
                if (controller.signal.aborted) throw new Error("Agent query aborted");
                const body = validateEnvelope(JSON.parse(Buffer.concat(chunks).toString("utf8")), entry.agent.nodeId);
                if (entry.body && Date.parse(body.generated_at) < Date.parse(entry.body.generated_at))
                    throw new Error("Agent snapshot moved backwards");
                if (this.stopped) return;
                entry.body = body;
                entry.etag = response.headers.get("etag");
                entry.failed = false;
            }
        } catch {
            if (!this.stopped) entry.failed = true;
        } finally {
            clearTimeout(timer);
            this.controllers.delete(controller);
            if (!this.stopped) this.onUpdate();
        }
    }
    close() {
        this.stopped = true;
        clearInterval(this.timer);
        for (const controller of this.controllers) controller.abort();
    }
}
module.exports = PublicDashboardCollector;
