import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile, readdir, rm, symlink, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkBodyDestination, finishBodyFileInstall, writeBodyFile } from "../src/body-file";
import { Result } from "better-result";
const dirs: string[] = [];
afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});
async function destination() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "mpctl-body-"));
  dirs.push(dir);
  return { dir, file: path.join(dir, "正文 文件.html") };
}

test("pull refuses existing edits unless overwrite is explicit, and installs private complete UTF-8", async () => {
  const { dir, file } = await destination();
  await writeFile(file, "local edits");
  expect(await checkBodyDestination(file, false)).toEqual(
    Result.err(expect.objectContaining({ code: "file_exists" })),
  );
  expect(await writeBodyFile(file, "remote", false)).toEqual(
    Result.err(expect.objectContaining({ code: "file_exists" })),
  );
  expect(await readFile(file, "utf8")).toBe("local edits");
  expect(Result.isOk(await writeBodyFile(file, "<p>橘子 ☂</p>", true))).toBe(true);
  expect(await readFile(file, "utf8")).toBe("<p>橘子 ☂</p>");
  expect((await stat(file)).mode & 0o777).toBe(0o600);
  expect(await readdir(dir)).toEqual([path.basename(file)]);
});
test("two no-overwrite pulls racing for one path leave one complete winner", async () => {
  const { dir, file } = await destination();
  const first = "甲".repeat(10000);
  const second = "乙".repeat(10000);
  const results = await Promise.all([writeBodyFile(file, first), writeBodyFile(file, second)]);
  expect(results.filter((result) => Result.isOk(result))).toHaveLength(1);
  expect([first, second]).toContain(await readFile(file, "utf8"));
  expect(await readdir(dir)).toEqual([path.basename(file)]);
});
test("an overwrite destination becoming a symlink does not damage either original file", async () => {
  const { dir, file } = await destination();
  const target = path.join(dir, "original.html");
  await writeFile(target, "original");
  await symlink(target, file);
  expect(await writeBodyFile(file, "remote", true)).toEqual(
    Result.err(expect.objectContaining({ code: "file_error" })),
  );
  expect(await readFile(target, "utf8")).toBe("original");
  expect((await readdir(dir)).sort()).toEqual(["original.html", path.basename(file)].sort());
});

test("reports a rejected temp removal alongside an installation error", async () => {
  let removeAttempted = false;
  const result = await finishBodyFileInstall(Result.err({ code: "file_error" }), async () => {
    removeAttempted = true;
    throw new Error("remove failed");
  });

  expect(removeAttempted).toBe(true);
  expect(result).toEqual(
    Result.err(expect.objectContaining({ code: "file_error", details: { cleanupFailed: true } })),
  );
});
