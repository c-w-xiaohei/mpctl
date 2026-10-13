# RFC 0001: mpctl 通信架构与技术栈

- 状态：目标架构已确认；四包产品骨架、Nexus 通信链路与离线浏览器文件路径已实现。仅已观察到的登录超时页可按完整标志组合分类；其他登录/权限模式、真实 MP 兼容性及安全文章身份仍未验证或不完整；见“当前设计边界”。
- 作者：mpctl 维护者
- 创建日期：2026-09-11
- 目标版本：初始化阶段

## 摘要

本文定义 `mpctl` 的通信架构、运行时边界和技术栈。当前目标是文件驱动的文字正文编辑：CLI 将指定文章的正文导出为本地 HTML，agent 使用已有文件工具完成排版，再通过 CLI 导入同一文章。标题、作者、摘要是独立字段；图片管理暂不纳入当前范围。正文文件工作流见 [RFC 0004](./0004-article-and-assets-workflow.zh.md)。

```txt
LLM agent
  └─ 编辑本地 HTML 文件（CLI 负责拉取/推送时的文件 I/O）
-> mpctl CLI in WSL/Linux
-> Nexus node IPC
-> mpctl 守护进程
<-> Nexus WebSocket
<-> Windows Chrome 扩展后台脚本
-> Nexus Chrome
-> mpctl 内容脚本
-> mpctl 页面 Nexus Endpoint/Port（离线 Chromium 已验证）
-> window.__MP_Editor_JSAPI__
-> 公众号编辑器当前正文
```

页面执行端是编辑页的主 JavaScript 环境。页面桥接适配器在 mpctl 内部实现，封装 Nexus Endpoint/Port；MAIN 常驻提供编辑器服务。离线 Chromium 测试已验证生产桥的跨 world 二进制传输、顺序、重入、关闭与重载；该证据不验证微信页面兼容性。扩展特权不向页面开放。

## 动机与约束

- CLI 可能运行在 WSL/Linux，Chrome 运行在 Windows。
- CLI 命令可能同时到达；需要顺序执行或限制请求量时，由插件业务层排队并做背压，不增加锁服务。
- 守护进程能与 CLI 通信时，浏览器插件仍可能尚未建立 WebSocket 连接；此状态必须可由 agent 识别，并提示显式运行 CLI `connect` 或使用插件界面连接。
- 一个守护进程只接纳一个插件实例的一条有效活动连接；插件内部可以同时发现多个编辑页。
- 扩展不能直接监听 Unix socket、Windows named pipe 或 Node IPC。
- JSAPI 是页面主环境对象，不是 HTTP 接口、服务端草稿 API 或微信网页 JS-SDK。
- 内容脚本不能假设能直接读取页面主执行环境变量；页面主执行环境的注入和返回路径必须实测。
- 不遍历 ProseMirror/旧 UEditor 内部对象作为正式 API。
- 只能把已验证接口声明为可用；选区、封面、保存和发布保持未知状态。
- 跨边界数据使用 `packages/contracts` 中的共享类型和 Valibot 运行时校验；包职责见 RFC 0005。

服务内部以 `Result` 表达预期失败：成功为 `Ok`，领域失败为带类型错误数据的 `Err`，不以 throw/catch 作为常规传播方式。Nexus 服务边界使用 protocol `0.5.0` 的 `status: "ok"` / `status: "error"` 序列化结果；编解码器的 `serialize`/`deserialize` 均异步返回 `Result`，无效 envelope 以 `invalid_result_envelope` 的 `Err` 表达。CLI 在终端边界把失败呈现为紧凑 JSON 与非零退出码，不改变 agent-facing 输出。

