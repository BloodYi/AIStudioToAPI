# Mihomo 节点池与账号出口管理改造方案

## 1. 文档状态

- 状态：设计草案
- 目标项目：AIStudioToAPI
- 实施方式：分两个阶段交付
- 第一阶段重点：手工管理节点与账号出口，不自动切换运行中的账号代理
- 第二阶段重点：订阅、健康检查、自动分配与故障转移，所有自动能力默认关闭

## 2. 背景

当前项目已经通过 `proxylist.txt` 和 `proxy_mapping.json` 支持账号固定代理。每个账号在创建 Playwright Browser Context 时获得一个代理，已有映射会在后续启动时继续复用。

这套机制能够完成基础的一号一出口，但在账号数量较多时存在以下管理问题：

- 代理只能通过文本文件增删，无法在管理后台查看和编辑；
- 无法直接查看每个账号的期望出口、当前出口和实际公网 IP；
- 缺少节点连通性测试、批量导入和批量绑定；
- 节点变更和账号绑定缺少明确的应用状态；
- 没有节点订阅、健康检查和自动调度能力。

实际部署中，用户可能在另一台服务器上搭建 Shadowsocks 或 SOCKS5 出口，再由 AIStudioToAPI 主机上的 Mihomo 将这些远程出口转换为稳定的本地 SOCKS5 端口。管理后台需要负责节点配置、账号绑定和运行状态展示。

## 3. 关键约束

### 3.1 代理属于 Browser Context

Playwright 代理配置在 Browser Context 创建时传入，不能在 Context 存活期间直接替换。因此：

- 修改账号绑定不能立即改变现有 Context 的代理；
- 应用新代理需要关闭并重建目标账号的 Context；
- 重建可能中断在途请求，并可能触发 Google 登录验证；
- 自动故障转移不能照搬普通 HTTP Client 的热切换方式。

### 3.2 Mihomo 配置变更也可能影响现有流量

账号 Context 指向的是本地 SOCKS5 监听端口。如果某个本地端口对应的远程节点配置发生变化，即使没有重建 Context，后续连接也可能使用新的出口。因此，编辑正在使用的节点必须展示影响范围，并经过显式应用。

### 3.3 必须避免静默直连

当账号已经绑定节点，但出现以下情况时，不能自动回退到服务器直连：

- Mihomo 未运行；
- 本地监听端口不可用；
- 节点被删除或禁用；
- 绑定引用了不存在的节点；
- 配置生成或重载失败。

此时账号 Context 应标记为不可用，并在管理页面显示具体原因。静默直连会破坏账号出口隔离，也可能导致大量账号共用服务器公网 IP。

### 3.4 多架构镜像

项目当前发布 `linux/amd64` 和 `linux/arm64` 镜像。Mihomo 内核必须按构建目标架构选择对应文件，不能只支持单一架构。

## 4. 改造目标

### 4.1 第一阶段目标

第一阶段交付可控、可观察的手工节点池：

1. Docker 镜像内置固定版本的 Mihomo 内核；
2. 支持手工添加直连、Shadowsocks 和 SOCKS5 节点；
3. 支持分享链接和结构化表单批量导入；
4. 每个远程代理节点分配稳定的本地 SOCKS5 监听端口；直连节点不分配端口；
5. 在独立前端页面管理节点和账号绑定；
6. 展示账号期望出口、当前出口和待应用状态；
7. 支持单账号或批量账号在空闲后重建 Context；
8. 支持测试节点连通性、延迟和出口公网 IP；
9. 兼容现有 `proxylist.txt`、`proxy_mapping.json` 和环境变量代理；
10. 所有节点与绑定数据随 `/app/data` 持久化。

### 4.2 第二阶段目标

第二阶段增加完整节点池能力：

