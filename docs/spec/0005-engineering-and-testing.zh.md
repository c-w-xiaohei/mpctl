# RFC 0005：工程结构与测试架构

- 状态：本轮工程与测试决策已确认；随产品实现逐步验证
- 作者：mpctl 维护者
- 创建日期：2026-09-25

## 1. 目的与范围

本文记录 workspace 边界、工具链职责和验证层次，服务 RFC 0001–0004 定义的文件驱动文字正文流程。测试用于证明局部行为、传输集成和真实浏览器执行边界；不扩展产品命令或建立通用测试框架。原计划不使用真实 MP 账号；后续用户明确授权在其已安装扩展的 Chrome 中作真实账号验证，且反馈测试标签过多后要求未经再次确认不再创建真实测试标签。真实验收与离线证据分开记录，见 `tmp/live-verification-evidence.md`。

## 2. Workspace 与模块边界

仓库使用 Bun workspace 和 Turbo，包含四个包：

| 包                   | 职责                                                                                                           |
| -------------------- | -------------------------------------------------------------------------------------------------------------- |
| `packages/cli`       | CLI main、article、connection；文章命令与本地 UTF-8 HTML 文件 I/O 同处，不额外建 FileService。                 |
| `packages/broker`    | broker main/server、IPC 与 WS 宿主、唯一插件连接及 Relay 生命周期。Relay 属连接编排，不预先抽成纯转发包/模块。 |
| `packages/contracts` | CLI、broker、extension 跨程序共享的 workspace/connection 类型、Valibot schema 与 Token。取代原 `shared`。      |
| `packages/extension` | WXT MV3 入口及插件内部业务和适配器。                                                                           |

依赖方向：运行时包可依赖 `contracts`；`contracts` 不依赖运行时包。扩展内部页面契约属于扩展，不因 TS 类型方便就提升为跨包 API。`contracts` 不包含 Chrome 地址、DOM、Node 服务实现或扩展存储记录。

扩展建议的职责落点是 `src/connection.ts`、`src/workspace.ts`、`src/pages.ts`、`src/mp/drafts.ts`、`src/mp/editor.ts`、`src/mp/jsapi.ts`；Nexus 页面传输若有独立边界，使用 `src/transport/page-bridge.ts`。该文件/路径是落点建议，不要求创建 `transport/page-bridge/` 目录。职责可按实现规模合并，不建空目录、空接口或仅为对称而设的模块。不得提前拆 article managers 或纯 Relay/转发模块。

文章引用与浏览器业务由 workspace 拥有；pages 管 Chrome 页面生命周期；mp 模块管理微信页面/JSAPI；页面桥管理 Nexus 传输。WXT entrypoint 负责平台入口及组装，不承载独立业务规则。目录是定位辅助，不要求每个职责对应一个类。

当前清理落点：`background-runtime.ts` 仅构造唯一 Chrome Nexus，background entrypoint 统一配置；`mp/routes.ts` 保存跨 world 共享的纯路由判据，content/MAIN 不导入 background 实例或 Chrome 页面管理器。content 正文用 Relay，保留本地 DOM provider 和调用 policy；MAIN 拥有实际 HTML hash 与文档写入队列。删除旧 prepare/complete、随机候选注册表、交互计数及另造连接缓存。

CLI 使用 Commander 声明命令树、必选参数、标准帮助和参数错误，业务不解析 argv 位置。`article.ts` 处理正文操作，`body-file.ts` 集中无覆盖/原子替换；成功操作 JSON、帮助文本、TTY-only 等待提示遵循标准输出边界。saved open 直接返回每个请求自己的页面绑定，不用组 ID 槽位跨方法交接；错误带 pageCreated 事实，不暴露内部 tab/document/URL。

帮助逐层披露：root 区分日常与维护入口，article 分组说明选择文章和文件工作流，叶子说明必要参数、输入输出、示例及当前操作约束。空分组命令成功显示帮助，子命令展示继承的全局选项。正常 connect 按需启动 broker，broker start 只用于单独启动后台；workspace cleanup 是维护入口，不是正文流程前置步骤。

输出面向 agent context，默认只保留下一步必需数据。open/new/current 返回 article 与 bodyHash，pull/push 仅 bodyHash，list 保留供选择的标题；inspect 仅返回 title、author、summary、fieldsHash，版本不含正文或封面。错误为 code 与必要事实，仅需恢复动作时附一条短 instruction，不再重复 message/action；stage 不附同义翻译，pageCreated 仅为 true 时输出。协议版本只在 status --details 披露，不在每次响应复制就绪说明。

## 3. 工具链与脚本

- Bun 是安装、脚本、workspace 和运行时工具；Turbo 编排包任务及依赖顺序。
- TypeScript 7 `tsgo` 负责类型检查；不以 transpile/build 成功替代 typecheck。
- Oxlint 负责 lint，Oxfmt 负责格式化；Oxc 取代 Biome，不并行维护 Biome 配置。
- WXT 负责扩展 entrypoints、Chrome MV3 构建与开发体验；React 用于扩展 UI。
- Valibot 用于业务边界运行时数据校验；TS 类型本身不替代运行时校验。

根目录维护一致的包管理、格式和 lint 风格；各运行时使用隔离的 TS 配置，明确 Node/Bun 与 DOM/Chrome 全局边界。扩展 TS 配置继承 WXT 生成的配置。根/Turbo 及每个运行时包提供可运行的 `lint`、`format`、`typecheck`、`test`、`build` 脚本；没有适用构建产物的包可提供成功且有说明的 build 脚本，不伪造额外构建步骤。扩展另提供独立浏览器集成测试命令。具体脚本名可由实现落定，但应可从包级及 Turbo 统一调用。

