# Context 状态展示与账号管理体验修复文档

## 1. 背景

实际使用中，当前管理界面存在三类问题：

1. Context 浏览器池进度条把 `READY` 显示为绿色占用，却没有显示真正承载请求的 `BUSY`，与“绿色代表正在使用容量”的直觉相反。
2. 在调度面板的“人工禁用”列表中恢复账号后，后端状态已经恢复，但账号仍停留在该列表，必须刷新整个网页才会移动到“正常”。
3. 首页“账号管理”在账号数量较多时缺少快速定位能力，需要支持账号搜索和“只显示过期账号”。

本文给出问题根因、交互口径、代码改动范围、测试方案和验收标准。本次仅修复管理端展示与状态同步，不修改账号调度、Context 分配、账号过期判定和请求处理策略。

## 2. 涉及范围

主要涉及以下文件：

- `ui/app/components/SchedulerStatus.vue`
  - Context 汇总标签和容量进度条；
  - 人工禁用账号的恢复后刷新。
- `src/core/ModelScheduler.js`
  - 账号恢复后的状态版本递增，确保 ETag 失效。
- `ui/app/pages/StatusPage.vue`
  - 账号管理列表的搜索和“仅过期”筛选；
  - 筛选结果、全选和空状态的联动。
- `ui/locales/zh.json`、`ui/locales/en.json`
  - 新增界面文案，避免在 Vue 模板中硬编码。
- `tests/model-scheduler.test.js`、`tests/realtime-dashboard.test.js`
  - 调度器版本和接口缓存回归测试。

不直接修改 `ui-public/dist/` 或其他构建产物。功能完成后通过 `npm run build:ui` 统一生成发布资源。

## 3. 问题一：Context 进度条状态不符合直觉

### 3.1 现状

后端 `ModelScheduler.summarySnapshot()` 已经提供完整汇总：

```js
contexts_summary: {
    busy,
    initializing,
    max,
    ready,
    reconnecting,
    unavailable,
}
```

但 `SchedulerStatus.vue` 的进度条当前只渲染：

- `UNAVAILABLE`：红色；
- `READY`：绿色；
- `INITIALIZING`：初始化色。

`BUSY` 和 `RECONNECTING` 没有对应区段。标题右侧也只有 `READY`、`INIT` 和异常标签。因此在 14 个 Context 全部空载时，页面会显示一条填满的绿色进度条；真正进入 `BUSY` 后，进度条反而没有可见变化。

### 3.2 新展示口径

进度条表达“最大 Context 容量当前如何被占用”，状态颜色统一为：

| 状态           | 含义             | 进度条                            | 汇总标签                   |
| -------------- | ---------------- | --------------------------------- | -------------------------- |
| `BUSY`         | 正在承载请求     | 绿色实心                          | 绿色，始终显示 `BUSY n`    |
| `READY`        | 已启动但空载     | 不填充，保留为轨道空白            | 中性灰，始终显示 `READY n` |
| `INITIALIZING` | 正在初始化       | 黄色/橙色                         | 同色，仅数量大于 0 时显示  |
| `RECONNECTING` | 正在重连         | 黄色/橙色，可与初始化使用不同深浅 | 同色，仅数量大于 0 时显示  |
| `UNAVAILABLE`  | 故障、当前不可用 | 红色                              | 红色，仅数量大于 0 时显示  |

进度条各区段宽度仍按 `count / max × 100%` 计算。`READY` 不再生成彩色区段，未着色部分即表示当前没有被请求占用的可用容量。

示例：`max=14, busy=3, ready=10, unavailable=1` 时，进度条显示约 21.4% 绿色、7.1% 红色，其余为中性轨道；不能再显示 10/14 的绿色。

标题中的容量文案同步改为“`busy / max 占用`”，避免继续把 `ready / max` 标记为“容量”。`READY` 数量仍保留在右侧标签中，便于观察热池是否充足。

### 3.3 推荐实现

在 `SchedulerStatus.vue` 中：

1. 新增 `BUSY` 绿色标签和 `.slot-busy` 绿色区段。
2. 将 `READY` 标签调整为中性色，并删除 `.slot-ready` 彩色区段。
3. 为 `RECONNECTING` 增加标签和区段，补全后端已经提供但前端遗漏的状态。
4. 容量数字使用 `contextSummary.busy / contextSummary.max`。
5. 每个彩色区段保留 `title`，内容包含状态和数量；不能只依赖颜色表达状态。
6. 对后端未返回的字段继续用 `0` 兜底，避免旧服务端与新前端组合时出现 `NaN%`。

本项只改变显示含义，不改变后端 Context 状态机，也不把 `READY` 重命名为其他运行状态。

## 4. 问题二：恢复人工禁用账号后列表不立即更新

### 4.1 复现路径

1. 展开“账号 × 模型详情”。
2. 进入“人工禁用”筛选页。
3. 对某个禁用账号点击“恢复账号及全部模型”。
4. 接口返回成功，但账号仍在“人工禁用”列表中。
5. 刷新浏览器后，该账号才出现在“正常”列表。

### 4.2 根因

恢复操作调用：

