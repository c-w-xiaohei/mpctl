import { Result } from "better-result";
import {
  coverRequestDigest,
  saveRequestDigest,
  coverWriteResultCodec,
  saveWriteResultCodec,
  fieldsIdentityResultCodec,
  coverSaveReceiptResultCodec,
  type CoverExecution,
  type SaveExecution,
  type CoverReceipt,
  type SaveReceipt,
} from "../src/background-contracts";

export const executorId = crypto.randomUUID();
export const coverExecution = (): CoverExecution => ({
  operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
  executorId,
  asset: "original-asset",
});
export const saveExecution = (): SaveExecution => ({
  operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
  executorId,
  expectedBodyHash: "a".repeat(64),
  expectedFieldsHash: "b".repeat(64),
  expectedCoverHash: "c".repeat(64),
});
export const coverIdentity = {
  identity: async () =>
    (await fieldsIdentityResultCodec.serialize(Result.ok({ executorId }))).unwrap(),
  getReceipt: async () => (await coverSaveReceiptResultCodec.serialize(Result.ok(null))).unwrap(),
};
export async function coverReceipt(
  execution: CoverExecution,
  expected: string,
  effect: CoverReceipt["effect"] = { cover: true, outcome: "confirmed", coverHash: "b".repeat(64) },
  result: CoverReceipt["result"] = { status: "ok", value: {} },
  ended = true,
) {
  return (
    await coverWriteResultCodec.serialize(
      Result.ok({
        operationId: execution.operationId,
        executorId: execution.executorId,
        requestDigest: await coverRequestDigest(execution.asset, expected),
        effect,
        result,
        ended,
      }),
    )
  ).unwrap();
}
export async function saveReceipt(
  execution: SaveExecution,
  effect: SaveReceipt["effect"] = { outcome: "confirmed", persistence: "unverified" },
  result: SaveReceipt["result"] = { status: "ok", value: {} },
  ended = true,
) {
  return (
    await saveWriteResultCodec.serialize(
      Result.ok({
        operationId: execution.operationId,
        executorId: execution.executorId,
        requestDigest: await saveRequestDigest(execution),
        effect,
        result,
        ended,
      }),
    )
  ).unwrap();
}
