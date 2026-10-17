import { chmod, cp, rm } from "node:fs/promises";
import path from "node:path";
import { dependencies } from "../packages/cli/package.json";

const root = path.resolve(import.meta.dir, "..");
const packageRoot = path.join(root, "packages/cli");
const outdir = path.join(packageRoot, "dist");

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
// 文档源只维护在根目录；npm 所需副本与素材在构建时生成。
await cp(path.join(root, "README.md"), path.join(packageRoot, "README.md"));
await cp(path.join(root, "assets/brand"), path.join(packageRoot, "assets/brand"), {
  recursive: true,
});