架构设计边界仍适用于后续能力；当前产品实现与证据见文末。已实现命令包括 `status`、`article list/open/new/current/pull/push/inspect/update`；inspect 已通过单篇真实只读验收，update 仅支持作者／摘要并通过隔离验收，真实写入未验证。列表/打开能力受限于观察到的草稿卡片和单条可见图文。列表返回不透明的实际组定位候选，open 当次重查唯一匹配，经卡片“编辑”入口核对 `appmsgid` 后返回临时文章引用；两者都不是稳定 MP 条目 ID。不引入 Native Messaging、独立 `protocol` 包或过度拆分的服务包。

## 技术选型与验证基线

通信层采用 Nexus 2.0 alpha，项目作为真实应用验证其适配器组合。跨传输的类型化服务透传优先采用 Nexus Relay：在每个中继运行时显式配置来源实例、下游实例、服务 Token 和目的目标，而非逐跳重写相同的 RPC 方法。扩展开发框架采用 WXT，目标为 Chrome Manifest V3，界面使用 React。工具链采用 Bun、TypeScript 7 (`tsgo`)、Oxlint、Oxfmt、Turbo 和 Valibot；Oxc 工具取代 Biome，分工见 RFC 0005。broker 在 Bun 运行时中使用 Node 兼容接口承载 HTTP 与 WebSocket，不使用 Bun 原生 `ServerWebSocket` 对接当前 Nexus endpoint。

| 组件                  | 已验证版本      | 用途                                                       |
| --------------------- | --------------- | ---------------------------------------------------------- |
| Bun                   | `1.3.14`        | broker 运行时                                              |
| `@nexus-js/core`      | `2.0.0-alpha.0` | 仅旧版 WebSocket 探针使用；不含本规格所需的最新 Relay 路径 |
| `@nexus-js/websocket` | `0.1.0-alpha.1` | 仅旧版 WebSocket 探针使用；部署版本另行核对                |
| `ws`                  | `8.18.3`        | 服务端 WebSocket Upgrade 和连接对象                        |
| Hono                  | `4.13.8`        | 旧隔离选型资料；当前产品未引入                             |
| `@hono/node-server`   | `1.19.12`       | 旧隔离选型资料；当前产品未引入                             |

表中版本只说明先前的隔离探针。当前锁定 `@nexus-js/core@2.0.0-alpha.2`、`@nexus-js/websocket@0.1.0-alpha.3`、`@nexus-js/node-ipc@0.7.0-alpha.2`、`@nexus-js/chrome@0.6.0-alpha.2`；离线浏览器 E2E 已覆盖该产品通信链路。真实 MP 页面兼容性不由此推出。

仓库内离线 Chromium E2E 通过真实 CLI 子进程、broker IPC/WS、Nexus Relay、构建的扩展、页面桥和本地文件完成空白文章及受限草稿正文拉取/推送和字段 inspect；另有后台／content Chrome Blob RPC 与生产页面桥浏览器传输测试。当前三项浏览器测试通过，含第二个可见条目的拒绝，当前证据见 `tmp/reports/preparation-live-check.md`，T10 为历史证据。测试使用本地合成 JSAPI 页面，不访问真实 MP 服务，不证明真实页面/账号行为，也不覆盖同一文档内切换文章。

## 术语

- **page session（页面会话）**：一个已识别的公众号编辑页会话，包含 tab/frame、页面身份和当前 editor session。
- **main-world bridge（页面主执行环境桥）**：位于扩展工程内部的 Nexus Endpoint/Port，连接隔离环境与 MAIN 常驻服务。
- **editor capability（编辑器能力）**：逐项记录实现验证等级与当前可用性；编辑器就绪不代表所有能力可用。
- **article reference（文章引用）**：插件工作区中的文章定位引用，不是 tabId 或远程 Ref。
- **body file（正文文件）**：本地 UTF-8 HTML 片段，承载 agent 对正文的修改，不包含文章标题等独立字段。

## 架构概览

