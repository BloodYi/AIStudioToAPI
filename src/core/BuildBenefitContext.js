/* global window, location, XMLHttpRequest */
const ORIGIN = "https://alkalimakersuite-pa.clients6.google.com";
const RPC = "/$rpc/google.internal.alkali.applications.makersuite.v1.MakerSuiteService/";
const MODEL = "gemini-4-argon";
const isArgon = model => model?.replace(/^models\//, "") === MODEL;
const benefitError = message => Object.assign(new Error(message), { code: "BUILD_BENEFIT_NOT_READY", status: 503 });

// Runs in each new document. Credentials and opaque entitlement values never leave
// the owning page except for the final, native RPC's headers.
function installObserver({ origin, rpc, binding, owner }) {
    if (window !== window.top) return;
    const documentId = crypto.randomUUID();
    const state = {
        auth: null,
        documentId,
        ext: null,
        outgoing: new Set(),
        owner,
        pending: null,
        source: null,
        tier: null,
    };
    window.__buildBenefit = state;
    const observe = (url, headers) => {
        try {
            const parsed = new URL(url, location.href);
            if (parsed.origin !== origin || !parsed.pathname.startsWith(rpc)) return;
            if (!/^[A-Za-z]+$/.test(parsed.pathname.slice(rpc.length))) return;
            if (parsed.pathname === rpc + "GetAiStudioBenefitTier") return;
            const h = new Headers(headers);
            if (h.has("authorization") && (h.has("x-goog-api-key") || parsed.searchParams.has("key"))) {
                state.auth = {
                    authorization: h.get("authorization"),
                    "x-goog-api-key": h.get("x-goog-api-key") || parsed.searchParams.get("key"),
                    "x-goog-authuser": h.get("x-goog-authuser") || parsed.searchParams.get("authuser") || "0",
                };
            }
            const tier = h.get("x-aistudio-g1-tier");
            if (tier === "TIER1" || tier === "TIER2") {
                state.tier = tier;
                state.source = "native";
                if (binding) window[binding](documentId).catch(() => {});
            }
            if (h.has("x-goog-ext-519733851-bin")) state.ext = h.get("x-goog-ext-519733851-bin");
            if (binding && state.auth && !tier) window[binding](documentId).catch(() => {});
        } catch {
            // Ignore unrelated requests and malformed header input.
        }
    };
    const rememberBody = (url, body) => {
        try {
            const parsed = new URL(url, location.href);
            if (parsed.origin === origin && parsed.pathname === rpc + "ProxyUnaryCall" && typeof body === "string") {
                const payload = JSON.parse(body);
                if (
                    Array.isArray(payload) &&
                    typeof payload[0] === "string" &&
                    /^(?:https:\/\/generativelanguage\.googleapis\.com)?\/v1beta\/models\/gemini-4-argon:generateContent(?:\?|$)/.test(
                        payload[0]
                    )
                )
                    state.outgoing.add(body);
            }
        } catch {
            /* Unrelated URL. */
        }
    };
    const originalFetch = window.fetch;
    window.fetch = function (input, init) {
        const url = input instanceof Request ? input.url : input;
        observe(url, init?.headers || input?.headers);
        if (
            input instanceof Request &&
            init?.body === undefined &&
            String(url).startsWith(origin + rpc + "ProxyUnaryCall")
        ) {
            return input
                .clone()
                .text()
                .then(body => {
                    rememberBody(url, body);
                    return originalFetch.call(this, input, init);
                });
        }
        rememberBody(url, init?.body);
        return originalFetch.call(this, input, init);
    };
    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    const requests = new WeakMap();
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
        requests.set(this, { headers: new Headers(), url });
        return open.call(this, method, url, ...rest);
    };
    XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        requests.get(this)?.headers.append(name, value);
        return setHeader.call(this, name, value);
    };
    XMLHttpRequest.prototype.send = function (...args) {
        const request = requests.get(this);
        if (request) {
            observe(request.url, request.headers);
            rememberBody(request.url, args[0]);
        }
        return send.apply(this, args);
    };
    state.read = async timeoutMs => {
        if (state.tier) return { source: state.source, state: "ready-paid" };
        if (state.pending) return state.pending;
        state.pending = (async () => {
            if (!state.auth)
                throw Object.assign(new Error("authentication context unavailable"), { reason: "auth_unavailable" });
            const controller = new AbortController();
            state.controller = controller;
            const timer = setTimeout(() => controller.abort(), timeoutMs);
            try {
                const response = await originalFetch(origin + rpc + "GetAiStudioBenefitTier", {
                    body: "[]",
                    credentials: "include",
                    headers: { ...state.auth, "content-type": "application/json+protobuf" },
                    method: "POST",
                    signal: controller.signal,
                });
                if (!response.ok)
                    throw Object.assign(new Error("benefit query HTTP failure"), {
                        reason: "query_http",
                        status: response.status,
                    });
                const data = await response.json();
                if (!Array.isArray(data) || !Number.isInteger(data[0]) || ![0, 1, 2].includes(data[0]))
                    throw Object.assign(new Error("unknown benefit response"), { reason: "query_response" });
                if (!state.tier) {
                    state.tier = data[0] === 1 ? "TIER1" : data[0] === 2 ? "TIER2" : null;
                    state.source = "query";
                }
                return { source: state.source, state: state.tier ? "ready-paid" : "ready-free" };
            } catch (error) {
                if (state.tier) return { source: state.source, state: "ready-paid" };
                throw error;
            } finally {
                clearTimeout(timer);
                state.controller = null;
            }
        })();
        try {
            return await state.pending;
        } finally {
            state.pending = null;
        }
    };
}

