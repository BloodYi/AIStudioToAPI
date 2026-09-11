# 调度监控面板与实时流量优化改造设计

## 1. 背景

当前管理界面需要保持接近实时的运行监控，但页面打开后会产生异常高的持续下行流量。与此同时，调度面板中的部分指标口径和展示方式也需要调整：

1. “预估剩余额度”当前只显示所有模型合计值，无法判断具体模型的剩余额度。
2. Context 实时状态表在 Context 较多时占用大量纵向空间。
3. 模型汇总中的累计成功、累计失败与“使用统计”分页重复。
4. “账号 × 模型详情”中的失败数是跨日累计值，和今日请求数口径不一致。
5. 所有“今日”指标必须以太平洋时间自然日为准。
6. 页面必须维持至少每 5 秒一次的实时刷新，不能通过降低刷新频率来解决流量问题。

本次改造同时处理指标口径、页面信息密度和传输架构。核心原则是：**保留 5 秒实时刷新，但实时轮询只传输当前画面需要的轻量数据；历史数据和折叠内容不再反复全量传输。**

## 2. 现状与根因

### 2.1 当前轮询存在重复调度

`StatusPage.vue` 挂载时分别执行：

```js
updateContent().finally(scheduleUpdate);
fetchUsageStats().finally(scheduleUpdate);
```

两次初始化都会启动一条独立的 `scheduleUpdate()` 链。之后每条链又同时请求 `/api/status` 和 `/api/usage-stats`，因此正常情况下会存在两组约 4～7 秒的轮询。除了请求数量近似翻倍，单一 `updateTimer` 变量也只能保存最后一个定时器句柄，生命周期管理不完整。

### 2.2 `/api/usage-stats` 每次返回完整历史

`UsageStatsService.getSnapshot()` 会返回：

- 完整账号聚合；
- 完整 summary；
- `this.records.slice().reverse()`，即从启动/持久化数据中载入的所有请求记录。

历史记录没有分页或增量游标。随着 `usage-stats.jsonl` 增长，同一份历史数据会被每隔数秒重复下载。即使用户当前停留在首页、设置或日志分页，统计接口仍会被轮询。

这是流量随运行时间持续增长并最终达到 MB/s 级别的主要原因。

### 2.3 `/api/status` 混合了不同更新需求的数据

调度模式下，`/api/status` 同时返回：

- 基础服务和配置状态；
- 最近日志全文；
- scheduler 模型汇总；
- 全部 Context 明细；
- 全部 worker 明细；
- 全部账号及其全部模型 slot；
- metrics 及 timing 统计。

其中只有少量汇总字段需要一直可见。Context 和账号详情即使在界面中折叠，当前也已经由后端生成并传到浏览器；视觉折叠本身不能降低网络流量。

### 2.4 当前统计口径

- `daily_request_count` 已按 `America/Los_Angeles` 日期键统计上游尝试数。
- 模型汇总的 `success`、`failures` 分别来自累计 `success_count`、`failure_count`。
- 账号 × 模型的失败列直接显示累计 `failure_count`。
- `estimated_remaining_quota` 把所有可估算模型的余额相加，只返回一个总值。

## 3. 改造目标

### 3.1 功能目标

1. 预估剩余额度按真实上游模型 ID 独立展示，例如 `gemini-3.7-flash` 和 `gemini-3.8-flash` 分别显示，不再用一个总数表达。
2. Context 明细默认折叠；折叠标题仍显示 READY、BUSY、INITIALIZING、RECONNECTING、UNAVAILABLE 等汇总数。
3. 模型汇总表删除“累计成功”和“累计失败”两列。
4. 账号 × 模型详情将“累计失败”改为“今日失败（PT）”。
5. 今日请求、今日失败和预估额度均按太平洋时间 00:00 日切。
6. 当前可见监控内容每 5 秒刷新一次。

### 3.2 性能目标

