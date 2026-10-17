const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const tick = () => new Promise(resolve => setImmediate(resolve));
function client(fetch, clock = performance) {
    const source = fs.readFileSync(require.resolve("../scripts/client/build.js"), "utf8");
    const realm = vm.createContext({
        AbortController,
        clearTimeout,
        DOMException,
        EventTarget,
        fetch,
        performance: clock,
        setTimeout,
        TextDecoder,
    });
    vm.runInContext(
        source.replace(/initializeProxySystem\(\);\s*$/, "") +
            "\nLogger.enabled=false;globalThis.Processor=RequestProcessor;globalThis.System=ProxySystem;",
        realm
    );
    const processor = new realm.Processor();
    processor._constructUrl = () => "https://fixture.invalid/";
    processor._buildRequestConfig = (spec, signal) => ({ signal });
    return { processor, realm };
}
const request = {
    remaining_budget_ms: 100000,
    request_attempt_id: "attempt",
    request_id: "request",
    streaming_mode: "fake",
    transport_policy: { transport: "makersuite" },
};

test("client validates buffered budgets and keeps old-client five minute protection", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let signal;
    let calls = 0;
    const { processor } = client((url, init) => {
        signal = init.signal;
        calls++;
        return new Promise(() => {});
    });
    for (const budget of [undefined, 0, -1, 300001, NaN])
        assert.throws(() => processor.execute({ ...request, remaining_budget_ms: budget }, "request"), /budget/);
    assert.equal(calls, 0);
    const execution = processor.execute({}, "legacy");
    const rejected = assert.rejects(execution.responsePromise, /Timeout/);
    t.mock.timers.tick(299999);
    assert.equal(signal.aborted, false);
    t.mock.timers.tick(1);
    await rejected;
    assert.equal(signal.aborted, true);
    execution.cancelTimeout();
});

test("body chunks cannot renew the buffered client's generation deadline", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    let elapsed = 0;
    let signal;
    let read;
    let cancelled = false;
    const reader = {
        cancel: async () => {
            cancelled = true;
        },
        read: () =>
            new Promise(resolve => {
                read = resolve;
            }),
    };
    const { realm, processor } = client(
        async (url, init) => {
            signal = init.signal;
            return { body: { getReader: () => reader }, ok: true };
        },
        { now: () => elapsed }
    );
    const events = [];
    const system = Object.create(realm.System.prototype);
    system.requestProcessor = processor;
    system.connectionManager = { isConnected: true, transmit: value => events.push(value) };
    system._transmitHeaders = () => {};
    const running = system._processProxyRequest(request);
    await tick();
    for (const at of [59000, 61000, 90000]) {
        t.mock.timers.tick(at - elapsed);
        elapsed = at;
        read({ done: false, value: Buffer.from("chunk") });
        await tick();
        assert.equal(signal.aborted, false);
    }
    elapsed = 100000;
    t.mock.timers.tick(10000);
    await running;
    assert.equal(signal.aborted, true);
    assert.equal(cancelled, true);
    assert.equal(events.filter(event => event.event_type === "error").length, 1);
    assert.equal(events[0].status, 504);
    assert.equal(
        events.some(event => event.event_type === "chunk" || event.event_type === "stream_close"),
        false
    );
    assert.equal(processor.activeOperations.size, 0);
});
