// Fault injector: intentionally ignores cancellation and can leave browser-like
// descendants behind. Only referenced by the isolated account queue tests.
const { spawn } = require("node:child_process");
process.on("message", message => {
    if (!message.credentials) return;
    const { email } = message.credentials;
    process.send({ phase: "mock_page", token: message.token });
    if (email.startsWith("hang")) {
        spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
        return;
    }
    if (email.startsWith("exit")) {
        process.exit(1);
        return;
    }
    const result = email.startsWith("network")
        ? { error: "network_timeout", retryable: true }
        : email.startsWith("wrong")
          ? { error: "wrong_password", retryable: false }
          : { email, storageState: { cookies: [], origins: [] } };
    if (result.error) process.send({ screenshot: { reason: "page_closed" }, token: message.token });
    setTimeout(() => process.send({ result, token: message.token }), email.startsWith("late") ? 1000 : 50);
});