1. Clash/Mihomo、Base64 和分享链接订阅；
2. 定时刷新订阅；
3. 周期性健康检查；
4. 真实请求失败反馈；
5. 自动分配；
6. 自动故障转移；
7. 节点恢复与重新纳入候选池；
8. 冷却、防抖和并发控制；
9. Mihomo 子进程自愈；
10. 自动化策略的前端配置。

第二阶段所有自动行为必须默认关闭。升级后不能因为存在节点或订阅就自动调整账号出口。

### 4.3 非目标

- 第一阶段不自动选择最低延迟节点；
- 第一阶段不因请求失败自动重建 Context；
- 第一阶段不自动刷新订阅；
- 不直接复制其他项目的 AGPL 实现代码；
- 不把 Mihomo 控制端口暴露到公网；
- 不在接口响应或日志中返回节点明文密码。

## 5. 总体架构

```text
管理后台
  ├─ Mihomo 状态
  ├─ 节点管理
  └─ 账号出口管理
          │
          ▼
ProxyPoolRoutes
          │
          ▼
ProxyPoolService
  ├─ ProxyPoolStore
  ├─ ProxyBindingService
  ├─ MihomoConfigGenerator
  └─ MihomoManager
          │
          ▼
Mihomo 子进程
  ├─ 127.0.0.1:10801 ──► 远程节点 A
  ├─ 127.0.0.1:10802 ──► 远程节点 B
  └─ 127.0.0.1:10803 ──► 远程节点 C
          ▲
          │
BrowserManager 按账号创建 Context
```

### 5.1 后端模块

建议新增以下文件：

```text
src/proxy/
├── ProxyPoolStore.js
├── ProxyPoolService.js
├── ProxyBindingService.js
├── ProxyNodeParser.js
├── MihomoConfigGenerator.js
└── MihomoManager.js

src/routes/
└── ProxyPoolRoutes.js
```

模块职责：

| 模块 | 职责 |
| --- | --- |
| `ProxyPoolStore` | 加载、校验和原子保存节点池数据 |
| `ProxyPoolService` | 对外提供节点、设置、测试和绑定操作 |
| `ProxyBindingService` | 解析账号身份、期望绑定、当前绑定和应用状态 |
| `ProxyNodeParser` | 解析 SS、SOCKS5 分享链接和批量文本 |
| `MihomoConfigGenerator` | 从节点池快照生成 Mihomo 运行配置 |
| `MihomoManager` | 管理二进制探测、子进程、控制端、重载和日志 |
| `ProxyPoolRoutes` | 管理 API、认证、请求校验和错误映射 |

`ProxyPoolService` 由 `ProxyServerSystem` 创建，并注入 `BrowserManager` 和管理路由。业务逻辑不放进 `StatusRoutes.js`。

### 5.2 前端模块

建议新增：

```text
ui/app/components/proxy/
├── ProxyPoolPanel.vue
├── MihomoStatusCard.vue
├── ProxyNodeTable.vue
├── ProxyNodeDialog.vue
├── ProxyImportDialog.vue
├── AccountBindingTable.vue
└── BatchBindingDialog.vue
```

第一阶段可以沿用现有 `StatusPage.vue` 的侧边栏和 `activeTab` 结构，增加独立的“节点池”页签。新增业务 UI 必须放在独立组件中，避免继续扩大 `StatusPage.vue`。

后续若管理页面继续增加，再单独把公共布局和侧边栏提取成管理后台 Shell；这不作为第一阶段的前置条件。

## 6. 节点、绑定和运行状态模型

### 6.1 持久化位置

```text
data/
├── proxy-pool.json
└── mihomo/
    ├── runtime.yaml
    ├── mihomo.log
    └── cache.db
```

Docker 已经建议挂载 `/app/data`，因此新增文件可以随现有数据卷持久化。

