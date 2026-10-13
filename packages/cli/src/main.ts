#!/usr/bin/env bun
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { articleCommand } from "./article.js";
import { operationStatus } from "./connection.js";
import {
  friendlyError,
  withBroker,
  withConnection,
  cliError,
  cliErrorFromUnknown,
} from "./connection.js";
import { connectCommand } from "./connect.js";
import { protocolVersion } from "@mpctl/contracts";
import { Result } from "better-result";
import { assetCommand } from "./asset.js";

const program = new Command()
  .name("mpctl")
  .description("在本地 HTML 文件与公众号编辑器之间读写正文，并检查或更新作者和摘要字段。")
  .version(protocolVersion)
  .option("--quiet", "不输出交互终端的等待提示")
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .configureHelp({ showGlobalOptions: true })
  .commandsGroup("日常命令：")
  .addHelpText("after", "\n运行 mpctl <command> --help 查看用法。操作结果为 JSON；帮助为文本。");
program
  .command("status")
  .description("查看插件连接状态")
  .option("--details", "显示 broker/插件协议版本及就绪含义")
  .addHelpText(
    "after",
    "\n返回 connected，仅表示传输连接，不代表公众号登录或编辑页就绪。\n--details 返回运行中组件的协议版本；未上报版本显示 null。",
  )
  .action(async (options) =>
    outputOutcome(
      await withBroker(async ({ connection }) => {
        const status = await connection.getStatus();
        if (Result.isError(status)) return Result.err(cliError(status.error.code));
        const { connected, brokerVersion, extensionVersion } = status.value;
        return Result.ok(
          options.details
            ? {
                connected,
                brokerVersion: brokerVersion ?? null,
                extensionVersion: extensionVersion ?? null,
                expectedVersion: protocolVersion,
              }
            : { connected },
        );
      }),
    ),
  );
program
  .command("connect")
  .description("检查插件连接，未连接时返回浏览器交接指令")
  .option("--extension <id>", "已安装扩展 ID", process.env.MPCTL_EXTENSION_ID)
  .option("--reload", "通过现有通道重载插件，并完成本次重连")
  .addHelpText(
    "after",
    "\n按需启动本地后台；已连接时返回 connected:true。未连接时非零退出，\n返回 instruction；提供 --extension 或 MPCTL_EXTENSION_ID 时附 connectionPageUrl。\nagent 应根据浏览器实际运行位置和 profile，使用该环境的工具打开连接页；\nCLI 不启动浏览器，也不等待交接。连接页成功或失败后均自动关闭。\n打开后运行 mpctl status 确认连接，再重试原命令。\n--reload 仅在已连接时通过通道重载并等待本次重连；未连接时先返回交接指令。\n重载会使旧文章引用失效；用 article current 获取已有编辑页的新引用，\n或 list → open 重新定位已存稿。失效的页面桥不能靠 current 恢复。\n\n示例：\n  mpctl connect --extension <installed-extension-id>\n  mpctl connect --reload",
  )
  .action(async (options) => outputOutcome(await connectCommand(options)));
const broker = program.command("broker").helpGroup("维护命令：").description("单独启动本地后台");
broker.addHelpCommand(true);
broker.action(() => broker.help());
broker.addHelpText(
  "after",
  "\n常规 connect/status/article 命令会按需启动后台，无需先运行 broker start。",
);
broker
  .command("start")
  .description("仅启动或复用后台，不连接浏览器")
  .addHelpText(
    "after",
    "\n返回 started，表示本次是否新启动后台；退出 0 表示后台可用。\n仅需预先启动后台时使用；正常工作从 mpctl connect 开始。\n首次启动须配置 MPCTL_PAIRING_CREDENTIAL；之后可使用已保存的私有配对配置。",
  )
  .action(async () =>
    outputOutcome(
      await withBroker(async ({ brokerStarted, connection }) => {
        const status = await connection.getStatus();
        if (Result.isError(status)) return Result.err(cliError(status.error.code));
        return Result.ok({ started: brokerStarted });
      }),
    ),
  );
