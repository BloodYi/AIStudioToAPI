/* eslint-env browser */
// Runs in the page. Only enums, booleans and dimensions leave this snapshot;
// text is returned privately only when the transition handler already needs it.
function snapshotDialogs(nodes, includeText = false) {
    const visible = node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
    };
    const candidates = nodes.filter(includeText ? node => node.isConnected && node.getClientRects().length : visible);
    const viewport = { height: innerHeight, width: innerWidth };
    const dialogs = candidates.slice(0, 10).map(node => {
        const text = node.innerText || "";
        let summary;
        try {
            const box = node.getBoundingClientRect();
            const tag = node.tagName.toLowerCase();
            const role = node.getAttribute("role");
            const modal = node.getAttribute("aria-modal");
            const closeButtonCandidate = [...node.querySelectorAll('button, [role="button"]')].some(button => {
                const labelled = (button.getAttribute("aria-labelledby") || "")
                    .split(/\s+/)
                    .map(id => document.getElementById(id)?.textContent || "")
                    .join(" ")
                    .trim();
                const name = labelled || button.getAttribute("aria-label") || button.innerText || "";
                return visible(button) && /^(Close|Dismiss|关闭|關閉)$/i.test(name.trim());
            });
            summary = {
                areaRatio:
                    Math.round(((box.width * box.height) / Math.max(1, innerWidth * innerHeight)) * 10000) / 10000,
                ariaModal: modal === null ? "missing" : ["true", "false"].includes(modal) ? modal : "other",
                closeButtonCandidate,
                gateCandidate: node.matches('[role="dialog"], dialog, mat-dialog-container'),
                height: Math.round(box.height),
                nonblockingRule: modal !== "true" && box.width * box.height < (innerWidth * innerHeight) / 4,
                role:
                    role === null
                        ? "missing"
                        : ["dialog", "alertdialog", "tooltip", "menu", "presentation", "none"].includes(role)
                          ? role
                          : "other",
                tag: ["div", "dialog", "mat-dialog-container", "span", "section", "aside"].includes(tag)
                    ? tag
                    : "other",
                textMatches: {
                    cap: /Set a monthly spending cap|设置每月支出上限/i.test(text),
                    create: /Create spending cap|创建支出上限/i.test(text),
                    title: /New.*control API costs|新功能[：:].*控制 API 费用/i.test(text),
                },
                transitionCandidate: node.matches('[role="dialog"]'),
                width: Math.round(box.width),
            };
        } catch {
            // Metadata failures must not replace the transition's existing text
            // observation or change its classification.
            summary = { status: "capture_failed" };
        }
        return includeText ? { summary, text } : summary;
    });
    return {
        count: candidates.length,
        dialogs,
        gateCount: candidates.filter(node => node.matches('[role="dialog"], dialog, mat-dialog-container')).length,
        transitionCount: candidates.filter(node => node.matches('[role="dialog"]')).length,
        truncated: candidates.length > 10,
        viewport,
    };
}
module.exports = snapshotDialogs;
