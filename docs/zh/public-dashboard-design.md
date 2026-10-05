# 公益站公开用量看板设计方案

## 1. 文档目的

本文设计一个面向公益站使用者的独立、匿名、只读公示前端，用于公开模型额度估算、实时调度负载和历史请求质量。

该前端不是管理面板的匿名模式，也不是管理接口的裁剪版路由。它使用独立端口、独立静态资源和单一只读 API，通过后端的公开数据投影层取得经过白名单筛选与聚合的数据。公开服务不得读取认证文件，不得返回账号标识，不得提供任何写操作，也不得复用管理面板的会话、路由或页面组件。

本文基于当前项目已有能力设计：

- `ModelScheduler.summarySnapshot()` 已提供可见模型的额度估算、今日请求、可用账号、429 账号、排队数和执行数；
- 调度器的 `hiddenModels` 已负责过滤管理面板隐藏模型；
- `UsageStatsService` 已维护全局及分模型历史请求聚合；
- 主服务当前由 `ProxyServerSystem` 创建 API/管理 HTTP 服务及内部 WebSocket 服务。

## 2. 目标

### 2.1 功能目标

公开页面至少展示：

1. 每个可见模型的预估剩余额度，并醒目标注“预估值，可能与实际额度不同”；
2. 每个可见模型的今日请求数、可用账号数、额度耗尽（429）账号数、排队请求数、正在执行请求数；
3. 全局正在执行数和全局并发上限；
4. 全部历史请求数、成功率、失败数、平均耗时；
5. 每个可见模型的历史请求数、成功率、失败数、平均耗时；
6. 使用普通用户容易理解的中文名词；
7. 公开模型集合始终与管理面板当前的可见模型集合一致。

### 2.2 安全目标

1. 默认关闭公开看板；
2. 公开服务仅接受 `GET`、`HEAD` 和 `OPTIONS`；
3. 不暴露管理登录、管理 API、代理 API、VNC、内部 WebSocket 或文件下载能力；
4. 不返回账号名、邮箱、账号索引、账号 key、认证文件、Cookie、API Key、客户端 IP、请求内容、错误原文、日志或内部 Context 状态；
5. 即使未来管理接口新增敏感字段，公开响应也不会自动携带这些字段；
6. 公开前端不持有管理凭证，也不调用管理端口。

### 2.3 非目标

本方案不包含：

- 修改请求调度、账号轮换、重试或 429 冷却规则；
- 修改管理面板现有功能；
- 向公众公开逐账号信息或逐请求记录；
- 提供按账号、IP、API Key 或用户维度的统计；
- 承诺预估额度与 Google 实际额度完全一致；
- 将“隐藏模型”变成“禁止调用模型”；
- 在浏览器端直接读取 `scheduler-state.json` 或 `usage-stats.jsonl`。

## 3. 用户可见的信息架构

页面采用单页只读看板，无登录框、设置入口和操作按钮。

### 3.1 页面顶部

展示：

- 标题：`服务用量公示`；
- 数据更新时间；
- 状态：`数据正常`、`部分统计不可用` 或 `暂时无法获取数据`；
- 固定提示：`额度为本服务根据可观测请求估算的参考值，可能与实际额度存在差异。`；
- 统计日说明：`“今日”按太平洋时间（PT）计算。`。

不得展示服务版本、管理端地址、服务器地址、内部端口、运行环境或启动参数。

### 3.2 全局概览

使用五张概览卡：

| 页面名称 | 展示格式  | 含义                                    |
| -------- | --------- | --------------------------------------- |
| 正在执行 | `8 / 24`  | 当前占用的全局逻辑执行槽 / 全局并发上限 |
| 历史请求 | `128,520` | 已完成并纳入使用统计的逻辑 API 请求总数 |
| 成功率   | `98.7%`   | 历史成功请求数 / 历史请求总数           |
| 失败请求 | `1,671`   | 历史错误请求与用户中止请求之和          |
| 平均耗时 | `4.2 秒`  | 全部历史请求从进入服务到结束的平均耗时  |

“正在执行”可以和其余四项排成五张卡，也可在窄屏单独占一行。页面不展示“活跃账号”“账号总数”等非必要全局信息。

### 3.3 模型额度与实时状态

每个可见模型使用一张卡片，展示：

- 模型名；
- `预估剩余额度`；
- 今日请求；
- 可用账号；
- 额度耗尽账号；
- 排队请求；
- 正在执行。