| 组件            | 运行位置                   | 职责                                                                                                   |
| --------------- | -------------------------- | ------------------------------------------------------------------------------------------------------ |
| CLI             | WSL/Linux                  | 呈现文章命令、读写本地 HTML 文件、返回必要结果；页面步骤交给插件                                       |
| 守护进程        | WSL/Linux                  | 常驻监听 IPC 与 WebSocket，维持唯一插件连接并提供 CLI 到浏览器服务的通路；不因连接宿主身份接管文章编排 |
| 扩展后台脚本    | Windows Chrome MV3         | 用户触发时连接守护进程；提供工作区，管理标签组、按需开页、核对登录、解析文章引用并组织页面操作         |
| 内容脚本        | 公众号编辑页               | 持有文档/编辑器绑定，提供页面级编辑服务；字段 DOM 操作与 MAIN 正文 JSAPI 服务组合                      |
| 页面通信适配器  | 隔离环境及页面主环境       | 传输 Nexus 消息、管理接入与关闭，不包含微信业务                                                        |
| MAIN 正文服务   | 页面主环境                 | 包装正文就绪、读取和整体写入 JSAPI，处理调用与回调                                                     |
| HTTP/WS 宿主    | Bun 的 Node 兼容环境       | HTTP 服务、Upgrade、路径与 Origin 检查、连接接管及关闭                                                 |
| 普通 HTTP 请求  | 守护进程 `node:http`       | 当前直接返回 404；正文 HTML 沿 Nexus 传递，不设文件端点                                                |
| Nexus WebSocket | 守护进程/扩展              | 会话、双向类型化服务调用、回调与远程引用                                                               |
| Nexus Relay     | 守护进程与扩展等中继运行时 | 把指定 Token 显式挂载到本地实例，延迟获取指定下游连接，按 ResourceScope 转发调用与资源                 |
| Nexus Chrome    | 扩展内部                   | 扩展后台脚本与内容脚本之间的 typed service/callback 边界                                               |
| Nexus Node IPC  | CLI/守护进程               | 本地 typed API/callback 边界                                                                           |

```txt
CLI <-> 守护进程: Nexus node IPC
守护进程 <-> 扩展后台脚本: Nexus WebSocket（插件由用户触发后主动连接）
扩展后台脚本 <-> 内容脚本: Nexus Chrome
内容脚本 <-> 页面主执行环境: mpctl 内部的 Nexus 页面适配器
页面主执行环境 -> 编辑器: window.__MP_Editor_JSAPI__.invoke/on
```

适配器位于扩展内部，推荐文件 `packages/extension/src/transport/page-bridge.ts`；不要求 `page-bridge/` 目录，不新增工作区包。采用 WXT 加载常驻 MAIN 脚本，以其共享脚本节点及 `CustomEvent` 双向通道为实现起点。二进制传输、重入和生命周期须验证；不使用额外 iframe、逐次执行脚本或第二套 RPC。具体设计见 RFC 0003 和 RFC 0005。

## 守护进程与插件连接

当前显式连接入口包含插件 UI 和 CLI `connect` 的交接指令：CLI 检查已有连接，未连接时返回 instruction 与 connectionPageUrl（须提供扩展 ID），agent 判断浏览器实际运行位置与 profile 后在该环境打开 `connect.html`。CLI 不选择浏览器或启动平台进程；该页调用既有背景连接服务并使用插件已存配置。普通状态与正文命令不自动拨号，配对凭据不进入连接页 URL。成功启动的新 broker 可由 CLI 将凭据保存在私有本机配置，后续启动无需再次设置 shell 环境变量。

未连接时由 agent 按指令打开连接页。连接尝试以 Ok 或 Err 结束后，连接页都报告安全的结果/错误码并尝试关闭自身标签；连接失败不会将错误页留在前台。若浏览器拒绝关闭标签，页面报告关闭失败，连接 Result 保持原值。`connect --reload` 仅已连接时经现有通道调用同一个 background control Token；未连接时先返回交接指令，不派发 reload。BG 写短时一次性重连意图后自重载，新实例消费意图再拨号一次。broker 的连接状态另含内部 `sessionId` 供 CLI 验证新会话，公开 `status` 默认只输出 connected；不将旧资源或调用迁移到新会话。成功的通道 reload 无需额外内页。

