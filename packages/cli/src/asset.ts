import { Result } from "better-result";
import { withConnection, submitAsset, type CliError } from "./connection.js";
import { readAssetFile } from "./asset-file.js";

type Outcome<T> = import("better-result").Result<T, CliError>;

export async function assetCommand(
  command: "list" | "upload",
  article: string,
  options: { file?: string; operation?: string } = {},
): Promise<Outcome<unknown>> {
  if (command === "list")
    return withConnection(
      async ({ workspace }) => {
        const listed = await workspace.listAssets(article);
        return Result.isError(listed) ? Result.err(listed.error) : Result.ok(listed.value);
      },
      { callTimeout: 5_000 },
    );

  const file = await readAssetFile(options.file ?? "");
  if (Result.isError(file)) return file;
  return submitAsset({ article, ...file.value }, options.operation);
}
