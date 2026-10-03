/* eslint-env browser */
// Compatibility rules informed by iBUHub/AIStudioToAPI saveAuth.js
// (Ellinav, iBenzene, bbbugg), CC BY-NC 4.0; see integration acceptance record.
const { performance } = require("node:perf_hooks");
const snapshotDialogs = require("./LoginDialogDiagnostics");
const failure = reason => Object.assign(new Error(reason), { reason });
const termsText =
    /terms of service|terms of use|Google APIs? terms|additional terms|服务条款|使用条款|服務條款|附加条款/i;
const optionalText = /newsletter|updates|marketing|offers|optional|订阅|訂閱|最新消息|電子郵件.*接收|接收.*邮件/i;
const acceptName = /^(I agree|I accept|Agree|Accept|同意|我同意|接受|Continue|继续|繼續)$/i;
class LoginPageHandlers {
    constructor({ page, interaction, guard, stepTimeout, deadline, phase }) {
        Object.assign(this, { deadline, guard, interaction, page, phase, stepTimeout });
    }
    async snapshot(locator) {
        this.operation = "terms_read";
        // One DOM snapshot: missing containers never enter Playwright's locator retry.
        return this.interaction.operation("text_read", () =>
            locator.evaluateAll(nodes => {
                const node = nodes.find(node => node.isConnected && node.getClientRects().length);
                return node ? node.innerText : null;
            })
        );
    }
    async terms(limit = this.deadline) {
        this.guard();
        if (new URL(this.page.url()).hostname !== "aistudio.google.com") return false;
        const end = Math.min(limit, this.deadline, performance.now() + this.stepTimeout);
        let handled = false;
        for (let attempt = 0; attempt <= 3; attempt++) {
            this.guard();
            let found, foundFrame;
            for (const frame of this.page.frames().slice(0, 10)) {
                this.guard();
                // Never follow third-party consent frames or unclassified about:blank frames.
                let host;
                try {
                    host = new URL(frame.url()).hostname;
                } catch {
                    continue;
                }
                if (host !== "aistudio.google.com") continue;
                const dialogs = frame
                    .locator(
                        '[role="dialog"], [aria-modal="true"], dialog, mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .mdc-dialog'
                    )
                    .filter({ visible: true });
                for (let index = 0; index < Math.min(await dialogs.count(), 5); index++) {
                    const dialog = dialogs.nth(index);
                    let text;
                    try {
                        text = await this.snapshot(dialog);
                    } catch (cause) {
                        this.guard();
                        if (frame.isDetached()) break;
                        throw cause;
                    }
                    if (text !== null && termsText.test(text) && /AI Studio|Gemini/i.test(text)) {
                        found = dialog;
                        foundFrame = frame;
                        break;
                    }
                }
                if (found) break;
            }
            if (!found) {
                if (handled) this.termsOutcome = "completed";
                this.phase("aistudio_ready_wait");
                return handled;
            }
            if (attempt === 3) throw failure("terms_or_consent_required");
            this.phase("aistudio_terms");
            this.termsOutcome = "identified";
            handled = true;
            try {
                const boxes = found.locator('input[type="checkbox"], [role="checkbox"]').filter({ visible: true });
                for (let index = 0; index < Math.min(await boxes.count(), 10); index++) {
                    this.guard();
                    const box = boxes.nth(index);
                    const info = await box.evaluate(node => ({
                        checked: node.checked === true || node.getAttribute("aria-checked") === "true",
                        label:
                            node.labels?.[0]?.innerText ||
                            document.getElementById(node.getAttribute("aria-labelledby"))?.innerText ||
                            node.closest("label, mat-checkbox, .mdc-form-field")?.innerText ||
                            node.getAttribute("aria-label") ||
                            "",
                        required: node.required || node.getAttribute("aria-required") === "true",
                    }));
                    if (optionalText.test(info.label)) continue;
                    if (
                        !info.checked &&
                        (info.required ||
                            (/agree|accept|同意|接受/i.test(info.label) && /terms|条款|條款/i.test(info.label)))
                    )
                        await this.interaction.click(box, { timeout: this.remaining(end) });
                }
                let button = found
                    .getByRole("button", { name: /^(I agree|I accept|Agree|Accept|同意|我同意|接受)$/i })
                    .first();
                if (!(await button.isVisible())) button = found.getByRole("button", { name: acceptName }).first();
                if (!(await button.isVisible())) {
                    // AI Studio can expose a longer aria-label than its visible
                    // confirmation caption. Use exact approved text only inside
                    // the already identified consent container.
                    const controls = found
                        .locator('button, [role="button"], input[type="button"], input[type="submit"]')
                        .filter({ visible: true });
                    const matches = [];
                    for (let index = 0; index < Math.min(await controls.count(), 30); index++) {
                        this.guard();
                        const control = controls.nth(index);
                        const caption = await control.evaluate(node =>
                            (node.textContent || node.value || "").replace(/\s+/g, " ").trim()
                        );
                        if (acceptName.test(caption))
                            matches.push({ control, explicit: !/^(Continue|继续|繼續)$/i.test(caption) });
                    }
                    button = matches.find(match => match.explicit)?.control || matches[0]?.control || button;
                }
                if (!(await button.isVisible())) {
                    if ((await this.snapshot(found)) === null) continue;
                    this.termsOutcome = "confirmation_missing";
                    throw failure("terms_or_consent_required");
                }
                const before = await this.snapshot(found);
                if (before === null) continue;
                this.operation = "terms_confirm";
                try {
                    await this.interaction.click(button, { timeout: this.remaining(end) });
                    this.termsOutcome = "clicked";
                } catch (cause) {
                    this.guard();
                    if (cause.name !== "TimeoutError" || (await this.snapshot(found)) === before) throw cause;
                    // Rescan and validate the current page; disappearance alone is not success.
                    continue;
                }
                let changed = false;
                const observeUntil = Math.min(end, performance.now() + 2000);
                while (performance.now() < observeUntil) {
                    this.guard();
                    if ((await this.snapshot(found)) !== before) {
                        changed = true;
                        break;
                    }
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
                if (!changed && attempt === 2) {
                    this.termsOutcome = "unchanged";
                    throw failure("terms_or_consent_required");
                }
            } catch (cause) {
                this.guard();
                if (foundFrame.isDetached()) continue;
                if (cause.name !== "TimeoutError" || (await this.snapshot(found)) !== null) throw cause;
                // A known consent container disappeared during control preparation.
                // The next scan and Studio validation still have to succeed.
            }
        }
        throw failure("terms_or_consent_required");
    }
    async transition(limit = this.deadline) {
        this.guard();
        if (new URL(this.page.url()).hostname !== "aistudio.google.com") return false;
        const end = Math.min(limit, this.deadline, performance.now() + this.stepTimeout);
        const dialogs = this.page.locator('[role="dialog"]').filter({ visible: true });
        this.transitionDiagnostics = { scanCount: null, scannedDialogs: [] };
        const countDialogs = async () => {
            const count = await dialogs.count();
            this.transitionDiagnostics.scanCount ??= count;
            return count;
        };
        for (let index = 0; index < Math.min(await countDialogs(), 5); index++) {
            this.guard();
            const dialog = dialogs.nth(index);
            this.operation = "terms_read";
            const observed = await this.interaction.operation("text_read", () =>
                dialog.evaluateAll(snapshotDialogs, true)
            );
            this.transitionDiagnostics.viewport ??= observed.viewport;
            const text = observed.dialogs[0]?.text ?? null;
            this.transitionDiagnostics.scannedDialogs.push(observed.dialogs[0]?.summary || { disappeared: true });
            // Observed informational spending-cap hint, never its settings action.
            if (
                !/New.*control API costs|新功能[：:].*控制 API 费用/i.test(text) ||
                !/Set a monthly spending cap|设置每月支出上限/i.test(text) ||
                !/Create spending cap|创建支出上限/i.test(text)
            )
                continue;
            const nonblocking = await dialog.evaluate(node => {
                const box = node.getBoundingClientRect();
                return (
                    node.getAttribute("aria-modal") !== "true" &&
                    box.width * box.height < (innerWidth * innerHeight) / 4
                );
            });
            this.transitionDiagnostics.scannedDialogs.at(-1).nonblockingResult = nonblocking;
            if (!nonblocking) continue;
            this.phase("aistudio_transition");
            const close = dialog.getByRole("button", { name: /^(Close|Dismiss|关闭|關閉)$/i }).first();
            this.transitionClicks ||= 0;
            if ((await close.isVisible()) && this.transitionClicks < 2) {
                this.transitionClicks++;
                await this.interaction.click(close, { timeout: this.remaining(end) });
                const observeUntil = Math.min(end, performance.now() + 1000);
                while ((await dialog.isVisible()) && performance.now() < observeUntil) {
                    this.guard();
                    await new Promise(resolve => setTimeout(resolve, 100));
                }
            }
            // The exact known, nonmodal hint can remain visible without blocking
            // service validation. Never select its optional spending-cap settings.
            return true;
        }
        return false;
    }
    async studioDialogDiagnostics() {
        // Failure was already decided. Bound best-effort collection so it cannot
        // replace that failure or consume a full UI operation timeout.
        const budget = Math.max(1, Math.min(500, this.deadline - performance.now()));
        let timer;
        let failureSnapshot;
        try {
            failureSnapshot = await Promise.race([
                this.page
                    .locator(
                        '[role="dialog"], [aria-modal="true"], dialog, mat-dialog-container, .mat-mdc-dialog-container, .cdk-overlay-pane, .mdc-dialog'
                    )
                    .evaluateAll(snapshotDialogs)
                    .then(snapshot => ({ status: "captured", ...snapshot })),
                new Promise(resolve => {
                    timer = setTimeout(() => resolve({ status: "capture_timeout" }), budget);
                }),
            ]);
        } catch {
            failureSnapshot = { status: "capture_failed" };
        } finally {
            clearTimeout(timer);
        }
        return { failureSnapshot, transitionScan: this.transitionDiagnostics };
    }
    remaining(end) {
        this.guard();
        const remaining = end - performance.now();
        if (remaining <= 0) throw failure("terms_or_consent_required");
        return Math.max(1, Math.floor(remaining));
    }
    async pin(input) {
        const handle = await input.elementHandle();
        if (!handle) throw failure("challenge_changed");
        // ElementHandle keeps the original node through redraws. Its per-character
        // typing API is named type(), while Locator exposes pressSequentially().
        return {
            boundingBox: options => handle.boundingBox(options),
            click: options => handle.click(options),
            evaluate: (...args) => handle.evaluate(...args),
            fill: (...args) => handle.fill(...args),
            locator: selector => input.locator(selector),
            press: (...args) => handle.press(...args),
            pressSequentially: (text, options) => handle.type(text, options),
        };
    }
    async totpInputs(selector) {
        this.guard();
        const inputs = (typeof selector === "string" ? this.page.locator(selector) : selector).filter({
            visible: true,
        });
        const editable = [];
        for (let index = 0; index < Math.min(await inputs.count(), 12); index++) {
            const input = inputs.nth(index);
            if ((await input.isEnabled()) && (await input.isEditable())) editable.push(input);
        }
        this.editableCount = editable.length;
        if (editable.length === 1) return Promise.all(editable.map(input => this.pin(input)));
        if (
            editable.length === 6 &&
            (await Promise.all(editable.map(input => input.getAttribute("maxlength")))).every(length => length === "1")
        )
            return Promise.all(editable.map(input => this.pin(input)));
        throw failure("manual_challenge");
    }
    async structure() {
        // No arbitrary attributes, body text, labels, URLs or values leave the DOM.
        return this.page.evaluate(() => {
            const types = new Set(["email", "password", "text", "tel", "number", "checkbox", "submit", "button"]);
            const names = new Set([
                "Next",
                "Continue",
                "Verify",
                "I agree",
                "Accept",
                "Try another way",
                "下一步",
                "继续",
                "验证",
                "同意",
                "接受",
            ]);
            return [...document.querySelectorAll('input, button, [role="checkbox"], iframe')]
                .slice(0, 100)
                .filter(node => node.getClientRects().length)
                .map(node => ({
                    type:
                        node.tagName === "INPUT"
                            ? types.has(node.type)
                                ? node.type
                                : "other"
                            : node.tagName === "IFRAME"
                              ? "iframe"
                              : node.getAttribute("role") === "checkbox"
                                ? "checkbox"
                                : "button",
                    ...(node.tagName === "BUTTON" && names.has(node.textContent.trim())
                        ? { label: node.textContent.trim() }
                        : {}),
                }));
        });
    }
}
module.exports = LoginPageHandlers;
