<template>
    <section v-if="data" class="status-card scheduler-status">
        <h3>{{ t("schedulerTitle") }}</h3>
        <p>
            {{ t("schedulerWorkers") }}: {{ data.active_workers }} / {{ data.active_workers + data.idle_workers }} ·
            {{ t("schedulerQueued") }}: {{ data.queued_requests }}
        </p>
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
                    #{{ account.index }} {{ account.key }} · {{ account.healthy ? "HEALTHY" : "UNHEALTHY" }}
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