1. 任意 5 秒实时响应都不得携带完整请求历史。
2. Context 折叠时不得传输 Context 行明细；账号详情折叠时不得传输账号 × 模型明细。
3. 非日志分页不得重复传输日志全文；日志分页使用增量日志。
4. 非使用统计分页不得请求使用统计接口。
5. 同一页面实例最多只有一个刷新循环，且上一轮未完成时不启动下一轮。
6. 历史记录规模从 1 万增长到 100 万时，首页每轮实时响应大小不应随之增长。

建议在 50 个账号、2 个模型、10 万条历史记录的验收数据集上，将首页每轮 5 秒刷新总传输量控制在 100 KB 以内，并相对当前实现降低至少 90%。实际阈值可根据账户名称和错误文本长度微调，但必须是与历史记录总数无关的有界值。

## 4. 范围与非目标

本次涉及：

- `src/core/ModelScheduler.js` 的日失败计数、额度分模型汇总和快照拆分；
- `src/core/UsageStatsService.js` 的轻量汇总、分页/增量读取能力；
- `src/routes/StatusRoutes.js` 的轻量实时接口和按需明细接口；
- `ui/app/pages/StatusPage.vue` 的单轮询控制、按分页取数和状态合并；
- `ui/app/components/SchedulerStatus.vue` 的额度展示、Context 折叠和列调整；
- 中英文文案与自动化测试。

本次不改变：

- 5 秒实时性要求；
- 请求调度、重试、429/403 冷却策略；
- Flash 每账号每模型 100 次、Pro 每账号每模型 10 次的现有估算规则；
- 使用统计 JSONL 的下载、导入格式；
- Google 实际配额。页面显示值仍然只是本服务可观测范围内的估算值。

## 5. 时间与事件统计口径

### 5.1 太平洋自然日

统一使用 IANA 时区：

```text
America/Los_Angeles
```

“今日”区间为当前太平洋日期的 `00:00:00.000`（含）到当前时刻。不使用固定 UTC-8，因为太平洋地区存在 PST/PDT 夏令时切换。

继续使用后端日期键，例如 `2026-09-10`。slot 在以下时机检查并惰性日切：

- 开始一次真实上游尝试；
- 记录一次上游失败；
- 生成调度快照；
- 从持久化状态恢复后首次访问。

浏览器只展示后端返回的日期和时区，不自行判断是否跨日，避免客户端时区、时钟或夏令时规则导致口径分裂。

### 5.2 今日请求数

沿用当前定义：在真实上游发送开始时由 `startAttempt()` 递增。同一个逻辑 API 请求发生换账号重试时，每一次真实上游尝试分别计数；尚未发送就在本地失败或取消的不计数。

### 5.3 今日失败数

新增 `daily_failure_count`，在 `failure()` 确认一次上游尝试失败时递增：

- 本地传输错误若当前逻辑不进入累计 `failure_count`，也不进入今日失败；
- 用户主动取消不计入今日失败；
- 403、429、上游 5xx 及现有会递增 `failure_count` 的错误，同步递增今日失败；
- 失败跨越太平洋午夜时，按失败被确认的时刻归属日期。

最后一条可能导致极少量跨午夜请求的“今日请求”和“今日失败”不在同一天，但事件口径明确、实现简单且不会篡改已经结算的前一日状态。

## 6. 分模型预估剩余额度

### 6.1 配额模型独立计算

每个真实上游模型 ID 是独立的配额桶，不再把不同模型合并成一个展示值。例如：

```text
gemini-3.7-flash  -> 独立计算
gemini-3.8-flash  -> 独立计算
```

两者即使都属于 Flash，也不能先合并今日请求数后只显示总余额。

继续沿用现有模型类型规则：

- 模型名包含独立 `flash` 词段：100 次/账号/模型/太平洋日；
- 模型名包含独立 `pro` 词段：10 次/账号/模型/太平洋日；
- `flash-lite` 归入 Flash；
- embedding、imagen、内部模型等无法匹配规则的模型不展示预估余额；
- 请求侧别名必须先归一化为真实上游模型，避免同一配额桶重复展示。

