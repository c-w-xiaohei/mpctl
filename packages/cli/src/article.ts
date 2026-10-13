import { readFile } from "node:fs/promises";
import { Result } from "better-result";
import type { Result as BetterResult } from "better-result";
import {
  articleNavigationTimeoutMs,
  articleFieldUpdateInputSchema,
  articleStateSchema,
} from "@mpctl/contracts";
import * as v from "valibot";
import {
  withConnection,
  cliError,
  submitBody,
  submitFields,
  submitCover,
  submitSave,
  submitNavigation,
  type CliError,
} from "./connection.js";
import { writeBodyFile, checkBodyDestination } from "./body-file.js";

type Outcome<T> = BetterResult<T, CliError>;

export function articleCommand(
  command:
    | "list"
    | "open"
    | "new"
    | "current"
    | "pull"
    | "push"
    | "inspect"
    | "update"
    | "check"
    | "cover"
    | "save",
  ref?: string,
  options: {
    body?: string;
    expectedHash?: string;
    overwrite?: boolean;
    fields?: string;
    asset?: string;
    fromBody?: string;
    expectedBodyHash?: string;
    expect?: string;
    all?: boolean;
    operation?: string;
    candidate?: string;
    new?: boolean;
  } = {},
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

  if (command === "inspect")
    return withConnection(async ({ workspace }) => {
      const result = await workspace.inspectArticle(ref!, options.all ? { all: true } : undefined);
      if (Result.isOk(result)) {
        if (options.all) {
          if (!("article" in result.value) || result.value.article !== ref)
            return Result.err(cliError("invalid_result_envelope"));
        }
        return Result.ok(result.value);
      }
      const error = result.error;
      const instruction =
        error.code === "target_unavailable"
          ? "用 article current 获取新引用，或 list → open 指定已有稿。"
          : undefined;
      return Result.err(cliError(error.code, instruction, error.details));
    });

  if (command === "check")
    return withConnection(async ({ workspace }) => {
      const result = await workspace.checkArticle(ref!);
      return Result.isOk(result)
        ? Result.ok({ errors: result.value.errors, warnings: result.value.warnings })
        : Result.err(cliError(result.error.code, undefined, result.error.details));
    });

  if (command === "cover") {
    const body = options.fromBody !== undefined;
    const writing =
      body ||
      options.asset !== undefined ||
      options.expectedHash !== undefined ||
      options.expectedBodyHash !== undefined;
    if (!writing && options.operation !== undefined)
      return Promise.resolve(
        Result.err(
          cliError(
            "invalid_command",
            "只读 cover 不接受 --operation；设置封面请指定 --asset 或 --from-body。",
          ),
        ),
      );
    if (
      writing &&
      (!/^[0-9a-f]{64}$/.test(options.expectedHash ?? "") ||
        (body
          ? options.asset !== undefined ||
            !/^[1-9][0-9]*$/.test(options.fromBody!) ||
            !Number.isSafeInteger(Number(options.fromBody)) ||
            !/^[0-9a-f]{64}$/.test(options.expectedBodyHash ?? "")
          : !options.asset || options.expectedBodyHash !== undefined))
    )
      return Promise.resolve(
        Result.err(
          cliError(
            "invalid_command",
            "互斥来源 --asset 或 --from-body；写入必需 --expected-hash，正文来源还必需 --expected-body-hash。图片序号为正整数，hash 为 64 位小写 SHA-256",
          ),
        ),
      );
    if (writing)
      return submitCover(
        body
          ? {
              article: ref!,
              bodyImage: Number(options.fromBody),
              expectedBodyHash: options.expectedBodyHash!,
              expectedCoverHash: options.expectedHash!,
            }
          : { article: ref!, asset: options.asset!, expectedCoverHash: options.expectedHash! },
        options.operation,
      );
    return withConnection(async ({ workspace }) => {
      const result = await workspace.readArticleCover(ref!);
      return Result.isError(result)
        ? Result.err(cliError(result.error.code, undefined, result.error.details))
        : Result.ok({ coverHash: result.value.coverHash });
    });
  }

  if (command === "save") {
    if (!options.expect)
      return Promise.resolve(
        Result.err(
          cliError("invalid_command", "save 需要 --expect 指向 inspect --all 输出的 JSON 文件"),
        ),
      );
    return Result.tryPromise({
      try: () => readFile(options.expect!, "utf8"),
      catch: () => cliError("file_error", "检查 --expect 状态文件是否存在且可读"),
    }).then((file) => {
      if (file.isErr()) return file;
      const decoded = Result.try({
        try: () => JSON.parse(file.value) as unknown,
        catch: () => cliError("invalid_command", "--expect 必须是 inspect --all 输出的 JSON"),
      });
      if (decoded.isErr()) return decoded;
      const state = v.safeParse(articleStateSchema, decoded.value);
      if (!state.success || state.output.article !== ref)
        return Result.err(
          cliError(
            "invalid_command",
            "状态文件必须来自同一 article 的 inspect --all；不会自动刷新或替换版本",
          ),
        );
      return submitSave(
        {
          article: ref!,
          expectedBodyHash: state.output.bodyHash,
          expectedFieldsHash: state.output.fieldsHash,
          expectedCoverHash: state.output.coverHash,
        },
        options.operation,
      );
    });
  }

  if (command === "update") {
    if (!/^[0-9a-f]{64}$/.test(options.expectedHash ?? ""))
      return Promise.resolve(
        Result.err(
          cliError("invalid_command", "--expected-hash 必须是 article inspect 返回的 fieldsHash"),
        ),
      );
    return Result.tryPromise({
      try: () => readFile(options.fields!, "utf8"),
      catch: () => cliError("file_error", "检查 --fields JSON 文件是否存在且可读"),
    }).then((file) => {
      if (Result.isError(file)) return Result.err(file.error);
      const decoded = Result.try({
        try: () => JSON.parse(file.value) as unknown,
        catch: () => cliError("invalid_fields"),
      });
      if (Result.isError(decoded)) return Result.err(decoded.error);
      const validated = v.safeParse(articleFieldUpdateInputSchema, decoded.value);
      if (!validated.success)
        return Result.err(cliError("invalid_fields", "提供 title、author 和/或 summary 字符串"));
      return submitFields(
        { article: ref!, fields: validated.output, expectedHash: options.expectedHash! },
        options.operation,
      );
    });
  }

  if (command === "open" || command === "new")
    return submitNavigation(command === "open" ? ref! : undefined, options.operation);
  if (command === "current") {
    if (options.new && options.candidate !== undefined)
      return Promise.resolve(Result.err(cliError("invalid_command", "--new 与 --candidate 互斥")));
    return withConnection(
      async ({ workspace }) => {
        const result = await workspace.currentArticle({
          ...(options.candidate ? { candidate: options.candidate } : {}),
          ...(options.new ? { new: true } : {}),
        });
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
  }

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
    return submitBody(
      { article: ref!, html: file.value, expectedHash: options.expectedHash! },
      options.operation,
    );
  });
}
