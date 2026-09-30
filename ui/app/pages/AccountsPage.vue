<template>
    <section class="accounts-panel">
        <div class="account-toolbar">
            <ElButton type="primary" @click="openNew">{{ l("新增账号", "Add account") }}</ElButton>
            <ElButton @click="importVisible = true">{{
                l("账密 / 验证器导入", "Import credentials / authenticator")
            }}</ElButton>
            <RouterLink to="/auth">{{ l("VNC 人工登录", "Manual VNC login") }}</RouterLink>
            <RouterLink to="/">{{ l("返回首页", "Home") }}</RouterLink>
        </div>
        <ElCard class="queue-card">
            <div class="account-toolbar">
                <span
                    >{{ l("登录队列", "Login queue") }}: {{ queue.running || 0 }} {{ l("运行", "running") }} /
                    {{ queue.queued || 0 }} {{ l("排队", "queued") }} / {{ queue.retryWait || 0 }}
                    {{ l("退避", "retrying") }} / {{ queue.faultSlots || 0 }} {{ l("故障槽", "fault slots") }}</span
                >
                <ElInputNumber v-model="concurrency" :min="1" :max="32" />
                <ElButton @click="configure({ concurrency })">{{ l("设置并发", "Set concurrency") }}</ElButton>
                <ElButton @click="configure({ paused: !queue.paused })">{{
                    queue.paused ? l("恢复队列", "Resume queue") : l("暂停队列", "Pause queue")
                }}</ElButton>
            </div>
            <small
                >{{ queue.source }} · {{ l("单次超时", "Attempt timeout") }} {{ queue.attemptTimeout / 1000 }}s</small
            >
            <p v-for="execution in queue.executions || []" :key="execution.taskId">
                {{ execution.taskId }} · {{ execution.phase }} · {{ Math.round(execution.elapsedMs / 1000) }}s
                <span v-if="execution.fault">{{ l("执行器清理故障", "Executor cleanup fault") }}</span>
            </p>
        </ElCard>
        <div class="account-toolbar">
            <ElInput
                v-model="search"
                :placeholder="l('搜索邮箱', 'Search email')"
                clearable
                @input="
                    page = 1;
                    refresh();
                "
            />
            <ElSelect
                v-model="filter"
                clearable
                :placeholder="l('全部状态', 'All states')"
                @change="
                    page = 1;
                    refresh();
                "
            >
                <ElOption
                    v-for="value in [
                        'credentials_missing',
                        'expired',
                        'queued',
                        'running',
                        'retry_wait',
                        'manual_required',
                    ]"
                    :key="value"
                    :value="value"
                    :label="stateLabel(value)"
                />
            </ElSelect>
            <ElButton :disabled="!selected.length" @click="batchLogin">{{
                l("批量重新登录", "Log in selected")
            }}</ElButton>
        </div>
        <ElTable :data="accounts" row-key="accountId" @selection-change="selected = $event">
            <ElTableColumn type="selection" width="45" />
            <ElTableColumn :label="l('账号', 'Account')" min-width="200">
                <template #default="{ row }"
                    >{{ row.authIndex === null ? "—" : `#${row.authIndex}` }} {{ row.email || row.displayName
                    }}<br /><small v-if="row.disabled">{{ l("人工禁用", "Manually disabled") }}</small></template
                >
            </ElTableColumn>
            <ElTableColumn :label="l('会话 / 恢复', 'Session / recovery')" min-width="160"
                ><template #default="{ row }"
                    >{{ stateLabel(row.sessionState) }} / {{ stateLabel(row.recoveryState) }}<br /><small>{{
                        row.lastFailure?.error
                    }}</small></template
                ></ElTableColumn
            >
            <ElTableColumn :label="l('凭据', 'Credentials')" width="110"
                ><template #default="{ row }"
                    >{{ row.hasPassword ? "✓" : "—" }} Password<br />{{ row.hasTotpSecret ? "✓" : "—" }} TOTP</template
                ></ElTableColumn
            >
            <ElTableColumn :label="l('自动恢复', 'Auto recovery')" width="110"
                ><template #default="{ row }"
                    ><ElSwitch
                        :model-value="row.autoRecovery"
                        @change="value => toggleRecovery(row, value)" /></template
            ></ElTableColumn>
            <ElTableColumn :label="l('操作', 'Actions')" min-width="360"
                ><template #default="{ row }">
                    <ElButton size="small" @click="openEdit(row)">{{ l("编辑凭据", "Edit credentials") }}</ElButton>
                    <ElButton size="small" @click="login(row)">{{ l("重新登录", "Log in") }}</ElButton>
                    <ElButton v-if="row.currentTaskId" size="small" @click="cancel(row.currentTaskId)">{{
                        l("取消", "Cancel")
                    }}</ElButton>
                    <ElButton size="small" @click="viewHistory(row)">{{ l("任务 / 日志", "Tasks / logs") }}</ElButton>
                    <ElButton v-if="row.authIndex === null" size="small" type="danger" @click="deleteMissing(row)">{{
                        l("删除", "Delete")
                    }}</ElButton>
                </template></ElTableColumn
            >
        </ElTable>
        <ElPagination
            v-model:current-page="page"
            :page-size="25"
            :total="total"
            layout="prev, pager, next, total"
            @current-change="refresh"
        />
        <ElDialog
            v-model="editVisible"
            :title="editing ? l('编辑凭据', 'Edit credentials') : l('新增账号', 'Add account')"
            @closed="clearForm"
        >
            <ElForm label-position="top">
                <ElFormItem label="Email"><ElInput v-model="form.email" autocomplete="off" /></ElFormItem>
                <ElFormItem label="Password"
                    ><ElInput
                        v-model="form.password"
                        type="password"
                        show-password
                        autocomplete="new-password"
                        :placeholder="editing ? l('留空不修改', 'Leave empty to preserve') : ''"
                /></ElFormItem>
                <ElFormItem label="TOTP / otpauth://"
                    ><ElInput
                        v-model="form.totpSecret"
                        type="password"
                        show-password
                        autocomplete="off"
                        :placeholder="l('可选；留空不修改', 'Optional; empty preserves existing')"
                /></ElFormItem>
                <ElButton v-if="editing" @click="reveal">{{
                    l("显示已保存凭据", "Reveal saved credentials")
                }}</ElButton>
                <template v-if="editing"
                    ><ElCheckbox v-model="form.clearPassword">{{ l("清除密码", "Clear password") }}</ElCheckbox
                    ><ElCheckbox v-model="form.clearTotpSecret">{{
                        l("清除验证器密钥", "Clear TOTP secret")
                    }}</ElCheckbox
                    ><ElCheckbox v-model="form.loginNow">{{
                        l("保存后重新登录", "Log in after saving")
                    }}</ElCheckbox></template
                >
            </ElForm>
            <template #footer
                ><ElButton type="primary" :loading="busy" @click="save">{{ l("保存", "Save") }}</ElButton></template
            >
        </ElDialog>
        <ElDialog v-model="importVisible" :title="l('导入预览', 'Import preview')" width="85%" @closed="clearImport">
            <ElSelect v-model="importKind"
                ><ElOption label="CSV: email,password,totpSecret" value="csv" /><ElOption
                    label="Authenticator / otpauth-migration / Base32"
                    value="authenticator"
            /></ElSelect>
            <input type="file" accept=".csv,.txt" @change="readImportFile" />
            <ElInput
                v-model="importContent"
                type="textarea"
                :rows="5"
                :placeholder="l('粘贴 CSV 或验证器链接 / 密钥', 'Paste CSV or authenticator links / secrets')"
            />
            <ElButton @click="previewImport">{{ l("解析预览", "Preview") }}</ElButton>
            <p v-if="preview && !preview.complete">
                {{
                    l(
                        "迁移批次缺失，补全后才能提交。",
                        "Migration batches are incomplete. Add missing batches before committing."
                    )
                }}
            </p>
            <ElTable v-if="preview" :data="preview.rows">
                <ElTableColumn prop="email" label="Email" />
                <ElTableColumn prop="error" :label="l('问题', 'Issue')" />
                <ElTableColumn :label="l('映射 / 创建', 'Map / create')"
                    ><template #default="{ row }">
                        <ElSelect
                            v-if="importKind === 'authenticator'"
                            v-model="choices[row.index].accountId"
                            clearable
                            :placeholder="l('选择账号或跳过', 'Select account or skip')"
                            ><ElOption
                                v-for="account in mappingAccounts"
                                :key="account.accountId"
                                :value="account.accountId"
                                :label="account.email || account.displayName"
                        /></ElSelect>
                        <ElCheckbox v-else-if="!row.accountId" v-model="choices[row.index].create">{{
                            l("创建记录，不立即登录", "Create record without login")
                        }}</ElCheckbox>
                        <span v-else>{{ l("匹配已有账号", "Existing account matched") }}</span>
                    </template></ElTableColumn
                >
                <ElTableColumn :label="l('显式覆盖 / 跳过', 'Overwrite / skip')"
                    ><template #default="{ row }"
                        ><ElCheckbox v-model="choices[row.index].overwrite">{{ l("覆盖", "Overwrite") }}</ElCheckbox
                        ><ElCheckbox v-model="choices[row.index].skip">{{ l("跳过", "Skip") }}</ElCheckbox
                        ><span v-if="row.conflict">⚠ {{ l("密钥冲突", "Secret conflict") }}</span></template
                    ></ElTableColumn
                >
            </ElTable>
            <p v-if="importResult">{{ JSON.stringify(importResult) }}</p>
            <template #footer
                ><ElButton type="primary" :disabled="!preview?.complete" @click="commitImport">{{
                    l("提交导入", "Commit import")
                }}</ElButton></template
            >
        </ElDialog>
        <ElDialog v-model="historyVisible" :title="l('登录任务与尝试日志', 'Login tasks and attempts')" width="85%">
            <div v-for="task in tasks" :key="task.taskId">
                <p>
                    {{ task.taskId }} · {{ stateLabel(task.status) }} · {{ task.phase }} · {{ task.attempts }}
                    {{ l("次尝试", "attempts") }} ·
                    {{ task.startedAt ? Math.round(((task.finishedAt || now) - task.startedAt) / 1000) : 0 }}s
                    <ElButton
                        v-if="['queued', 'running', 'retry_wait'].includes(task.status)"
                        @click="cancel(task.taskId)"
                        >{{ l("取消", "Cancel") }}</ElButton
                    >
                </p>
                <p v-for="(attempt, index) in task.history" :key="index">
                    {{ attempt.phase }} · {{ attempt.error || "OK" }} · {{ new Date(attempt.endedAt).toISOString() }}
                    <ElButton v-if="attempt.artifactId" @click="showArtifact(attempt.artifactId)">{{
                        l("查看失败截图", "View failure screenshot")
                    }}</ElButton
                    ><span v-else>{{ attempt.screenshotReason || l("未生成截图", "No screenshot") }}</span>
                </p>
            </div>
            <ElPagination
                v-model:current-page="taskPage"
                :page-size="25"
                :total="taskTotal"
                layout="prev, pager, next"
                @current-change="loadHistory"
            />
        </ElDialog>
        <ElDialog v-model="imageVisible" :title="l('失败截图', 'Failure screenshot')" width="85%" @closed="releaseImage"
            ><img v-if="imageUrl" :src="imageUrl" style="width: 100%"
        /></ElDialog>
    </section>
