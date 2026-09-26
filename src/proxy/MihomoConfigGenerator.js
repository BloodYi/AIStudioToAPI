const crypto = require("crypto");
const YAML = require("yaml");

class MihomoConfigGenerator {
    static nodeName(node) {
        return `pool-${node.id}`;
    }

    static proxy(node) {
        const common = { name: this.nodeName(node), port: node.port, server: node.host, type: node.type };
        if (node.type === "ss") return { ...common, cipher: node.cipher, password: node.password };
        if (node.type === "socks5")
            return { ...common, password: node.password || undefined, username: node.username || undefined };
        if (node.type === "trojan")
            return {
                ...common,
                password: node.password,
                "skip-cert-verify": Boolean(node.skipCertVerify ?? node["skip-cert-verify"]),
                sni: node.sni || undefined,
            };
        if (["vless", "vmess"].includes(node.type)) {
            return {
                ...common,
                alterId: node.type === "vmess" ? Number(node.alterId || 0) : undefined,
                cipher: node.type === "vmess" ? node.cipher || "auto" : undefined,
                "client-fingerprint": node.fp || node["client-fingerprint"] || undefined,
                flow: node.type === "vless" ? node.flow || undefined : undefined,
                "grpc-opts": node["grpc-opts"] || undefined,
                network: node.network || undefined,
                "reality-opts": node["reality-opts"] || undefined,
                servername: node.sni || undefined,
                "skip-cert-verify": Boolean(node.skipCertVerify ?? node["skip-cert-verify"]),
                tls: Boolean(node.tls),
                uuid: node.uuid,
                "ws-opts": node["ws-opts"] || undefined,
            };
        }
        throw new Error(`Unsupported Mihomo node type: ${node.type}`);
    }

    static generate(snapshot, secret) {
        const nodes = snapshot.nodes.filter(node => node.enabled !== false && node.status !== "missing");
        const config = {
            "allow-lan": false,
            "external-controller": `127.0.0.1:${snapshot.settings.controllerPort}`,
            listeners: nodes.map(node => ({
                listen: "127.0.0.1",
                name: `listener-${node.id}`,
                port: node.localPort,
                proxy: this.nodeName(node),
                type: "socks",
                udp: true,
            })),
            "log-level": "warning",
            mode: "rule",
            proxies: nodes.map(node => this.proxy(node)),
            rules: ["MATCH,DIRECT"],
            secret,
        };
        return YAML.stringify(config, { lineWidth: 0 });
    }

    static hash(content) {
        return crypto.createHash("sha256").update(content).digest("hex");
    }
}

module.exports = MihomoConfigGenerator;