### 6.2 账号范围

每个模型仅基于 `authSource.getRotationIndices()` 返回的有效轮换账号计算：

- 排除 expired、无效、重复淘汰和已删除账号；
- 临时处于 COOLDOWN、RATE_LIMITED、UNHEALTHY 或 UNSUPPORTED 的账号仍纳入理论配额基数，与当前估算原则保持一致；
- 外部服务对同一 Google 账号产生的用量不可见，因此结果必须继续标注“预估”。

### 6.3 公式

对模型 `M`：

```text
M 的预估剩余额度 = Σ max(0, M 的单账号日上限 - 账号在 M 上的今日请求数)
```

必须先对每个账号截断到 0，再求和，不能用：

```text
账号数 × 单账号日上限 - 模型总请求数
```

否则某个账号超出估算上限时，会错误扣减其他账号的剩余额度。

示例：44 个有效账号，两个 Flash 模型今日分别尝试 889 和 902 次：

```text
gemini-3.7-flash：逐账号 max(0, 100 - 今日请求数) 后求和
gemini-3.8-flash：逐账号 max(0, 100 - 今日请求数) 后求和
```

页面分别展示两个结果，不再显示二者之和。

### 6.4 API 字段

轻量调度汇总新增：

```json
{
    "usage_window": {
        "date": "2026-09-10",
        "timezone": "America/Los_Angeles"
    },
    "quota_by_model": [
        {
            "model": "gemini-3.7-flash",
            "quota_per_account": 100,
            "tracked_accounts": 44,
            "daily_requests": 889,
            "estimated_remaining_quota": 3511
        },
        {
            "model": "gemini-3.8-flash",
            "quota_per_account": 100,
            "tracked_accounts": 44,
            "daily_requests": 902,
            "estimated_remaining_quota": 3498
        }
    ]
}
```

示例余额只用于说明响应结构；真实值必须按账号逐一截断后计算，未必总是等于 `44 × 100 - daily_requests`。

兼容期内可保留旧 `estimated_remaining_quota` 字段供旧前端使用，但新前端不得读取或显示它；后续主版本再删除。

## 7. 调度状态数据模型

每个账号 × 模型 slot 增加今日失败字段：

```js
{
    request_count: 9237,              // 现有累计请求，仅内部兼容/调度使用
    success_count: 8640,              // 现有累计成功，不再在模型汇总展示
    failure_count: 597,                // 现有累计失败，不再在新 UI 展示
    daily_request_count: 37,
    daily_failure_count: 3,
    daily_request_date: "2026-09-10"
}
```

`daily_request_date` 作为该 slot 所有日计数的共同 PT 日期键。日期变化时同时清零 `daily_request_count` 和 `daily_failure_count`。

调度状态持久化版本建议由 2 升级为 3：

- 版本 3：读取并校验 `daily_failure_count` 为非负整数；
- 版本 2：保留当日请求数，新增今日失败从 0 开始；
- 版本 1：继续沿用现有迁移规则，请求数和失败数均从 0 开始；
- 累计 `request_count`、`success_count`、`failure_count` 不删除，避免影响 `least_used` 和状态兼容；
- 旧数据没有失败事件时间戳，升级当天不能可靠还原今日失败，必须在日志和发布说明中提示；下一个 PT 自然日起恢复完整口径。

## 8. 前端信息架构

### 8.1 预估额度区域

将当前单一额度条改为按模型排列的卡片或紧凑表格：

```text
预估剩余额度（太平洋时间今日）

gemini-3.7-flash    3,511 次
44 个账号 × 100/账号 · 今日尝试 889

gemini-3.8-flash    3,498 次
44 个账号 × 100/账号 · 今日尝试 902
```

交互要求：

- 不再显示所有模型总额度；
- 按模型名称稳定排序，模型增删时布局不跳动；
- 结果为 0 时正常显示 `0 次`，不能当作缺失值；
- 未知配额模型不显示在额度区，可在 tooltip 中说明“仅估算 Flash/Pro”；
- 小屏使用单列，大屏可使用自适应多列；
- tooltip 说明日界线、逐账号截断公式、外部用量不可见和失败尝试可能造成估算偏差。

