// This function is also evaluated inside Playwright pages.
/* eslint-env browser */
function pageErrors() {
    const bodyText = document.body.innerText || "";
    return {
        appletFailed: bodyText.includes("Failed to initialize applet"),
        concurrentUpdates: bodyText.includes("There are concurrent updates") || bodyText.includes("concurrent updates"),
        snapshotFailed: bodyText.includes("Failed to create snapshot") || bodyText.includes("Please try again"),
    };
}
module.exports = { pageErrors };
