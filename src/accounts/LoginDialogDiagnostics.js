/* eslint-env browser */
// Runs in the page. Both business decisions and diagnostic samples return
// only enums, booleans, counts and dimensions; raw text never leaves the DOM.
function snapshotDialogs(nodes, mode) {
    const business = mode === "business";
    const visible = node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.height > 0 && getComputedStyle(node).visibility !== "hidden";
    };
    const candidates = nodes.filter(visible);
    const viewport = { height: innerHeight, width: innerWidth };
    const dialogs = candidates.slice(0, business ? 20 : 10).map(node => {
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
            // Business decisions treat any incomplete metadata as unsafe.
            summary = { status: "capture_failed" };
        }
        if (business) {
            // Containing another candidate is not evidence that its independent
            // authorization is safe. Keep ambiguous wrappers unclassified.
            const nested = candidates.some(other => other !== node && node.contains(other));
            const classification =
                summary.status === "capture_failed" || nested
                    ? "unknown"
                    : /terms of service|terms of use|Google APIs? terms|additional terms|服务条款|使用条款|服務條款|附加条款/i.test(
                            text
                        ) && /AI Studio|Gemini/i.test(text)
                      ? "terms"
                      : summary.nonblockingRule && Object.values(summary.textMatches).every(Boolean)
                        ? "known_hint"
                        : "unknown";
            return { ...summary, classification, index: nodes.indexOf(node) };
        }
        return summary;
    });
    if (business) {
        const unknownCount = dialogs.filter(dialog => dialog.classification === "unknown").length;
        const knownHintCount = dialogs.filter(dialog => dialog.classification === "known_hint").length;
        const termsCount = dialogs.filter(dialog => dialog.classification === "terms").length;
        const incomplete = candidates.length > 20 || dialogs.some(dialog => dialog.status === "capture_failed");
        return {
            dialogs,
            dialogState: incomplete
                ? "incomplete"
                : unknownCount
                  ? "unknown_present"
                  : termsCount
                    ? "terms_present"
                    : knownHintCount
                      ? "known_hint_only"
                      : "clear",
            knownHintCount,
            scanCount: candidates.length,
            termsCount,
            truncated: candidates.length > 20,
            unknownCount,
            viewport,
        };
    }
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