守护进程是常驻连接宿主，职责是让短生命周期 CLI 能通过 IPC 使用由浏览器插件主动建立的 WebSocket 会话。守护进程可由 CLI 按需确保启动，也可通过其他方式启动；启动方式不改变其常驻职责。不得以 CLI 命令结束或空闲计时为由自动关闭活动 WS 连接。

```txt
1. 守护进程建立单实例 IPC 与 WebSocket 监听；可在没有插件连接时响应 CLI。
2. 用户在浏览器插件界面发起连接，插件作为唯一 WS 客户端主动连接守护进程。
3. 会话就绪后 CLI 才能发现并使用插件中的编辑页；没有连接时立即返回可行动的状态，不等待页面 RPC 超时。
4. 插件或守护进程断线后，旧连接和依赖它的页面服务句柄失效。重连由用户再次在插件界面发起；不自动重放断线期间的写操作。
```

守护进程只接纳一条有效活动会话，并在 Upgrade 阶段校验配对凭证；凭证通过 WebSocket 子协议传递，扩展配置保存在 `storage.local`，broker 凭证由 `MPCTL_PAIRING_CREDENTIAL` 提供。会话替换及授权实现见 broker。默认 WS 地址和 IPC 路径以实现配置为准，不把旧建议值当作冻结值。

插件未连接可提示显式运行 CLI `connect`，也可在插件界面连接；当前仅对已观察到的完整登录超时页标志组合返回 `not_logged_in`。其他登录/权限页仍不能可靠分类；JSAPI 缺失和空列表都不是未登录证据，歧义列表失败关闭。连接阶段、Nexus 会话标识、tab/document 地址和完整能力清单属于内部诊断，不进入常规输出。

## 类型与服务模型

职责边界以 [RFC 0003](./0003-nexus-main-world-editor-bridge.zh.md) 的工作区模型为准：

| 契约               | 提供方          | 主要能力                                                                                                              |
| ------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| 文件命令入口       | CLI             | 已实现状态查询、受限草稿列表/打开、新建空白文章、拉取/推送正文                                                        |
| 守护进程连接入口   | 守护进程        | 连接状态、唯一插件会话与 Relay 接入；没有插件连接时提供可行动状态                                                     |
| 公众号工作区入口   | 扩展后台提供    | 受限草稿发现/打开、空白新稿及正文导入/导出；单一观察到的登录超时页可分类，其他登录/权限模式和稳定同文档条目身份未验证 |
| 页面服务（暂定名） | 内容脚本与 MAIN | 内容脚本核对页面与条目，MAIN 读取及整体替换正文；相同 Token 的透明转发使用 Relay                                      |

agent 使用文章引用和本地文件，不使用页面句柄、光标或修改 RPC。守护进程仅 Relay 唯一插件的稳定工作区 Token，插件内部解析引用并调用对应页面；不随文章切换替换守护进程上的全局 EditorToken。诊断与页面连接记录属于内部数据，不为每层建立 Store 服务。

正文文件只对应一篇文章的正文，不代表整个图文组或全部文章字段。保存、预览是独立操作，具体入口另行收敛；不以推送成功代替保存成功。工作流见 RFC 0004，内部服务边界见 RFC 0003。

## HTTP 宿主与 Nexus WebSocket 接入

建议路由（端口为建议值）：

```txt
GET  /bridge                 # WebSocket upgrade
其他 HTTP 入口按连接认证等实际需求再增设
```

```txt
Bun 进程中的 node:http 服务
├── 普通 HTTP 请求：当前返回 404
└── /bridge Upgrade
    -> ws.WebSocketServer({ noServer: true })
    -> handleUpgrade 返回已打开的 ws.WebSocket
    -> WebSocketServerEndpoint.safeAttach(socket, facts)
    -> Nexus 握手、授权与服务调用
```