```text
POST /api/scheduler/reset
    -> ModelScheduler.reset(index)
```

`reset(index)` 已经把账号的 `disabled` 改为 `false`，所以业务状态实际恢复成功；问题发生在状态版本和前端刷新链路：

1. `ModelScheduler.disable()` 修改账号后会执行 `this.sequence++`。
2. `ModelScheduler.reset()` 修改账号和模型状态后只执行 `flush()`、`drain()`，没有递增 `sequence`。
3. `/api/scheduler/accounts` 的 revision 为 `accounts:${this.sequence}`，接口通过该 revision 生成 ETag。
4. 前端恢复成功后只 `emit("refresh")`，没有直接刷新当前展开的账号列表。
5. 即使随后请求账号明细，由于 `sequence` 未变化，也可能命中原 ETag 并得到 `304 Not Modified`，于是本地 `accounts` 仍保留 `disabled: true`。

因此，这不是恢复操作失败，而是状态已经改变、缓存版本却没有改变造成的陈旧视图。

### 4.3 修复方案

采用“后端正确失效缓存 + 前端立即拉取明细”的双层修复。

#### 后端：所有可观察变更必须更新 sequence

修改 `ModelScheduler.reset()`：

1. 在修改前判断账号级字段或目标模型字段是否真的发生变化。
2. 只要至少一个可观察字段发生变化，执行一次 `this.sequence++`。
3. 一个 reset 调用最多递增一次，避免不同字段分别递增造成无意义的版本跳跃。
4. 没有任何变化的幂等 reset 可以不递增。
5. 继续保留现有 `flush()`、`drain()` 和 `handleAccountEnabled(index)` 行为。

同一原则应覆盖 `resetAllAccounts()` 和 `resetAllRateLimits()`：只要响应快照会变化，就必须更新 `sequence`。否则它们也可能产生相同的 ETag 陈旧问题。

#### 前端：恢复成功后直接刷新当前账号列表

修改 `SchedulerStatus.vue` 中的 `reset(accountId, model)`：

```js
async function reset(accountId, model) {
  const result = await sendReset("/api/scheduler/reset", { account_id: accountId, model });
  if (!result) return;
  await fetchAccounts(true);
}
```

账号级恢复成功后，重新请求 `/api/scheduler/accounts`。在当前筛选为 `disabled` 时，该账号应由 `filteredAccounts` 自动移除；切换到“正常”后应立即可见。

不建议仅在前端执行 `account.disabled = false` 的乐观更新。恢复还会同时清除健康状态、错误和模型冷却字段，仅改一个布尔值会制造新的局部不一致；后端快照应继续作为权威状态。

### 4.4 接口返回建议

当前 `ModelScheduler.reset()` 没有显式返回值，路由只返回 `success: true`。可以让它返回：

```json
{
  "account_id": 13,
  "changed": true,
  "scope": "account"
}
```

模型级恢复时可附带 `model`。这不是修复陈旧列表的必要条件，但能让前端提示和测试更明确。

## 5. 问题三：账号管理增加搜索和“只显示过期”

### 5.1 交互布局

在首页“账号管理”的顶部操作区增加筛选区，放在“全选/批量操作”和右侧图标按钮之间；窄屏时允许换行：

```text
[全选] [已选 n]      [搜索账号序号或邮箱……] [ ] 只显示过期      [新增] [上传] [去重]
```

新增两个本地状态：

```js
const accountSearchQuery = ref("");
const showExpiredOnly = ref(false);
```

新增单一派生列表 `filteredAccountDetails`，模板渲染、空状态和“全选”都基于该列表，不要在模板中叠加多组条件。

### 5.2 搜索规则

搜索在前端本地完成，不增加后端接口或请求频率。规则如下：

- 去除输入首尾空格。
- 邮箱/显示名称按不区分大小写的子串匹配。
- 账号序号支持 `13` 和 `#13` 两种输入。
- 数字查询可匹配序号的字符串形式；例如 `12` 可找到 `#12`、`#120`。
- 查询为空时不限制结果。
- 搜索字段使用 `getAccountDisplayName(item)` 和 `String(item.index)`，兼容无邮箱、无效账号及重复账号的现有显示逻辑。

本次不做模糊拼写纠错、正则搜索和服务端分页。

### 5.3 “只显示过期”规则

- 使用现有 `item.isExpired === true` 作为唯一判断依据，不在前端重新解析 Cookie 或有效期。
- 勾选后只显示过期账号。
- 搜索与过期筛选为交集关系；例如输入邮箱片段并勾选后，只显示匹配该片段的过期账号。
- 取消勾选后恢复显示所有符合搜索条件的账号。
- 筛选只影响可见列表，不修改账号状态、当前账号或 Context。

### 5.4 全选和批量操作

账号被筛选后，“全选”必须以当前可见结果为范围：

- `isAllSelected`：`filteredAccountDetails` 非空，且其中每个账号都已选中。
- 点击“全选”：只添加当前可见账号。
- 取消“全选”：只取消当前可见账号，不意外清除其他筛选条件下手动选中的账号。
- 没有可见结果时禁用“全选”。
- 批量操作仍作用于 `selectedAccounts` 中的全部账号；已选数量继续明确显示，避免隐藏选择无提示。