可通过以下环境变量覆盖默认路径：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PROXY_POOL_CONFIG_PATH` | `./data/proxy-pool.json` | 节点池配置路径 |
| `MIHOMO_PATH` | 内置二进制路径 | 自定义 Mihomo 二进制 |
| `MIHOMO_DATA_DIR` | `./data/mihomo` | Mihomo 运行目录 |

### 6.2 配置结构

```json
{
  "schemaVersion": 1,
  "settings": {
    "enabled": false,
    "binaryPath": "",
    "basePort": 10801,
    "controllerPort": 19090
  },
  "nodes": [
    {
      "id": "node-a1b2c3",
      "name": "US-01",
      "type": "ss",
      "host": "proxy.example.com",
      "port": 443,
      "cipher": "aes-256-gcm",
      "password": "secret",
      "username": "",
      "localPort": 10801,
      "enabled": true,
      "createdAt": "2026-09-26T00:00:00.000Z",
      "updatedAt": "2026-09-26T00:00:00.000Z"
    },
    {
      "id": "node-direct",
      "name": "VPS 直连",
      "type": "direct",
      "host": "",
      "port": null,
      "localPort": null,
      "enabled": true,
      "createdAt": "2026-09-26T00:00:00.000Z",
      "updatedAt": "2026-09-26T00:00:00.000Z"
    }
  ],
  "bindings": {
    "user@example.com": {
      "desiredNodeId": "node-a1b2c3",
      "updatedAt": "2026-09-26T00:00:00.000Z"
    }
  },
  "automation": {
    "enabled": false,
    "subscriptionsEnabled": false,
    "healthCheckEnabled": false,
    "autoAssignEnabled": false,
    "autoFailoverEnabled": false,
    "autoRebuildContext": false,
    "checkIntervalSeconds": 60,
    "healthTimeoutMs": 5000,
    "failureThreshold": 3,
    "recoveryThreshold": 2,
    "switchCooldownMinutes": 30,
    "maxConcurrentChecks": 20,
    "testUrl": "https://www.google.com/generate_204",
    "exitIpUrl": ""
  }
}
```

`automation` 在第一阶段写入默认值，但不实现自动调度。这样第二阶段升级时无需再次迁移配置结构。

### 6.3 节点 ID 和本地端口

- 节点 ID 使用不可变随机 ID，不使用节点名称作为主键；
- 节点名称可以修改；
- 节点类型创建后不可修改；代理节点与直连节点之间切换时必须新建节点并重新绑定，避免运行中 Context 的应用状态失真；
- 远程代理节点的 `localPort` 第一次创建时分配并持久化；
- `type=direct` 表示 VPS 自身公网出口，只允许配置一个，`host`、`port` 和 `localPort` 均为空；
- 直连节点是账号分组和出口意图，不生成 Mihomo proxy/listener，不经过 Mihomo，也不继承 `proxylist.txt` 或代理环境变量；
- 节点排序、服务重启和订阅刷新不能改变已有端口；
- `controllerPort` 必须从节点端口分配范围排除；
- 删除节点前必须确认没有期望绑定或运行中的 Context 使用该节点；
- 第一阶段若节点仍被使用，删除接口返回 `409`，不自动解绑或回收端口。

### 6.4 账号身份

账号绑定键按以下顺序产生：

1. 规范化后的 `accountName`，通常为小写邮箱；
2. 没有 `accountName` 时使用 `auth-{index}`。

接口同时返回账号当前索引和显示名称。后续如果项目为认证文件引入永久 UUID，可以在新 schema 版本中迁移，不阻塞第一阶段。

### 6.5 期望状态和实际状态

只持久化 `desiredNodeId`。实际状态从运行中的 Browser Context 元数据计算：

```js
{
    accountKey: "user@example.com",
    authIndex: 12,
    desiredNodeId: "node-b",
    appliedNodeId: "node-a",
    state: "pending",
    contextState: "READY"
}
```

绑定状态定义：

| 状态 | 含义 |
| --- | --- |
| `unbound` | 没有任何节点池绑定；不包含已经绑定直连节点的账号 |
| `pending` | 期望节点与当前 Context 使用节点不同 |
| `applied` | 当前 Context 已使用期望节点 |
| `offline` | 没有运行中的 Context，新建时将使用期望节点 |
| `draining` | 已申请应用，正在等待账号请求清空 |
| `rebuilding` | Context 正在重建 |
| `error` | 节点、Mihomo 或 Context 初始化失败 |

服务重启后所有 `appliedNodeId` 从空状态重新建立，不能把上次运行时状态当作当前状态。

## 7. 代理解析优先级

账号创建 Context 时按以下优先级解析代理：

```text
节点池中的账号绑定
  ├─ 绑定直连节点：强制 VPS 直连，不经过 Mihomo
  └─ 绑定远程节点：使用该节点的 Mihomo 本地 SOCKS5 listener
  ↓ 未绑定
