import { assetRequestDigest, type AssetPayload } from "@mpctl/contracts";
import type { UploadExecution, UploadReceipt } from "../src/background-contracts";

export const uploadExecution: UploadExecution = {
  operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
  executorId: crypto.randomUUID(),
};
export async function uploadReceipt(
  payload: AssetPayload,
  execution = uploadExecution,
): Promise<UploadReceipt> {
  return {
    ...execution,
    requestDigest: await assetRequestDigest(payload),
    effect: {
      outcome: "confirmed",
      filename: payload.filename,
      thumbnailUrl: "https://mmbiz.qpic.cn/test/300",
    },
    ended: true,
    result: { status: "ok", value: {} },
  };
}
export const materialIdentity = {
  identity: async () => ({
    status: "ok" as const,
    value: { executorId: uploadExecution.executorId },
  }),
  getReceipt: async () => ({ status: "ok" as const, value: null }),
};
