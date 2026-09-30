const { performance } = require("node:perf_hooks");

// Ordinary browser input events with bounded pacing; no fingerprint changes or
// CAPTCHA handling. Dependencies can be replaced by a deterministic test clock.
class LoginInteraction {
    constructor({
        config,
        guard,
        sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
        random = Math.random,
        now = () => performance.now(),
    }) {
        this.config = config;
        this.guard = guard;
        this.sleep = sleep;
        this.random = random;
        this.now = now;
    }
    number(min, max) {
        return Math.floor(min + this.random() * (max - min + 1));
    }
    async pause(min = 250, max = 700) {
        this.guard();
        if (this.config.humanize !== false) await this.sleep(this.number(min, max));
        this.guard();
    }
    async click(locator, { timeout = this.config.stepTimeout } = {}) {
        await this.pause(180, 450);
        const options = { timeout: Math.min(timeout, this.config.stepTimeout) };
        if (this.config.humanize !== false) {
            const box = await locator.boundingBox({ timeout: options.timeout });
            this.guard();
            if (box && box.width > 0 && box.height > 0)
                options.position = {
                    x: (box.width * this.number(35, 65)) / 100,
                    y: (box.height * this.number(35, 65)) / 100,
                };
            options.delay = this.number(60, 140);
            options.steps = this.number(4, 10);
        }
        try {
            await locator.click(options);
        } catch (cause) {
            if (cause.name === "TimeoutError") {
                cause.reason = "ui_click_timeout";
                cause.retryable = true;
            }
            throw cause;
        }
        this.guard();
    }
    async type(locator, value) {
        if (this.config.humanize === false) {
            await locator.fill(typeof value === "function" ? await value() : value);
            this.guard();
            return;
        }
        await this.click(locator);
        await locator.press("ControlOrMeta+A");
        await locator.press("Backspace");
        await this.pause(100, 280);
        // Generate short-lived codes after focusing/clearing the field, not before.
        const text = typeof value === "function" ? await value() : value;
        const deadline = this.now() + this.config.stepTimeout;
        for (const character of text) {
            this.guard();
            const remaining = deadline - this.now();
            if (remaining <= 0)
                throw Object.assign(new Error("input_timeout"), { reason: "input_timeout", retryable: true });
            await locator.pressSequentially(character, {
                delay: this.number(45, 125),
                timeout: Math.max(1, Math.floor(remaining)),
            });
        }
        this.guard();
    }
}
module.exports = LoginInteraction;