### 8.2 Context 实时状态

Context 区域使用原生 `<details>` 或等价可访问折叠组件，默认关闭：

```text
▸ Context 实时状态
  READY 8 · BUSY 2 · 初始化 1 · 重连 0 · 不可用 0 / 11
```

展开后显示现有列：Context、状态、在途请求、WS Epoch、最近断线原因。

要求：

- 初次进入页面默认折叠；
- 折叠状态在本次页面会话中保持，5 秒数据刷新不能导致自动收起；
- 折叠时只轮询汇总计数，不请求 Context 行明细；
- 展开后立即请求一次明细，随后每 5 秒更新；
- 收起后停止请求明细并清理内存中的明细，避免旧断线原因长期驻留；
- 页面离开再返回时默认折叠，不要求跨会话持久化；
- 使用 `aria-expanded`、键盘可操作 summary，并为异常状态提供不仅依赖颜色的文字标识。

### 8.3 模型请求数表

模型汇总表调整为：

```text
模型 | 今日请求数（PT） | 可用账号 | 429 | 排队 | 逻辑执行槽 | Min / Preferred
```

删除：

- 累计成功；
- 累计失败。

后端轻量汇总也不再为新前端发送这两个累计字段。累计值继续保留在调度器内部和持久化文件中，不影响使用统计分页。

### 8.4 账号 × 模型详情

现有账号详情继续默认折叠。表格调整为：

```text
模型 | 状态 | 在途请求 | 今日请求数（PT） | 今日失败（PT） | 冷却截止 | 最近错误 | 操作
```

其中“今日失败（PT）”读取 `daily_failures`，不再读取 `failure_count`。账号详情展开时按需获取；折叠时不进入 5 秒实时响应。

为避免大量账号同时展开造成响应无界，前端采用以下策略：

- 外层“账号 × 模型详情”展开后先获取账号概要列表；
- 单个账号展开后才获取该账号的模型 slot；
- 仅刷新当前已展开账号；
- 可同时展开多个账号，但每轮请求明确携带账号 ID 列表，并设置合理上限，例如 20 个；超过上限时提示先收起部分账号。

## 9. 保持 5 秒实时性的低流量方案

### 9.1 单一、无重叠刷新器

前端只保留一个页面级刷新控制器：

```text
立即刷新当前分页所需数据
        ↓
等待本轮全部请求完成
        ↓
距离本轮开始满 5 秒时启动下一轮
```

实现约束：

- 页面挂载只调用一次 `startPolling()`；
- 固定目标周期为 5 秒，不再由两个初始化 Promise 各自启动定时器；
- 使用 `inFlight` 防重入；慢请求超过 5 秒时不并发叠加，完成后立即进入下一轮；
- 切换分页或展开/折叠时使用 `AbortController` 取消已无价值的请求；
- 组件卸载时取消定时器和进行中的请求；
- 页面处于 `document.hidden` 时可暂停网络轮询，恢复可见后立即刷新。该行为不损害用户正在查看页面时的 5 秒实时性；如业务要求后台标签也持续监控，可保留轮询，但仍必须遵守单链和无重叠规则。

### 9.2 按当前分页请求数据

建议把当前大而全的 `/api/status` 拆成用途明确的接口。也可以使用 `include` 参数实现同样效果，但返回字段必须有明确上限。

| 当前分页/状态 | 每 5 秒请求 | 不应传输 |
| --- | --- | --- |
| 首页 | `/api/dashboard/realtime` | 历史记录、日志全文、Context 行、账号 slot |
| 首页且 Context 展开 | 额外 `/api/scheduler/contexts` | 历史记录、账号 slot |
| 首页且账号详情展开 | 额外 `/api/scheduler/accounts?ids=...` | 未展开账号 slot |
| 使用统计 | `/api/usage-stats/summary`，以及当前第一页增量 | 全量历史记录 |
| 日志 | `/api/logs?after=<cursor>` | 每轮完整日志全文 |
| 设置 | `/api/status/core` 或仅需要的配置状态 | scheduler 全量、统计历史、日志 |

