# RFC 0002: mpctl Chrome 扩展开发、配对与发布流程

- 状态：目标开发/发布流程已记录；WXT MV3 扩展、显式配对与离线 Chromium 文件路径已实现并验证。一次真实账号的新稿合成正文往返及一次已存草稿只读拉取通过；这不证明普遍 MP 兼容性、已存稿写入、保存/发表或原子性。仅已观察到的登录超时页可分类；其他登录/权限形态及发布渠道未验证。
- 作者：mpctl 维护者
- 创建日期：2026-09-11

## 摘要

本文定义公众号编辑器 Chrome 扩展的目标开发加载、配对、调试和发布生命周期。扩展使用 WXT、Chrome Manifest V3 和 React；生产页面桥已在离线 Chromium fixture 中验证传输行为。有限真实账号验收通过一次新稿合成正文往返和一次已存草稿只读拉取，不代表普遍真实 MP 页面兼容性。

本文不定义总通信架构，见 [RFC 0001](./0001-communication-architecture.zh.md)。

## 关键结论

- JSAPI 只能在公众号编辑页主执行环境调用；扩展后台脚本、内容脚本和 CLI 不应直接假定可访问。
- 开发加载使用 WXT 生成的 Chrome MV3 未打包扩展；生产使用浏览器扩展包的正式发布渠道，具体商店/企业分发路径待定。
- 本地 broker 与扩展使用 mpctl 独立的配对凭证：插件用户显式连接时通过 WebSocket 子协议列表提供凭证，broker 在 Upgrade 阶段验证；不复用其他系统的 token 或 storage。
- 配对成功不代表真实 MP 页面编辑能力可用。离线 E2E 验证显式配对和合成 JSAPI 文件路径；匿名只读观察与离线 fixture 只支持一种明确登录超时页的分类，不验证真实页面会话或一般登录检测及平台能力。
- 当前只有就绪检查/读取/设置/插入已验证；选区、封面、事件、保存和发布未验证。
- 当前业务采用本地 HTML 拉取/推送，只需要正文读取和整体替换。插入接口的既有调用记录不意味着向 agent 提供光标或选区能力。

## 开发环境与加载流程

