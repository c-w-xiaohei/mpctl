import { Result } from "better-result";
import { withConnection, submitAsset, cliError, type CliError } from "./connection.js";
import { operationIdSchema } from "@mpctl/contracts";
import * as v from "valibot";
import { readAssetFile } from "./asset-file.js";

type Outcome<T> = import("better-result").Result<T, CliError>;

export async function assetCommand(
  command: "list" | "upload" | "resolve",
  article: string,
  options: { file?: string; operation?: string; asset?: string } = {},
): Promise<Outcome<unknown>> {
  if (command === "resolve")
    return withConnection(({ workspace }) => workspace.resolveAsset(article, options.asset ?? ""));
  if (
    command === "list" &&
    options.operation !== undefined &&
    !v.safeParse(operationIdSchema, options.operation).success
  )
    return Result.err(cliError("invalid_operation"));
  if (command === "list")
    return withConnection(
      async ({ workspace }) => {
        const listed = await workspace.listAssets(
          article,
          options.operation ? { operation: options.operation } : undefined,
        );
        return Result.isError(listed) ? Result.err(listed.error) : Result.ok(listed.value);
      },
      { callTimeout: 5_000 },
    );

  const file = await readAssetFile(options.file ?? "");
  if (Result.isError(file)) return file;
  return submitAsset({ article, ...file.value }, options.operation);
}