服务端从 `@nexus-js/websocket/server` 导入 endpoint，扩展从浏览器安全的 `@nexus-js/websocket` 导入客户端。当前宿主绑定 loopback，核对 Upgrade 路径和配对凭证，并设置 WebSocket 资源上限；没有单独实施 Origin allowlist 或原生心跳。`safeAttach` 成功后 socket 归 Nexus 管理；失败时仍由宿主负责关闭。成功接管不等于 Nexus 会话已经就绪。

注册服务及策略后必须先等待 `nexus.ready()`，再允许接收连接。Upgrade 回调取得打开的 socket 后应同步交给 `safeAttach`，不能在其间等待异步任务而丢失早期消息。关闭时先停止接收新请求、处理未完成业务操作，再关闭 Nexus 持有的连接，最后关闭宿主的 WebSocket 和 HTTP 服务。

不再定义独立的 WS 请求、响应、错误、回调或状态帧。扩展在 WebSocket Nexus 实例中提供类型明确的服务，守护进程仅从已准入的唯一插件会话获取代理。插件主动拨号不限制 RPC 方向；服务端 endpoint 不主动拨号到浏览器。当前没有普通 HTTP 业务路由，也不通过 HTTP 解析、重组或转发 Nexus 二进制协议。

配对凭证通过浏览器 WebSocket 原生子协议列表发送。宿主在 Upgrade 阶段核对凭证，拒绝错误凭证，服务端只选择固定的非密钥子协议且不回显凭证；通过核对的当前 socket 身份事实传入 Nexus `safeAttach`，由 `policy.canConnect` 和 `policy.canCall` 授权。客户端核对协商结果，异常时关闭连接。凭证不得放入 URL、查询参数、页面桥或自动日志；浏览器 WebSocket 客户端不能任意设置 HTTP 请求头。

## 请求流程与状态

```txt
`mpctl article pull a1 --body ./body.html` 拉取正文到本地文件
-> CLI 经守护进程的 Relay 调用插件工作区
-> 工作区核对账号与文章引用，复用或打开所需 tab
-> 经 Nexus Chrome 调用对应文档的页面服务
-> 页面主执行环境适配器
-> JSAPI invoke(mp_editor_get_content)
-> HTML 经守护进程返回 CLI，由 CLI 写入指定文件
```

推送读取整个文件，携带调用者最近观察的实际 BODY HTML `expectedHash`。MAIN 对同文档写入排队，读取当前 HTML 并比较 hash，不匹配时零写入返回 `content_conflict`；成功 set 后回读规范化 HTML 的 `bodyHash`。这是检查后写入，不是 JSAPI 原子 CAS。断线或超时后结果可能未知，不自动重放；守护进程不负责持久操作日志。

远程代理、Ref 和回调均绑定 Nexus 会话，失效后重新获取。文章定位信息与当前 document 绑定分开：后台重启或页面变化后重新核对，不能把旧代理当普通数据恢复。本地 HTML 文件仍由 agent 保管，不要求在文件中维护连接状态。重新连接不等于重新配对，配对取决于凭证有效性。

## 通信方向与技术决策

| 通信段                    | 发起方           | 方式                            | 说明                                   |
| ------------------------- | ---------------- | ------------------------------- | -------------------------------------- |
| Agent -> CLI              | agent            | shell                           | 结构化 CLI 输出                        |
| CLI <-> broker            | CLI              | Nexus Node IPC                  | 使用 `@nexus-js/node-ipc`，仅 Node/Bun |
| 扩展 -> broker            | 扩展后台脚本     | Nexus WebSocket 客户端          | 主动连接并提供扩展服务                 |
| 守护进程 -> 插件服务      | 守护进程         | 唯一已准入 Nexus WebSocket 会话 | 无连接时返回需用户在插件中连接         |
| 扩展后台脚本 <-> 内容脚本 | 扩展             | Nexus Chrome                    | 显式 tab/frame target                  |
| 内容脚本 <-> MAIN         | 内容脚本建立绑定 | mpctl 页面 Nexus 适配器         | 独立会话，MAIN 提供正文 JSAPI 实现     |
| 页面 -> 编辑器            | 页面主执行环境   | MP Editor JSAPI                 | 基于 callback 的 `invoke`/`on`         |