</template>
<script setup>
import { ref, reactive, onMounted, onBeforeUnmount } from "vue";
import { ElMessage, ElMessageBox } from "element-plus";
import I18n from "../utils/i18n";
const l = (zh, en) => (I18n.getLang() === "zh" ? zh : en);
const labels = {
    cancelled: ["已取消", "Cancelled"],
    credentials_missing: ["缺少凭据", "Credentials missing"],
    expired: ["已过期", "Expired"],
    failed: ["失败", "Failed"],
    idle: ["空闲", "Idle"],
    manual_required: ["需人工处理", "Manual required"],
    missing: ["无会话", "Missing"],
    queued: ["排队", "Queued"],
    retry_wait: ["等待重试", "Retry wait"],
    running: ["登录中", "Running"],
    succeeded: ["成功", "Succeeded"],
    valid: ["有效", "Valid"],
};
const stateLabel = value => (labels[value] ? l(...labels[value]) : value);
const accounts = ref([]),
    total = ref(0),
    page = ref(1),
    search = ref(""),
    filter = ref(""),
    selected = ref([]),
    queue = ref({}),
    concurrency = ref(1),
    now = ref(Date.now());
const editVisible = ref(false),
    editing = ref(null),
    busy = ref(false),
    form = reactive({
        clearPassword: false,
        clearTotpSecret: false,
        email: "",
        loginNow: false,
        password: "",
        totpSecret: "",
    });
