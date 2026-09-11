<script setup>
import { computed, onBeforeUnmount, onMounted, ref } from "vue";

const data = ref(null);
const error = ref(false);
const loading = ref(true);
let timer;
let controller;

const number = value => (value == null ? "—" : new Intl.NumberFormat("zh-CN").format(value));
const percent = value => (value == null ? "—" : `${value.toFixed(1)}%`);
const duration = value => {
    if (value == null) return "—";
    return value < 1000 ? `${number(value)} 毫秒` : `${(value / 1000).toFixed(value < 10000 ? 1 : 0)} 秒`;
};
const updatedAt = computed(() =>
    data.value?.generated_at
        ? new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "medium" }).format(
              new Date(data.value.generated_at)
          )
        : "—"
);

async function refresh() {
    if (controller) return;
    controller = new AbortController();
    try {
        const response = await fetch("/api/public/dashboard", {
            headers: { Accept: "application/json" },
            signal: controller.signal,
        });
        if (!response.ok) throw new Error("unavailable");
        data.value = await response.json();
        error.value = false;
    } catch (fetchError) {
        if (fetchError.name !== "AbortError") error.value = true;
    } finally {
        controller = null;
        loading.value = false;
    }
}

function schedule() {
    clearTimeout(timer);
    timer = setTimeout(
        async () => {
            await refresh();
            schedule();
        },
        document.hidden ? 30000 : 5000
    );
}
function onVisibilityChange() {
    if (!document.hidden) refresh();
    schedule();
}
onMounted(async () => {
    await refresh();
    schedule();
    document.addEventListener("visibilitychange", onVisibilityChange);
});
onBeforeUnmount(() => {
    clearTimeout(timer);
    controller?.abort();
    document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
    <main>
        <header>
            <div>
                <p class="eyebrow">PUBLIC STATUS</p>
                <h1>服务用量公示</h1>
                <p class="updated">数据更新时间：{{ updatedAt }}</p>
            </div>
            <span
                class="status"
                :class="{ warning: error || (data && (!data.history.enabled || data.realtime.limit === 0)) }"
            >
                {{
                    loading
                        ? "正在获取数据"
                        : error
                          ? data
                              ? "数据暂时中断，显示上次结果"
                              : "暂时无法获取数据"
                          : !data?.history.enabled || data?.realtime.limit === 0
                            ? "部分统计不可用"
                            : "数据正常"
                }}
            </span>
        </header>

        <aside class="notice">
            <strong>额度均为预估值</strong>
            <span
                >外部用量、Google
                配额调整、失败重试及统计延迟都可能造成偏差，以实际上游结果为准。“今日”按太平洋时间（PT）计算。</span
            >
        </aside>

        <section v-if="!data && !loading" class="empty">暂时无法获取数据，请稍后再试。</section>
        <template v-if="data">
            <section aria-labelledby="overview-title">
                <h2 id="overview-title">全局概览</h2>
                <div class="overview">
                    <article>
                        <span>正在执行</span
                        ><b>{{ number(data.realtime.active) }} / {{ number(data.realtime.limit) }}</b>
                    </article>
                    <article>
                        <span>历史请求</span><b>{{ number(data.history.total_requests) }}</b>
                    </article>
                    <article>
                        <span>成功率</span><b>{{ percent(data.history.success_rate) }}</b>
                    </article>
                    <article>
                        <span>失败请求</span><b>{{ number(data.history.failed_requests) }}</b>
                    </article>
                    <article>
                        <span>平均耗时</span><b>{{ duration(data.history.average_duration_ms) }}</b>
                    </article>
                </div>
                <p v-if="!data.history.enabled" class="muted">历史请求统计未启用。</p>
            </section>

            <section aria-labelledby="models-title">
                <h2 id="models-title">模型额度与实时状态</h2>
                <p v-if="data.realtime.limit === 0" class="muted">模型实时统计未启用。</p>
                <p v-else-if="!data.models.length" class="muted">当前没有公开展示的模型。</p>
                <div class="models">
                    <article v-for="model in data.models" :key="model.model" class="model-card">
                        <h3>{{ model.model }}</h3>
                        <div class="quota">
                            <span>预估剩余额度</span
                            ><b>{{
                                model.quota.estimable ? `${number(model.quota.estimated_remaining)} 次` : "暂无法估算"
                            }}</b
                            ><em>预估</em>
                        </div>
                        <dl>
                            <div>
                                <dt>今日请求</dt>
                                <dd>{{ number(model.today.requests) }}</dd>
                            </div>
                            <div>
                                <dt>可用账号</dt>
                                <dd>{{ number(model.realtime.available_accounts) }}</dd>
                            </div>
                            <div>
                                <dt>额度耗尽账号</dt>
                                <dd>{{ number(model.realtime.rate_limited_accounts) }}</dd>
                            </div>
                            <div>
                                <dt>排队请求</dt>
                                <dd>{{ number(model.realtime.queued) }}</dd>
                            </div>
                            <div>
                                <dt>正在执行</dt>
                                <dd>{{ number(model.realtime.active) }}</dd>
                            </div>
                        </dl>
                    </article>
                </div>
                <p v-if="data.models.length" class="helper">
                    今日请求是今天实际发往模型的请求次数，重试会重复计数。额度耗尽账号是当前因上游返回 429
                    而暂不可用的账号数，不代表永久失效。
                </p>
            </section>

            <section aria-labelledby="history-title">
                <h2 id="history-title">分模型历史统计</h2>
                <div class="table-wrap">
                    <table>
                        <thead>
                            <tr>
                                <th>模型</th>
                                <th>历史请求</th>
                                <th>成功率</th>
                                <th>失败请求</th>
                                <th>平均耗时</th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="model in data.models" :key="model.model">
                                <th>{{ model.model }}</th>
                                <td>{{ number(model.history.total_requests) }}</td>
                                <td>{{ percent(model.history.success_rate) }}</td>
                                <td>{{ number(model.history.failed_requests) }}</td>
                                <td>{{ duration(model.history.average_duration_ms) }}</td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </section>
        </template>
    </main>
</template>