proxylist.txt 固定代理
  ↓ 未启用
HTTPS_PROXY / HTTP_PROXY / ALL_PROXY
  ↓ 未配置
直连
```

如果命中节点池绑定但节点不可用，解析立即失败，不能继续向下回退。

直连节点同样属于明确绑定。命中直连节点后返回无代理的 Browser Context 配置，并立即停止优先级解析；即使存在 `proxylist.txt`、`HTTP_PROXY`、`HTTPS_PROXY` 或 `ALL_PROXY`，该账号也必须使用 VPS 自身出口。节点池总开关和 Mihomo 进程状态不影响直连节点。

旧固定代理功能在第一阶段保留，以便平滑升级。管理页面需要明确标注账号当前代理来源：

- `mihomo_pool`
- `direct_node`
- `sticky_proxy_file`
- `environment`
- `direct`

其中 `direct_node` 表示显式绑定到“VPS 直连”节点，`direct` 仅表示未绑定账号经过全部兼容配置后自然落到直连。两者必须在接口和页面中区分。

## 8. Mihomo 生命周期

### 8.1 启动

当 `settings.enabled=true` 时：

1. 探测 `settings.binaryPath`；
2. 探测 `MIHOMO_PATH`；
3. 探测镜像内置路径；
4. 生成随机控制端 secret；
5. 生成并校验 `runtime.yaml`；
6. 启动 Mihomo 子进程；
7. 携带 secret 请求本地 `/version`；
8. 验证所需监听端口；
9. 更新运行状态。

不能只通过 TCP 端口可连接判断 Mihomo 已就绪，避免控制端口被其他进程占用时误判。

### 8.2 配置应用

配置变更按事务方式应用：

1. 在内存中完成请求校验；
2. 生成临时节点池配置和 Mihomo 配置；
3. 执行 Mihomo 配置校验；
4. 原子保存 `proxy-pool.json`；
5. 原子替换 `runtime.yaml`；
6. 通过本地控制端热重载；
7. 执行就绪检查；
8. 失败时恢复旧配置并返回明确错误。

生成内容与当前运行配置完全相同时跳过重载。

### 8.3 退出

服务正常关闭时：

1. 停止接受新的节点池管理操作；
2. 终止 Mihomo 子进程；
3. 等待退出，超时后再强制终止；
4. 清理仅属于本次进程的临时文件；
5. 保留持久化配置和日志。

### 8.4 意外退出

第一阶段只记录状态并告警，不自动无限重启。管理员可以从前端手工重启。

第二阶段启用自愈后，必须配置最小重启间隔和连续失败上限，避免错误配置导致重启循环。

## 9. 账号绑定应用语义

### 9.1 保存绑定

保存绑定只更新 `desiredNodeId`：

- 不关闭 Context；
- 不中断请求；
- 没有 Context 的账号会在下次创建时使用新节点；
- 已有 Context 的账号显示为“待应用”。

### 9.2 立即应用

“立即应用”实际表示“安全排空后应用”：

1. 将账号标记为 `draining`；
2. 调度器停止向该账号发放新 lease；
3. 等待账号当前 inflight 归零；
4. 关闭该账号 Context 和内部 WebSocket；
5. 使用新节点创建 Context；
6. 成功后恢复调度；
7. 失败时保持账号不可用并展示错误，不回退直连。

接口返回 `202 Accepted` 和任务 ID，前端轮询任务状态。不能让 HTTP 请求一直阻塞到浏览器初始化完成。

### 9.3 仅应用空闲账号

批量操作默认只立即处理当前空闲账号。繁忙账号继续保持 `pending`，由管理员稍后再次执行，或者选择“排队等待空闲”。

### 9.4 解绑

解绑同样分为保存和应用：

- 保存后，已有 Context 继续使用旧节点；
- 应用后根据代理解析优先级选择旧固定代理、环境代理或直连；
- 页面在确认框中展示解绑后的实际代理来源。

### 9.5 VNC 新账号绑定

创建 VNC 登录会话时允许选择节点：

1. 前端向 VNC 会话创建接口传入可选 `nodeId`；
2. 临时浏览器通过该节点登录；
3. 保存账号后，将节点绑定提交到检测到的账号键；
4. VNC 失败或取消时释放临时预留，不写入账号绑定。

未选择节点时沿用现有固定代理或环境代理行为。

## 10. 第一阶段管理 API

所有接口复用现有管理会话认证。

### 10.1 状态和设置

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/proxy-pool/status` | 返回配置状态、Mihomo 状态和版本 |
| `GET` | `/api/proxy-pool/settings` | 返回脱敏设置 |
| `PUT` | `/api/proxy-pool/settings` | 更新启用状态、端口和二进制路径 |
| `POST` | `/api/proxy-pool/mihomo/start` | 手工启动 |
| `POST` | `/api/proxy-pool/mihomo/stop` | 手工停止 |
| `POST` | `/api/proxy-pool/mihomo/reload` | 校验并重载配置 |

