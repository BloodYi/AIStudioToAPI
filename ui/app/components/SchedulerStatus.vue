<template>
    <section v-if="data" class="status-card scheduler-status">
        <h3>{{ t("schedulerTitle") }}</h3>
        <p>
            {{ t("schedulerWorkers") }}: {{ data.active_workers }} / {{ data.active_workers + data.idle_workers }} ·
            {{ t("schedulerQueued") }}: {{ data.queued_requests }}
        </p>
        <p>
            {{ t("schedulerReadyContexts") }}: {{ data.ready_browser_workers }} · {{ t("schedulerBusyContexts") }}:
            {{ data.busy_browser_workers }} · {{ t("schedulerIdleContexts") }}: {{ data.idle_browser_workers }} ·
            {{ t("schedulerInitializingContexts") }}: {{ data.initializing_browser_workers }} ·
            {{ t("schedulerReconnectingContexts") }}: {{ data.reconnecting_browser_workers }} ·
            {{ t("schedulerUnavailableContexts") }}: {{ data.unavailable_browser_workers }} /
            {{ data.max_browser_workers }}
        </p>
        <div class="scheduler-table">
            <table>
                <thead>
                    <tr>
                        <th>Context</th>
                        <th>{{ t("schedulerStatus") }}</th>
                        <th>{{ t("schedulerInflight") }}</th>
                        <th>WS Epoch</th>
                        <th>{{ t("schedulerLastDisconnect") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="context in data.contexts" :key="context.auth_index">
                        <td>#{{ context.auth_index }}</td>
                        <td>{{ context.state }}</td>
                        <td>{{ context.inflight }}</td>
                        <td>{{ context.connection_epoch || "—" }}</td>
                        <td>{{ context.last_disconnect_reason || "—" }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <p v-if="data.metrics">
            {{ t("schedulerLocalTransport") }}: {{ data.metrics.local_transport }} ·
            {{ t("schedulerDispatchTimeout") }}: {{ data.metrics.dispatch_timeout }} ·
            {{ t("schedulerUpstreamErrors") }}: {{ data.metrics.upstream_error }}
        </p>
        <div v-if="data.metrics" class="scheduler-table">
            <table>
                <thead>
                    <tr>
                        <th>{{ t("schedulerTiming") }}</th>
                        <th>p50</th>
                        <th>p95</th>
                        <th>p99</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="(timing, name) in data.metrics.timings" :key="name">
                        <td>{{ name }}</td>
                        <td>{{ timing.p50 ?? "—" }} ms</td>
                        <td>{{ timing.p95 ?? "—" }} ms</td>
                        <td>{{ timing.p99 ?? "—" }} ms</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <button :disabled="busy" @click="resetAllRateLimits">
            {{ t("schedulerResetAll429") }}
        </button>
        <p v-if="rateLimitsReset" role="status">{{ t("schedulerResetAll429Success") }}</p>
        <div class="scheduler-table">
            <table>
                <thead>
                    <tr>
                        <th>{{ t("schedulerModel") }}</th>
                        <th>{{ t("schedulerRequests") }}</th>
                        <th>{{ t("schedulerSuccess") }}</th>
                        <th>{{ t("schedulerErrors") }}</th>
                        <th>{{ t("schedulerAvailable") }}</th>
                        <th>429</th>
                        <th>{{ t("schedulerQueued") }}</th>
                        <th>{{ t("schedulerWorkers") }}</th>
                        <th>Min / Preferred</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-for="model in data.models" :key="model.model">
                        <td>{{ model.model }}</td>
                        <td>{{ model.requests }}</td>
                        <td>{{ model.success }}</td>
                        <td>{{ model.failures }}</td>
                        <td>{{ model.available_accounts }}</td>
                        <td>{{ model.rate_limited_accounts }}</td>
                        <td>{{ model.queue_length }}</td>
                        <td>{{ model.active_workers }}</td>
                        <td>{{ model.configured_workers.min }} / {{ model.configured_workers.preferred }}</td>
                    </tr>
                </tbody>
            </table>
        </div>
        <details>
            <summary>{{ t("schedulerAccounts") }}</summary>
            <div v-for="account in data.accounts" :key="account.key">
                <p>
                    #{{ account.index }} {{ account.key }} · {{ account.healthy ? "HEALTHY" : "UNHEALTHY" }} ·
                    {{ t("schedulerInflight") }}: {{ account.inflight }}
                    <button :disabled="busy || account.inflight > 0" @click="reset(account.index)">
                        {{ t("schedulerResetAccount") }}
                    </button>
                </p>
                <div class="scheduler-table">
                    <table>
                        <thead>
                            <tr>
                                <th>{{ t("schedulerModel") }}</th>
                                <th>{{ t("schedulerStatus") }}</th>
                                <th>{{ t("schedulerInflight") }}</th>
                                <th>{{ t("schedulerRequests") }}</th>
                                <th>{{ t("schedulerErrors") }}</th>
                                <th>{{ t("schedulerCooldown") }}</th>
                                <th>{{ t("schedulerLastError") }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="(slot, model) in account.models" :key="model">
                                <td>{{ model }}</td>
                                <td>{{ slot.status }}</td>
                                <td>{{ slot.inflight }}</td>
                                <td>{{ slot.request_count }}</td>
                                <td>{{ slot.failure_count }}</td>
                                <td>
                                    {{ slot.cooldown_until ? new Date(slot.cooldown_until).toLocaleString() : "—" }}
                                </td>
                                <td>{{ slot.last_error || "—" }}</td>
                                <td>
                                    <button
                                        :disabled="busy || account.inflight > 0"
                                        @click="reset(account.index, model)"
                                    >
                                        {{ t("schedulerReset") }}
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </div>
        </details>
        <p v-if="error" role="alert">{{ error }}</p>
    </section>
</template>
<script setup>
import { ref } from "vue";
defineProps({ data: { default: null, type: Object }, t: { required: true, type: Function } });
const emit = defineEmits(["refresh"]);
const busy = ref(false);
const error = ref("");
const rateLimitsReset = ref(false);
async function resetAllRateLimits() {
    rateLimitsReset.value = await sendReset("/api/scheduler/reset-rate-limits", {});
}
async function reset(accountId, model) {
    await sendReset("/api/scheduler/reset", { account_id: accountId, model });
}
async function sendReset(url, body) {
    rateLimitsReset.value = false;
    busy.value = true;
    error.value = "";
    try {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        if (!response.ok) throw new Error((await response.json()).error);
        emit("refresh");
        return true;
    } catch (failure) {
        error.value = failure.message;
        return false;
    } finally {
        busy.value = false;
    }
}
</script>
<style scoped>
.scheduler-status {
    margin-bottom: 20px;
}
.scheduler-table {
    overflow-x: auto;
}
table {
    width: 100%;
    border-collapse: collapse;
}
th,
td {
    padding: 8px;
    text-align: left;
    overflow-wrap: anywhere;
}
summary {
    cursor: pointer;
}
</style>
