const PublicDashboardServer = require("./PublicDashboardServer");
let server,
    snapshot,
    receivedAt = 0;
const logger = { error: console.error, info: console.log };
process.on("message", async message => {
    if (message.type === "snapshot") {
        snapshot = message.body;
        receivedAt = Date.now();
    }
    if (message.type === "configure" && !server) {
        server = new PublicDashboardServer({ config: message.config, logger });
        server.service = {
            getSnapshot: async () => {
                if (!snapshot) throw new Error("Snapshot not yet available");
                const stale = Date.now() - receivedAt > 15000;
                return { ...snapshot, service_status: stale ? "unavailable" : snapshot.service_status, stale };
            },
        };
        server.healthProvider = () => ({
            status: !snapshot || Date.now() - receivedAt > 15000 ? "stale" : "ok",
            updated_at: snapshot?.generated_at || null,
        });
        try {
            await server.start();
            process.send({ address: server.server.address(), type: "ready" });
        } catch (error) {
            process.send({ error: error.message, type: "startup-error" }, () => process.exit(1));
        }
    }
    if (message.type === "shutdown") {
        await server?.close();
        process.exit(0);
    }
});
process.on("disconnect", () => process.exit(0));