### 10.2 节点

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/proxy-pool/nodes` | 节点列表，不返回密码 |
| `POST` | `/api/proxy-pool/nodes` | 新增节点 |
| `PUT` | `/api/proxy-pool/nodes/:id` | 更新节点，空密码表示保留旧密码 |
| `DELETE` | `/api/proxy-pool/nodes/:id` | 删除未使用节点 |
| `POST` | `/api/proxy-pool/nodes/import` | 批量导入分享链接或结构化文本 |
| `POST` | `/api/proxy-pool/nodes/:id/test` | 测试单个节点 |
| `POST` | `/api/proxy-pool/nodes/test` | 测试选中节点 |

测试结果示例：

```json
{
  "success": true,
  "latencyMs": 183,
  "exitIp": "203.0.113.10",
  "testedAt": "2026-09-26T00:00:00.000Z",
  "message": "ok"
}
```

`exitIp` 只有在配置了出口 IP 测试地址时返回。测试失败只更新展示状态，不自动解绑账号。

### 10.3 绑定

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `GET` | `/api/proxy-pool/bindings` | 账号、期望节点、当前节点和应用状态 |
| `PUT` | `/api/proxy-pool/bindings/:accountKey` | 保存单账号期望节点 |
| `POST` | `/api/proxy-pool/bindings/batch` | 批量保存绑定 |
| `POST` | `/api/proxy-pool/bindings/:accountKey/apply` | 排空并重建单账号 Context |
| `POST` | `/api/proxy-pool/bindings/apply-idle` | 应用所有当前空闲账号 |
| `POST` | `/api/proxy-pool/bindings/apply-pending` | 将所有待应用账号加入排空队列 |
| `GET` | `/api/proxy-pool/tasks/:taskId` | 查询应用任务状态 |

批量绑定请求必须是单次持久化事务，不能逐个账号写文件。

## 11. 前端页面设计

侧边栏增加“节点池”入口，页面包含三个区域。

### 11.1 Mihomo 状态卡片

展示：

- 功能是否启用；
- 二进制是否存在；
- Mihomo 版本；
- 进程是否运行；
- 控制端是否就绪；
- 当前节点和监听端口数量；
- 最近一次配置应用时间；
- 最近错误；
- 启动、停止和重载按钮。

### 11.2 节点列表

每行展示：

- 节点名称；
- 类型；
- 远程地址；
- 本地 SOCKS5 端口；
- 启用状态；
- 最近延迟；
- 最近出口 IP；
- 已绑定账号数；
- 当前运行 Context 数；
- 测试、编辑和删除操作。

节点编辑弹窗支持 Shadowsocks 和 SOCKS5 的类型字段。批量导入支持一行一个 URI，并在保存前展示解析成功、重复和失败条目。

节点编辑弹窗还支持创建唯一的“直连（VPS 出口）”节点。该节点的远程地址和本地端口显示为“不适用”，测试操作直接从应用进程访问测试地址，不能调用 Mihomo 控制端进行测试。

### 11.3 账号出口列表

每行展示：

- 账号索引；
- 账号名称；
- Context 状态；
- 代理来源；
- 期望节点；
- 当前节点；
- 当前出口 IP；
- 是否有在途请求；
- 绑定状态；
- 保存绑定和立即应用操作。

需要支持分页、搜索、按状态过滤、多选和批量操作。账号数量超过 100 时，不能每次轮询都返回完整节点密码、日志或大对象。

账号筛选必须把“未绑定”和“直连组”分开：`unbound` 只展示尚未选择任何节点的账号；直连组账号通过其直连节点 ID 查询和统计。这样未绑定筛选可以直接用于发现尚未分配出口的新账号。

### 11.4 影响确认

以下操作必须展示影响账号数量：

- 编辑正在使用的节点；
- 停止 Mihomo；
- 禁用节点池；
- 删除节点；
- 批量立即应用；
- 修改 `basePort` 或 `controllerPort`。

提示应说明是否会中断连接、重建多少个 Context，以及是否存在待应用账号。

## 12. Docker 和二进制分发

### 12.1 镜像构建

Dockerfile 增加：

- `ARG TARGETARCH`；
- `ARG MIHOMO_VERSION`；
- amd64/arm64 资源名称映射；
- 官方发布文件下载；
- SHA256 校验；
- 解压并安装到固定路径；
- Mihomo 许可证和版本信息。

构建失败时不能静默忽略 Mihomo 下载或校验错误，否则发布的镜像会出现同一标签下能力不一致的问题。

### 12.2 源码运行

源码运行按以下顺序探测：

1. 节点池设置中的 `binaryPath`；
2. `MIHOMO_PATH`；
3. 项目根目录下的 `mihomo` 或 `mihomo.exe`；
4. `bin/` 子目录；
5. 系统 `PATH`。

第一阶段不要求应用自动下载内核。前端在未找到内核时展示探测路径和安装说明。

### 12.3 网络暴露

- 节点 SOCKS5 监听只绑定 `127.0.0.1`；
- Mihomo 控制端只绑定 `127.0.0.1`；
- Docker 不发布节点端口和控制端口；
- 控制端使用每次启动随机生成的 secret；
- secret 不写入管理 API 响应和普通日志。

## 13. 兼容与迁移

### 13.1 保留旧功能

第一阶段不删除以下能力：

- `proxylist.txt`；
- `proxy_mapping.json`；
- `HTTP_PROXY`；
- `HTTPS_PROXY`；
- `ALL_PROXY`；
- `NO_PROXY`。

### 13.2 旧代理导入

管理页面提供“从 proxylist.txt 导入”操作：

- 将旧代理转换为节点池节点；
- 尽量保留账号绑定；
- 导入结果先预览，确认后写入；
- 不自动删除原文件；
- 不自动启用节点池；
- 导入 Shadowsocks 以外的普通 HTTP/SOCKS 代理时，按 Mihomo 支持的节点类型转换。

完成导入和验证后，管理员可以自行停用旧文件配置。

### 13.3 配置版本

`schemaVersion` 必须参与加载校验。未来新增订阅和健康状态时通过显式迁移升级，不能在多个模块中临时兼容不同结构。

## 14. 安全与日志

- 节点池配置文件使用仅运行用户可读写的权限；
- 管理 API 永远不返回明文密码；
- 更新节点时，空密码表示保留旧值；
- 日志中的 URI、用户名、密码和控制端 secret 必须脱敏；
- 分享链接解析失败时，不把完整含密钥链接写入日志；
- 前端不能把密码保存在浏览器持久化存储中；
- 批量导出默认不包含密码；
- 管理接口继续使用现有会话认证和 CSRF 风险控制方式；
- Mihomo 日志应限制大小并支持轮转，避免长期运行占满数据卷。

Mihomo 作为独立程序随镜像分发时，需要同时保留对应许可证和源码获取信息。项目自身不直接复制其他代理项目的 AGPL 代码。

## 15. 第二阶段自动化设计

### 15.1 默认配置

```json
{
  "enabled": false,
  "subscriptionsEnabled": false,
  "healthCheckEnabled": false,
  "autoAssignEnabled": false,
  "autoFailoverEnabled": false,
  "autoRebuildContext": false
}
```

总开关关闭时，其他自动化开关即使保留为 `true` 也不能运行。

### 15.2 订阅

支持：

- Clash/Mihomo YAML；
- Base64 整体编码；
- `ss://`、`socks5://`、`trojan://`、`vless://`、`vmess://` 等分享链接；
- 手工节点和订阅节点并存；
- 节点稳定 ID；
- 订阅刷新时保留未变化节点的本地端口和绑定；
- 节点消失时进入 `missing` 状态，不立即破坏运行中的 Context。