Nexus 统一承担 Node IPC、WebSocket、Chrome 和页面 Endpoint 上的远程服务通信；普通 HTTP 请求由 `node:http` 返回 404。Valibot 校验配置、业务输入和页面返回值，不重复定义 Nexus 协议帧。TypeScript 服务契约不替代业务运行时校验。不引入第二套 RPC，也不提供 HTTP 轮询控制回退。

守护进程的 IPC 与 WS 使用独立 Nexus 实例，通过 Relay 暴露唯一插件的工作区。WS 离线撤下 Relay，但 IPC 与本地 status 继续可用；显式重连重新注册，后续根调用可取得新上游，旧在途调用不重放。扩展 background 只用一个 Chrome Nexus 定位 document；content 提供 DOM 服务并 Relay MAIN 正文 Token，注册后用身份更新发布业务就绪。MAIN 持有正文 JSAPI 和文档写入队列。

## 命令流程

### 状态与查找文章

```txt
CLI -> 守护进程查询是否已有唯一插件连接
-> 未连接：返回需用户在插件界面发起连接
-> 已连接：调用插件工作区，按需打开首页/草稿列表并检查登录
-> CLI 向 agent 展示文章候选或必要失败动作
```

CLI 的 list 返回 candidate 与标题供选择；open/new/current 只返回文章引用与 bodyHash，pull/push 只返回 bodyHash，不回显输入或附加成功标志。插件维护引用到具体文档/图文条目的绑定；后台重启后重新检查浏览器事实，不将缓存视为当前状态。

### 拉取正文（命令形式示意）

```txt
mpctl article pull <article> --body ./body.html
-> CLI 检查插件连接并指定文章引用
-> 守护进程 Relay 到唯一插件工作区
-> 工作区核对登录、复用或打开页面并核对文章条目
-> 经 Nexus Chrome 调用对应文档内容脚本
-> 内容脚本 -> 页面适配器 -> MAIN 正文 JSAPI
-> 读取正文 HTML 并按调用路径返回
-> CLI 将 HTML 写入指定文件
```

### 推送正文（命令形式示意）

```txt
mpctl article push <article> --body ./body.html --expected-hash <last-observed-sha256>
-> CLI 读取本地文件，传递文章引用和 HTML
-> 经守护进程 Relay 到插件工作区
-> 工作区核对登录、文档/条目绑定并执行所需页面步骤
-> MAIN 调用 mp_editor_set_content 整体替换正文
-> 返回编辑器执行结果；无法确定时报告未知，不自动重放
```

JSAPI 超时不会取消编辑器内部操作。回调丢失时不能声称未开始，一次回读也不证明旧操作已经结束。推送不自动反写本地文件、不触发保存或发表；需要实际正文时再次拉取。

## 文件与数据归属

正文文件以 UTF-8 HTML 片段保存，agent 使用文件工具编辑，CLI 负责导入导出时的文件读写。插件接收或返回 HTML 字符串，不接收 `/home/...` 等本地路径。正文沿现有 Nexus 链路传递，不建立 broker artifact、HTTP 文件下载或独立文件仓库。

