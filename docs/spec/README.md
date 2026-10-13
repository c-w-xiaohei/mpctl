# mpctl 技术规格

当前设计聚焦文件驱动的公众号正文编辑：将指定文章的正文拉取为本地 HTML，agent 用已有文件工具排版，再推送回编辑器。文章引用确定目标，HTML 文件承载正文，插件组织浏览器操作，微信编辑器负责渲染。

本文区分目标设计与当前实现。RFC 中的架构和流程描述目标边界；各 RFC 状态及“当前实现与证据”段落记录已落地范围和限制。端口、socket 等配置以实现为准。

## 文档索引

1. [RFC 0001 通信架构与技术栈](./0001-communication-architecture.zh.md)：运行时边界、常驻守护进程、唯一插件连接与 Nexus Relay。
2. [RFC 0002 扩展开发与发布流程](./0002-mp-extension-development-and-release-flow.zh.md)：WXT Chrome MV3 工程、用户显式连接、开发加载与发布。
3. [RFC 0003 插件工作区与页面通信适配器](./0003-nexus-main-world-editor-bridge.zh.md)：标签组、文章定位、插件数据归属、内部正文服务与 MAIN Endpoint/Port。
4. [RFC 0004 文件驱动的正文编辑与排版](./0004-article-and-assets-workflow.zh.md)：编辑器模型、正文文件约定、拉取/推送语义、agent 工作方式。保留原文件路径以维持已有链接。
5. [RFC 0005 工程结构与测试架构](./0005-engineering-and-testing.zh.md)：workspace 包边界、工具链职责、测试层次及真实浏览器/微信证据范围。
6. [RFC 0006 公众号发稿准备与管理能力扩展](./0006-article-preparation-and-management.zh.md)：提案；字段、图片／封面、检查／保存与预览的单篇工作流，采用新版 Nexus 二进制能力传图片，区分传输验证与微信上传验证。
7. [RFC 0007 发稿准备能力实施方案](./0007-article-preparation-implementation-plan.zh.md)：设计草案；命令输入输出、运行时落点、Nexus 升级与页面能力核实、任务依赖和退出条件。
8. [RFC 0008 分布式执行、幂等记录与异常责任](./0008-distributed-execution-and-errors.zh.md)：收敛提案；IndexedDB 与 BG 防重接口、执行端薄守卫、BODY 冲突／回执查询切片、单一操作快照与交互错误；不默认全局锁。尚未实施。

## 已确定的设计

- 一个编辑页可能有多条图文。文章是操作对象，tab 是操作场所；标题、作者、摘要独立于正文 HTML。
- agent-facing 使用文章引用和本地 HTML 文件。mpctl 不提供正文 patch、光标、选区或段落修改协议。
- CLI 读取或写入 UTF-8 HTML 片段；插件传递 HTML，不访问本地路径。不增加 manifest、sidecar、排版 DSL 或正文文件仓库。
- 推送以调用者观察的实际 HTML `expectedHash` 检查正文版本，冲突零写入；成功后整体替换并回读规范化 `bodyHash`。不做合并或强制备份；JSAPI 检查后写入不是原子 CAS。
- 推送不自动反写本地源文件，不隐含保存草稿或发表。微信会规范化 HTML，实际结果可以再次拉取，视觉效果以编辑器呈现为准。
- 目标设计：插件维护一个 `mpctl` 工作标签组，按需开页、检查登录并解析文章引用；登录失败与页面加载失败应分别报告。当前实现边界见下文“当前状态与范围”。
- 守护进程常驻并维持唯一插件的一条有效 WS 连接；首次和断线后的连接均需显式发起，可使用插件 UI，或由 CLI `connect` 返回 instruction/connectionPageUrl，agent 按浏览器实际运行位置打开扩展连接页。CLI 不启动浏览器，普通状态/正文命令不自动重连。
- 插件通过标准 WebSocket 子协议提供 mpctl 配对凭证；守护进程在 Upgrade 阶段核对，仅选择固定非密钥协议并将已验证连接事实交给 Nexus 授权。凭证不放 URL、日志或页面桥。
- 守护进程 Relay 唯一插件的稳定工作区入口；文章切换由插件内部处理，不轮换全局页面 Token。
- 工作组锁和配置放在 `storage.local`，受管 tab 与临时 document 提示放在 `storage.session`，连接/proxy/ref 与文章引用表留在所属运行时内存。后台重启核对工作组并等待 content 上报，不恢复文章引用；CLI 退出和仅 WS 断开不清仍存活 background 的绑定。不重放旧请求。
- 技术栈为 Bun、TypeScript 7 (`tsgo`)、Oxlint、Oxfmt、Turbo、Valibot，插件采用 WXT、Chrome MV3、React。通信采用 Nexus Node IPC、WS、Chrome 和 mpctl 内部 MAIN 页面桥；当前 WS 宿主使用 `node:http + ws`，普通 HTTP 请求由 `node:http` 返回 404，没有引入 Hono 或正文 HTTP 端点。workspace 与测试约定见 RFC 0005。
- 需要顺序执行或限制请求量时，在插件业务层排队、做背压。超时或断线后无法确定写入结果时如实报告，不自动重放。

