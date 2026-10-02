import { readFile } from "node:fs/promises";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import { articleNavigationTimeoutMs } from "@mpctl/contracts";
import { withConnection, cliError, type CliError } from "./connection.js";
import { writeBodyFile, checkBodyDestination } from "./body-file.js";

type Outcome<T> = BetterResult<T, CliError>;

export function articleCommand(
  command: "list" | "open" | "new" | "current" | "pull" | "push",
  ref?: string,
  options: { body?: string; expectedHash?: string; overwrite?: boolean } = {},
): Promise<Outcome<unknown>> {
  if (command === "list")
    return withConnection(
      async ({ workspace }) => {
        const result = await workspace.listArticles();
        return Result.isError(result)
          ? Result.err(result.error)
          : Result.ok({ articles: result.value });
      },
      { callTimeout: articleNavigationTimeoutMs },
    );

  if (command === "open" || command === "new" || command === "current")
    return withConnection(
      async ({ workspace }) => {
        const result =
          command === "open"
            ? await workspace.openArticle(ref!)
            : command === "current"
              ? await workspace.currentArticle()
              : await workspace.newArticle();
        if (Result.isError(result)) {
          const error = result.error;
          const instruction =
            command === "current"
              ? error.code === "target_ambiguous"
                ? "明确目标编辑页后再 current，或 list → open 指定已存稿。"
                : "检查已有编辑页的加载和登录状态。"
              : undefined;
          return Result.err(cliError(error.code, instruction, error.details));
        }
        return Result.ok({ article: result.value.article, bodyHash: result.value.bodyHash });
      },
      { callTimeout: articleNavigationTimeoutMs },
    );

  if (command === "pull") {
    return checkBodyDestination(options.body!, options.overwrite ?? false).then((checked) => {
      if (Result.isError(checked)) return Result.err(checked.error);
      return withConnection(async ({ workspace }) => {
        const result = await workspace.readBody(ref!);
        if (Result.isError(result)) return Result.err(result.error);
        const written = await writeBodyFile(
          options.body!,
          result.value.html,
          options.overwrite ?? false,
        );
        return Result.isError(written)
          ? Result.err(written.error)
          : Result.ok({ bodyHash: result.value.bodyHash });
      });
    });
  }

  if (!/^[0-9a-f]{64}$/.test(options.expectedHash ?? ""))
    return Promise.resolve(
      Result.err(
        cliError(
          "invalid_command",
          "--expected-hash 必须是 open/new/current/pull 返回的 64 位小写 SHA-256",
        ),
      ),
    );

  return Result.tryPromise({
    try: () => readFile(options.body!, "utf8"),
    catch: () => cliError("file_error", "检查 --body 源文件是否存在且可读"),
  }).then((file) => {
    if (Result.isError(file)) return Result.err(file.error);
    return withConnection(async ({ workspace }) => {
      const write = await workspace.writeBody(ref!, file.value, options.expectedHash!);
      if (Result.isError(write)) return Result.err(write.error);
      return Result.ok({ bodyHash: write.value.bodyHash });
    });
  });
}
