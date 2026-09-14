<template>
    <section v-if="data" class="status-card scheduler-status">
        <h3>{{ t("schedulerTitle") }}</h3>
        <p>
            {{ t("schedulerWorkers") }}: {{ data.active_workers }} / {{ data.active_workers + data.idle_workers }} ·
            {{ t("schedulerQueued") }}: {{ data.queued_requests }}
        </p>
        <div class="quota-section" :title="t('schedulerEstimatedQuotaTooltip')">
            <strong>{{ t("schedulerEstimatedQuota") }}（{{ data.usage_window?.date }} PT）</strong>
            <p>{{ t("schedulerEstimatedQuotaHint") }}</p>
            <p v-if="!data.quota_by_model?.length" class="scheduler-empty">
                {{ t("schedulerNoVisibleQuota") }}
            </p>
            <div class="quota-grid">
                <div v-for="quota in data.quota_by_model" :key="quota.model" class="quota-card">
                    <strong>{{ quota.model }}</strong>
                    <span>{{ formatNumber(quota.estimated_remaining_quota) }} {{ t("schedulerQuotaUnit") }}</span>
                    <small
                        >{{ quota.tracked_accounts }} × {{ quota.quota_per_account }} ·
                        {{ t("schedulerTodayRequests") }} {{ formatNumber(quota.daily_requests) }}</small
                    >
                </div>
            </div>
        </div>
        <div class="scheduler-actions">
            <button :disabled="busy" @click="resetAllRateLimits">{{ t("schedulerResetAll429") }}</button>
            <button :disabled="busy" @click="resetAllAccounts">{{ t("schedulerResetAllAccounts") }}</button>
            <details class="hidden-models" :open="hiddenModelsOpen" @toggle="toggleHiddenModels">
                <summary :aria-expanded="hiddenModelsOpen">
                    {{ t("schedulerHiddenModels", { count: hiddenModels.length }) }}
                </summary>
                <p v-if="hiddenModelsLoading">{{ t("schedulerHiddenModelsLoading") }}</p>
                <p v-else-if="!hiddenModels.length" class="scheduler-empty">{{ t("schedulerNoHiddenModels") }}</p>
                <ul v-else>
                    <li v-for="model in hiddenModels" :key="model">
                        <span>{{ model }}</span>
                        <button :disabled="busy || operatingModel === model" @click="setModelVisibility(model, false)">
                            {{ t("schedulerShowModel") }}
                        </button>
                    </li>
                </ul>
            </details>
        </div>
        <p v-if="rateLimitsReset" role="status">{{ t("schedulerResetAll429Success") }}</p>
        <p v-if="allAccountsResetMessage" role="status">{{ allAccountsResetMessage }}</p>
        <p v-if="accountActionMessage" role="status">{{ accountActionMessage }}</p>
        <p v-if="modelVisibilityMessage" role="status">{{ modelVisibilityMessage }}</p>
        <details :open="contextsOpen" @toggle="toggleContexts">
            <summary :aria-expanded="contextsOpen">
                Context {{ t("schedulerStatus") }} · READY {{ contextSummary.ready || 0 }} · BUSY
                {{ contextSummary.busy || 0 }} · INITIALIZING {{ contextSummary.initializing || 0 }} · RECONNECTING
                {{ contextSummary.reconnecting || 0 }} · UNAVAILABLE {{ contextSummary.unavailable || 0 }} /
                {{ contextSummary.max || 0 }}
            </summary>
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
                        <tr v-for="context in contexts" :key="context.auth_index">
                            <td>#{{ context.auth_index }}</td>
                            <td>{{ context.state }}</td>
                            <td>{{ context.inflight }}</td>
                            <td>{{ context.connection_epoch || "—" }}</td>
                            <td>{{ context.last_disconnect_reason || "—" }}</td>
                        </tr>
                    </tbody>
                </table>
            </div>
        </details>
        <p v-if="data.metrics">
            {{ t("schedulerLocalTransport") }}: {{ data.metrics.local_transport }} ·
            {{ t("schedulerDispatchTimeout") }}: {{ data.metrics.dispatch_timeout }} ·
            {{ t("schedulerUpstreamErrors") }}: {{ data.metrics.upstream_error }}
        </p>
        <div class="scheduler-table">
            <table>
                <thead>
                    <tr>
                        <th>{{ t("schedulerModel") }}</th>
                        <th>{{ t("schedulerTodayRequests") }}</th>
                        <th>{{ t("schedulerAvailable") }}</th>
                        <th>429</th>
                        <th>{{ t("schedulerQueued") }}</th>
                        <th>{{ t("schedulerWorkers") }}</th>
                        <th>Min / Preferred</th>
                        <th>{{ t("schedulerActions") }}</th>
                    </tr>
                </thead>
                <tbody>
                    <tr v-if="!data.models?.length">
                        <td colspan="8" class="scheduler-empty">{{ t("schedulerNoVisibleModels") }}</td>
                    </tr>
                    <tr v-for="model in data.models" :key="model.model">
                        <td>{{ model.model }}</td>
                        <td>{{ model.daily_requests }}</td>
                        <td>{{ model.available_accounts }}</td>
                        <td>{{ model.rate_limited_accounts }}</td>
                        <td>{{ model.queue_length }}</td>
                        <td>{{ model.active_workers }}</td>
                        <td>{{ model.configured_workers.min }} / {{ model.configured_workers.preferred }}</td>
                        <td>
                            <button :disabled="busy || operatingModel === model.model" @click="hideModel(model.model)">
                                {{ t("schedulerHideModel") }}
                            </button>
                        </td>
                    </tr>
                </tbody>
            </table>
        </div>
        <details :open="accountsOpen" @toggle="toggleAccounts">
            <summary :aria-expanded="accountsOpen">{{ t("schedulerAccounts") }}</summary>
            <details
                v-for="account in accounts"
                :key="account.index"
                @toggle="event => toggleAccount(event, account.index)"
            >
                <summary :aria-expanded="expandedAccounts.has(account.index)">
                    #{{ account.index }} {{ account.key }} ·
                    {{ account.disabled ? "DISABLED" : account.healthy ? "HEALTHY" : "UNHEALTHY" }} ·
                    {{ t("schedulerInflight") }}: {{ account.inflight }}
                    <button :disabled="busy || account.inflight > 0" @click.prevent="reset(account.index)">
                        {{ t("schedulerResetAccount") }}
                    </button>
                    <button :disabled="busy || account.disabled" @click.prevent="disableAccount(account.index)">
                        {{ t("schedulerDisableAccount") }}
                    </button>
                </summary>
                <div class="scheduler-table">
                    <table>
                        <thead>
                            <tr>
                                <th>{{ t("schedulerModel") }}</th>
                                <th>{{ t("schedulerStatus") }}</th>
                                <th>{{ t("schedulerInflight") }}</th>
                                <th>{{ t("schedulerTodayRequests") }}</th>
                                <th>{{ t("schedulerTodayFailures") }}</th>
                                <th>{{ t("schedulerCooldown") }}</th>
                                <th>{{ t("schedulerLastError") }}</th>
                                <th></th>
                            </tr>
                        </thead>
                        <tbody>
                            <tr v-for="slot in account.models || []" :key="slot.model">
                                <td>{{ slot.model }}</td>
                                <td>{{ slot.status }}</td>
                                <td>{{ slot.inflight }}</td>
                                <td>{{ slot.daily_requests }}</td>
                                <td>{{ slot.daily_failures }}</td>
                                <td>
                                    {{ slot.cooldown_until ? new Date(slot.cooldown_until).toLocaleString() : "—" }}
                                </td>
                                <td>{{ slot.last_error || "—" }}</td>
                                <td>
                                    <button
                                        :disabled="busy || account.inflight > 0"
                                        @click="reset(account.index, slot.model)"
                                    >
                                        {{ t("schedulerReset") }}
                                    </button>
                                </td>
                            </tr>
                        </tbody>
                    </table>
                </div>
            </details>
        </details>
        <p v-if="error" role="alert">{{ error }}</p>
    </section>
