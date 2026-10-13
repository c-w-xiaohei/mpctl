import type { FieldsExecution, FieldsReceipt } from "../src/background-contracts";
import { fieldsRequestDigest } from "../src/background-contracts";
import { initialFieldsEffect } from "../src/mp/article-fields";
export const fieldsExecutorId = crypto.randomUUID();
export const fieldsProviderIdentity = {
  async identity() {
    return { status: "ok" as const, value: { executorId: fieldsExecutorId } };
  },
  async getReceipt() {
    return { status: "ok" as const, value: null };
  },
};
export async function fieldsReceipt(
  fields: { title?: string; author?: string; summary?: string },
  expectedHash: string,
  execution: FieldsExecution,
  fieldsHash: string,
): Promise<FieldsReceipt> {
  const effect = initialFieldsEffect(fields);
  return {
    ...execution,
    requestDigest: await fieldsRequestDigest(fields, expectedHash),
    effect: {
      ...effect,
      outcome: "confirmed",
      attempted: effect.requested,
      confirmed: effect.requested,
      fieldsHash,
    },
    ended: true,
    result: { status: "ok", value: {} },
  };
}
