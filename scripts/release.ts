import { mkdir } from "node:fs/promises";
import path from "node:path";
import { version as extensionVersion } from "../packages/extension/package.json";

if (process.env.GITHUB_ACTIONS !== "true") throw new Error("发布只允许从 Release CI/CD 执行。");
const root = path.resolve(import.meta.dir, "..");
const repository = process.env.GITHUB_REPOSITORY;
const commit = process.env.GITHUB_SHA;
if (!repository || !commit) throw new Error("缺少 GitHub 发布上下文。");
const output = path.join(root, ".cache/release");
await mkdir(output, { recursive: true });
if (process.env.CHANGESETS_OUTPUT) await Bun.write(process.env.CHANGESETS_OUTPUT, "");

// Changesets 管理版本；npm 和 GitHub 的已发布事实决定本次还需交付哪些产物。
const planPath = path.join(output, "plan.json");
await run(["bun", "run", "changeset", "publish-plan", "--output", planPath]);
const { plan } = (await Bun.file(planPath).json()) as {
  plan: Array<Array<{ kind: string; name: string; version: string }>>;
};
const publishCli = plan
  .flat()
  .some((release) => release.name === "mpctl" && release.kind === "publish");
const extensionTag = `@mpctl/extension@${extensionVersion}`;
const assetName = `mpctl-extension-v${extensionVersion}.zip`;
const releaseResult = await capture([
  "gh",
  "api",
  `repos/${repository}/releases/tags/${encodeURIComponent(extensionTag)}`,
]);
let extensionRelease: { draft: boolean; assets: Array<{ name: string }> } | undefined;
if (releaseResult.code === 0) extensionRelease = JSON.parse(releaseResult.stdout);
else if (!releaseResult.stderr.includes("HTTP 404")) throw new Error(releaseResult.stderr);
const publishExtension =
  !extensionRelease ||
  extensionRelease.draft ||
  !extensionRelease.assets.some((asset) => asset.name === assetName);

// 先构建并验证所有待发产物，再上传；只上传已验证的 tarball/ZIP，不二次构建。
if (publishCli) {
  await run(["bun", "run", "build:cli"]);
  await run(
    ["bun", "run", "changeset", "pack", "--from-publish-plan", planPath, "--out-dir", output],
    {
      npm_config_ignore_scripts: "true",
    },
  );
  const packed = (await Bun.file(path.join(output, "publish-plan.json")).json()) as {
    plan: Array<Array<{ name: string; tarball: { path: string } }>>;
  };
  const cli = packed.plan.flat().find((release) => release.name === "mpctl");
  if (!cli) throw new Error("缺少 CLI 发布产物。");
  await run(["bun", "test", "./test/package.test.ts"], {
    MPCTL_PACKAGE_TARBALL: path.join(output, cli.tarball.path),
  });
}
if (publishExtension) {
  await run(["bun", "run", "build:extension"]);
  await run(["bun", "test", "./test/extension-package.test.ts"]);
}

if (publishCli) {
  await run(["bun", "run", "changeset", "publish", "--from-pack-dir", output], {
    npm_config_ignore_scripts: "true",
  });
}
if (publishExtension) {
  const archive = path.join(root, "packages/extension/.output", assetName);
  if (!extensionRelease) {
    // 先上传到草稿再公开；上传失败可重跑同一条 CI，不重发 npm 或覆盖已有附件。
    const args = [
      "gh",
      "release",
      "create",
      extensionTag,
      archive,
      "--repo",
      repository,
      "--target",
      commit,
      "--title",
      `mpctl extension ${extensionVersion}`,
      "--draft",
      "--notes",
      "下载附件 ZIP 并解压，在 chrome://extensions 开启开发者模式，选择“加载已解压的扩展程序”。CLI 单独通过 npm install -g mpctl 安装。连接配置见 README。",
    ];
    if (extensionVersion.includes("-")) args.push("--prerelease");
    await run(args);
  } else if (!extensionRelease.assets.some((asset) => asset.name === assetName)) {
    await run(["gh", "release", "upload", extensionTag, archive, "--repo", repository]);
  }
  if (!extensionRelease || extensionRelease.draft) {
    await run(["gh", "release", "edit", extensionTag, "--repo", repository, "--draft=false"]);
  }
}
console.log(
  publishCli || publishExtension ? "本次待发布产物已交付。" : "当前版本均已发布，无需重复发布。",
);

async function run(args: string[], env: Record<string, string> = {}) {
  const child = Bun.spawn(args, {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: "inherit",
    stderr: "inherit",
  });
  if ((await child.exited) !== 0) throw new Error(`命令失败：${args.join(" ")}`);
}

async function capture(args: string[]) {
  const child = Bun.spawn(args, { cwd: root, stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code, stdout, stderr };
}
