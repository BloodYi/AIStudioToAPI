class PublicDashboardService {
    constructor(scheduler, usageStatsService, options = {}) {
        this.scheduler = scheduler;
        this.usageStatsService = usageStatsService;
        this.cacheTtlMs = options.cacheTtlMs ?? 1000;
        this.cachedAt = 0;
        this.cachedSnapshot = null;
    }

    getSnapshot() {
        const now = Date.now();
        if (this.cachedSnapshot && now - this.cachedAt < this.cacheTtlMs) return this.cachedSnapshot;

        const realtime = this.scheduler?.publicSummarySnapshot?.() || {
            active: 0,
            limit: 0,
            models: [],
            queued: 0,
            usageWindow: { date: null, timezone: "America/Los_Angeles" },
        };
        const visibleModels = realtime.models.map(item => item.model);
        const history = this.usageStatsService.getPublicSummarySnapshot(visibleModels);
        const historyByModel = new Map(history.models.map(item => [item.modelKey, item]));
        const count = value => (Number.isSafeInteger(value) && value >= 0 ? value : 0);
        const nullableCount = value => (value === null ? null : count(value));
        const rate = value => (Number.isFinite(value) && value >= 0 && value <= 100 ? Number(value.toFixed(1)) : null);

        this.cachedSnapshot = {
            disclaimer: "estimated_quota_may_differ_from_actual",
            generated_at: new Date(now).toISOString(),
            history: {
                average_duration_ms: nullableCount(history.summary.averageDurationMs),
                enabled: history.enabled,
                failed_requests: nullableCount(history.summary.failedRequests),
                success_rate: rate(history.summary.successRate),
                total_requests: nullableCount(history.summary.totalRequests),
            },
            models: realtime.models.map(item => {
                const modelHistory = historyByModel.get(item.model);
                const quotaIsEstimable = Number.isSafeInteger(item.estimatedRemaining) && item.estimatedRemaining >= 0;
                return {
                    history: {
                        average_duration_ms: nullableCount(modelHistory?.averageDurationMs ?? null),
                        failed_requests: nullableCount(modelHistory?.failedRequests ?? null),
                        success_rate: rate(modelHistory?.successRate),
                        total_requests: nullableCount(modelHistory?.totalRequests ?? null),
                    },
                    model: item.model,
                    quota: {
                        estimable: quotaIsEstimable,
                        estimated_remaining: quotaIsEstimable ? item.estimatedRemaining : null,
                    },
                    realtime: {
                        active: count(item.active),
                        available_accounts: count(item.availableAccounts),
                        queued: count(item.queued),
                        rate_limited_accounts: count(item.rateLimitedAccounts),
                    },
                    today: { requests: count(item.todayRequests) },
                };
            }),
            realtime: {
                active: count(realtime.active),
                limit: count(realtime.limit),
                queued: count(realtime.queued),
            },
            schema_version: 1,
            usage_window: { date: realtime.usageWindow.date, timezone: realtime.usageWindow.timezone },
        };
        this.cachedAt = now;
        return this.cachedSnapshot;
    }
}

module.exports = PublicDashboardService;
