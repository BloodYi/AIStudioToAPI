const { generateSync, createGuardrails } = require("otplib");
// Existing Google Authenticator installations can use 80-bit (16-char) keys.
const guardrails = createGuardrails({ MIN_SECRET_BYTES: 10 });
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function encode(bytes) {
    let bits = 0,
        value = 0,
        result = "";
    for (const byte of bytes) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            bits -= 5;
            result += alphabet[(value >>> bits) & 31];
        }
    }
    if (bits) result += alphabet[(value << (5 - bits)) & 31];
    return result;
}
function normalize(input, parameters = {}) {
    let secret = input;
    let { algorithm = "SHA1", digits = 6, period = 30, type = "totp" } = parameters;
    if (typeof input !== "string") throw new Error("Invalid TOTP secret");
    if (input.startsWith("otpauth://")) {
        const url = new URL(input);
        type = url.hostname;
        secret = url.searchParams.get("secret");
        algorithm = url.searchParams.get("algorithm") || "SHA1";
        digits = Number(url.searchParams.get("digits") || 6);
        period = Number(url.searchParams.get("period") || 30);
    }
    if (
        type !== "totp" ||
        String(algorithm).toUpperCase().replaceAll("-", "") !== "SHA1" ||
        Number(digits) !== 6 ||
        Number(period) !== 30
    )
        throw new Error("Unsupported OTP parameters (requires SHA1 / 6 digits / 30 seconds / TOTP)");
    secret = String(secret || "")
        .replace(/\s/g, "")
        .replace(/=+$/, "")
        .toUpperCase();
    if (!/^[A-Z2-7]{16,256}$/.test(secret) || ![0, 2, 4, 5, 7].includes(secret.length % 8))
        throw new Error("Invalid Base32 TOTP secret");
    const normalized = { algorithm: "sha1", digits: 6, period: 30, secret };
    generateSync({ ...normalized, epoch: 0, guardrails });
    return normalized;
}
function code(parameters, now = Date.now()) {
    return generateSync({ ...parameters, epoch: Math.floor(now / 1000), guardrails });
}
module.exports = { code, encode, normalize };
