#!/usr/bin/env bun
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { articleCommand } from "./article.js";
import {
  operationStatus,
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
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";
import { version } from "../package.json";

configureNexusDebug("cli", process.env.MPCTL_NEXUS_DEBUG === "1", (line) => {
  process.stderr.write(`${line}\n`);
});

const program = new Command()
  .name("mpctl")
  .description("用本地 HTML/JSON 编辑公众号正文和字段，管理图片、封面并显式保存草稿。")
  .version(version)
  .option("--quiet", "不输出交互终端的等待提示")
  .exitOverride()
  .configureOutput({ writeErr: () => {} })
  .configureHelp({ showGlobalOptions: true })
  .commandsGroup("日常命令：")
  .addHelpText(
    "after",
    "\n首次使用从 connect 开始。操作结果为 JSON；帮助为文本。\n运行 mpctl <command> --help 查看用法。不会自动发表或发送预览。",
  );
program
  .command("status")
  .description("查看插件连接状态")
  .option("--details", "显示运行中组件的协议版本")
  .addHelpText(
    "after",
    "\nconnected 只表示连接，不代表公众号登录或编辑页就绪。日常文章命令无需先调用 status。",
  )
  .action(async (options) =>
    outputOutcome(
      await withBroker(async ({ connection }) => {
        const status = await connection.getStatus();
        if (status.isErr()) return Result.err(cliError(status.error.code));
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
  .option(
    "--extension <id>",
    "已安装扩展 ID；也可配置 MPCTL_EXTENSION_ID",
    process.env.MPCTL_EXTENSION_ID,
  )
  .option("--reload", "维护：显式重载已连接插件并等待重连")
  .addHelpText(
    "after",
    "\n示例：mpctl connect --extension <installed-extension-id>\n未连接时按返回的 instruction，在安装了扩展的浏览器/profile 打开 connectionPageUrl。CLI 不启动浏览器或代替登录。后台按需启动。\n--reload 会使旧文章引用失效；恢复用 current，不是每次编辑的前置步骤。",
  )
  .action(async (options) => outputOutcome(await connectCommand(options)));

const article = program.command("article").description("选择文章、编辑正文和字段、设置封面与保存");
article.addHelpCommand(true);
article.action(() => article.help());
article.addHelpText(
  "after",
  "\n已有稿：list → open → pull → 编辑文件 → push\n本地新稿：new → push；字段用 inspect → update。\n图片：asset upload → asset list → asset resolve，将返回的 HTML 加入正文后 push。\nopen/new 首次确认成功直接返回 article 和 bodyHash，不需要再 current。\n已有编辑页或引用失效时才用 current；历史重提不恢复临时引用。\n所有编辑都不隐含保存：inspect --all > state.json → save --expect state.json。",
);
article
  .command("list")
  .helpGroup("选择文章：")
  .description("列出可打开的草稿")
  .addHelpText(
    "after",
    "\n返回 articles，每项含 candidate 和 title。选中后：\n  mpctl article open '<candidate>'\ncandidate 是定位值，不是标题。已知 candidate 无需重复 list。",
  )
  .action(async () => outputOutcome(await articleCommand("list")));
article
  .command("open")
  .helpGroup("选择文章：")
  .argument("<candidate>", "list 返回的草稿定位", nonBlank)
  .description("打开或复用指定草稿，返回编辑引用")
  .option("--operation <id>", "高级：同次重提使用原操作 ID")
  .addHelpText(
    "after",
    "\n示例：mpctl article open '<candidate>'\n首次确认成功返回 article、bodyHash 和持久 snapshot，可直接 pull/push。有效同稿编辑页会复用，不刷新或覆盖未保存内容。重复页拒绝，不自动关闭。\n历史同键重提只返回 snapshot；需要重新接入页面时用 current。超时或未决先查询原 operation，不换键重做。",
  )
  .action(async (candidate, options) =>
    outputOutcome(await articleCommand("open", candidate, options)),
  );
article
  .command("new")
  .helpGroup("选择文章：")
  .description("创建未保存的新稿编辑页，返回编辑引用")
  .option("--operation <id>", "高级：同次重提使用原操作 ID")
  .addHelpText(
    "after",
    "\n示例：mpctl article new\n首次确认成功返回 article、bodyHash 和持久 snapshot。已有本地 HTML 可直接 push，不必先拉取空正文。\n已有新稿编辑页时拒绝重复创建；用 current --new 接入原页。不会保存或发表；编辑完成后显式 save。未知结果查询原 operation，不再创建。",
  )
  .action(async (options) => outputOutcome(await articleCommand("new", undefined, options)));
article
  .command("current")
  .helpGroup("选择文章：")
  .description("只读接入已有编辑页或恢复临时引用")
  .option("--candidate <candidate>", "多页时定位已打开的指定草稿", nonBlank)
  .option("--new", "多页时定位现有新稿；与 --candidate 互斥")
  .addHelpText(
    "after",
    "\n示例：mpctl article current\n返回 article、bodyHash。不创建、重载或写入页面。无选择参数时要求工作组内编辑页唯一，不猜激活标签。不可用的页面桥不会自动恢复；current 不判定旧操作已结束。",
  )
  .action(async (options) => outputOutcome(await articleCommand("current", undefined, options)));
article
  .command("pull")
  .helpGroup("正文文件：")
  .argument("<article>", "open/new/current 返回的临时文章引用", nonBlank)
  .requiredOption("--body <path>", "UTF-8 HTML 目标文件", nonBlank)
  .option("--overwrite", "显式原子替换已有目标文件")
  .description("拉取正文到 HTML 文件")
  .addHelpText(
    "after",
    "\n示例：mpctl article pull '<article>' --body ./body.html\n返回实际页面正文 bodyHash。目录须存在，默认拒绝覆盖已有文件。核对未知写入请拉到另一文件，保留本地源稿；当前内容不能证明原操作结束。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("pull", ref, options)));
article
  .command("push")
  .helpGroup("正文文件：")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--body <path>", "UTF-8 HTML 源文件", nonBlank)
  .requiredOption("--expected-hash <hash>", "上次从页面读取的 bodyHash")
  .option("--operation <id>", "高级：同次重提使用原操作 ID 和原输入")
  .description("用 HTML 文件替换整篇正文，不保存")
  .addHelpText(
    "after",
    "\n示例：mpctl article push '<article>' --body ./body.html --expected-hash '<bodyHash>'\n版本来自 open/new/current/pull，不是修改后文件的 hash。页面已变化则 content_conflict，不覆盖。成功规范化 bodyHash 在 snapshot.effect，不改写源文件，无需为取 hash 再 pull。\n超时或未决：operation status 原 ID；不换键、不自动重做。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("push", ref, options)));
article
  .command("inspect")
  .helpGroup("文章字段：")
  .argument("<article>", "临时文章引用", nonBlank)
  .option("--all", "同时读取正文/字段/封面版本，供 save --expect 使用")
  .description("只读读取标题、作者、摘要；可读取完整状态")
  .addHelpText(
    "after",
    "\n字段：mpctl article inspect '<article>'\n保存前：mpctl article inspect '<article>' --all > state.json\n普通读取返回 title、author、summary、fieldsHash，不读正文/封面。--all 还返回 article、bodyHash、coverHash，重复观察一致才返回；不是原子快照或云端证明。不会写入、保存或自动刷新。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("inspect", ref, options)));
article
  .command("update")
  .helpGroup("文章字段：")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--fields <json-file>", "UTF-8 JSON：title、author 和/或 summary", nonBlank)
  .requiredOption("--expected-hash <fieldsHash>", "inspect 返回的字段版本")
  .option("--operation <id>", "高级：同次重提使用原操作 ID 和原输入")
  .description("更新指定字段，不改正文、不保存")
  .addHelpText(
    "after",
    "\n示例：mpctl article update '<article>' --fields ./fields.json --expected-hash '<fieldsHash>'\n省略字段不修改，空字符串清空。本地 UTF-16 上限：title 64、author 8、summary 120。版本基于原始字段值，不是平台字符规则保证。\n部分成功不自动续写；未知结果查询原 operation，不换键重做。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("update", ref, options)));
article
  .command("cover")
  .helpGroup("图片封面：")
  .argument("<article>", "临时文章引用", nonBlank)
  .option("--asset <asset>", "设置来源：同文章的当前素材句柄")
  .option("--from-body <number>", "设置来源：正文第 N 张平台图片，从 1 开始，排除分隔符")
  .option("--expected-body-hash <bodyHash>", "正文来源时必需：当前正文版本")
  .option("--expected-hash <coverHash>", "设置时必需：当前封面版本；只读不需要")
  .option("--operation <id>", "高级：仅设置时接受，同次重提使用原 ID")
  .description("读取封面版本；明确指定来源时设置封面，不保存")
  .addHelpText(
    "after",
    "\n读取：mpctl article cover '<article>'\n正文图：mpctl article cover '<article>' --from-body 1 --expected-body-hash '<bodyHash>' --expected-hash '<coverHash>'\n素材：mpctl article cover '<article>' --asset '<asset>' --expected-hash '<coverHash>'\n来源互斥。正文图仅支持受检平台 data-src 图片，官方默认居中裁切。素材库只操作已可见的唯一菜单，隐藏控件安全拒绝，不扩权。coverHash 是预览 URL/可见性的版本，不是裁切坐标或永久素材身份。未知结果查询原 operation。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("cover", ref, options)));
article
  .command("check")
  .helpGroup("检查与保存：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("可选：只读检查有限字段条件和空白正文")
  .addHelpText(
    "after",
    "\n示例：mpctl article check '<article>'\n返回 errors、warnings；不是保存前置步骤，不证明可发布。非空 HTML 的语义、封面、平台设置未检查。不会修改、保存或发送预览。",
  )
  .action(async (ref) => outputOutcome(await articleCommand("check", ref)));
article
  .command("save")
  .helpGroup("检查与保存：")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--expect <json-file>", "同一 article 的 inspect --all 输出", nonBlank)
  .option("--operation <id>", "高级：同次重提使用原 ID 和原状态文件")
  .description("显式保存单篇稿，观察原生确认")
  .addHelpText(
    "after",
    "\n示例：\n  mpctl article inspect '<article>' --all > state.json\n  mpctl article save '<article>' --expect state.json\n核对正文、字段、封面三版本，再保存一次。成功为 settled/confirmed，persistence:unverified，非独立云端证明。\n首次保存确认后 snapshot.effect.candidate 返回已存稿定位，可用 article current --candidate '<candidate>' 接入，不必从浏览器 URL 查找。超时或未决查询原 operation；不换键重做，不发表或发送预览。",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("save", ref, options)));

const asset = program.command("asset").description("查看或上传文章图片素材");
asset.addHelpCommand(true);
asset.action(() => asset.help());
asset
  .command("list")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("列出当前可见素材页")
  .option("--operation <id>", "取回已确认上传对应的当前素材句柄，不重新上传")
  .addHelpText(
    "after",
    "\n返回 scope:visible-page 和 cards，不是全账号素材目录。句柄绑定文章/文档；thumbnailUrl 是缩略图，不是正文原图。\n上传状态确认成功后：asset list '<article>' --operation '<原ID>'，按原回执精确匹配素材并返回当前句柄。素材不在可见页或账号无法核对时拒绝，不按文件名猜测。不上传、插入正文、设置封面或保存。",
  )
  .action(async (ref, options) => outputOutcome(await assetCommand("list", ref, options)));
asset
  .command("upload")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--file <path>", "PNG、JPEG、GIF 或 WebP 文件", nonBlank)
  .option("--operation <id>", "高级：同次重提使用原 ID 和原文件字节")
  .description("上传到图片库，不插入正文或设置封面")
  .addHelpText(
    "after",
    "\n示例：mpctl asset upload '<article>' --file ./image.png\n本地预算 2 MiB，校验格式签名；同名拒绝，不自动改名。首次确认成功返回 asset 素材卡片和 snapshot，可用于封面，无需为取句柄再次 list。\n历史重提只返回持久结果，不恢复句柄。未知结果查询原 operation，不重传；确认成功后可用 asset list '<article>' --operation '<原ID>' 取回当前句柄。缩略图不是正文原图或源字节持久化证明。不保存或发表。",
  )
  .action(async (ref, options) => outputOutcome(await assetCommand("upload", ref, options)));

const operation = program.command("operation").description("异常恢复：查询原操作，不重放");
asset
  .command("resolve")
  .argument("<article>", "临时文章引用", nonBlank)
  .requiredOption("--asset <asset>", "asset list 返回的素材句柄", nonBlank)
  .description("读取原生素材选择产生的正文图片 HTML，不插入或保存")
  .action(async (ref, options) => outputOutcome(await assetCommand("resolve", ref, options)));
operation.action(() => operation.help());
operation
  .command("status")
  .argument("<id>", "原操作 ID", nonBlank)
  .description("读取持久快照，必要时查询原执行回执")
  .addHelpText(
    "after",
    "\n示例：mpctl operation status '<原ID>'\n查询成功退出 0，不代表被查询操作成功；检查 snapshot 和 issue。不会写入、导航或创建页面。原执行端消失可能无法找回终局，不换键恢复未决操作。",
  )
  .action(async (id) => outputOutcome(await operationStatus(id)));

const broker = program.command("broker").helpGroup("维护命令：").description("单独启动本地后台");
broker.addHelpCommand(true);
broker.action(() => broker.help());
broker
  .command("start")
  .description("维护：只启动或复用后台，不连接浏览器")
  .addHelpText(
    "after",
    "\n普通命令已按需启动后台，日常无需执行。首次启动需 MPCTL_PAIRING_CREDENTIAL；后续可用保存的私有配置。",
  )
  .action(async () =>
    outputOutcome(
      await withBroker(async ({ brokerStarted, connection }) => {
        const status = await connection.getStatus();
        return status.isErr()
          ? Result.err(cliError(status.error.code))
          : Result.ok({ started: brokerStarted });
      }),
    ),
  );
const workspace = program
  .command("workspace")
  .helpGroup("维护命令：")
  .description("修复历史重复工作组");
workspace.addHelpCommand(true);
workspace.action(() => workspace.help());
workspace
  .command("cleanup")
  .description("合并重复工作组，保留标签和正文")
  .addHelpText(
    "after",
    "\n只用于重复组修复，不是文章流程前置步骤。将标签移入锁定组，不关闭标签或改正文，不自动处理重复编辑页。",
  )
  .action(async () =>
    outputOutcome(
      await withConnection(async ({ workspace }) => {
        const result = await workspace.cleanupWorkspace();
        return result.isErr() ? Result.err(result.error) : Result.ok(result.value);
      }),
    ),
  );

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
function outputOutcome<T>(
  outcome: import("better-result").Result<T, import("./connection.js").CliError>,
) {
  if (outcome.isErr()) {
    process.stderr.write(`${JSON.stringify({ error: friendlyError(outcome.error) })}\n`);
    process.exitCode = 1;
  } else process.stdout.write(`${JSON.stringify(outcome.value)}\n`);
}
function nonBlank(value: string): string {
  if (!value.trim()) throw new InvalidArgumentError("参数不能为空");
  return value;
}