为降低误操作风险，筛选结果为空时仍要保留已选数量和取消选择能力，不能因为列表为空而隐藏批量操作状态。

### 5.5 空状态

区分两类空状态：

- `state.accountDetails.length === 0`：继续显示“暂无可用账号”。
- 总账号不为空但 `filteredAccountDetails.length === 0`：显示“没有符合筛选条件的账号”，并提供清除搜索/取消“只显示过期”的操作。

### 5.6 多语言文案

至少新增以下 key，并同时提供中文和英文：

- `accountSearchPlaceholder`
- `showExpiredOnly`
- `noMatchingAccounts`
- `clearAccountFilters`
- `contextBusy`
- `contextReady`
- `contextInitializing`
- `contextReconnecting`
- `contextUnavailable`
- `contextCapacityInUse`

## 6. 数据流与刷新行为

修复后的关键链路如下：

```text
点击恢复账号
    -> POST /api/scheduler/reset
    -> 后端修改账号状态并递增 sequence
    -> accounts ETag 随 revision 变化
    -> 前端 fetchAccounts(true)
    -> accounts 替换为最新快照
    -> filteredAccounts 重新计算
    -> 账号立即从“人工禁用”消失，并可在“正常”中看到
```

首页账号搜索和过期筛选只对已经由 `/api/status` 返回的 `state.accountDetails` 做 computed 过滤，不参与上述调度器账号明细请求。

## 7. 测试方案

### 7.1 调度器单元测试

在 `tests/model-scheduler.test.js` 增加：

1. 禁用账号后调用账号级 `reset()`：
   - `disabled` 从 `true` 变为 `false`；
   - `sequence` 严格增加一次；
   - `accountsOverviewSnapshot().revision` 发生变化；
   - 最新快照中的账号状态为 healthy。
2. 对已完全正常的账号重复 reset：
   - 状态保持不变；
   - 若采用幂等版本策略，`sequence` 不增加。
3. 模型级 reset 清除 429/403/冷却字段后，`sequence` 增加且明细 revision 变化。
4. `resetAllAccounts()`、`resetAllRateLimits()` 在实际改变状态时递增 sequence。

### 7.2 路由和 ETag 测试

在 `tests/realtime-dashboard.test.js` 增加真实调度器或带可变 sequence 的路由测试：

1. 首次请求 `/api/scheduler/accounts` 得到 `200` 和 ETag A。
2. 未修改状态并携带 `If-None-Match: A`，得到 `304`。
3. 恢复账号后再次携带 ETag A，请求必须得到 `200`、ETag B 和 `disabled: false`。
4. ETag B 必须不同于 ETag A。

### 7.3 前端行为验证

项目当前没有 Vue 组件测试框架，因此本次至少完成构建检查和浏览器手工回归；若后续引入 Vitest，应把以下场景组件化：

- `busy=0, ready=max`：进度条无绿色占用，READY 标签为中性。
- `busy=3, ready=10, unavailable=1, max=14`：绿色和红色比例正确。
- 恢复禁用账号后无需整页刷新，账号立即离开“人工禁用”。
- 用大小写不同的邮箱片段可搜索到同一账号。
- 输入 `13` 或 `#13` 均能定位 `#13`。
- “只显示过期”只展示 `isExpired` 账号。
- 搜索与“只显示过期”正确取交集。
- 筛选后“全选”只选择当前可见账号。
- 中文和英文下控件均无溢出，窄屏工具栏可换行。

### 7.4 执行命令

```bash
npm run lint:js
npm run lint:css
npm test
npm run build:ui
```

## 8. 验收标准

全部满足以下条件才算完成：

1. 空载 Context 不再以绿色填满进度条；只有 `BUSY` 使用绿色占用色。
2. `READY`、`BUSY`、初始化、重连和故障数量都能从汇总区域辨认。
3. 从“人工禁用”恢复账号后，无需刷新网页，账号在一次操作完成后立即离开该列表。
4. 恢复后的账号切换到“正常”筛选时可立即看到，状态和模型详情与后端一致。
5. 账号管理可按邮箱或账号序号搜索。
6. “只显示过期”可独立使用，并能与搜索组合。
7. 筛选后的全选不会选中当前不可见的账号。
8. 筛选无结果时展示专用空状态，而不是误报“没有账号”。
9. 所有新增文案同时支持中文和英文。
10. lint、现有测试、新增回归测试和前端生产构建全部通过。

## 9. 风险与回滚

- Context 修改只涉及展示，回滚 `SchedulerStatus.vue` 即可恢复旧视觉，不影响调度器运行。
- `sequence` 递增会让状态变化后的下一次请求从 `304` 变为 `200`，这是正确的缓存失效；只有真实变更才递增，不会持续增加轮询流量。
- 账号筛选完全在浏览器内执行。以当前账号规模不会产生明显性能压力；若未来达到数千账号，再单独评估虚拟列表或服务端分页。
- 不应以给请求追加随机 query 参数的方式绕过 ETag。该做法会掩盖服务端版本遗漏，并让所有账号请求永久失去缓存收益。