建议文案示例：

```text
gemini-3.7-flash
预估剩余额度  3,511 次  [预估]

今日请求       889
可用账号        40
额度耗尽账号     4
排队请求         2
正在执行         3
```

额度无法估算的可见模型仍应展示实时状态，其额度位置显示 `暂无法估算`，不得显示 `0`。真正估算为零时显示 `0 次`。

### 3.4 分模型统计

展示模型、请求数、成功率、失败请求数和平均耗时，支持“历史 / 近 24 小时 / 近 1 小时”，默认近 24 小时。选择只影响底部表格，顶部全局概览仍为累计历史，额度卡片仍为今日请求与实时状态。

近期窗口按已完成逻辑请求的 `finished_at_ms` 滚动计算，下界包含、上界排除；失败数合并错误与用户中止，平均耗时包含所有结果。可见模型无请求时计数为零，成功率与耗时为 `null`；统计关闭或查询失败时所有值为 `null`，分别标记 `disabled` 与 `unavailable`。

接口保持 `schema_version: 1` 和原有历史字段，新增 `model_stat_windows` 元数据与 `models[].recent_stats`，一次返回两个近期范围。完整口径与接口见 [分模型统计时间范围方案](./public-dashboard-model-time-windows-design.md)。旧后端缺少新增字段时仅展示历史，禁用近期按钮并提示不支持；整体请求失败时保留原快照和更新时间。

### 3.5 明确不展示的内容

以下内容对公众无意义或具有安全风险，不能出现在页面、HTML 注释、浏览器日志、接口响应或 source map 中：

- Context 的 READY、BUSY、INITIALIZING、RECONNECTING、UNAVAILABLE 状态；
- Context 数量、连接 epoch、断线原因；
- worker ID、Context ID、账号 ID、账号索引；
- 账号健康状态、邮箱、昵称、文件名和逐账号模型状态；
- 累计本地传输错误、上游错误原文、调度超时诊断和内部 timing 指标；
- 请求路径、客户端 IP、请求 ID、请求正文和逐请求历史；
- 管理操作和“一键重置 429”等按钮。

## 4. 指标定义

公开页面必须给出稳定口径，避免把“逻辑请求”和“上游尝试”混为一谈。

### 4.1 今日请求

来源为调度器模型 slot 的 `daily_request_count` 汇总，按 `America/Los_Angeles` 自然日计算。

一次用户 API 请求若发生换账号重试，每次真正发往上游的尝试都会计数。因此页面帮助文本使用：

> 今日请求：今天实际发往模型的请求次数；重试会重复计数。

### 4.2 预估剩余额度

沿用当前调度器规则，对模型 `M`：

```text
预估剩余额度(M) = Σ max(0, 单账号每日估算上限(M) - 该账号今日请求数(M))
```

当前可估算规则为 Flash 每账号每模型 100 次、Pro 每账号每模型 10 次；具体计算继续由调度器负责，公开层不得复制另一套配额规则。

页面必须始终显示以下说明：

> 预估额度仅供参考。外部用量、Google 配额调整、失败重试及统计延迟都可能造成偏差，以实际上游结果为准。

### 4.3 可用账号

来源为 `summarySnapshot().models[*].available_accounts`，表示当前符合调度条件、可被该模型选择的账号数量。该数字仅为聚合数量，不得提供对应账号列表。

### 4.4 额度耗尽账号

来源为 `rate_limited_accounts`，表示该模型当前被调度器标记为 429 的账号数量。页面使用“额度耗尽账号”作为易懂名称，并用帮助文本说明：

> 指当前因上游返回 429 而暂不可用的账号数，不代表永久失效。

### 4.5 排队请求与正在执行

- 分模型“排队请求”来源为 `queue_length`；
- 分模型“正在执行”来源为 `active_workers`；
- 全局“正在执行”来源为所有已占用逻辑 worker 数；
- 全局并发上限来源为 `GLOBAL_MAX_CONCURRENCY` 对应的 worker 总数。

公开接口需要直接返回全局并发上限，不让前端通过 `正在执行 + 空闲槽` 推算。

### 4.6 历史统计

历史统计来源为 `UsageStatsService` 的已完成逻辑请求聚合：

```text
历史请求数 = successCount + errorCount + abortedCount
失败请求数 = errorCount + abortedCount
成功率     = totalRequests == 0 ? null : successCount / totalRequests × 100%
平均耗时   = totalDurationMs / totalRequests
```