const workspace = program
  .command("workspace")
  .helpGroup("维护命令：")
  .description("维护工作标签组");
workspace.addHelpCommand(true);
workspace.action(() => workspace.help());
workspace
  .command("cleanup")
  .description("合并重复工作组，保留标签和正文")
  .addHelpText(
    "after",
    "\n将重复 mpctl 工作组中的标签移入锁定工作组，返回清理计数。\n不关闭标签，不改写正文，不影响其他工作组；通常无需执行。",
  )
  .action(async () =>
    outputOutcome(
      await withConnection(async ({ workspace }) => {
        const result = await workspace.cleanupWorkspace();
        if (Result.isError(result)) return Result.err(result.error);
        return Result.ok(result.value);
      }),
    ),
  );
const article = program.command("article").description("选择文章、读写正文与检查已支持字段");
article.addHelpCommand(true);
article.action(() => article.help());
article.addHelpText(
  "after",
  "\n已有稿：list → open → current --candidate <candidate> → pull → 编辑文件 → push\n新稿：  new → current --new → pull → 编辑文件 → push\n已有编辑页：current → pull → 编辑文件 → push\n\nopen/new 返回操作快照；current 返回新取得的 article 和 bodyHash。分组内首页、草稿列表、同一 SavedID 编辑页各自唯一，\n普通 open 复用同稿有效编辑页，不刷新或覆盖未保存内容。已有新稿页时 new 拒绝重复创建；\n使用 current 读取现有页。save 只观察原生确认，不刷新或重开验收。\n已有重复页返回 target_ambiguous，不自动关闭编辑页。\npush 使用上次读取的 bodyHash，不使用修改后文件的 hash。正文写入不显式保存或发表。\ninspect 只读 title、author、summary，不读取正文或修改文章。\n运行 mpctl article <command> --help 查看参数和示例。",
);
article
  .command("cover")
  .helpGroup("发稿准备：")
  .argument("<article>", "临时文章引用", nonBlank)
  .option("--asset <asset>", "显式 asset list 返回的同文章临时素材句柄")
  .option(
    "--from-body <number>",
    "当前正文第几张图片（从 1 开始，不含分隔符）；图文消息草稿，默认居中裁切",
  )
  .option("--expected-body-hash <bodyHash>", "--from-body 必需：当前正文 bodyHash")
  .option("--expected-hash <coverHash>", "必需：article cover 读取的封面版本")
  .option("--operation <id>", "稳定操作 ID；封面设置同次重提保留原键")
  .description("读取封面版本；提供成对写入选项时显式设置封面，不保存")
  .addHelpText(
    "after",
    "\ncoverHash 只涵盖当前 primary/square 预览 URL 与可见性，不是裁切坐标或永久素材身份。无参数为只读。互斥来源：--asset 或 --from-body；两者都必需 --expected-hash。--from-body 还必需当前正文 --expected-body-hash，按 pull 中图片顺序从 1 开始（排除分隔符），仅支持图文消息草稿中受检平台 data-src 图片，使用官方接口默认居中裁切，无 debugger 需求。设置不会改正文/字段或保存；成功仅为页面确认，不是云端持久化。未知结果查询原 operation，不重试。旧 --asset 路径隐藏的 hover-only 控件需要 debugger 权限；默认生产权限不包含它，缺权限时返回 cover_input_unavailable，不请求权限或接管已有调试会话。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("cover", ref, options)));
article
  .command("save")
  .option("--operation <id>", "稳定操作 ID；保存同次重提保留原键")
  .helpGroup("发稿准备：")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption(
    "--expected-body-hash <hash>",
    "必需：current/pull 读取的正文 bodyHash（不是修改后本地文件 hash）",
  )
  .requiredOption(
    "--expected-fields-hash <hash>",
    "必需：article inspect 读取的 title/author/summary fieldsHash",
  )
  .requiredOption(
    "--expected-cover-hash <hash>",
    "必需：article cover 只读读取的 configured-cover hash",
  )
  .description("显式保存已存单篇稿并观察原生确认，不刷新或重开验收")
  .addHelpText(
    "after",
    "\n仅支持已保存的单篇文章；新稿派发前返回 unsupported。bodyHash 来自已读正文，不是修改后本地文件的 hash；fieldsHash 来自 article inspect 的原始字段；coverHash 来自 article cover 只读结果。保存前核对正文、标题/作者/摘要和配置封面的三个当前 hash，只点击一次原生手动保存并观察确认、清理自有历史面板。不刷新草稿列表、不重载编辑页、不做独立云端重开验收；成功 snapshot 为 settled/confirmed，persistence 为 unverified，不代表平台级准备就绪。原 article 引用不因 SAVE 失效；同键只返回持久结果，不再次 SAVE。派发前 stderr 输出 operation ID；结果未知先 operation status 原 ID，不换键重做。历史未决操作不会因新语义解锁，旧 verified 记录保持可读。不会发布、发送预览或回滚。",
  )
  .action(async (ref, options) =>
    outputOutcome(
      await articleCommand("save", ref, {
        expectedBodyHash: options.expectedBodyHash,
        expectedFieldsHash: options.expectedFieldsHash,
        expectedCoverHash: options.expectedCoverHash,
        operation: options.operation,
      }),
    ),
  );
const asset = program.command("asset").description("查看或上传文章图片素材");
asset.addHelpCommand(true);
asset.action(() => asset.help());
asset
  .command("list")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("列出当前可见页面范围内的图片素材")
  .addHelpText(
    "after",
    "\n仅返回 visible-page 范围，不是全账号素材目录。asset 是绑定文章和页面文档的临时句柄；thumbnailUrl 是缩略图，不是正文原图地址。不会插入正文、选择封面或保存文章。",
  )
  .action(async (ref) => outputOutcome(await assetCommand("list", ref)));
asset
  .command("upload")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--file <path>", "支持的 PNG、JPEG、GIF 或 WebP 文件")
  .option("--operation <id>", "稳定操作 ID；同次重提保留原键和文件内容")
  .description("上传图片到当前文章的图片库；不插入正文或选择封面")
  .addHelpText(
    "after",
    "\n文件采用 2 MiB 本地保守预算并校验格式签名，不是平台大小或完整解码保证。同名拒绝，不自动改名。派发前 stderr 输出稳定 operation ID；同次重提保留原 ID、article、字节、filename 和 MIME。返回统一持久 snapshot，创建确认与缩略图在 snapshot.effect；不返回可用素材句柄。结果未知先 operation status 原 ID，不换键或重传；查询不打开素材库。清理失败保留确认及首因；confirmationTimedOut 区分确认超时与最后观察原因。历史记录不恢复旧引用；后续封面需独立显式 asset list 取得当前句柄。上传不保存或发表，缩略图不是 BODY 原图地址，也不证明源字节持久化。",
  )
  .action(async (ref, options) => outputOutcome(await assetCommand("upload", ref, options)));
article
  .command("check")
  .helpGroup("发稿准备：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("只读检查已证实的字段和正文条件")
  .addHelpText(
    "after",
    "\n只返回精确的 errors 与 warnings 数组。检查目标、字段和正文，不解析 HTML、不读取封面或平台其他设置；不会保存、聚焦页面或派发修改，也不保证审核或发布通过。只把空白 HTML 判为已知空正文；非空 HTML 的正文语义会以 warning 标为未检查。作者／摘要采用本地 UTF-16 字符边界（8／120），不是微信字符规则承诺。\n\n示例：\n  mpctl article check '<article>'",
  )
  .action(async (ref) => outputOutcome(await articleCommand("check", ref)));
article
  .command("inspect")
  .helpGroup("文章字段：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("只读读取文章标题、作者和摘要")
  .addHelpText(
    "after",
    "\n返回 title、author、summary 和仅基于这三个原始字段的 fieldsHash。\n不读取正文、封面或其他设置，也不写入页面。空 summary 是页面字段原值，\n不代表微信平台默认摘要。\n\n示例：\n  mpctl article inspect '<article-from-current>'",
  )
  .action(async (ref) => outputOutcome(await articleCommand("inspect", ref)));
article
  .command("update")
  .helpGroup("文章字段：")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--fields <json-file>", "UTF-8 JSON，包含 title、author 和/或 summary")
  .requiredOption("--expected-hash <fieldsHash>", "必需：article inspect 返回的 fieldsHash")
  .description("更新标题、作者和/或摘要；不保存文章")
  .addHelpText(
    "after",
    "\n支持 title（最多 64 个 UTF-16 单元）、author（最多 8 个）与 summary（最多 120 个）；title 为单行且不含 NUL。显式空字符串清空。fieldsHash 基于实际读取的原始三字段；title 清空后的镜像读取可能为换行。返回已提交 snapshot，实际字段子集与 fieldsHash 在 snapshot.effect；不保存或发表。派发前 stderr 输出稳定 operation ID；同次重提使用原键，partial 不续写。结果未知先 operation status 查询原 ID，不换键重做。\n\n示例：\n  mpctl article update '<article>' --fields ./fields.json --expected-hash '<fieldsHash>'",
  )
  .option("--operation <id>", "稳定操作 ID；同次重提使用原键")
  .action(async (ref, options) => outputOutcome(await articleCommand("update", ref, options)));
article
  .command("list")
  .helpGroup("选择文章：")
  .description("列出可打开的草稿")
  .addHelpText(
    "after",
    "\n返回 articles 数组，每项含 candidate 和标题。将选中的 candidate 原样传给 open；\ncandidate 是不透明定位值，不是标题或永久文章 ID。\n\n示例：\n  mpctl article list\n  mpctl article open '<candidate-from-list>'",
  )
  .action(async () => outputOutcome(await articleCommand("list")));
article
  .command("open")
  .helpGroup("选择文章：")
  .argument("<candidate>", "list 返回的目标定位", nonBlank)
  .description("打开 list 中指定的草稿")
  .option("--operation <id>", "稳定操作 ID；同次重提使用原键")
  .addHelpText(
    "after",
    "\n返回已提交 snapshot，不返回可写引用。后续显式 current --candidate 定位当前页。\n首次派发前 stderr 输出 operation ID；同次重提保留原键及 candidate。\n未决或丢回复先 operation status，不换键重做。\n\n示例：\n  mpctl article open '<candidate-from-list>'\n  mpctl article current --candidate '<candidate-from-list>'",
  )
  .action(async (candidate, options) =>
    outputOutcome(await articleCommand("open", candidate, options)),
  );
article
  .command("new")
  .helpGroup("选择文章：")
  .description("创建新稿")
  .option("--operation <id>", "稳定操作 ID；同次重提使用原键")
  .addHelpText(
    "after",
    "\n在已登录账号中创建新编辑页，返回已提交 snapshot，不返回可写引用。\n已有新稿编辑页时拒绝重复创建，不覆盖内容；显式 current --new 读取现有页。\n不保存或发表。首次派发前 stderr 输出 operation ID；同次重提保留原键。\n未决或丢回复先 operation status，不换键重做。\n\n示例：\n  mpctl article new\n  mpctl article current --new",
  )
  .action(async (options) => outputOutcome(await articleCommand("new", undefined, options)));
article
  .command("current")
  .helpGroup("选择文章：")
  .description("获取唯一已打开编辑页的引用")
  .option("--candidate <candidate>", "只读定位指定已打开草稿", nonBlank)
  .option("--new", "只读定位已打开的新稿编辑页")
  .addHelpText(
    "after",
    "\n只读核对 mpctl 工作组中唯一支持的编辑页，返回新 article 和 bodyHash。\n不创建、重载或写入页面。多个编辑页返回 target_ambiguous；不可用的页面桥\n不会自动恢复。适用于已有编辑页或旧引用失效后重新获取引用。\n\n示例：\n  mpctl article current\n  mpctl article pull '<article-from-current>' --body ./recovered.html",
  )
  .action(async (options) => outputOutcome(await articleCommand("current", undefined, options)));
article
  .command("pull")
  .helpGroup("正文文件：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("拉取正文到 HTML 文件")
  .requiredOption("--body <path>", "必需：UTF-8 HTML 目标文件", nonBlank)
  .option("--overwrite", "原子替换已有目标文件")
  .addHelpText(
    "after",
    "\narticle 来自显式 current；new/open 只返回历史 snapshot，不恢复引用。\n正文写入 --body 路径，只返回 bodyHash。目标目录必须存在；默认拒绝覆盖，\n--overwrite 才原子替换。核对未知写入时拉取到另一个路径，保留本地源稿。\n\n示例：\n  mpctl article pull '<article>' --body './draft body.html'\n  mpctl article pull '<article>' --body ./body.html --overwrite",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("pull", ref, options)));
article
  .command("push")
  .helpGroup("正文文件：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("用 HTML 文件替换正文")
  .requiredOption("--body <path>", "必需：UTF-8 HTML 源文件", nonBlank)
  .requiredOption("--expected-hash <hash>", "必需：上次读取的编辑器正文 bodyHash")
  .option("--operation <id>", "稳定操作 ID；同次重提使用原键")
  .addHelpText(
    "after",
    "\narticle 来自 open/new/current；expected-hash 使用 open/new/current/pull 返回的\n64 位小写 SHA-256，不要计算修改后本地文件的 hash 来替代。\n返回已提交 snapshot；成功的规范化回读 bodyHash 在 snapshot.effect 中，\n不改写源文件，不显式保存或发表。首次派发前 stderr 输出 operation ID，\n--quiet 也保留该标识；自动化调用方可预先保存并提供 --operation。\n同次重提必须保留原 ID、article、文件内容与 expected-hash，不换键自动重做。\ncontent_conflict 表示未写入；未决、超时或断线先 operation status 原 ID。\n纯 pull 只观察当前正文，不能证明旧写入已结束。\n\n示例：\n  mpctl article push '<article>' --body ./body.html --expected-hash '<last-bodyHash>'\n  mpctl operation status '<operation-id>'",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("push", ref, options)));

const operation = program.command("operation").description("查询持久操作结果；不重放写入");
operation.action(() => operation.help());
operation
  .command("status")
  .argument("<id>", "原操作 ID", nonBlank)
  .description("读取已提交快照，必要时核对原 BODY 回执")
  .addHelpText(
    "after",
    "\n查询得到业务失败快照仍以 0 退出；快照不可读、键无效或 ledger 不匹配以非零退出。\n辅助回执或连接清理失败保留快照和 issue，不触发写入、导航或新页面。\n不要用新键恢复未决操作；原端已替换或消失时可能无法找回终局回执。",
  )
  .action(async (id) => outputOutcome(await operationStatus(id)));

let progress: ReturnType<typeof setTimeout> | undefined;
program.hook("preAction", (_root, command) => {
  if (process.stderr.isTTY && !command.optsWithGlobals().quiet)
    progress = setTimeout(
      () => process.stderr.write(`正在执行 ${command.name()}，请等待；不要重复提交命令。\n`),
      1000,
    );
});
try {
  await program.parseAsync(process.argv.length === 2 ? ["--help"] : process.argv.slice(2), {
    from: "user",
  });
} catch (error) {
  if (error instanceof CommanderError && error.exitCode === 0) process.exitCode = 0;
  else {
    const failure =
      error instanceof CommanderError
        ? cliError("invalid_command", error.message.replace(/^error:\s*/, ""))
        : cliErrorFromUnknown(error);
    process.stderr.write(`${JSON.stringify({ error: friendlyError(failure) })}\n`);
    process.exitCode = 1;
  }
} finally {
  if (progress) clearTimeout(progress);
}

function output(value: unknown) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
function outputOutcome<T>(
  outcome: import("better-result").Result<T, import("./connection.js").CliError>,
) {
  if (Result.isError(outcome)) {
    process.stderr.write(`${JSON.stringify({ error: friendlyError(outcome.error) })}\n`);
    process.exitCode = 1;
    return;
  }
  output(outcome.value);
}
function nonBlank(value: string): string {
  if (!value.trim()) throw new InvalidArgumentError("参数不能为空");
  return value;
}