订阅数据建议独立保存，避免每次健康检查结果变化都重写主节点池文件。

### 15.3 健康检查

健康状态：

- `unknown`
- `healthy`
- `degraded`
- `failed`
- `recovering`

判定需要同时考虑：

- 周期性主动测试；
- 实际浏览器导航和连接失败；
- 连续失败次数；
- 连续恢复次数；
- 最后成功和失败时间。

单次超时不能立即触发故障转移。成功请求应清理连续传输失败计数。

### 15.4 自动分配

自动分配候选节点必须满足：

- 节点启用；
- 健康状态不是 `failed`；
- 未超过配置的账号数上限；
- 不在节点冷却中；
- 满足地区、标签或出口 IP 去重规则。

显式手工解绑的账号需要有 `manualDirect=true` 或等价状态，自动分配不得重新绑定。

### 15.5 自动故障转移

故障转移拆分为两个独立决定：

1. 是否为账号选择新的期望节点；
2. 是否自动重建该账号 Context。

建议支持：

| 模式 | 行为 |
| --- | --- |
| `disabled` | 只告警，不修改绑定 |
| `deferred` | 更新期望节点，等待自然重建 |
| `drain` | 停止新请求，空闲后重建 |

默认使用 `disabled`。开启自动故障转移后，如果 `autoRebuildContext=false`，行为等同于 `deferred`。

