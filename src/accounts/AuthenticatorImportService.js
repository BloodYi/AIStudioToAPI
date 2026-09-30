const protobuf = require("protobufjs");
const { parse } = require("csv-parse/sync");
const Totp = require("./TotpService");
const emailKey = value =>
    typeof value === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) ? value.trim().toLowerCase() : null;
// Interoperable migration schema: https://github.com/qistoph/otp_export/blob/master/OtpMigration.proto
const Payload = protobuf
    .parse(
        `syntax="proto3";
message Entry { bytes secret=1; string name=2; string issuer=3; int32 algorithm=4; int32 digits=5; int32 type=6; int64 counter=7; }
message Payload { repeated Entry entries=1; int32 version=2; int32 batchSize=3; int32 batchIndex=4; int32 batchId=5; }`
    )
    .root.lookupType("Payload");
function emailFromName(name) {
    const matches = String(name).match(/[^\s:@/]+@[^\s:@/]+\.[^\s:@/]+/g) || [];
    return matches.length === 1 ? emailKey(matches[0]) : null;
}
function parseImport(kind, content) {
    if (typeof content !== "string" || Buffer.byteLength(content) > 1048576) throw new Error("Import exceeds 1 MiB");
    let rows = [];
    const batches = new Map();
    if (kind === "csv") {
        rows = parse(content, { bom: true, columns: true, max_record_size: 1048576, skip_empty_lines: true }).map(
            row => {
                try {
                    if (!emailKey(row.email) || !row.password) throw new Error("Invalid email or empty password");
                    return {
                        email: emailKey(row.email),
                        password: row.password,
                        ...(row.totpSecret ? { totp: Totp.normalize(row.totpSecret) } : {}),
                    };
                } catch {
                    return { email: emailKey(row.email), error: "Invalid email, empty password or unsupported OTP" };
                }
            }
        );
    } else if (kind === "authenticator") {
        for (const line of content.split(/\r?\n/).filter(line => line.trim())) {
            try {
                const input = line.trim();
                if (input.startsWith("otpauth-migration:")) {
                    const url = new URL(input);
                    if (url.protocol !== "otpauth-migration:" || url.hostname !== "offline") throw new Error();
                    const raw = url.search
                        .slice(1)
                        .split("&")
                        .filter(part => part.startsWith("data="));
                    if (raw.length !== 1) throw new Error();
                    const data = decodeURIComponent(raw[0].slice(5));
                    if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(data) || data.length % 4 === 1) throw new Error();
                    const payload = Payload.decode(Buffer.from(data, "base64"));
                    if (
                        payload.version !== 1 ||
                        payload.batchSize < 1 ||
                        payload.batchSize > 1000 ||
                        payload.batchIndex < 0 ||
                        payload.batchIndex >= payload.batchSize
                    )
                        throw new Error();
                    const key = String(payload.batchId);
                    const batch = batches.get(key) || { indices: new Map(), size: payload.batchSize };
                    if (batch.size !== payload.batchSize) throw new Error();
                    if (batch.indices.has(payload.batchIndex)) {
                        if (batch.indices.get(payload.batchIndex) !== data) throw new Error();
                        continue;
                    }
                    batch.indices.set(payload.batchIndex, data);
                    batches.set(key, batch);
                    for (const entry of payload.entries) {
                        try {
                            if (entry.algorithm !== 1 || entry.digits !== 1 || entry.type !== 2) throw new Error();
                            rows.push({
                                email: emailFromName(entry.name),
                                name: entry.name,
                                totp: Totp.normalize(Totp.encode(entry.secret)),
                            });
                        } catch {
                            rows.push({ email: emailFromName(entry.name), error: "Unsupported or invalid OTP entry" });
                        }
                    }
                } else {
                    const name = input.startsWith("otpauth:")
                        ? decodeURIComponent(new URL(input).pathname.slice(1))
                        : "";
                    rows.push({ email: emailFromName(name), name, totp: Totp.normalize(input) });
                }
            } catch {
                rows.push({ error: "Damaged migration link or invalid OTP" });
            }
        }
    } else throw new Error("Unknown import kind");
    if (rows.length > 1000) throw new Error("Import exceeds 1000 entries");
    const seen = new Set();
    for (const row of rows)
        if (row.email) {
            if (seen.has(row.email)) row.error = "Duplicate email in import";
            seen.add(row.email);
        }
    return {
        batches: [...batches].map(([id, batch]) => ({ id, received: [...batch.indices.keys()], size: batch.size })),
        complete: [...batches.values()].every(batch => batch.indices.size === batch.size),
        rows,
    };
}
module.exports = { emailKey, parseImport, Payload };
