const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const net = require("node:net");
const { once } = require("node:events");
const WebSocket = require("ws");
const Transport = require("../src/accounts/TargetValidationTransport");

test("validation transport redirects native sockets and rejects other account indices", async () => {
    const accepted = [];
    const transport = new Transport({ addConnection: (socket, info) => accepted.push(info.authIndex) }, null, 1000);
    try {
        await transport.start();
        const destinations = [];
        const direct = transport.direct.bind(transport);
        transport.direct = (host, port) => {
            destinations.push({ host, port });
            return direct(host, port);
        };
        for (const host of ["127.0.0.1", "localhost", "::1"]) {
            const socket = await transport.connect(host, 9998);
            const client = new WebSocket("ws://localhost:9998?authIndex=0", { createConnection: () => socket });
            await once(client, "open");
            client.close();
            await once(client, "close");
        }
        assert.deepEqual(accepted, [0, 0, 0]);
        assert.ok(destinations.every(item => item.port === transport.wsServer.address().port && item.port !== 9998));
        const socket = await transport.connect("localhost", 9998);
        const invalid = new WebSocket("ws://localhost:9998?authIndex=1", { createConnection: () => socket });
        assert.equal((await once(invalid, "close"))[0], 1008);
        assert.deepEqual(accepted, [0, 0, 0]);
    } finally {
        await transport.close();
    }
});

test("account SOCKS proxy tunnels validation traffic and has a bounded handshake", async () => {
    const sockets = new Set();
    let requests = 0;
    const echo = net.createServer(socket => {
        sockets.add(socket);
        socket.pipe(socket);
    });
    echo.listen(0, "127.0.0.1");
    await once(echo, "listening");
    const proxy = net.createServer(client => {
        sockets.add(client);
        if (++requests > 1) return; // The next handshake deliberately hangs.
        client.once("data", () => {
            client.write(Buffer.from([5, 0]));
            client.once("data", () => {
                const upstream = net.connect(echo.address().port, "127.0.0.1", () => {
                    sockets.add(upstream);
                    client.write(Buffer.from([5, 0, 0, 1, 127, 0, 0, 1, 0, 0]));
                    client.pipe(upstream).pipe(client);
                });
                client.once("close", () => upstream.destroy());
                upstream.once("close", () => client.destroy());
            });
        });
    });
    proxy.listen(0, "127.0.0.1");
    await once(proxy, "listening");
    const transport = new Transport(null, { server: `socks5://127.0.0.1:${proxy.address().port}` }, 100);
    try {
        const socket = await transport.connect("127.0.0.1", echo.address().port);
        const received = once(socket, "data");
        socket.write("synthetic");
        assert.equal((await received)[0].toString(), "synthetic");
        socket.destroy();
        await assert.rejects(transport.connect("127.0.0.1", echo.address().port), /timed out/i);
    } finally {
        await transport.close();
        for (const socket of sockets) socket.destroy();
        await Promise.all([proxy, echo].map(server => new Promise(resolve => server.close(resolve))));
    }
});

test("validation transport forwards normal HTTP and chains the account's HTTP proxy", async () => {
    const target = http.createServer((request, response) => response.end("synthetic"));
    target.listen(0, "127.0.0.1");
    await once(target, "listening");
    const destination = `http://127.0.0.1:${target.address().port}/`;
    let tunneled = 0;
    const upstreamProxy = http.createServer();
    const upstreamSockets = new Set();
    upstreamProxy.on("connect", (request, client, head) => {
        assert.equal(
            request.headers["proxy-authorization"],
            `Basic ${Buffer.from("synthetic:password").toString("base64")}`
        );
        const upstream = net.connect(target.address().port, "127.0.0.1", () => {
            tunneled++;
            client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
            if (head.length) upstream.write(head);
            client.pipe(upstream).pipe(client);
        });
        upstreamSockets.add(upstream);
        upstreamSockets.add(client);
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
    });
    upstreamProxy.listen(0, "127.0.0.1");
    await once(upstreamProxy, "listening");
    const transport = new Transport(
        { addConnection() {} },
        { password: "password", server: `http://127.0.0.1:${upstreamProxy.address().port}`, username: "synthetic" },
        1000
    );
    try {
        const proxy = await transport.start();
        const body = await new Promise((resolve, reject) => {
            const request = http.get(`${proxy.server}/`, { path: destination }, response => {
                let text = "";
                response.on("data", chunk => (text += chunk));
                response.once("end", () => resolve(text));
            });
            request.once("error", reject);
        });
        assert.equal(body, "synthetic");
        assert.equal(tunneled, 1);
        // Fixed-port application traffic is isolated even when an account proxy exists.
        const socket = await transport.connect("127.0.0.1", 9998);
        socket.destroy();
        assert.equal(tunneled, 1);
    } finally {
        await transport.close();
        for (const socket of upstreamSockets) socket.destroy();
        await Promise.all([target, upstreamProxy].map(server => new Promise(resolve => server.close(resolve))));
    }
});
