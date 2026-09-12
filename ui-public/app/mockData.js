export const mockPresets = {
    busy: {
        data: {
            disclaimer: "estimated_quota_may_differ_from_actual",
            generated_at: new Date().toISOString(),
            history: {
                average_duration_ms: 2850,
                enabled: true,
                failed_requests: 142,
                success_rate: 91.5,
                total_requests: 26800,
            },
            models: [
                {
                    history: {
                        average_duration_ms: 4500,
                        failed_requests: 88,
                        success_rate: 89.2,
                        total_requests: 8200,
                    },
                    model: "gemini-2.5-pro",
                    quota: {
                        estimable: true,
                        estimated_remaining: 0,
                    },
                    realtime: {
                        active: 8,
                        available_accounts: 0,
                        queued: 15,
                        rate_limited_accounts: 12,
                    },
                    today: { requests: 1250 },
                },
                {
                    history: {
                        average_duration_ms: 1100,
                        failed_requests: 54,
                        success_rate: 94.8,
                        total_requests: 18600,
                    },
                    model: "gemini-2.5-flash",
                    quota: {
                        estimable: true,
                        estimated_remaining: 320,
                    },
                    realtime: {
                        active: 4,
                        available_accounts: 3,
                        queued: 6,
                        rate_limited_accounts: 7,
                    },
                    today: { requests: 7420 },
                },
            ],
            realtime: {
                active: 12,
                limit: 12,
                queued: 21,
            },
            schema_version: 1,
            usage_window: {
                date: "2026-09-12",
                timezone: "America/Los_Angeles",
            },
        },
        label: "高负载告警（排队严重与额度耗尽429）",
    },
    disabledHistory: {
        data: {
            disclaimer: "estimated_quota_may_differ_from_actual",
            generated_at: new Date().toISOString(),
            history: {
                average_duration_ms: null,
                enabled: false,
                failed_requests: null,
                success_rate: null,
                total_requests: null,
            },
            models: [
                {
                    history: {
                        average_duration_ms: null,
                        failed_requests: null,
                        success_rate: null,
                        total_requests: null,
                    },
                    model: "gemini-2.5-flash",
                    quota: {
                        estimable: true,
                        estimated_remaining: 500,
                    },
                    realtime: {
                        active: 1,
                        available_accounts: 5,
                        queued: 0,
                        rate_limited_accounts: 0,
                    },
                    today: { requests: 42 },
                },
            ],
            realtime: {
                active: 1,
                limit: 5,
                queued: 0,
            },
            schema_version: 1,
            usage_window: {
                date: "2026-09-12",
                timezone: "America/Los_Angeles",
            },
        },
        label: "历史统计未开启状态",
    },
    standard: {
        data: {
            disclaimer: "estimated_quota_may_differ_from_actual",
            generated_at: new Date().toISOString(),
            history: {
                average_duration_ms: 1280,
                enabled: true,
                failed_requests: 18,
                success_rate: 98.7,
                total_requests: 14250,
            },
            models: [
                {
                    history: {
                        average_duration_ms: 2150,
                        failed_requests: 6,
                        success_rate: 98.2,
                        total_requests: 3410,
                    },
                    model: "gemini-2.5-pro",
                    quota: {
                        estimable: true,
                        estimated_remaining: 58,
                    },
                    realtime: {
                        active: 2,
                        available_accounts: 10,
                        queued: 1,
                        rate_limited_accounts: 2,
                    },
                    today: { requests: 480 },
                },
                {
                    history: {
                        average_duration_ms: 620,
                        failed_requests: 5,
                        success_rate: 99.6,
                        total_requests: 8960,
                    },
                    model: "gemini-2.5-flash",
                    quota: {
                        estimable: true,
                        estimated_remaining: 1820,
                    },
                    realtime: {
                        active: 4,
                        available_accounts: 18,
                        queued: 0,
                        rate_limited_accounts: 0,
                    },
                    today: { requests: 3120 },
                },
                {
                    history: {
                        average_duration_ms: 3450,
                        failed_requests: 7,
                        success_rate: 96.1,
                        total_requests: 1880,
                    },
                    model: "gemini-2.0-flash-thinking-exp",
                    quota: {
                        estimable: false,
                        estimated_remaining: null,
                    },
                    realtime: {
                        active: 2,
                        available_accounts: 6,
                        queued: 3,
                        rate_limited_accounts: 4,
                    },
                    today: { requests: 290 },
                },
            ],
            realtime: {
                active: 8,
                limit: 12,
                queued: 4,
            },
            schema_version: 1,
            usage_window: {
                date: "2026-09-12",
                timezone: "America/Los_Angeles",
            },
        },
        label: "标准运行（多模型与各状态均衡）",
    },
};