`/api/dashboard/realtime` 只包含：

- 基础服务在线状态；
- scheduler worker/queue/Context 汇总计数；
- metrics 汇总；
- `quota_by_model`；
- 精简后的模型汇总行；
- `usage_window`；
- 用于判断数据是否变化的 `revision` 或 `generated_at`。

### 9.3 Context 与账号详情按需加载

视觉折叠必须和数据请求联动：

- Context 默认折叠，所以首屏响应中 `contexts` 不存在，而不是返回后由 CSS 隐藏；
- 账号详情默认折叠，所以首屏响应中 `accounts[*].models` 不存在；
- 展开后的明细接口只返回 UI 实际使用字段，不传播内部累计计数、完整 account 对象或 worker/lease 引用；
- `last_error`、`last_disconnect_reason` 等自由文本继续设置最大长度，防止单条异常信息放大响应。

### 9.4 使用统计分页化

将当前 `/api/usage-stats` 拆为：

```http
GET /api/usage-stats/summary
GET /api/usage-stats/records?cursor=<opaque>&limit=20&filters=...
```

要求：

- summary 不包含 `records`；
- records 默认 20 条，`limit` 只允许 10、20、50、100；
- 时间范围、模型、账号、状态码、结果等筛选在后端执行；
- cursor 使用不透明稳定游标，不能依赖前端数组下标；
- 5 秒刷新只更新 summary 和当前第一页的新记录；用户停留在旧页时不反复刷新旧数据；
- 导入统计或服务重载导致数据集重建时，返回新的 `dataset_revision`，前端丢弃旧 cursor 并重新取第一页；
- 下载接口继续直接发送 JSONL 文件，不受分页影响。

如果首版暂时无法完成全部服务端筛选，最低可接受方案是“summary + 最近 N 条 + `after_sequence` 增量”，但绝不能继续每 5 秒返回全部历史。

### 9.5 日志增量

日志接口返回递增 cursor：

```json
{
    "cursor": 1842,
    "reset": false,
    "lines": ["...new line 1...", "...new line 2..."]
}
```

- 进入日志分页时首次获取配置上限内的最近日志；
- 后续只请求 cursor 之后的新增行；
- 服务重启或环形缓冲覆盖 cursor 时返回 `reset: true` 和新的最近窗口；
- 非日志分页只获取日志条数或告警摘要，不传日志正文。

### 9.6 HTTP 压缩与缓存

在 Nginx 或 Express 层为 JSON 启用 gzip/brotli，并对无变化的只读快照支持 ETag/`If-None-Match`。服务端数据 revision 未变化时可直接返回 `304`。

压缩和 304 是补充优化，不是主方案。即使开启压缩，也必须完成单轮询、按需明细和历史分页，否则后端仍会反复构造、序列化全量对象并消耗 CPU 和内存。

## 10. 建议接口契约

### 10.1 首页实时汇总

```http
GET /api/dashboard/realtime
```

示例：

```json
{
    "generated_at": "2026-09-11T08:10:05.000Z",
    "revision": "scheduler:9281",
    "status": {
        "service_connected": true,
        "browser_connected": true
    },
    "scheduler": {
        "active_workers": 0,
        "idle_workers": 2,
        "queued_requests": 0,
        "contexts_summary": {
            "ready": 8,
            "busy": 0,
            "initializing": 3,
            "reconnecting": 0,
            "unavailable": 0,
            "max": 11
        },
        "usage_window": {
            "date": "2026-09-11",
            "timezone": "America/Los_Angeles"
        },
        "quota_by_model": [],
        "models": []
    }
}
```

响应中不得包含 `logs`、`records`、`contexts`、`workers` 或完整 `accounts`。

### 10.2 Context 明细

```http
GET /api/scheduler/contexts
```