切换后设置账号级冷却时间，避免多个故障节点之间反复切换。手工切换可以重置冷却。

### 15.6 子进程自愈

Mihomo 意外退出后：

- 记录退出码和最近日志；
- 使用最小间隔限制重启；
- 连续失败达到上限后停止自动重启；
- 所有已绑定账号标记为出口不可用；
- 不允许回退直连。

## 16. 测试计划

### 16.1 单元测试

- SS、SOCKS5 URI 解析；
- 节点字段校验与凭据脱敏；
- 节点 ID 和端口稳定性；
- 直连节点唯一性、无本地端口和不生成 Mihomo listener；
- 控制端端口冲突检测；
- 配置文件原子写入和损坏恢复；
- Mihomo YAML 生成；
- 相同配置跳过重载；
- 账号身份和绑定解析；
- 节点池、旧固定代理、环境代理的优先级；
- 命中无效节点绑定时禁止直连回退；
- 显式直连绑定忽略 Mihomo、旧固定代理和代理环境变量；
- 批量绑定单事务写入；
- 自动化默认关闭。

### 16.2 集成测试

- 使用假的 Mihomo 可执行程序测试启动、就绪、退出和重载；
- 使用本地测试 SOCKS5 服务验证请求确实经过指定出口；
- 保存绑定不会关闭运行中的 Context；
- 空闲账号应用后只重建目标 Context；
- 繁忙账号进入 `draining` 后不再获得新 lease；
- inflight 清零后自动完成重建；
- 重建失败时账号保持不可用且不会直连；
- 删除被绑定或被运行 Context 使用的节点返回 `409`；
- Mihomo 停止后已绑定账号不能创建 Context；
- VNC 预留节点在成功和取消路径上正确提交或释放。

