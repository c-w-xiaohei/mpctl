import { lstat, open, link, rename, rm, access } from "node:fs/promises";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { Result } from "better-result";
import { cliError, type CliError } from "./connection.js";

const fileFailure = (code: string): CliError =>
  cliError(
    code,
    code === "file_exists"
      ? "目标文件已存在；换一个路径或传 --overwrite"
      : "目标目录不存在、不可写或写文件失败；检查目标目录和空间",
  );

export async function checkBodyDestination(
  file: string,
  overwrite: boolean,
): Promise<Result<void, CliError>> {
  const parent = await Result.tryPromise({
    try: () => access(path.dirname(file), constants.W_OK),
    catch: () => fileFailure("file_error"),
  });
  if (Result.isError(parent)) return Result.err(parent.error);
  const stat = await Result.tryPromise({ try: () => lstat(file), catch: (error) => error });
  if (Result.isOk(stat)) {
    if (!stat.value.isFile() || stat.value.isSymbolicLink())
      return Result.err(fileFailure("file_error"));
    if (!overwrite) return Result.err(fileFailure("file_exists"));
    return Result.ok(undefined);
  }
  if (isCode(stat.error, "ENOENT")) return Result.ok(undefined);
  return Result.err(fileFailure("file_error"));
}

export async function writeBodyFile(
  file: string,
  html: string,
  overwrite = false,
): Promise<Result<void, CliError>> {
  const temp = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  const opened = await Result.tryPromise({
    try: () => open(temp, "wx", 0o600),
    catch: (error) => error,
  });
  if (Result.isError(opened))
    return Result.err(fileFailure(isCode(opened.error, "EEXIST") ? "file_exists" : "file_error"));
  const handle = opened.value;
  const wrote = await Result.tryPromise({
    try: async () => {
      await handle.writeFile(html, "utf8");
      await handle.sync();
    },
    catch: () => fileFailure("file_error"),
  });
  const closed = await Result.tryPromise({
    try: () => handle.close(),
    catch: () => fileFailure("file_error"),
  });
  let installed: Result<void, CliError>;
  if (Result.isError(wrote)) installed = Result.err(wrote.error);
  else if (Result.isError(closed)) installed = Result.err(closed.error);
  else if (overwrite) {
    const checked = await checkBodyDestination(file, true);
    installed = Result.isError(checked)
      ? checked
      : await Result.tryPromise({
          try: () => rename(temp, file),
          catch: () => fileFailure("file_error"),
        });
  } else {
    installed = await Result.tryPromise({
      try: () => link(temp, file),
      catch: (error) => fileFailure(isCode(error, "EEXIST") ? "file_exists" : "file_error"),
    });
  }
  const outcome = await finishBodyFileInstall(installed, async () => {
    await rm(temp, { force: true });
  });
  if (Result.isError(outcome)) return outcome;
  return Result.ok(undefined);
}

export async function finishBodyFileInstall(
  installed: Result<void, CliError>,
  removeTemporary: () => Promise<void>,
): Promise<Result<void, CliError>> {
  const removed = await Result.tryPromise({
    try: removeTemporary,
    catch: () => fileFailure("file_error"),
  });
  if (Result.isError(installed) && Result.isError(removed))
    return Result.err(
      cliError(installed.error.code, installed.error.instruction, {
        ...installed.error.details,
        cleanupFailed: true,
      }),
    );
  return Result.isError(installed) ? installed : removed;
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}
