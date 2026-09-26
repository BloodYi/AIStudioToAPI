const crypto = require("crypto");
const YAML = require("yaml");

const decode = value => decodeURIComponent(String(value || "").replace(/\+/g, "%20"));
const decodeBase64 = value => {
    const clean = String(value || "")
        .replace(/\s/g, "")
        .replace(/-/g, "+")
        .replace(/_/g, "/");
    if (!clean || !/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new Error("Invalid Base64 data");
    return Buffer.from(clean, "base64").toString("utf8");
};
const idFor = (prefix, stableKey) =>
    `${prefix}-${crypto.createHash("sha256").update(stableKey).digest("hex").slice(0, 12)}`;

class ProxyNodeParser {
    static parseUri(raw) {
        const value = String(raw || "").trim();
        if (!value) throw new Error("Empty share link");
        if (value.startsWith("ss://")) return this._parseSs(value);
        if (/^socks5?:\/\//i.test(value)) return this._parseUrl(value, "socks5");
        if (/^(trojan|vless):\/\//i.test(value)) return this._parseUrl(value);
        if (/^vmess:\/\//i.test(value)) return this._parseVmess(value);
        throw new Error("Unsupported share link protocol");
    }

    static _parseUrl(value, forcedType) {
        const url = new URL(value);
        const type = forcedType || url.protocol.slice(0, -1).toLowerCase();
        const node = {
            host: url.hostname,
            name: decode(url.hash.slice(1)) || `${url.hostname}:${url.port}`,
            password: decode(url.password),
            port: Number(url.port),
            type,
            username: decode(url.username),
        };
        for (const [key, val] of url.searchParams) {
            if (key === "type") node.network = val;
            else if (key === "security") node.tls = ["tls", "reality"].includes(val);
            else if (key === "allowInsecure") node.skipCertVerify = val === "1" || val === "true";
            else node[key] = val;
        }
        if (node.network === "ws") {
            node["ws-opts"] = {
                headers: node.host ? { Host: node.host } : undefined,
                path: node.path || undefined,
            };
            node.host = url.hostname;
        }
        if (type === "vless") node.uuid = node.username;
        if (type === "trojan" && !node.password) node.password = node.username;
        return this.validate(node);
    }

    static _parseSs(value) {
        const withoutScheme = value.slice(5);
        const hashAt = withoutScheme.indexOf("#");
        const name = hashAt >= 0 ? decode(withoutScheme.slice(hashAt + 1)) : "";
        const core = (hashAt >= 0 ? withoutScheme.slice(0, hashAt) : withoutScheme).split("?")[0];
        let credentials;
        let address;
        if (core.includes("@")) {
            const at = core.lastIndexOf("@");
            credentials = core.slice(0, at).includes(":") ? core.slice(0, at) : decodeBase64(core.slice(0, at));
            address = core.slice(at + 1);
        } else {
            const decoded = decodeBase64(core);
            const at = decoded.lastIndexOf("@");
            if (at < 0) throw new Error("Invalid Shadowsocks link");
            credentials = decoded.slice(0, at);
            address = decoded.slice(at + 1);
        }
        const split = credentials.indexOf(":");
        const url = new URL(`tcp://${address}`);
        return this.validate({
            cipher: decode(credentials.slice(0, split)),
            host: url.hostname,
            name: name || `${url.hostname}:${url.port}`,
            password: decode(credentials.slice(split + 1)),
            port: Number(url.port),
            type: "ss",
            username: "",
        });
    }

    static _parseVmess(value) {
        const data = JSON.parse(decodeBase64(value.slice(8)));
        return this.validate({
            alterId: Number(data.aid || 0),
            cipher: data.scy || "auto",
            host: data.add,
            name: data.ps || `${data.add}:${data.port}`,
            network: data.net || "tcp",
            port: Number(data.port),
            sni: data.sni || undefined,
            tls: data.tls === "tls",
            type: "vmess",
            uuid: data.id,
            "ws-opts":
                data.net === "ws"
                    ? { headers: data.host ? { Host: data.host } : undefined, path: data.path || undefined }
                    : undefined,
        });
    }

    static validate(node) {
        if (!node.name || !node.type || !node.host || !Number.isInteger(Number(node.port)))
            throw new Error("Node requires name, type, host and port");
        if (Number(node.port) < 1 || Number(node.port) > 65535) throw new Error("Invalid node port");
        if (node.type === "ss" && (!node.cipher || !node.password))
            throw new Error("Shadowsocks requires cipher and password");
        if (node.type === "vmess" && !node.uuid) throw new Error("VMess requires UUID");
        if (node.type === "vless" && !node.uuid) throw new Error("VLESS requires UUID");
        if (node.type === "trojan" && !node.password) throw new Error("Trojan requires password");
        return { ...node, password: node.password || "", port: Number(node.port), username: node.username || "" };
    }

    static parseText(text) {
        const results = { errors: [], nodes: [] };
        for (const [index, line] of String(text || "")
            .split(/\r?\n/)
            .entries()) {
            if (!line.trim() || line.trim().startsWith("#")) continue;
            try {
                results.nodes.push(this.parseUri(line));
            } catch (error) {
                results.errors.push({ line: index + 1, message: error.message });
            }
        }
        return results;
    }

    static parseSubscription(payload, contentType = "") {
        const raw = String(payload || "").trim();
        if (!raw) return { errors: [], nodes: [] };
        let decoded = raw;
        if (!raw.includes("://") && !/proxies\s*:/i.test(raw)) {
            try {
                decoded = decodeBase64(raw);
            } catch {
                /* YAML/parser below returns a useful error */
            }
        }
        if (/proxies\s*:/i.test(decoded) || /ya?ml/i.test(contentType)) {
            const doc = YAML.parse(decoded);
            if (!Array.isArray(doc?.proxies)) throw new Error("Clash subscription has no proxies list");
            const errors = [];
            const nodes = doc.proxies.flatMap((entry, index) => {
                try {
                    return [this.fromClash(entry)];
                } catch (error) {
                    errors.push({ line: index + 1, message: error.message });
                    return [];
                }
            });
            return { errors, nodes };
        }
        return this.parseText(decoded);
    }

    static fromClash(entry) {
        if (!entry || typeof entry !== "object") throw new Error("Invalid Clash proxy entry");
        const type = String(entry.type || "").toLowerCase();
        if (!["ss", "socks5", "trojan", "vless", "vmess"].includes(type))
            throw new Error(`Unsupported Clash type: ${type}`);
        return this.validate({ ...entry, host: entry.server, port: Number(entry.port), type, uuid: entry.uuid });
    }

    static stableId(node, subscriptionId = "manual") {
        return idFor("node", `${subscriptionId}|${node.type}|${node.host}|${node.port}|${node.name}`);
    }
}

module.exports = ProxyNodeParser;