### 16.3 前端测试

- 密码不回显；
- 节点导入预览；
- 账号分页、搜索和过滤；
- `desiredNodeId` 与 `appliedNodeId` 不一致时显示待应用；
- 批量应用只处理空闲账号；
- 影响确认展示准确账号数；
- 后端任务失败后页面展示具体错误。

### 16.4 镜像验证

- 构建 amd64 和 arm64 镜像；
- 两种架构均能运行 `mihomo -v`；
- `/app/data` 重建容器后节点、端口和绑定保持不变；
- 节点端口和控制端口没有发布到宿主机；
- 内置二进制版本和校验值可追溯。

### 16.5 规模验证

至少验证：

- 200 个节点配置生成；
- 100 个账号绑定；
- 100 个本地 listener 的启动和内存占用；
- 账号列表分页响应大小；
- 20 并发节点测试；
- 批量保存和批量应用时没有重复端口和丢失绑定。

## 17. 第一阶段验收标准

第一阶段完成必须满足：

1. amd64 和 arm64 Docker 镜像均包含可运行的 Mihomo；
2. 管理后台可以添加、编辑、测试和删除未使用节点；
3. 可以为账号手工选择节点并批量绑定；
4. 保存绑定不会自动关闭浏览器 Context；
5. 页面能够区分期望节点和当前节点；
6. 可以只应用空闲账号，也可以将繁忙账号加入排空队列；
7. 应用时只重建目标账号 Context，不重启整个浏览器；
8. 节点池故障时不静默直连；
9. 重启容器后节点 ID、本地端口和账号绑定保持不变；
10. API 和日志不泄露节点密码；
11. 旧 `proxylist.txt` 和环境代理继续工作；
12. 100 个账号规模下，页面和绑定接口可正常使用。
13. 页面能区分未绑定账号与显式直连组，直连组流量不经过 Mihomo。

## 18. 推荐实施顺序

建议拆分为以下可独立审查的变更：

1. 节点池 schema、存储、校验和单元测试；
2. Mihomo 配置生成器和进程管理器；
3. Docker 多架构 Mihomo 集成；
4. 节点 CRUD、导入和测试 API；
5. BrowserManager 代理来源抽象和兼容优先级；
6. 期望绑定、当前绑定和 Context 元数据；
7. 账号排空、任务状态和安全重建；
8. 节点池前端页面；
9. VNC 新账号节点预留；
10. 文档、迁移说明和 100 账号规模验证；
11. 第二阶段订阅支持；
12. 第二阶段健康检查、自动分配和故障转移。

第一阶段不要同时实现自动调度。先验证手工绑定、运行状态和 Context 安全重建的边界，再在稳定的数据模型上增加第二阶段能力。