守护进程只持有连接状态与通信对象。目标设计用插件 `storage.session` 保存工作组、页面用途和文章定位线索，`storage.local` 保存配置；Nexus 代理留在内存，正文以页面当前状态为准。当前实现只保存工作组、受管 tab 和临时 document 线索；后台重启后不复活旧候选或文章引用，必须重新 `list/open` 或 `new`。详细分层见 RFC 0003。agent 可保留本地原稿，mpctl 不要求持久文章数据库、sidecar 或强制备份屏障。

## 替代方案与未决问题

- WebSocket 远程调用直接使用 Nexus 服务协议；跨实例的同一服务优先使用显式 Relay，不增加自定义 RPC 封装。
- Native Messaging + Windows shim 是后续正式安装候选，不是初始化交付物。
- 页面适配器在 mpctl 内部实现；WXT 通道不满足 Nexus 传输契约时，按实际失败证据调整底层，不在业务层叠加 RPC。
- 仍需验证的项包括真实 MP 页面下主执行环境桥的 CSP/兼容性、其他登录/权限信号及 JSAPI 用户操作约束；已观察登录超时页的完整 DOM 组合仅经匿名只读观察和离线 fixture 覆盖，离线 Chromium 也覆盖构建和 synthetic fixture 下的桥接行为。

## WSL、Chrome 与安全

默认连接方向是 Windows Chrome 扩展在用户操作后主动连接 `ws://127.0.0.1:17381/bridge`（建议值）。面向 agent 的默认结果只需说明是否已连接、页面是否可操作、下一步需用户做什么；WSL、socket、Nexus 会话和页面内部状态可留给显式诊断命令。WS 不可用时返回明确诊断，不提供 HTTP polling 控制回退。

broker 默认仅绑定 loopback。宿主负责路径、Origin、配对认证及连接资源限制；Nexus 负责其协议与会话处理，应用通过 `policy.canConnect` 和 `policy.canCall` 设置权限。`where` 仅筛选连接，不构成授权；对端声明的身份不等于宿主观察到的事实。页面中的 origin/nonce 不能排除同页脚本，页面桥不得暴露扩展特权、任意代码执行或 broker 控制入口。

## 能力与事实状态

```json
{
  "error": {
    "code": "not_connected",
    "instruction": "运行 mpctl connect --extension <id> 获取连接指令。"
  }
}
```

上例是输出形状示意。插件连接后可按需新建空白编辑页；仅已观察到的登录超时页完整标志组合返回登录专属结果，其他模式仍不支持分类。已验证 JSAPI 范围来自 `tmp/ref/editor-api-usage.md`，离线 fixture 与匿名只读观察均不构成真实 MP 账号兼容性证明。

## 当前设计边界

当前是四包 Bun/TypeScript 7/Oxc/Turbo workspace 与 WXT MV3 扩展，支持 `status`、`article list/open/new/current/pull/push/inspect/update`。list 提供稳定的实际组定位，open 当次重查对应组；文章引用只绑定当前 background 中的实际页面，current 可核对唯一已有编辑页并发新引用。saved 路径要求唯一可见的索引 0 当前项。正文版本用实际 HTML hash，交互本身不令引用失效。inspect 仅输出三个实际字段和独立 `fieldsHash`，不含正文／封面；update 仅修改作者／摘要且不保存／发表。当前隔离验收与单篇真实只读证据见 `tmp/reports/preparation-live-check.md`；T73/T74/T76/T78 为历史证据，不代表字段写入已在真实账号验收。其他登录模式、标题写入、保存、预览及图片能力不属于当前实现。

保存与预览保持独立，字段编辑和图片能力后续讨论；它们不作为当前正文文件工作流的前置设计。

## 参考资料

- [Nexus WebSocket adapter](https://c-w-xiaohei.github.io/nexus/docs/websocket/)
- [Nexus 核心概念](https://c-w-xiaohei.github.io/nexus/docs/concepts/)
- [Nexus Relay](https://c-w-xiaohei.github.io/nexus/docs/relay/)
- [Nexus WebSocket npm 包](https://www.npmjs.com/package/@nexus-js/websocket)