class BuildBenefitContext {
    constructor(
        page,
        { authIndex, verified = false, onChange = () => {}, isCurrent = () => true, timeoutMs = 5000 } = {}
    ) {
        Object.assign(this, { authIndex, isCurrent, onChange, page, timeoutMs, verified });
        this.state = "unknown";
        this.owner = require("node:crypto").randomUUID();
        this.epoch = 0;
        this.onNavigation = frame => {
            if (frame === page.mainFrame()) {
                this.cancelPending?.();
                this.epoch++;
                this.state = "unknown";
                this.source = null;
                this.failureReason = null;
                this.queryStatus = null;
                this.pending = null;
                this.onChange();
            }
        };
        this.onClose = () => this.dispose();
        this.route = this.route.bind(this);
        this.matcher = url => url.origin === ORIGIN && url.pathname === RPC + "ProxyUnaryCall";
    }

    async install() {
        this.page.on("framenavigated", this.onNavigation);
        this.page.on("close", this.onClose);
        const binding = "__buildBenefitChanged";
        await this.page.exposeBinding(binding, async ({ frame }, documentId) => {
            if (this.disposed || frame !== this.page.mainFrame()) return;
            const epoch = this.epoch;
            const current = await this.page
                .evaluate(() => ({ id: window.__buildBenefit?.documentId, tier: window.__buildBenefit?.tier }))
                .catch(() => null);
            if (this.disposed || !this.isCurrent() || epoch !== this.epoch || current?.id !== documentId) return;
            if (!current?.tier) {
                if (this.verified && this.state === "failed" && Date.now() >= this.retryAt)
                    this.ensure({ refresh: true });
                return;
            }
            this.state = "ready-paid";
            this.source = "native";
            this.failureReason = null;
            this.queryStatus = null;
            this.onChange();
        });
        await this.page.addInitScript(installObserver, { binding, origin: ORIGIN, owner: this.owner, rpc: RPC });
        await this.page.route(this.matcher, this.route);
    }