const importVisible = ref(false),
    importKind = ref("csv"),
    importContent = ref(""),
    preview = ref(null),
    choices = ref([]),
    importResult = ref(null),
    mappingAccounts = ref([]);
const historyVisible = ref(false),
    historyAccount = ref(null),
    tasks = ref([]),
    taskPage = ref(1),
    taskTotal = ref(0),
    imageVisible = ref(false),
    imageUrl = ref("");
let timer,
    polling = false,
    disposed = false,
    refreshSequence = 0;
async function api(path, method = "GET", body) {
    const response = await fetch(`/api/account-management${path}`, {
        headers: { Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        method,
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || String(response.status));
    }
    return response.json();
}
async function action(work) {
    try {
        await work();
    } catch (cause) {
        ElMessage.error(cause.message);
    }
}
async function refresh() {
    const sequence = ++refreshSequence;
    await action(async () => {
        const [list, status] = await Promise.all([
            api(`/accounts?page=${page.value}&search=${encodeURIComponent(search.value)}&state=${filter.value}`),
            api("/login-queue"),
        ]);
        if (disposed || sequence !== refreshSequence) return;
        accounts.value = list.accounts;
        total.value = list.total;
        queue.value = status;
        if (!polling) concurrency.value = status.concurrency;
    });
}
async function configure(values) {
    await action(async () => {
        queue.value = await api("/login-queue", "PATCH", values);
        await refresh();
    });
}
function clearForm() {
    Object.assign(form, {
        clearPassword: false,
        clearTotpSecret: false,
        email: "",
        loginNow: false,
        password: "",
        totpSecret: "",
    });
    editing.value = null;
}
function openNew() {
    clearForm();
    editVisible.value = true;
}
function openEdit(account) {
    clearForm();
    releaseImage();
    editing.value = account;
    form.email = account.email || "";
    editVisible.value = true;
}
async function reveal() {
    await action(async () => {
        const result = await api(`/accounts/${editing.value.accountId}/credentials`);
        form.password = result.password || "";
        form.totpSecret = result.totpSecret || "";
        editing.value = { ...editing.value, credentialVersion: result.credentialVersion };
    });
}
async function save() {
    busy.value = true;
    await action(async () => {
        const body = {
            email: form.email,
            ...(form.password ? { password: form.password } : {}),
            ...(form.totpSecret ? { totpSecret: form.totpSecret } : {}),
        };
        if (editing.value) {
            if (form.clearPassword) delete body.password;
            if (form.clearTotpSecret) delete body.totpSecret;
            await api(`/accounts/${editing.value.accountId}/credentials`, "PATCH", {
                ...body,
                clearPassword: form.clearPassword,
                clearTotpSecret: form.clearTotpSecret,
                credentialVersion: editing.value.credentialVersion,
            });
            if (form.loginNow) await api(`/accounts/${editing.value.accountId}/login`, "POST", {});
        } else await api("/accounts", "POST", body);
        editVisible.value = false;
        clearForm();
        await refresh();
    });
    busy.value = false;
}
async function login(account) {
    await action(async () => {
        await api(`/accounts/${account.accountId}/login`, "POST", {});
        await refresh();
    });
}
async function batchLogin() {
    for (const account of selected.value) await login(account);
}
async function cancel(id) {
    await action(async () => {
        await api(`/login-tasks/${id}/cancel`, "POST", {});
        await refresh();
        if (historyVisible.value) await loadHistory();
    });
}
async function toggleRecovery(account, autoRecovery) {
    await action(async () => {
        await api(`/accounts/${account.accountId}/credentials`, "PATCH", {
            autoRecovery,
            credentialVersion: account.credentialVersion,
        });
        await refresh();
    });
}
async function deleteMissing(account) {
    await action(async () => {
        await ElMessageBox.confirm(l("删除此账号记录？", "Delete this account?"));
        await api(`/accounts/${account.accountId}`, "DELETE");
        await refresh();
    });
}
async function readImportFile(event) {
    await action(async () => {
        const file = event.target.files[0];
        if (file?.size > 1048576) throw new Error("Import exceeds 1 MiB");
        if (file) importContent.value = await file.text();
        event.target.value = "";
    });
}
async function previewImport() {
    await action(async () => {
        preview.value = await api("/import/preview", "POST", { content: importContent.value, kind: importKind.value });
        importContent.value = "";
        choices.value = preview.value.rows.map(row => ({
            accountId: row.accountId,
            create: false,
            index: row.index,
            overwrite: false,
            skip: !!row.error || row.unchanged,
        }));
        mappingAccounts.value = [];
        let cursor = 1,
            list;
        do {
            list = await api(`/accounts?page=${cursor++}&pageSize=100`);
            mappingAccounts.value.push(...list.accounts);
        } while (mappingAccounts.value.length < list.total);
    });
}
async function commitImport() {
    await action(async () => {
        importResult.value = await api("/import/commit", "POST", {
            previewId: preview.value.previewId,
            rows: choices.value,
        });
        await refresh();
    });
}
function clearImport() {
    importContent.value = "";
    preview.value = null;
    choices.value = [];
    importResult.value = null;
}
async function viewHistory(account) {
    releaseImage();
    historyAccount.value = account.accountId;
    taskPage.value = 1;
    historyVisible.value = true;
    await loadHistory();
}
async function loadHistory() {
    await action(async () => {
        const result = await api(`/login-tasks?accountId=${historyAccount.value}&page=${taskPage.value}`);
        tasks.value = result.tasks;
        taskTotal.value = result.total;
    });
}
function releaseImage() {
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value);
    imageUrl.value = "";
    imageVisible.value = false;
}
async function showArtifact(id) {
    releaseImage();
    await action(async () => {
        const response = await fetch(`/api/account-management/artifacts/${id}`, {
            headers: { Accept: "application/json" },
        });
        if (!response.ok)
            throw new Error(
                response.status === 410
                    ? l("截图已过期", "Screenshot expired")
                    : l("截图不可用", "Screenshot unavailable")
            );
        imageUrl.value = URL.createObjectURL(await response.blob());
        imageVisible.value = true;
    });
}
onMounted(async () => {
    await refresh();
    timer = setInterval(async () => {
        if (polling) return;
        polling = true;
        now.value = Date.now();
        try {
            await refresh();
            if (historyVisible.value) await loadHistory();
        } finally {
            polling = false;
        }
    }, 5000);
});
onBeforeUnmount(() => {
    disposed = true;
    clearInterval(timer);
    releaseImage();
    clearForm();
    clearImport();
});
</script>
<style scoped>
.accounts-panel {
    margin-bottom: 24px;
}
.account-toolbar {
    display: flex;
    gap: 12px;
    align-items: center;
    flex-wrap: wrap;
    margin: 12px 0;
}
.account-toolbar > .el-input {
    max-width: 280px;
}
.account-toolbar > .el-select {
    width: 200px;
}
.queue-card {
    margin: 16px 0;
}
small {
    opacity: 0.7;
}
</style>