只返回：

```json
{
    "revision": "contexts:413",
    "contexts": [
        {
            "auth_index": 0,
            "state": "READY",
            "inflight": 0,
            "connection_epoch": 8,
            "last_disconnect_reason": null
        }
    ]
}
```

### 10.3 账号 × 模型明细

```http
GET /api/scheduler/accounts?ids=0,1,2
```

slot 对外字段应使用展示语义名称，例如：

```json
{
    "model": "gemini-3.7-flash",
    "status": "HEALTHY",
    "inflight": 0,
    "daily_requests": 4,
    "daily_failures": 1,
    "cooldown_until": null,
    "last_error": null
}
```

不返回 `request_count`、`success_count`、`failure_count` 等新 UI 不再使用的累计字段。

## 11. 后端实现建议

1. 将当前 `snapshot()` 拆为轻量汇总和明细构造器，例如：
   - `summarySnapshot()`；
   - `contextsSnapshot()`；
   - `accountsSnapshot(indices)`。
2. 三个构造器复用同一套日期日切、模型状态和字段裁剪辅助函数，避免不同接口口径漂移。
3. `summarySnapshot()` 计算 `quota_by_model`，旧 `snapshot()` 在兼容期可组合三个构造器。
4. slot 新增并持久化 `daily_failure_count`；`failure()` 复用日切后递增。
5. 使用统计新增不含 records 的 summary，以及支持 cursor、limit、过滤条件的记录查询。
6. 日志缓冲中的每一行附加单调递增序号，为增量接口提供 cursor。
7. 对明细查询的账号 ID、分页 limit、文本长度和筛选条件设置服务端上限，确保响应有界。
8. `/api/status` 兼容旧前端时可暂时保留原响应，但新前端应完全切换到轻量接口；确认无旧客户端后再移除全量 scheduler 和日志正文。

## 12. 前端状态与异常处理

- 各数据片段独立保存 `loading`、`error`、`updatedAt`，Context 请求失败不能让整个首页显示离线。
- 轮询失败采用有限退避，但网络恢复后立即恢复 5 秒周期；成功状态下始终维持 5 秒刷新。
- 新响应只替换对应片段，不因 Context 明细失败清空模型汇总。
- 使用请求序号或 AbortController 防止较旧响应覆盖较新状态。
- 日切后以后端 `usage_window.date` 为准，清除前端缓存的上一日明细和统计摘要。
- `304` 视为成功刷新，不更新 DOM 大对象。
- 折叠组件的开关状态属于 UI 状态，不能被 5 秒返回的数据对象覆盖。

## 13. 测试方案

### 13.1 调度器单元测试

- 两个 Flash 模型生成两个独立额度项，不生成总额度展示依赖。
- 同一模型按每账号 `max(0, limit - daily)` 后求和。
- Flash、Flash Lite、Pro 和未知类型模型匹配正确。
- expired、重复、无效账号不进入额度基数；临时不可用账号仍进入。
- 今日请求在 PST、PDT 以及夏令时切换日正确日切。
- 上游失败递增 `daily_failure_count`；成功、本地传输错误、用户取消不递增。
- PT 午夜后今日请求和今日失败同时清零，累计字段保持不变。
- 状态版本 1、2、3 均能安全加载，迁移不丢累计字段。

### 13.2 路由测试

- `/api/dashboard/realtime` 不包含日志、历史记录、Context 行和账号 slot。
- Context、账号明细接口要求认证，并只返回允许字段。
- 账号 IDs 数量超限、非法 ID 和 records limit 超限时返回 400。
- 使用统计 summary 不包含 records；records 分页顺序稳定且无重复/遗漏。
- 导入统计后 `dataset_revision` 变化，旧 cursor 得到明确的重置响应。
- 日志 cursor 正常增量、缓冲覆盖和服务重启场景正确返回。
- ETag 未变化时返回 304。

### 13.3 前端测试