公开页面不单列“已中止”。将中止合并进“失败请求”后，满足 `历史请求数 = 成功请求数 + 失败请求数`，也避免向普通用户引入内部状态名。平均耗时包含成功、错误和中止请求，与当前使用统计服务的总平均口径一致。

如果 `ENABLE_USAGE_STATS=false`，历史统计整体标记为 `未启用统计`，字段返回 `null`，不得用一组零值伪装成“从未收到请求”。实时调度数据仍可正常展示。

## 5. 总体架构

```text
公众浏览器
    │ 仅访问 PUBLIC_DASHBOARD_PORT
    ▼
PublicDashboardServer（独立 Express app / 独立 HTTP server）
    ├── GET /                    独立静态前端
    ├── GET /assets/*            公开前端资源
    ├── GET /api/public/dashboard
    └── GET /healthz             仅返回公开服务存活状态
             │
             ▼
PublicDashboardService（纯只读投影）
    ├── ModelScheduler.summarySnapshot()
    └── UsageStatsService.getPublicSummarySnapshot(visibleModels)

管理域名 / PORT
    └── 原有管理面板、管理 API、模型 API、VNC

内部 WS_PORT
    └── 浏览器 Context 通信
```

隔离原则：

1. 公开服务创建新的 Express 实例，不能把主服务的 `app` 监听到第二个端口；否则第二个端口仍会暴露全部管理和代理路由；
2. 公开 Express 实例不调用 `WebRoutes.setupSession()`，不挂载 `AuthRoutes`、`StatusRoutes`、API Key 中间件或通配代理路由；
3. 公开服务只持有调度器和使用统计服务的只读查询引用，不持有 `AuthSource`、`BrowserManager`、`RequestHandler`、日志服务或认证文件路径；
4. 公开前端使用自己的构建目录，不能复用包含登录、账号管理、VNC 和设置页面的 `ui/dist`；
5. 公开 API 只返回新建 DTO，不得直接 `res.json(summarySnapshot)` 或 `res.json(getSummarySnapshot())`。

建议新增文件：

```text
src/public/PublicDashboardServer.js
src/public/PublicDashboardService.js
ui-public/app/index.html
ui-public/app/index.js
ui-public/app/App.vue
ui-public/app/styles.less
vite.public.config.js
tests/public-dashboard.test.js
```

公开静态产物输出到 `ui-public/dist/`。生产构建脚本同时构建管理前端和公开前端；公开功能关闭时可以仍生成静态产物，但不得启动监听端口。

## 6. 配置设计

新增环境变量：

```dotenv
# 是否启用匿名只读的公益站用量公示页。默认关闭。
PUBLIC_DASHBOARD_ENABLED=false

# 公示页独立 HTTP 端口。不得与 PORT 或内部 WS 端口相同。
PUBLIC_DASHBOARD_PORT=7861

# 公示页监听地址。默认继承 HOST；生产环境可按网络拓扑设置。
PUBLIC_DASHBOARD_HOST=0.0.0.0

# 可选：允许跨域读取公开 JSON 的 Origin，逗号分隔。留空表示仅同源。
PUBLIC_DASHBOARD_CORS_ORIGINS=
```

`ConfigLoader` 中增加：

```js
config.publicDashboard = {
  enabled: false,
  host: config.host,
  port: 7861,
  corsOrigins: [],
};
```

校验要求：

- `PUBLIC_DASHBOARD_ENABLED` 只有不区分大小写的 `true` 才表示开启；
- 端口必须是 `1..65535` 的整数；
- 公开端口不得等于 `PORT` 或 `WS_PORT`；
- Origin 必须是合法的 `http:` 或 `https:` origin，不接受路径、通配子域或凭证；
- 配置错误时启动失败并给出明确日志，不静默退回管理端口；
- 开启公开看板但 `ENABLE_USAGE_STATS=false` 是允许的，只是历史区域显示未启用。

不设计“公开 API Key”。这是匿名公示页；访问控制、TLS、DDoS 防护和地域限制应在独立域名对应的反向代理/CDN 层完成。

## 7. 公开 API

### 7.1 接口

```http
GET /api/public/dashboard
Accept: application/json
```

成功响应示例：

