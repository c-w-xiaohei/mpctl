#!/usr/bin/env bun
import { Command, CommanderError, InvalidArgumentError } from "commander";
import { articleCommand } from "./article.js";
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

const program = new Command()
  .name("mpctl")
  .description("在本地 HTML 文件与公众号编辑器之间读写正文。")
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
        if (Result.isError(result)) return Result.err(cliError(result.error.code));
        return Result.ok(result.value);
      }),
    ),
  );
const article = program.command("article").description("选择文章、拉取和推送正文");
article.addHelpCommand(true);
article.action(() => article.help());
article.commandsGroup("选择文章：");
article.addHelpText(
  "after",
  "\n已有稿：list → open → pull → 编辑文件 → push\n新稿：  new → pull → 编辑文件 → push\n已有编辑页：current → pull → 编辑文件 → push\n\nopen/new/current 返回 article 和 bodyHash。push 使用上次读取的 bodyHash，\n不使用修改后文件的 hash。正文写入不显式保存或发表。\n运行 mpctl article <command> --help 查看参数和示例。",
);
article
  .command("list")
  .description("列出可打开的草稿")
  .addHelpText(
    "after",
    "\n返回 articles 数组，每项含 candidate 和标题。将选中的 candidate 原样传给 open；\ncandidate 是不透明定位值，不是标题或永久文章 ID。\n\n示例：\n  mpctl article list\n  mpctl article open '<candidate-from-list>'",
  )
  .action(async () => outputOutcome(await articleCommand("list")));
article
  .command("open")
  .argument("<candidate>", "list 返回的目标定位", nonBlank)
  .description("打开 list 中指定的草稿")
  .addHelpText(
    "after",
    "\n返回 article 和 bodyHash。article 用于后续 pull/push；页面变化或后台重启\n可能使引用失效。失败时若 pageCreated 为 true，先检查已打开页面再决定是否重试。\n\n示例：\n  mpctl article open '<candidate-from-list>'\n  mpctl article pull '<article-from-open>' --body ./body.html",
  )
  .action(async (candidate) => outputOutcome(await articleCommand("open", candidate)));
article
  .command("new")
  .description("创建新稿")
  .addHelpText(
    "after",
    "\n在已登录账号中创建新编辑页，返回 article 和 bodyHash。\n不显式保存或发表；不要用 new 恢复旧稿。失败时若 pageCreated 为 true，\n先检查已创建页面，避免重复新建。\n\n示例：\n  mpctl article new\n  mpctl article pull '<article-from-new>' --body ./body.html",
  )
  .action(async () => outputOutcome(await articleCommand("new")));
article
  .command("current")
  .description("获取唯一已打开编辑页的引用")
  .addHelpText(
    "after",
    "\n只读核对 mpctl 工作组中唯一支持的编辑页，返回新 article 和 bodyHash。\n不创建、重载或写入页面。多个编辑页返回 target_ambiguous；不可用的页面桥\n不会自动恢复。适用于已有编辑页或旧引用失效后重新获取引用。\n\n示例：\n  mpctl article current\n  mpctl article pull '<article-from-current>' --body ./recovered.html",
  )
  .action(async () => outputOutcome(await articleCommand("current")));
article
  .command("pull")
  .helpGroup("正文文件：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("拉取正文到 HTML 文件")
  .requiredOption("--body <path>", "必需：UTF-8 HTML 目标文件", nonBlank)
  .option("--overwrite", "原子替换已有目标文件")
  .addHelpText(
    "after",
    "\narticle 来自 open/new/current。正文写入 --body 路径，只返回 bodyHash。\n目标目录必须存在；默认拒绝覆盖已有文件，--overwrite 才原子替换。\n核对未知写入时拉取到另一个路径，保留本地源稿。\n\n示例：\n  mpctl article pull '<article>' --body './draft body.html'\n  mpctl article pull '<article>' --body ./body.html --overwrite",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("pull", ref, options)));
article
  .command("push")
  .helpGroup("正文文件：")
  .argument("<article>", "临时文章引用", nonBlank)
  .description("用 HTML 文件替换正文")
  .requiredOption("--body <path>", "必需：UTF-8 HTML 源文件", nonBlank)
  .requiredOption("--expected-hash <hash>", "必需：上次读取的编辑器正文 bodyHash")
  .addHelpText(
    "after",
    "\narticle 来自 open/new/current；expected-hash 使用 open/new/current/pull 返回的\n64 位小写 SHA-256，不要计算修改后本地文件的 hash 来替代。\n全文替换正文，只返回规范化回读的 bodyHash；不改写源文件，不显式保存或发表。\ncontent_conflict 表示未写入，重新 pull 后决定如何修改；write_unknown 不自动重试，\n先 pull 到另一个文件核对当前正文。\n\n示例：\n  mpctl article push '<article>' --body ./body.html --expected-hash '<last-bodyHash>'",
  )
  .action(async (ref, options) => outputOutcome(await articleCommand("push", ref, options)));

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
