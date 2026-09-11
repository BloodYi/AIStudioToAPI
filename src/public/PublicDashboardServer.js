const crypto = require("crypto");
const express = require("express");
const http = require("http");
const path = require("path");

const PublicDashboardService = require("./PublicDashboardService");

class PublicDashboardServer {
    constructor({ config, logger, scheduler, usageStatsService }) {
        this.config = config;
        this.logger = logger;
        this.service = new PublicDashboardService(scheduler, usageStatsService);
        this.server = null;
    }

    createApp() {
        const app = express();
        app.disable("x-powered-by");
        app.set("etag", false);
        app.use((req, res, next) => {
            res.set({
                "Content-Security-Policy":
                    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
                "Cross-Origin-Resource-Policy": "same-origin",
                "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
                "Referrer-Policy": "no-referrer",
                "X-Content-Type-Options": "nosniff",
            });
            const origin = req.get("origin");
            if (origin && this.config.corsOrigins.includes(origin) && req.path === "/api/public/dashboard") {
                res.set("Access-Control-Allow-Origin", origin);
                res.set("Vary", "Origin");
            }
            next();
        });
        app.options("/api/public/dashboard", (req, res) => {
            const origin = req.get("origin");
            if (!origin || !this.config.corsOrigins.includes(origin)) return res.sendStatus(404);
            res.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
            res.set("Access-Control-Allow-Headers", "Accept, Content-Type");
            return res.sendStatus(204);
        });
        app.get("/healthz", (req, res) => res.json({ status: "ok" }));
        app.get("/api/public/dashboard", (req, res) => {
            try {
                const body = this.service.getSnapshot();
                const serialized = JSON.stringify(body);
                if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("Public dashboard response too large");
                const etag = `"${crypto.createHash("sha256").update(serialized).digest("base64url")}"`;
                res.set("Cache-Control", "public, max-age=2, must-revalidate");
                res.set("ETag", etag);
                if (req.get("if-none-match") === etag) return res.status(304).end();
                return res.type("application/json").send(serialized);
            } catch (error) {
                this.logger.error(`[PublicDashboard] Failed to build snapshot: ${error.message}`);
                return res.status(503).json({ error: "dashboard_temporarily_unavailable" });
            }
        });

        const dist = path.join(__dirname, "..", "..", "ui-public", "dist");
        app.use("/assets", express.static(path.join(dist, "assets"), { fallthrough: false, index: false }));
        app.get("/", (req, res) => res.sendFile(path.join(dist, "index.html")));
        app.use((error, req, res, next) => {
            if (res.headersSent) return next(error);
            return res
                .status(error.status === 404 ? 404 : 503)
                .json(error.status === 404 ? { error: "not_found" } : { error: "dashboard_temporarily_unavailable" });
        });
        app.use((req, res) => {
            if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
                res.set("Allow", "GET, HEAD");
                return res.status(405).end();
            }
            return res.status(404).end();
        });
        return app;
    }

    start() {
        this.server = http.createServer(this.createApp());
        this.server.on("upgrade", (req, socket) => socket.destroy());
        return new Promise((resolve, reject) => {
            const onError = error => reject(error);
            this.server.once("error", onError);
            this.server.listen(this.config.port, this.config.host, () => {
                this.server.off("error", onError);
                this.server.on("error", error => this.logger.error(`[PublicDashboard] Server error: ${error.message}`));
                this.logger.info(`[PublicDashboard] Listening on http://${this.config.host}:${this.config.port}`);
                resolve();
            });
        });
    }

    close() {
        return new Promise(resolve => {
            if (!this.server?.listening) return resolve();
            this.server.close(() => resolve());
        });
    }
}

module.exports = PublicDashboardServer;