- 页面挂载后只有一个 5 秒刷新循环。
- 请求耗时超过 5 秒时不会出现同类并发请求。
- 切换分页后不再请求离开分页的大数据接口。
- Context 默认折叠；折叠时不请求明细，展开后立即请求并每 5 秒刷新。
- 账号详情只请求已展开账号，收起后停止请求。
- 模型汇总不存在累计成功、累计失败列。
- 账号 × 模型列显示今日失败，且读取 `daily_failures`。
- 额度区按模型分别显示，0、未知模型、模型新增/删除状态正确。
- PT 日切后无需刷新浏览器即可显示新日期和归零数据。

### 13.4 性能与流量测试

准备 1 万、10 万和 100 万条 usage records，并保持相同账号和模型数量：

1. 打开首页持续 60 秒，记录请求数、Transferred、响应大小和后端序列化耗时。
2. 验证三种历史规模下首页每轮响应大小基本一致。
3. 验证 60 秒内实时刷新约 12 轮，而不是约 24 轮。
4. Context 折叠/展开各测试 60 秒，确认只有展开时产生明细流量。
5. 进入统计分页，验证只传 summary、当前页和新增记录。
6. 进入日志分页，验证第二轮起只返回增量日志。
7. 使用慢网络模拟请求超过 5 秒，确认没有请求堆积。
8. 对比优化前后浏览器 Network 总流量、Node CPU、堆内存和事件循环延迟。

## 14. 验收标准

1. 可见页面的实时状态在正常网络下每 5 秒更新一次。
2. 页面不存在双轮询；同类请求任意时刻最多一个在途。
3. 首页轮询响应大小与 `usage-stats.jsonl` 的记录数量无关。
4. 非使用统计分页不请求 usage records；统计分页不下载全量历史。
5. 非日志分页不传输日志正文；日志分页只增量传输新增日志。
6. 额度区为每个真实模型显示独立的预估剩余额度，不显示模型总和。
7. `gemini-3.7-flash` 与 `gemini-3.8-flash` 分别计算、分别展示。
8. Context 默认折叠，折叠时不传输行明细，展开时保持 5 秒刷新。
9. 模型汇总表删除累计成功和累计失败。
10. 账号 × 模型详情显示今日失败（PT），不显示累计失败。
11. 今日请求、今日失败和额度窗口均在 `America/Los_Angeles` 00:00 日切，并正确处理 PST/PDT。
12. 在约定性能数据集上，首页持续流量相比当前版本下降至少 90%，且监控刷新频率没有降低。
13. JSONL 下载、导入、现有恢复按钮和调度行为保持可用。

## 15. 实施顺序

建议分为三个可独立验证的阶段：

1. **先消除流量放大**：修复双轮询、按分页请求、拆分轻量首页快照、统计分页/增量、日志增量。
2. **再调整调度口径**：增加今日失败、分模型额度字段和状态版本迁移。
3. **最后完成 UI**：额度分模型展示、Context 默认折叠、表格删列/改列、响应式和可访问性处理。

每个阶段都应执行 `npm test`、`npm run lint`、`npm run build:ui`，并在第三阶段完成浏览器 Network 的 60 秒流量验收。

## 16. 风险与注意事项

- 首次从旧状态升级时无法从累计失败精确还原当日失败；只能从升级时刻开始统计，到下一个 PT 自然日后完全准确。
- 服务端分页会把当前前端的大量客户端过滤迁移到后端，需要确保所有筛选组合和排序语义保持一致。
- 多进程实例使用相同 Google 账号但不共享调度状态时，各实例只能估算自己的使用量，余额仍可能高估。
- ETag、压缩或 WebSocket/SSE 都不能替代响应裁剪。首选 5 秒轻量 HTTP 轮询，结构简单、故障边界清楚；只有未来需要亚秒级推送时再评估 SSE/WebSocket。
- `/api/status` 当前每次还会重新扫描 auth source。它主要影响磁盘和 CPU，而非本次 10 MB/s 的核心网络问题；实施时可以增加文件变更检测，但不应阻塞本轮流量改造。