```json
{
  "schema_version": 1,
  "generated_at": "2026-09-11T08:30:05.123Z",
  "usage_window": {
    "date": "2026-09-11",
    "timezone": "America/Los_Angeles"
  },
  "disclaimer": "estimated_quota_may_differ_from_actual",
  "realtime": {
    "active": 8,
    "limit": 24,
    "queued": 3
  },
  "history": {
    "enabled": true,
    "total_requests": 128520,
    "failed_requests": 1671,
    "success_rate": 98.7,
    "average_duration_ms": 4230
  },
  "models": [
    {
      "model": "gemini-3.7-flash",
      "quota": {
        "estimated_remaining": 3511,
        "estimable": true
      },
      "today": {
        "requests": 889
      },
      "realtime": {
        "available_accounts": 40,
        "rate_limited_accounts": 4,
        "queued": 2,
        "active": 3
      },
      "history": {
        "total_requests": 50120,
        "failed_requests": 401,
        "success_rate": 99.2,
        "average_duration_ms": 3800
      }
    }
  ]
}
```

### 7.2 字段约束

- 所有计数必须是非负安全整数；
- `success_rate` 为 `0..100` 的一位小数；无历史请求时为 `null`；
- `average_duration_ms` 为非负整数；无历史请求或未启用统计时为 `null`；
- 不可估算额度时 `estimable=false` 且 `estimated_remaining=null`；
- 模型名是唯一允许返回的字符串型业务标识；
- `disclaimer` 使用稳定枚举，具体中文由前端本地文案渲染；
- `schema_version` 用于以后兼容演进，现有字段不得在同一版本内改变语义。

### 7.3 HTTP 行为

- 支持 `ETag` 和 `If-None-Match`，无变化时返回 `304`；
- `Cache-Control: public, max-age=2, must-revalidate`，允许短暂缓存削峰但保持近实时；
- 响应启用压缩时由反向代理或统一中间件处理；
- 公开前端每 5 秒轮询一次，上一轮未完成时不启动下一轮；
- 页面处于后台时可降低轮询频率，重新可见后立即刷新；
- API 异常时保留最后一次成功数据并显示“数据更新时间”，不得把旧数据伪装成实时数据；
- 不提供任意字段选择、模型过滤表达式、分页、文件路径或透传 URL 参数。

### 7.4 失败响应

失败响应只允许稳定、无内部细节的结构：

```json
{
  "error": "dashboard_temporarily_unavailable"
}
```

不得返回异常堆栈、文件路径、配置内容、上游错误、账号信息或原始 `error.message`。

## 8. 公开数据投影

### 8.1 可见模型的唯一来源

`PublicDashboardService` 每次生成响应时先调用 `scheduler.summarySnapshot()`，其 `models` 已基于 `_visibleSnapshotModels()` 过滤。公开层以 `schedulerSnapshot.models[*].model` 构造唯一可见集合。

不要使用以下数据作为公开模型集合：

- `configs/models.json`：它是对外模型目录，不等同于调度面板显示集合；
- `UsageStatsService.models`：其中可能存在旧模型、空模型或隐藏模型；
- 前端硬编码列表：无法随管理端隐藏/恢复操作同步。

因此，管理员在现有管理面板隐藏模型后，下一次公开轮询即消失；恢复显示后下一次轮询即重新出现，无需新增第二套公开隐藏配置。

调度器为 legacy 模式时没有调度面板可见模型集合。此时公开响应返回空 `models`、`realtime.active=0`、`realtime.limit=0`，页面提示“模型实时统计未启用”；不得退回 `modelList` 猜测模型集合。

### 8.2 历史统计安全方法

现有 `getSummarySnapshot()` 返回 `accounts`，其内部包含账号名、账号索引、账号 key 和按账号模型计数，不能被公开路由使用。

在 `UsageStatsService` 新增专用方法：

```js
getPublicSummarySnapshot(visibleModels);
```

该方法只构造：

```text
enabled
summary.{totalRequests, failedRequests, successRate, avgDurationMs}
models[].{modelKey, totalRequests, failedRequests, successRate, avgDurationMs}
```

实现时从内部 `summary` 和 `modelStats` 读取数字，并按 `visibleModels` 白名单逐项复制。禁止先取得完整 `getSummarySnapshot()` 再通过删除字段脱敏；删除式黑名单容易在将来新增字段时漏删。

历史统计不返回 `accounts`、`accountCounts`、`startedAt`、分格式统计、路径、记录、活跃请求元数据或 dataset revision。公开层只关心聚合数。

### 8.3 DTO 组装