</template>
<script setup>
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
const props = defineProps({ data: { default: null, type: Object }, t: { required: true, type: Function } });
const emit = defineEmits(["refresh"]);
const busy = ref(false),
    error = ref(""),
    rateLimitsReset = ref(false),
    allAccountsResetMessage = ref(""),
    modelVisibilityMessage = ref(""),
    operatingModel = ref("");
const accountActionMessage = ref("");
const contextsOpen = ref(false),
    accountsOpen = ref(false),
    hiddenModelsOpen = ref(false),
    contexts = ref([]),
    accounts = ref([]),
    expandedAccounts = ref(new Set()),
    hiddenModels = ref([]),
    hiddenModelsLoading = ref(false);
const contextSummary = computed(() => props.data?.contexts_summary || {});
let contextsController = null;
let accountsController = null;
let hiddenModelsController = null;
const formatNumber = value => Number(value || 0).toLocaleString();
async function getJson(url, signal) {
    const response = await fetch(url, { signal });
    if (response.status === 304) return null;
    if (response.redirected || response.status === 401) {
        window.location.href = response.redirected ? response.url : "/login";
        return null;
    }
    const result = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(result.error || `${response.status} ${response.statusText}`);
    return result;
}
async function fetchContexts(force = false) {
    if (!contextsOpen.value) return;
    if (contextsController) {
        if (!force) return;
        contextsController.abort();
    }
    const controller = new AbortController();
    contextsController = controller;
    try {
        const result = await getJson("/api/scheduler/contexts", controller.signal);
        if (result && contextsOpen.value) contexts.value = result.contexts || [];
    } finally {
        if (contextsController === controller) contextsController = null;
    }
}
async function fetchAccounts(force = false) {
    if (!accountsOpen.value) return;
    if (accountsController) {
        if (!force) return;
        accountsController.abort();
    }
    const controller = new AbortController();
    accountsController = controller;
    const ids = [...expandedAccounts.value];
    try {
        const result = await getJson(
            `/api/scheduler/accounts${ids.length ? `?ids=${ids.join(",")}` : ""}`,
            controller.signal
        );
        if (!result || !accountsOpen.value) return;
        if (!ids.length) accounts.value = result.accounts || [];
        else {
            const details = new Map((result.accounts || []).map(account => [account.index, account]));
            accounts.value = accounts.value.map(account => details.get(account.index) || account);
        }
    } finally {
        if (accountsController === controller) accountsController = null;
    }
}
async function fetchHiddenModels(force = false) {
    if (hiddenModelsController) {
        if (!force) return;
        hiddenModelsController.abort();
    }
    const controller = new AbortController();
    hiddenModelsController = controller;
    hiddenModelsLoading.value = true;
    try {
        const result = await getJson("/api/scheduler/models/hidden", controller.signal);
        if (result) hiddenModels.value = result.models || [];
    } finally {
        if (hiddenModelsController === controller) {
            hiddenModelsController = null;
            hiddenModelsLoading.value = false;
        }
    }
}
function toggleHiddenModels(event) {
    hiddenModelsOpen.value = event.currentTarget.open;
    if (hiddenModelsOpen.value) fetchHiddenModels(true).catch(setError);
}
function toggleContexts(event) {
    contextsOpen.value = event.currentTarget.open;
    if (contextsOpen.value) fetchContexts(true).catch(setError);
    else {
        contextsController?.abort();
        contexts.value = [];
    }
}
function toggleAccounts(event) {
    if (event.target !== event.currentTarget) return;
    accountsOpen.value = event.currentTarget.open;
    if (accountsOpen.value) fetchAccounts(true).catch(setError);
    else {
        accountsController?.abort();
        accounts.value = [];
        expandedAccounts.value = new Set();
    }
}
function toggleAccount(event, index) {
    const next = new Set(expandedAccounts.value);
    if (event.currentTarget.open) {
        if (next.size >= 20) {
            event.currentTarget.open = false;
            error.value = props.t("schedulerAccountExpandLimit");
            return;
        }
        next.add(index);
    } else next.delete(index);
    expandedAccounts.value = next;
    if (event.currentTarget.open)
        fetchAccounts(true).catch(failure => {
            if (failure.name !== "AbortError") setError(failure);
        });
}
function setError(failure) {
    if (failure.name === "AbortError") return;
    error.value = failure.message;
}
watch(
    () => props.data,
    () => {
        if (contextsOpen.value) fetchContexts().catch(setError);
        if (accountsOpen.value) fetchAccounts().catch(setError);
    }
);
onBeforeUnmount(() => {
    contextsController?.abort();
    accountsController?.abort();
    hiddenModelsController?.abort();
});
onMounted(() => fetchHiddenModels().catch(setError));
async function resetAllRateLimits() {
    rateLimitsReset.value = Boolean(await sendReset("/api/scheduler/reset-rate-limits", {}));
}
async function resetAllAccounts() {
    if (!window.confirm(props.t("schedulerResetAllAccountsConfirm"))) return;
    const result = await sendReset("/api/scheduler/reset-all", {});
    if (!result) return;
    allAccountsResetMessage.value =
        result.reset_account_count || result.reset_model_count
            ? props.t("schedulerResetAllAccountsSuccess", {
                  accounts: result.reset_account_count,
                  models: result.reset_model_count,
              })
            : props.t("schedulerResetAllAccountsNoChanges");
}
async function reset(accountId, model) {
    await sendReset("/api/scheduler/reset", { account_id: accountId, model });
}
async function disableAccount(accountId) {
    if (!window.confirm(props.t("schedulerDisableAccountConfirm"))) return;
    const result = await sendReset("/api/scheduler/disable", { account_id: accountId });
    if (!result) return;
    accountActionMessage.value = props.t(
        result.changed ? "schedulerDisableAccountSuccess" : "schedulerDisableAccountNoChanges"
    );
    await fetchAccounts(true);
}
async function hideModel(model) {
    if (!window.confirm(props.t("schedulerHideModelConfirm", { model }))) return;
    await setModelVisibility(model, true);
}
async function setModelVisibility(model, hidden) {
    rateLimitsReset.value = false;
    allAccountsResetMessage.value = "";
    modelVisibilityMessage.value = "";
    operatingModel.value = model;
    error.value = "";
    try {
        const response = await fetch(`/api/scheduler/models/${hidden ? "hide" : "show"}`, {
            body: JSON.stringify({ model }),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(result.error || result.message || `${response.status} ${response.statusText}`);
        modelVisibilityMessage.value = props.t(hidden ? "schedulerHideModelSuccess" : "schedulerShowModelSuccess", {
            model: result.model,
        });
        await Promise.all([fetchHiddenModels(true), accountsOpen.value ? fetchAccounts(true) : Promise.resolve()]);
        emit("refresh");
        return result;
    } catch (failure) {
        setError(failure);
        return false;
    } finally {
        operatingModel.value = "";
    }
}
async function sendReset(url, body) {
    rateLimitsReset.value = false;
    allAccountsResetMessage.value = "";
    busy.value = true;
    error.value = "";
    try {
        const response = await fetch(url, {
            body: JSON.stringify(body),
            headers: { "Content-Type": "application/json" },
            method: "POST",
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok)
            throw new Error(result.error || result.message || `${response.status} ${response.statusText}`);
        emit("refresh");
        return result;
    } catch (failure) {
        setError(failure);
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
.quota-section {
    padding: 14px 16px;
    margin: 14px 0;
    border: 1px solid var(--border-light);
    border-radius: 8px;
    background: rgba(var(--color-primary-rgb), 0.08);
}
.quota-section > p {
    margin: 4px 0 12px;
    color: var(--text-secondary);
}
.quota-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 10px;
}
.quota-card {
    display: grid;
    gap: 4px;
    padding: 10px;
    border: 1px solid var(--border-light);
    border-radius: 6px;
}
.quota-card span {
    font-size: 1.25rem;
    font-weight: 700;
}
.quota-card small {
    color: var(--text-secondary);
}
.scheduler-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-bottom: 12px;
}
.hidden-models {
    margin: 0;
}
.hidden-models ul {
    min-width: min(420px, 80vw);
    padding: 8px 0;
    margin: 0;
    list-style: none;
}
.hidden-models li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 4px 0;
}
.scheduler-empty {
    color: var(--text-secondary);
}
details {
    margin: 12px 0;
}
details details {
    margin-left: 16px;
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
@media (max-width: 600px) {
    .quota-grid {
        grid-template-columns: 1fr;
    }
}
</style>