## 4. 测试层次

测试分层针对不同风险，不互相冒充：

### 4.1 本地行为测试

使用 Bun 测试运行时，放在所属包内相邻的 `*.test.ts` 或 `test/`，按仓库一致约定组织。覆盖可确定的纯业务行为与边界：文章引用解析/校验、登录与页面失败结果区分、文件 UTF-8 读写错误语义、整体替换输入及未知操作结果、连接准入和清理等。只隔离真正外部副作用；被测转换或业务边界不得被 mock 掉。避免测试私有结构、重复生产逻辑，或仅断言源代码/字符串存在。

### 4.2 Nexus transport / Relay 集成

在 Bun 中运行真实 Nexus Node IPC 与 WS adapter 和真实 Relay，使用进程内/临时端点及小型测试 provider 验证端到端调用、方向、回调/资源作用域、连接断开后的失效以及重新接入，不 mock 被测 transport、Nexus 会话或 Relay。可替换的业务 provider 仅用于构造明确的集成场景；此测试证明 Nexus adapter/Relay 链路，不证明 Windows Chrome 或微信页面可用。

测试启动 CLI/broker 子进程时，socket、WS 端口和持久配对配置路径均使用隔离的临时位置；只隔离 socket 不能防止测试凭据覆盖用户默认配置。真实本机配置不作为测试输出或可变测试夹具。

跨服务调用的预期业务失败应作为 `Err` 沿真实 transport/Relay 链路传递；`Result` 实例不视为 wire 上的类实例。服务 wire 结果使用 protocol `0.5.0` 的 `status: "ok"` / `status: "error"` envelope，消费端在使用值前通过异步 codec 解码为 `Result`，包括将畸形 envelope 解为 `invalid_result_envelope`。字段修改已派发但结果不明时保留 `field_update_unknown`，包括内层 Chrome 回复丢失或无效，不用普通页面失败掩盖。浏览器/集成断言需保留完整调用链和具体错误事实；只有 CLI 终端边界将 `Err` 映射为既有紧凑错误 JSON。

### 4.3 Chromium 扩展跨 world fixture 集成

使用真实 Chromium 加载构建的扩展，在 fixture 页面中实际运行 WXT content script（ISOLATED）与 MAIN world entrypoint，连接真实页面 Nexus Endpoint/Port，并通过有行为的 fixture JSAPI 执行双向消息、二进制载荷、顺序/重入防护、关闭与页面重载等检查。被验证的 ISOLATED↔MAIN 桥不得由函数 mock、合成 postMessage 替身或直接调用模块代替。

Fixture 是受控的浏览器执行环境，用来验证 Chrome world 隔离、WXT 注入、浏览器序列化与桥接生命周期；它不是微信页面，也不能证明微信 JSAPI 兼容或真实账号流程。测试实现选择应与 Bun/WXT 相容，并复用单一浏览器运行器/driver；可由测试命令启动并以 CDP 驱动 Chromium，不为此引入面向产品的服务、RPC、daemon 或扩展入口。fixture 与浏览器测试归扩展包，独立于快速本地测试运行。

若浏览器、可执行文件或必要依赖不可用，浏览器命令必须明确失败或以机器可读/日志可见的 `SKIP` 说明原因；CI/验收记录需区分通过、跳过和失败，不能把未执行算作通过。常规无浏览器的 `test` 是否调用独立浏览器命令由 Turbo 配置清楚表达，不能静默吞掉其失败。

### 4.4 最小受控 E2E 与平台边界

在上述 Chromium fixture 环境中保留一条真实 CLI → IPC → broker Relay → WS → 扩展 → Chrome → 页面桥 → fixture JSAPI 的文件拉取/推送主路径，并检查用户显式连接、断线后不自动拨号及结果未知不重放。复用同一浏览器运行器，不另建模拟公众号平台。测试可使用浏览器请求拦截在匹配生产入口的 URL 下提供合成 HTML，但不得放通到真实 MP 站点；不能修改生产 host 权限来暴露测试接口。

草稿列表、图文条目等页面解析以已有脱敏结构证据为依据单独测试。fixture 不能证明微信当前 DOM 或真实账号行为；缺乏依据的页面兼容能力要明确记录，不能靠自造 fixture 反证实现正确。历史真实手动交接记录见 `tmp/reports/T69-final-verification.md`。真实验收要求仅使用项目 CLI 创建/打开、pull/push/pull，扩展内部原生导航属于产品链路，外部浏览器自动化不得补步骤；历史纯 CLI 真实验收见 T73/T74。本轮修订的隔离验收见 `tmp/reports/T78-cli-conventions-and-workflow.md`，历史真实结果不能冒充当前修订验收。

## 5. 证据与范围

测试证明的范围必须与实际执行边界一致：本地测试证明包内行为；Nexus 集成证明真实 transport/Relay；Chromium fixture/E2E 证明真实浏览器跨 world 桥和产品文件链路，不证明真实微信兼容性。测试失败应保留原始错误与可复现命令；跳过应给出环境原因和未验证能力。禁止字符串存在性断言充当行为测试，禁止 mock 掉本测试声称验证的桥接链路，禁止把合成页面描述成真实微信。

以上约定不改变 RFC 0004 的 file-facing 模型：agent 编辑本地 HTML，CLI 文件读写，插件收发 HTML，push 整体替换当前正文，不保存/发表、不反写源文件、不自动重放；不增加 patch/光标协议、素材能力、文章持久库或通用测试平台。