DTO 组装采用显式字段赋值，不使用对象展开：

```js
const publicModel = {
  model: model.model,
  quota: {/* 仅复制额度数值 */},
  today: { requests: model.daily_requests },
  realtime: {/* 仅复制五个聚合计数 */},
  history: {/* 仅复制安全历史聚合 */},
};
```

禁止：

```js
{ ...schedulerModel }
{ ...usageModel }
delete response.accounts
```

这些写法会让上游对象未来新增的敏感字段自动流入公开 API。

## 9. 服务生命周期与故障策略

`ProxyServerSystem` 增加 `publicDashboardServer` 成员。

启动顺序建议：

1. 加载并校验全部配置；
2. 启动主 HTTP 服务；
3. 启动内部 WebSocket 服务；
4. 若公开功能开启，创建并启动公开 HTTP 服务；
5. 任一已配置监听端口启动失败，整体启动失败，并关闭此前已启动的 server，避免进入只有部分服务工作的未知状态。

关闭时将公开 HTTP server 纳入现有 `Promise.all(closeServer(...))`，停止接收新连接并完成优雅关闭。

公开数据查询使用只读调度快照、累计内存聚合以及 SQLite worker 内的异步近期聚合：

- 不触发账号重载；
- 不初始化 Context；
- 不调用 `slot()` 创建缺失状态；
- 不读认证目录；
- 不扫描 JSONL 文件；
- 不改变调度 sequence；
- 不持有跨请求的可变账号对象引用。

注意：当前 `summarySnapshot()` 为计算额度可能调用 `slot()`。实现公开看板前应将“只读汇总”改为读取已有 slot，缺失 slot 按零值计算，或抽出保证无副作用的公共快照方法。公开 GET 请求不应导致调度状态创建或持久化。

## 10. 前端实现约束

### 10.1 独立构建

公开前端不得导入管理端的：

- router；
- `StatusPage.vue`、`SchedulerStatus.vue`、`AuthPage.vue` 或 `LoginPage.vue`；
- 管理 i18n 文案包；
- 账号、日志、VNC、设置相关组件；
- 管理 API 请求工具。

可以复用纯视觉变量，但建议复制一份最小公开主题，避免管理端后续依赖被意外打入公开 bundle。生产构建关闭 source map。

### 10.2 页面状态

前端至少处理：

- 首次加载；
- 正常数据；
- 历史统计未启用；
- 调度器未启用；
- 接口暂时失败但存在旧数据；
- 接口失败且无旧数据；
- 空模型列表；
- 某模型额度不可估算；
- 窄屏表格横向滚动或卡片化。

数值格式统一使用 `Intl.NumberFormat`。耗时小于 1000 ms 显示毫秒，大于等于 1000 ms 显示最多一位小数的秒。颜色只作为辅助，429、失败和状态必须同时有文字或图标。

### 10.3 易懂文案映射

| 内部字段                    | 公开名称     |
| --------------------------- | ------------ |
| `active_workers`            | 正在执行     |
| `globalConcurrency`         | 并发上限     |
| `queue_length`              | 排队请求     |
| `available_accounts`        | 可用账号     |
| `rate_limited_accounts`     | 额度耗尽账号 |
| `daily_requests`            | 今日请求     |
| `estimated_remaining_quota` | 预估剩余额度 |
| `totalRequests`             | 历史请求     |
| `errorCount + abortedCount` | 失败请求     |
| `avgDurationMs`             | 平均耗时     |

页面不出现 `Context`、`worker`、`slot`、`inflight`、`rate limited`、`aborted`、`PT date key` 等内部术语。

## 11. 安全设计

### 11.1 路由隔离

公开 server 使用肯定式路由表，仅注册以下路径：

```text
GET|HEAD /
GET|HEAD /assets/<构建产物>
GET|HEAD /api/public/dashboard
GET|HEAD /healthz
OPTIONS /api/public/dashboard（仅配置跨域时需要）
```

其他路径统一返回 `404`。非允许方法统一返回 `405` 并带 `Allow: GET, HEAD`。不能注册主服务的 `app.all(/(.*)/, ...)`。

### 11.2 响应头