```txt
1. 安装 Bun 依赖，使用 Turbo 运行 workspace 任务；工具链版本与检查职责见 RFC 0005。
2. 在 `packages/extension` 运行 WXT 的开发命令，目标为 Chrome MV3。
3. 打开 Chrome 扩展管理页并开启开发者模式。
4. 加载 WXT 输出的未打包扩展目录；若已由开发启动器加载，则直接使用该实例。
5. 确认 mpctl 守护进程正在监听；CLI 能连接守护进程不代表插件已连接。
6. 用户在扩展界面配置 broker 地址与配对凭证并显式连接；也可运行 CLI `connect --extension <id>`，未连接时返回 instruction 与 connectionPageUrl，由 agent 按实际浏览器运行位置/profile 打开连接页并按已存配置连接。CLI 不启动浏览器，打开后用 status 核对连接。凭证以 WebSocket 子协议发送，broker 在 Upgrade 阶段验证，扩展将配置保存在 `storage.local`。
7. 插件此时才通过 Nexus WebSocket 客户端主动连接 `ws://127.0.0.1:17381/bridge`（建议值），完成连接授权后提供扩展服务。
8. 发起文章操作，由插件创建/复用 mpctl 标签组并按需打开首页、草稿列表或编辑页。
9. 当前支持路径只在本地合成页面验证编辑器就绪；仅已观察到的完整登录超时页标志组合支持登录专属失败结果，其他登录/权限模式不支持分类。
```

WXT 开发启动器、输出目录、Chrome 版本和 MV3 后台生命周期均需实际验证。开发服务器页面不是编辑器，弹出页的连接成功也不代表 JSAPI 调用成功。

开发服务器运行但后台仍使用旧修订时，可显式执行 CLI `connect --reload --extension <id>`。未连接时只返回连接页交接指令，由 agent 根据实际浏览器环境打开后确认连接，再重试 reload；已连接时直接通过通道重载。BG 写入 30 秒有效的一次性重连意图后调用 `chrome.runtime.reload()`；新 BG 先消费意图再连接一次，普通启动/断线不自动拨号。CLI 核对重载前后 broker 会话不同，不依赖捕捉瞬时离线，不自行打开任何内页。重载会丢文章引用表，应在创建/打开文章前执行。

### 工程入口与构建职责

扩展工程采用 WXT 的入口约定，基础结构如下：

```txt
packages/extension/
├── wxt.config.ts
├── entrypoints/
│   ├── background.ts
│   ├── mp.content.ts
│   ├── mp-main-world.ts
│   ├── connect/
│   │   ├── index.html
│   │   └── main.ts
│   └── popup/
│       ├── index.html
│       └── main.tsx
└── package.json
```

`background.ts` 通过 `defineBackground` 定义后台入口，`mp.content.ts` 通过 `defineContentScript` 定义隔离环境内容脚本。`mp-main-world.ts` 使用 `defineUnlistedScript` 定义常驻页面端入口，以 `injectScript` 加载为设计基线，具体兼容性须验证。React 界面通过 WXT React 模块集成。

WXT/Vite 负责入口构建、资源处理、清单生成及开发加载；Nexus 负责远程服务通信。不因采用 WXT 而额外引入消息 RPC 库。借鉴 WXT 的页面脚本桥接示例时，应将底层通道封装为 Nexus Endpoint/Port，并单独验证传输与生命周期语义。

开发、构建和归档分别使用 WXT 的 `wxt`、`wxt build`、`wxt zip` 命令，由包脚本和 Turbo 编排。Chrome MV3 默认开发输出为 `.output/chrome-mv3-dev/`，生产输出为 `.output/chrome-mv3/`；实际路径以锁定版本及项目配置为准。当前构建版本由私有 `packages/extension/package.json` 单独提供，产物 manifest 为 `0.1.0`；隔离的浏览器桥测试配置生成独立的合成版本 `0.0.1`。这两个值仅标记开发/测试构建，不表示已归档发布或商店分发。采用脚本元素加载页面端资源时，须在清单中限定 `web_accessible_resources` 的资源和匹配范围。

### WebSocket 开发基线

先前仅对 `@nexus-js/core@2.0.0-alpha.0` 与 `@nexus-js/websocket@0.1.0-alpha.1` 做过独立 WS 探针验证，不能将其当作 Relay 依赖基线。实施 Relay 时按 RFC 0001 锁定兼容的 Core、WebSocket、Node IPC 和 Chrome adapter alpha 版本，并验证跨实例运行。扩展仅导入 WebSocket 包的浏览器客户端入口，不引入 `/server`、`ws` 或 Node HTTP 服务端代码。

守护进程在 Bun 中通过 `node:http` 和 `ws` 承载同端口的 HTTP 与 Nexus WS Upgrade；当前普通 HTTP 请求仅返回 404，没有引入 `@hono/node-server`。离线 Chromium E2E 已通过 broker、Relay、扩展与 CLI 的产品文件路径。真实已登录开发版扩展通过一次新稿 `prepare → 原生实体点击 → complete → pull → push → pull` 合成正文往返，源文件未变；已存草稿通过 `list → prepare/open → 原生铅笔点击 → complete → pull`。未对已存稿 push、显式保存或发表；旧历史中的自动保存记录不证明本轮持久化。此有限证据不证明普遍站点兼容性、云端保存或操作原子性。详见 `tmp/reports/T69-final-verification.md`。

当前自动导航修订另在真实账号通过纯 CLI `connect --reload → article new → pull → 本地编辑 → push → pull` 的散文验收，全文和关键内联装饰保留、两个本地输入文件不变；saved 自动 `list → open → pull` 只读通过。成稿编辑页保留，当前完整隔离浏览器回归2/2通过。工作组使用 `storage.local` 持久锁定，实际合并3个重复组后仅1组，重载不再增加。实际结果见 `tmp/reports/T73-cli-only-essay-acceptance.md` 和 `tmp/reports/T74-persistent-group-and-closeout.md`。

扩展提供稳定的公众号工作区服务；守护进程只接纳唯一插件会话，并将工作区 Token Relay 至 IPC。文章切换由工作区引用解析处理，不切换守护进程上的页面 Relay。客户端 `connectTo` 是一次性启动连接配置；初次及断线后的连接均由用户触发，不因后台重启、页面加载或 CLI 查询而自动拨号。一个插件可管理多个 tab，但只维护一个工作标签组。

## 运行时边界

```txt
扩展后台脚本
-> Nexus Chrome
-> 内容脚本（隔离世界）
-> mpctl 内部页面 Nexus Endpoint/Port
-> 页面主执行环境
-> window.__MP_Editor_JSAPI__.invoke/on
```

页面适配器在扩展内实现，建议文件为 `packages/extension/src/transport/page-bridge.ts`，不要求独立目录；以 WXT 共享脚本节点和 `CustomEvent` 示例为起点封装 Nexus Endpoint/Port。MAIN 常驻提供正文 JSAPI 实现，内容脚本对后台提供页面 `EditorService`，并可处理经过验证的字段 DOM 操作。不依赖 iframe 或逐次脚本执行，不引入其他 RPC。须验证 CSP、二进制传输、同步重入、顺序及失效清理。页面不得获得扩展特权、broker 控制入口或配对凭证；服务与传输职责见 RFC 0003。

## 配对与开发诊断

扩展配置通过 `storage.local` 保存；CLI 启动 broker 时优先读取 `MPCTL_PAIRING_CREDENTIAL`，否则读取私有本机配置 `${XDG_CONFIG_HOME:-~/.config}/mpctl/broker.json`，可用 `MPCTL_BROKER_CONFIG` 覆盖路径。CLI 确认自己成功启动 broker 后才持久化环境凭证，复用既有 broker 不覆盖配置。broker 在 Upgrade 阶段验证凭证；扩展仅由显式 CLI `connect` 或插件界面操作触发连接，后台启动不自动拨号。凭证存在不等于用户允许自动重新连接。

状态至少分开报告：

```txt
CLI 已连接守护进程
插件未连接、正在连接或已连接
连接认证是否通过
内容脚本已连接
页面会话已识别
页面传输已建立/失败
页面 Nexus 会话已就绪/失败
JSAPI 已存在
编辑器已就绪
能力已验证/未知
```

以上是目标诊断阶段。当前未连接状态和连接流程已实现；仅完整匹配已观察登录超时页标志组合时返回登录提示，其他登录/权限页不作登录结论。后台重启不自动建立 WS；连接重建不重放旧操作，也不恢复旧 proxy/ref。数据分层见 RFC 0003。

## 调用与回调约束

页面调用形状是：

```js
window.__MP_Editor_JSAPI__.invoke({
  apiName: "mp_editor_get_content",
  apiParam: {},
  sucCb: (result) => {},
  errCb: (error) => {},
});
```

`invoke` 不是 Promise API；EditorService 内部的 JSAPI 包装负责回调、结构化错误、超时和迟到结果，不放入传输适配器。写操作回调成功不等于服务器已保存。`on()` 的事件触发、频率、取消监听和跨边界数据尚未验证，暂不作为稳定订阅服务。

## 发布生命周期

```txt
本地开发 -> 加载未打包扩展 -> 手工 smoke test
-> 使用 WXT 构建 Chrome MV3 扩展并归档 -> 版本化产物
-> 选择 Chrome Web Store / 企业策略 / 内部分发路径
-> 审核或管理员批准（具体流程待验证）
-> 发布扩展 -> 用户安装/更新
-> 用户在插件界面发起连接 -> 守护进程准入 -> 页面能力检查
```

扩展发布只解决代码分发，不解决公众号页面权限、登录态、主世界桥兼容性或保存发布能力。商店 listing、host permissions、企业策略、自动更新和审核要求必须以实际目标分发渠道确认，不能将未验证的流程表述为已支持。

## 安全要求

- broker 绑定 loopback，使用 WebSocket 子协议传递 mpctl 凭证并在 Upgrade 阶段核对；服务端只选择固定非密钥子协议，不回显凭证。凭证长度、生成和轮换细节由连接契约落实。
- 扩展后台通过 Nexus 提供固定服务方法，使用连接及调用授权策略；内容脚本只允许固定编辑操作。
- 配对凭证仅在插件显式连接时通过 WebSocket 子协议传给 broker；已核对的当前 socket 身份事实交给 Nexus 授权策略。凭证不放 WS URL、查询参数、日志或页面桥；客户端检查服务端选择固定非密钥子协议，不能假定浏览器 WS 可以附加任意认证头。
- 页面主执行环境桥使用精确目标与请求关联；origin/nonce 只能作为协议约束或会话信号，不能声称能认证同页恶意脚本。
- 不接受任意 JS、任意 `apiName` 或任意页面对象跨边界传递；API allowlist 当前限定为已验证能力。
- 写入失败或断线可能使结果未知，无法确认时明确报告，不自动重放；当前不要求持久操作查询协议。守护进程仅负责连接通路。
- 页面桥不向页面开放扩展特权，也不暴露 pairing token。

## Spike 验收标准

在声明扩展链路可用前，至少验证：

1. WXT Chrome MV3 构建能够加载；普通后台重启后保持未连接，直到用户显式连接。用户请求的通道 reload 例外：新后台消费短时一次性意图后连接一次。
2. 守护进程已可供 CLI 查询、插件尚未连接时，CLI 返回可行动的用户连接提示；用户发起连接后完成准入，错误凭证被拒绝。
   验证 Nexus WS 会话就绪及 broker 对扩展 provider 的反向调用，不能以原生 socket 已打开作为通过条件。
3. 工作区能按需创建/复用标签组与页面；草稿列表打开正确稿件后返回文章引用，内容脚本核对具体文档与条目。
4. 页面 Endpoint/Port 通过二进制传输、Nexus 握手、双向调用、顺序与重入验证；EditorService 能读取状态及正文。
5. 以文章引用拉取正文到本地 HTML，编辑后携带返回的 `bodyHash` 作为 `--expected-hash` 推送；MAIN 比较实际当前正文版本后整体替换并回读规范化 hash。CLI 负责文件 I/O，不强制备份、不提供光标插入。
6. tab reload、页面切换或后台重启后旧文章引用失效；CLI 退出、单纯 WS/守护进程断线不清仍存活后台的引用表。重新连接由用户显式触发，旧调用不重放；current 可为唯一已有可用编辑页发新引用，但不能复活失效的 content bridge。
7. 超时或断线产生未知操作时不自动重放；如何核对及继续文章工作流由业务方案验证，不归因于守护进程连接是否恢复。

检查项区分目标要求与已验证能力。离线 Chromium E2E 已通过 popup 首次后台控制通道失败后的用户显式重试、挂载期已存配置迟到时用户输入逐字段优先（包括手动清空）及读取期间按当前输入连接、合成错误凭证请求的失败关闭、同弹窗正确凭证的手动连接、待完成连接的取消及迟到握手拒绝、再次手动连接、真实 CLI/broker/Relay/扩展/页面桥及本地 HTML 文件路径；生产桥传输测试也已通过。Bun 当前运行时对拒绝的 WebSocket Upgrade 未发送可观察的 HTTP 401 字节，浏览器测试只记录经 broker 前直通代理的连接到达/关闭；错误凭证拒绝分支另由 broker 集成测试与代码证实，不能说浏览器观察到 401。合成夹具覆盖受限的草稿列表/打开、单条正文 I/O 和已观察登录超时页的失败分类；这不证明真实 MP 兼容性、其他登录/权限分类、稳定条目身份、平台程序性切换或在途调用原子性。保存/发布未实现。详见 `tmp/reports/T25.md`、`tmp/reports/T26.md` 与 `tmp/reviews/T26-r4.md`（本地报告，不纳入 Git）。文件格式、推送语义和职责见 [RFC 0004](./0004-article-and-assets-workflow.zh.md)。

## 未决项

- WXT 页面通道与 Nexus Port 的数据、生命周期兼容性及目标页面 CSP。
- WXT/Vite 对工作区共享源码、React 界面和多个 Nexus 实例的打包行为。
- Chrome host permissions、企业分发和正式商店要求。
- 页面 JSAPI 是否在所有目标编辑器版本存在，ready 条件是否足够。
- 正文保存、封面、发布、事件和标题的正式能力。

## 参考资料

- [WXT 内容脚本与主执行环境](https://wxt.dev/guide/essentials/content-scripts.html#isolated-world-vs-main-world)
- [WXT 工程入口](https://wxt.dev/guide/essentials/entrypoints.html)
- [WXT 消息通信](https://wxt.dev/guide/essentials/messaging.html)
