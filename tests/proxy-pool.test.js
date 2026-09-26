const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const ProxyNodeParser = require("../src/proxy/ProxyNodeParser");
const ProxyPoolStore = require("../src/proxy/ProxyPoolStore");
const MihomoConfigGenerator = require("../src/proxy/MihomoConfigGenerator");
const ProxyBindingService = require("../src/proxy/ProxyBindingService");

const logger = { error() {}, info() {}, warn() {} };

async function main() {
    const ss = ProxyNodeParser.parseUri("ss://YWVzLTI1Ni1nY206c2VjcmV0@example.com:443#US-01");
    assert.deepStrictEqual(
        { cipher: ss.cipher, host: ss.host, name: ss.name, password: ss.password, port: ss.port, type: ss.type },
        { cipher: "aes-256-gcm", host: "example.com", name: "US-01", password: "secret", port: 443, type: "ss" }
    );
    const socks = ProxyNodeParser.parseUri("socks5://user:pass@127.0.0.1:1080#Local");
    assert.strictEqual(socks.username, "user");
    assert.strictEqual(socks.password, "pass");
    const vless = ProxyNodeParser.parseUri(
        "vless://11111111-1111-1111-1111-111111111111@v.example.com:443?type=ws&security=tls&path=%2Fws&host=cdn.example.com#VLESS"
    );
    assert.strictEqual(vless.type, "vless");
    assert.strictEqual(vless.network, "ws");
    assert.strictEqual(vless["ws-opts"].headers.Host, "cdn.example.com");

    const clash = ProxyNodeParser.parseSubscription(
        `proxies:\n  - name: JP\n    type: ss\n    server: jp.example.com\n    port: 8443\n    cipher: aes-128-gcm\n    password: hidden\n`
    );
    assert.strictEqual(clash.nodes.length, 1);
    assert.strictEqual(clash.nodes[0].host, "jp.example.com");
    const encoded = Buffer.from("socks5://u:p@proxy.example.com:1080#B64").toString("base64");
    assert.strictEqual(ProxyNodeParser.parseSubscription(encoded).nodes[0].name, "B64");

    const temp = fs.mkdtempSync(path.join(os.tmpdir(), "proxy-pool-"));
    const filePath = path.join(temp, "proxy-pool.json");
    const store = new ProxyPoolStore(logger, filePath);
    const data = store.snapshot();
    assert.strictEqual(data.automation.enabled, false);
    assert.strictEqual(data.automation.subscriptionsEnabled, false);
    data.nodes.push({ ...ss, enabled: true, id: "node-one", localPort: 10801 });
    await store.replace(data);
    assert.strictEqual(fs.statSync(filePath).mode & 0o777, 0o600);
    assert.strictEqual(new ProxyPoolStore(logger, filePath).snapshot().nodes[0].localPort, 10801);
    fs.writeFileSync(filePath, "{broken");
    assert.deepStrictEqual(new ProxyPoolStore(logger, filePath).snapshot().nodes, []);
    assert.ok(fs.readdirSync(temp).some(file => file.includes(".corrupt-")));
    await store.replace(data);

    const yaml = MihomoConfigGenerator.generate(store.snapshot(), "not-public");
    assert.match(yaml, /127\.0\.0\.1/);
    assert.match(yaml, /listener-node-one/);
    assert.match(yaml, /secret: not-public/);

    const authSource = { accountNameMap: new Map([[0, "User@Example.com"]]), availableIndices: [0] };
    const browserManager = {
        contexts: new Map(),
        contextUnavailable: new Map(),
        stickyProxyManager: { getProxyForAuth: () => null },
    };
    const manager = { status: { ready: false } };
    const bindingService = new ProxyBindingService(store, manager, browserManager, authSource);
    data.bindings["user@example.com"] = { desiredNodeId: "node-one", updatedAt: new Date().toISOString() };
    data.settings.enabled = true;
    await store.replace(data);
    assert.throws(() => bindingService.resolve(0), /Mihomo is not ready/);
    manager.status.ready = true;
    assert.strictEqual(bindingService.resolve(0).proxy.server, "socks5://127.0.0.1:10801");

    fs.rmSync(temp, { recursive: true });
    console.log("proxy-pool tests passed");
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
