const test = require("node:test");
const assert = require("node:assert/strict");
const LoginInteraction = require("../src/accounts/LoginInteraction");
const { config } = require("../src/accounts/AccountConfig");
function setup(options = {}) {
    let clock = 0,
        cancelled = false,
        text = "old";
    const events = [];
    const locator = {
        boundingBox: async () => ({ height: 40, width: 200 }),
        click: async settings => events.push({ click: settings }),
        fill: async value => {
            events.push({ fill: value });
            text = value;
        },
        press: async key => {
            events.push({ key });
            if (key === "Backspace") text = "";
        },
        pressSequentially: async (character, settings) => {
            events.push({ character, ...settings });
            text += character;
            clock += settings.delay;
            if (options.cancelOnKey) cancelled = true;
        },
    };
    let randomIndex = 0;
    const interaction = new LoginInteraction({
        config: { humanize: options.humanize, stepTimeout: options.timeout || 30000 },
        guard: () => {
            if (cancelled) throw new Error("cancelled");
        },
        now: () => clock,
        random: () => [0, 0.25, 0.5, 0.75, 0.999][randomIndex++ % 5],
        sleep: async delay => {
            events.push({ pause: delay });
            clock += delay;
        },
    });
    return { events, interaction, locator, text: () => text };
}
test("paced input preserves spaces, punctuation and Unicode without bulk fill", async () => {
    const { interaction, locator, events, text } = setup();
    const value = ' p,$a"ss中😀 ';
    await interaction.type(locator, value);
    assert.equal(text(), value);
    assert.ok(!events.some(event => event.fill !== undefined));
    const keys = events.filter(event => event.character !== undefined);
    assert.equal(keys.length, [...value].length);
    assert.ok(keys.every(event => event.delay >= 45 && event.delay <= 125 && event.timeout > 0));
    assert.ok(new Set(keys.map(event => event.delay)).size > 1);
    const click = events.find(event => event.click).click;
    assert.ok(click.steps >= 4 && click.steps <= 10);
    assert.ok(click.delay >= 60 && click.delay <= 140);
    assert.ok(click.position.x >= 70 && click.position.x <= 130);
    assert.ok(click.position.y >= 14 && click.position.y <= 26);
});
test("code supplier runs only after focus and clearing; diagnostic fast mode is opt-in", async () => {
    const slow = setup();
    await slow.interaction.type(slow.locator, () => {
        assert.equal(slow.text(), "");
        assert.ok(slow.events.some(event => event.key === "Backspace"));
        return "123456";
    });
    assert.equal(slow.text(), "123456");
    const fast = setup({ humanize: false });
    await fast.interaction.type(fast.locator, "synthetic");
    assert.deepEqual(fast.events, [{ fill: "synthetic" }]);
});
test("cancellation and typing budget stop before further key events", async () => {
    const cancelled = setup({ cancelOnKey: true });
    await assert.rejects(cancelled.interaction.type(cancelled.locator, "123"), /cancelled/);
    assert.equal(cancelled.text(), "1");
    const bounded = setup({ timeout: 1 });
    await assert.rejects(
        bounded.interaction.type(bounded.locator, "123"),
        error => error.reason === "input_timeout" && error.retryable
    );
    assert.equal(bounded.text(), "1");
});
test("pacing is enabled by default and its environment switch is strict", () => {
    const previous = process.env.ACCOUNT_LOGIN_HUMANIZE;
    try {
        delete process.env.ACCOUNT_LOGIN_HUMANIZE;
        assert.equal(config().humanize, true);
        process.env.ACCOUNT_LOGIN_HUMANIZE = "false";
        assert.equal(config().humanize, false);
        process.env.ACCOUNT_LOGIN_HUMANIZE = "invalid";
        assert.throws(config, /Invalid ACCOUNT_LOGIN_HUMANIZE/);
    } finally {
        if (previous === undefined) delete process.env.ACCOUNT_LOGIN_HUMANIZE;
        else process.env.ACCOUNT_LOGIN_HUMANIZE = previous;
    }
});

test("click preparation timeouts carry safe sub-operation diagnostics", async () => {
    const { interaction, locator } = setup();
    locator.boundingBox = async () => {
        throw Object.assign(new Error("private page fragment"), { name: "TimeoutError" });
    };
    await assert.rejects(
        interaction.click(locator),
        error => error.reason === "ui_click_timeout" && error.operationPart === "bounding_box" && error.retryable
    );
    assert.equal(interaction.diagnostics.operationPart, "bounding_box");
    assert.ok(!JSON.stringify(interaction.diagnostics).includes("private"));
});
test("challenge checks stop typing between keys when the page changes", async () => {
    const { interaction, locator, text } = setup();
    await assert.rejects(
        interaction.type(locator, "123456", async () => {
            if (text() === "1") throw Object.assign(new Error("challenge_changed"), { reason: "challenge_changed" });
        }),
        error => error.reason === "challenge_changed"
    );
    assert.equal(text(), "1");
});
