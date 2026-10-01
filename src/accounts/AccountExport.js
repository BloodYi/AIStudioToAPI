const JSZip = require("jszip");

function credentialsCsv(accounts) {
    const quote = value => `"${String(value ?? "").replaceAll('"', '""')}"`;
    return (
        "\uFEFFemail,password,recovery_email,totp_secret\r\n" +
        accounts
            .map(account =>
                [account.email, account.password, account.recoveryEmail, account.totp?.secret].map(quote).join(",")
            )
            .join("\r\n") +
        "\r\n"
    );
}
function cookieState(state) {
    return {
        ...(state.accountName ? { accountName: state.accountName } : {}),
        cookies: state.cookies,
        origins: state.origins,
    };
}
async function accountBundle(accounts, readAuth) {
    const zip = new JSZip();
    zip.file("credentials.csv", credentialsCsv(accounts));
    for (const account of accounts) {
        if (account.authIndex === null) continue;
        const state = await readAuth(account.authIndex);
        if (!state) throw Object.assign(new Error("Authentication file unavailable"), { status: 409 });
        zip.file(`auth-${account.authIndex}.json`, JSON.stringify(cookieState(state), null, 2));
    }
    return zip.generateAsync({ compression: "STORE", type: "nodebuffer" });
}
module.exports = { accountBundle, cookieState, credentialsCsv };