    ensure({ refresh = false } = {}) {
        if (this.disposed || !this.isCurrent()) return Promise.reject(benefitError("Build benefit context disposed"));
        if (this.pending) return this.pending;
        if (
            !refresh &&
            (["ready-paid", "ready-free"].includes(this.state) ||
                (this.state === "failed" && Date.now() < this.retryAt))
        )
            return Promise.resolve(this.state);
        const epoch = this.epoch;
        this.state = "loading";
        const task = (async () => {
            let timer;
            try {
                const result = await Promise.race([
                    this.page.evaluate(async timeout => {
                        try {
                            return await window.__buildBenefit.read(timeout);
                        } catch (error) {
                            return {
                                httpStatus: error.status || null,
                                reason: error.name === "AbortError" ? "query_timeout" : error.reason || "query_parse",
                                state: "failed",
                            };
                        }
                    }, this.timeoutMs),
                    new Promise((_, reject) => {
                        this.cancelPending = () => reject(benefitError("Build document retired"));
                        timer = setTimeout(
                            () => reject(benefitError("Build benefit query deadline exceeded")),
                            this.timeoutMs + 100
                        );
                    }),
                ]);
                if (this.disposed || !this.isCurrent() || epoch !== this.epoch)
                    throw benefitError("Build document changed");
                this.state = result.state;
                this.source = result.source;
                this.failureReason = result.reason || null;
                this.queryStatus = result.httpStatus || null;
                if (result.state === "failed") this.retryAt = Date.now() + 30000;
            } catch {
                if (!this.disposed && epoch === this.epoch) {
                    this.state = "failed";
                    this.failureReason = "context_or_deadline";
                    this.queryStatus = null;
                    this.retryAt = Date.now() + 30000;
                }
            } finally {
                clearTimeout(timer);
                if (epoch === this.epoch) {
                    this.pending = null;
                    this.cancelPending = null;
                    this.onChange();
                }
            }
            return this.state;
        })();
        this.pending = task;
        return task;
    }

    async assertReady() {
        if (!this.verified) throw benefitError(`No verified Build account for ${MODEL}`);
        if ((await this.ensure()) !== "ready-paid")
            throw benefitError(
                `Build benefit ${this.state} for ${MODEL}${this.failureReason ? ` (${this.failureReason}${this.queryStatus ? ` HTTP ${this.queryStatus}` : ""})` : ""}`
            );
    }

    async route(route) {
        const request = route.request();
        let body;
        try {
            body = JSON.parse(request.postData() || "null");
        } catch {
            return route.continue();
        }
        try {
            // Legacy Build's first protobuf-JSON field is the upstream path.
            // Do not scan prompt strings or opaque proof fields for model names.
            const target =
                Array.isArray(body) &&
                typeof body[0] === "string" &&
                /^(?:https:\/\/generativelanguage\.googleapis\.com)?\/v1beta\/models\/gemini-4-argon:generateContent(?:\?|$)/.test(
                    body[0]
                );
            if (!target || request.frame() !== this.page.mainFrame()) return await route.continue();
            const epoch = this.epoch;
            const documentId = await this.page.evaluate(body => {
                const state = window.__buildBenefit;
                return state?.outgoing.delete(body) ? state.documentId : null;
            }, request.postData());
            if (!documentId || epoch !== this.epoch) throw benefitError("Retired Build request");
            await this.assertReady();
            const native = await this.page.evaluate(() => {
                const state = window.__buildBenefit;
                return { documentId: state?.documentId, ext: state?.ext, tier: state?.tier };
            });
            if (epoch !== this.epoch || this.disposed || !this.isCurrent() || native.documentId !== documentId)
                throw benefitError("Build document changed");
            const headers = await request.allHeaders();
            if (headers["x-aistudio-g1-tier"] && !["TIER1", "TIER2"].includes(headers["x-aistudio-g1-tier"]))
                throw benefitError("Unknown native Build tier");
            if (!headers["x-aistudio-g1-tier"]) {
                if (!native.tier) throw benefitError("Build tier unavailable");
                headers["x-aistudio-g1-tier"] = native.tier;
            }
            if (!headers["x-goog-ext-519733851-bin"] && native.ext) headers["x-goog-ext-519733851-bin"] = native.ext;
            await route.continue({ headers });
        } catch {
            await route.abort("blockedbyclient").catch(() => {});
        }
    }

    dispose() {
        if (this.disposed) return;
        this.disposed = true;
        this.cancelPending?.();
        this.epoch++;
        this.state = "unknown";
        this.page.off("framenavigated", this.onNavigation);
        this.page.off("close", this.onClose);
        this.page.unroute(this.matcher, this.route).catch(() => {});
        this.page
            .evaluate(owner => {
                if (window.__buildBenefit?.owner === owner) window.__buildBenefit.controller?.abort();
            }, this.owner)
            .catch(() => {});
        this.onChange();
    }
}
module.exports = { benefitError, BuildBenefitContext, installObserver, isArgon, MODEL };
