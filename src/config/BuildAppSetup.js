const BUILD_APP_GUIDE = "https://github.com/BloodYi/AIStudioToAPI/blob/main/docs/BUILD-APP.md";

function requireBuildAppUrl(env = process.env) {
    const value = (env.AI_STUDIO_APP_URL || "").trim();
    let url;
    try {
        url = new URL(value);
    } catch {
        // Report setup instructions instead of attempting browser initialization.
    }
    if (
        !url ||
        url.protocol !== "https:" ||
        !["aistudio.google.com", "ai.studio"].includes(url.hostname) ||
        url.username ||
        url.password ||
        url.port ||
        !/^\/apps\/(?:drive\/)?[A-Za-z0-9_-]+\/?$/.test(url.pathname) ||
        /YOUR_|REPLACE|APP_ID_HERE/i.test(url.pathname)
    ) {
        throw new Error(
            "Build App setup required. First create your own Google AI Studio Build App, install this repository's bridge client, " +
                "and share it with your account pool. Set AI_STUDIO_APP_URL in .env and restart. " +
                `No shared app is provided. Guide: ${BUILD_APP_GUIDE}`
        );
    }
    return url.href;
}

module.exports = { BUILD_APP_GUIDE, requireBuildAppUrl };
