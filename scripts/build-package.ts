import { chmod, cp, rm } from "node:fs/promises";
import path from "node:path";
import { dependencies } from "../package.json";

const root = path.resolve(import.meta.dir, "..");
const outdir = path.join(root, "dist");

// dist 只存放本脚本生成的发布产物，避免旧文件混入下一次发布。
await rm(outdir, { recursive: true, force: true });
for (const [entrypoint, filename] of [
  ["packages/cli/src/main.ts", "cli.js"],
  ["packages/broker/src/main.ts", "broker.js"],
] as const) {
  const result = await Bun.build({
    entrypoints: [path.join(root, entrypoint)],
    outdir,
    naming: filename,
    target: "bun",
    external: Object.keys(dependencies),
  });
  if (!result.success) throw new AggregateError(result.logs, `构建 ${filename} 失败`);
}
await chmod(path.join(outdir, "cli.js"), 0o755);

const extension = Bun.spawn([process.execPath, "run", "--cwd", "packages/extension", "build"], {
  cwd: root,
  stdout: "inherit",
  stderr: "inherit",
});
if ((await extension.exited) !== 0) throw new Error("构建浏览器扩展失败");
await cp(path.join(root, "packages/extension/.output/chrome-mv3"), path.join(outdir, "extension"), {
  recursive: true,
});
