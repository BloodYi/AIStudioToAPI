const assert = require('node:assert/strict');
const {createServer} = require('vite');
const {createSSRApp} = require('vue');
const {renderToString} = require('vue/server-renderer');

(async () => {
    const server = await createServer({server: {middlewareMode: true}});
    try {
        const {default: Component} = await server.ssrLoadModule('/components/SchedulerStatus.vue');
        const render = async (available, requests, benefit) => {
            const data = {
                active_workers: 0, idle_workers: 2, queued_requests: 0, argon_benefits: benefit,
                models: [
                    {model: 'gemini-3.8-flash', daily_requests: 3},
                    {model: 'gemini-4-argon', daily_requests: requests, available_accounts: available},
                    {model: 'gemma-4-31b-it', daily_requests: 3},
                ],
                quota_by_model: [{model:'gemini-3.8-flash', daily_requests:3, tracked_accounts:1, quota_per_account:100, estimated_remaining_quota:97}],
            };
            data.models = data.models.map(model => ({configured_workers: {min:0,preferred:1}, ...model}));
            const html = await renderToString(createSSRApp(Component, {data, t: key => key}));
            const starts = [...html.matchAll(/<div[^>]*class="quota-card(?: [^"]*)?"[^>]*>/g)].map(m => m.index);
            return starts.map((start, index) => html.slice(start, starts[index + 1] ?? html.indexOf('</section>')));
        };
        let cards = await render(1, 2);
        assert.equal(cards.length, 3);
        assert.match(cards[0], /gemini-4-argon/);
        assert.match(cards[0], /quota-number[^>]*>48</);
        assert.match(cards[0], /1 × 50/);
        assert.match(cards[1], /quota-number[^>]*>97</);
        assert.match(cards[1], /1 × 100/);
        assert.match(cards[2], /未知/);
        assert.match(cards[2], />Gemma</);
        assert.doesNotMatch(cards[2], /quota-card-alert|quota-progress-track/);
        cards = await render(2, 7);
        assert.match(cards[0], /quota-number[^>]*>93</);
        assert.match(cards[0], /2 × 50/);
        cards = await render(0, 2);
        assert.match(cards[0], /未知/);
        assert.doesNotMatch(cards[0], /quota-card-alert/);
        cards = await render(1, 5, {pro_accounts:2,pro_daily_limit:50,pro_estimated_remaining:95,ultra_accounts:0});
        assert.match(cards[0], /quota-number[^>]*>95</);
        assert.match(cards[0], /2 × 50/);
        cards = await render(1, 0, {pro_accounts:0,pro_daily_limit:50,pro_estimated_remaining:0,ultra_accounts:1});
        assert.match(cards[0], /1 个 Ultra/);
        assert.doesNotMatch(cards[0], /× 50|quota-progress-track|quota-card-alert/);
        cards = await render(1, 2, {pro_accounts:1,pro_daily_limit:50,pro_estimated_remaining:48,ultra_accounts:1});
        assert.match(cards[0], /≥48/);
        assert.match(cards[0], /Ultra 额度待确认/);
        assert.doesNotMatch(cards[0], /quota-progress-track|quota-card-alert/);
        console.log('PASS: Argon first; 50 per usable Pro account; daily requests deducted; existing Flash estimate preserved; unknown quota has no fake zero or warning.');
    } finally {
        await server.close();
    }
})().catch(error => {console.error(error);process.exitCode=1;});