建议至少设置：

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cross-Origin-Resource-Policy: same-origin
```

默认不发送 `Access-Control-Allow-Origin`。配置允许跨域时按精确 Origin 白名单回显并添加 `Vary: Origin`，不允许 credentials。

### 11.3 账号信息零泄露规则

以下键名及其命名变体应被视为禁止字段：

```text
account, accounts, accountName, accountKey, authIndex, auth_index,
email, cookie, token, apiKey, clientIp, requestId, attempts,
path, errorMessage, last_error, logs, contexts, workers
```

例外只有三个明确批准的聚合计数：

```text
available_accounts
rate_limited_accounts
tracked_accounts（当前 API 方案不返回，保留为测试白名单说明）
```

禁止字段扫描测试必须递归遍历完整公开 JSON 的键和值。测试值中放入醒目的 canary 账号名、邮箱、IP、文件名、API Key 和错误文本，断言响应序列化后均不存在。

### 11.4 前端供应链与信息泄露

- 不加载第三方 CDN 字体、统计脚本、图标或埋点；
- 不在浏览器存储数据和身份标识；
- 不使用 Cookie；
- 不在公开页面输出接口原始异常；
- 不发布 source map；
- favicon、Logo 等资源必须来自公开前端自己的静态目录；
- 反向代理访问日志若需保留，应按公益站隐私策略限制留存期，这不属于公开 API 数据。

### 11.5 滥用防护

公开 JSON 可以被匿名抓取，因此：

- 使用 2 秒公共缓存和 ETag 降低重复计算；
- 在反向代理/CDN 对 `/api/public/dashboard` 设置合理的单 IP 限速；
- 限制响应体大小，例如 256 KiB；模型数异常增长并超限时记录服务端告警并返回通用错误；
- 不把限流器状态、客户端 IP 或封禁原因返回给调用方。

## 12. 缓存、一致性与性能

`PublicDashboardService.getSnapshot()` 为异步方法，按 1 秒 TTL 缓存最终安全 DTO；缓存过期时共享正在构建的 Promise，失败后释放以便重试。每次调用和构建完成时检查调度器可见模型集合，变化后失效缓存和待完成结果。近期查询失败仅将近期状态标为 `unavailable`，完整快照失败才返回 503。

快照一致性要求：

- 单次响应内的可见模型集合先固定，再据此读取额度、实时与历史聚合；
- 同一个模型的今日请求和额度来自同一次调度快照；
- 全局历史与分模型历史来自同一次使用统计快照；
- 账号状态在组装期间变化是允许的，但不能返回负数或结构不完整数据；
- 不要求跨调度器和历史服务的严格事务一致性；构建时固定 `asOfMs`，`generated_at` 与两个近期窗口的 `to` 完全相同，缓存命中时保留全部时间与指标。

性能目标：

- 公开响应大小只随可见模型数增长，不随账号数或历史记录数增长；
- 主线程生成响应不遍历请求明细；worker 通过现有完成时间索引一次扫描近 24 小时明细，条件聚合两个窗口；
- 典型 50 个模型时，未压缩响应应明显低于 256 KiB；
- 5 秒轮询下不会创建第二条重叠轮询链；
- 历史投影为 `O(可见模型数)`；近期查询成本随近 24 小时明细数增长，缓存与并发合并避免重复扫描。明细保留配置为整数天，`0` 表示永久保留，最短非零值为 1 天。

## 13. 测试方案

### 13.1 配置测试

- 默认配置不启动公开端口；
- `PUBLIC_DASHBOARD_ENABLED=true` 时启动独立端口；
- 非法端口、端口与主服务冲突、端口与 WS 冲突时启动失败；
- CORS Origin 非法时启动失败；
- 公开服务关闭时端口不监听。

### 13.2 路由隔离测试

对公开端口验证：

- `/`、公开静态资源和 `/api/public/dashboard` 可访问；
- `/api/status`、`/api/scheduler`、`/api/usage-stats`、`/api/accounts`、`/api/files`、`/login`、`/auth`、`/vnc`、`/v1/models` 及模型生成端点全部为 `404`；
- 对公开 API 的 `POST`、`PUT`、`PATCH`、`DELETE` 均为 `405`；
- 公开端口不接受 WebSocket upgrade；
- 管理端口原有认证和功能不受影响。

### 13.3 模型一致性测试

- 调度面板显示模型 A、B 时，公开接口只含 A、B；
- 管理员隐藏 B 后，公开接口只含 A；
- B 有大量历史数据时仍不能出现；
- 恢复 B 后，额度、实时和历史数据重新出现；
- 历史服务存在模型 C、`unknown` 和空模型时均不出现；
- 可见模型无历史数据时返回零计数和 `null` 成功率；
- 不可估算模型返回 `estimable=false`，不是零额度。

### 13.4 指标口径测试

- PT 跨日后今日请求归零，历史统计不归零；
- 一次逻辑请求重试两次：今日请求增加两次，历史请求只增加一次；
- 429 slot 正确计入额度耗尽账号数；
- 成功、错误、中止混合时，失败数及成功率公式正确；
- 无历史请求时成功率和平均耗时为 `null`；
- `ENABLE_USAGE_STATS=false` 时返回 `history.enabled=false` 及空历史字段；
- 全局正在执行和并发上限与调度器一致。

### 13.5 泄露测试

构造包含以下 canary 的内部状态：

```text
accountName = PUBLIC_MUST_NOT_SEE_ACCOUNT
email       = public-must-not-see@example.com
clientIp    = 203.0.113.99
apiKey      = PUBLIC_MUST_NOT_SEE_KEY
error       = /secret/configs/auth/auth-7.json
```

序列化公开 HTML、JS 和 JSON，断言上述字符串不存在；递归断言禁止字段不存在。再给调度与使用统计对象增加一个模拟敏感新字段，确认白名单 DTO 不会将其带出。

### 13.6 前端测试

- 首次加载、失败重试、旧数据提示正确；
- 预估声明在桌面端和移动端均无需交互即可看到；
- 0 与“不可估算”显示不同；
- 数字、百分比和耗时格式正确；
- 5 秒轮询不会重叠；
- 页面销毁时清除定时器并中止在途请求；
- 键盘导航、屏幕阅读器标签和颜色对比度满足基本可访问性要求。

## 14. 部署建议

推荐使用两个不同域名分别反代两个端口：

```text
status.example.org  -> 127.0.0.1:7861  # 公开看板
admin.example.org   -> 127.0.0.1:7860  # 管理面板与 API，继续鉴权
```

反向代理必须使用显式 upstream，不能让公开域名按路径回退到管理端口。公开域名不配置 `/vnc` WebSocket 转发，也不转发到内部 `9998` 端口。

容器部署时仅按需映射公开端口；管理端口应通过防火墙、私网、VPN 或额外访问控制保护。若 API 客户端还需访问主端口，应为 API 域名和管理域名分别配置访问策略，但这不改变公开看板的端口隔离要求。

## 15. 实施顺序

1. 在 `ConfigLoader` 和 `.env.example` 增加公开看板配置及冲突校验；
2. 为调度器整理无副作用的公开实时快照，明确返回全局并发上限；
3. 为 `UsageStatsService` 增加白名单式公开历史聚合方法；
4. 实现 `PublicDashboardService`，完成可见模型关联、指标归一化和安全 DTO；
5. 实现独立 `PublicDashboardServer`、安全响应头、ETag、缓存和路由白名单；
6. 将公开 server 接入主系统启动、失败回滚和优雅关闭；
7. 创建独立公开前端及独立 Vite 构建配置；
8. 增加配置、隔离、一致性、指标、泄露、性能和前端测试；
9. 更新 `package.json` 构建脚本、README、Docker 端口说明和 Nginx 示例；
10. 先在测试域名验证，再将 `PUBLIC_DASHBOARD_ENABLED` 设为 `true` 上线。

## 16. 验收标准

满足以下全部条件方可上线：

- 公开功能默认关闭，配置开启后只在独立端口提供服务；
- 公开端口无法访问任何管理、代理、VNC、账号、文件、日志和逐请求接口；
- 页面完整展示需求中的额度、模型实时状态、全局并发、全局历史和分模型历史指标；
- 所有额度位置均明确标注为预估，且页面可见说明包含偏差原因；
- 公开模型集合与管理调度面板可见模型集合一致，隐藏与恢复在下一轮刷新后生效；
- 页面和接口均不包含 Context 状态及其他内部诊断信息；
- 页面、静态资源和 JSON 中不存在账号身份信息、账号索引、认证材料、IP、日志、错误原文或请求明细；
- 公开 API 采用显式白名单 DTO，并通过新增敏感字段不会泄露的回归测试；
- 历史统计关闭、空数据、legacy 调度、不可估算额度和接口故障均有明确且不误导的页面状态；
- 响应大小只随可见模型数增长，不随账号数及历史记录总量增长；
- 服务启动失败能够回滚，关闭流程能够同时关闭公开端口。