## 当前状态与范围

- 已实现 Bun/TypeScript 7/Oxc/Turbo workspace 的 `cli`、`broker`、`contracts`、`extension` 四个包；扩展使用 WXT、Chrome MV3 与 React，运行时服务经 Nexus IPC、WebSocket、Chrome 和页面桥连接。详见 RFC 0005。
- 当前支持新稿正文 I/O 与受限 saved 列表/打开及单条可见图文正文 I/O。list 使用实际组定位，重复/失败读取不撤销旧选择；open 当次重查对应组，再经原生 Edit 目标获取实际页面引用。候选和引用都不是永久文章 ID。当前 hash/Relay 清理证据见 `tmp/reports/T76-nexus-cleanup.md`。
- saved 访问要求原路由/文档及唯一可见当前索引 0；第二项可见即拒绝。`data-msgindex="0"` 不是稳定 ID；无害交互不撤销引用，正文变化以实际 HTML hash 判断。完整已观察超时页分类为 `not_logged_in`，其他登录模式与已登录空列表尚无可靠判据。先前真实 CLI 新稿往返和 saved 只读通过见 T73/T74；本轮清理只做隔离验证，不代替真实站点兼容性结论。
- 正文 `get_isready/get_content/set_content/insert_html` 曾在真实页面单独调用；当前文件模型采用读取和整体替换，不据此扩大接口范围。
- 当前离线 E2E 已覆盖产品文件路径及生产页面桥在 Chromium 中的跨 world 传输；它不等于真实 MP 联调。旧版隔离探针的版本信息仅是历史证据，不能代表当前依赖版本。详见 RFC 0001。
- 已接入只读 `article inspect <article>`，输出 `title`、`author`、`summary`、`fieldsHash`；版本仅覆盖这三个实际字段值，不含正文、封面或平台自动摘要。真实已存稿 current→inspect→重复读取→pull 已验证字段 hash、读取稳定性和正文不变，并在运行时升级至 `0.5.0` 后再次通过。仅验收此单篇页面，不外推所有变体。真实页面观察使用 agent-browser 连接 9222。
- 已接入 `article update` 的作者／摘要 partial JSON 修改，版本冲突零写入、未知结果不重试、部分事实不推断未派发字段。独立安全审查、290 项测试与 3 项隔离浏览器测试通过；后续生产证据见下条。标题写入、CLI 保存、封面和预览仍未交付。
- 生产 P1 已在单独新建的验证稿上验证作者／摘要更新、清空、Unicode、过期 hash 拒绝及正文不变；P2 原生保存一次，刷新列表后 product open 同一保存身份，fieldsHash／bodyHash 与保存前一致，封面仍可见。云端持久化证据已取得，但这不等于 CLI save／cover 已实现；列表缓存问题正在修复。现有稿件未修改，后续复用同一稿件 checkpoint。
- `0.6.0` 的 list 刷新／inspect/check/pull 生产验收通过，check 仅返回 errors/warnings，不保证可以发表；`0.7.0` 完整标题 CLI 链路已验收，包括修改、旧 hash 拒绝、清空后的原始换行读取及 tuple hash 核对，作者／摘要／正文不变，candidate 和编辑路由均与 prior saved 身份一致。后续 P10 一次明确原生保存，新增手动保存记录后 product 重开同一身份，最新标题／字段／正文／封面状态持久化核实；不是 CLI save 接口。当前已验证正式 372 项测试、类型／lint／格式和完整隔离浏览器标题场景；新图片产品源码仍在实施，需要下一修订重新验收。
- 图片上传、素材管理和封面尚未实现；历史观察摘要保留在 RFC 0004。新版 Nexus 已固定安装，IPC／Relay／WS、后台／content Chrome 及 MAIN／ISOLATED Blob RPC 各段已通过隔离验证，不等同于一个完整业务上传调用。传输验证不代替微信上传成功、素材持久 URL 或产品大小上限验证。
- 后续扩展方向见 RFC 0006；该提案不代表保存、预览或素材操作已经可用，也不授权真实账号写入。字段读写能力的具体实施与验收边界见 RFC 0007。
