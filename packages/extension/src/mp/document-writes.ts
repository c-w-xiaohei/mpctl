import { Result } from "better-result";
import type { Failure } from "@mpctl/contracts";

type Owner = { operationId: string; token: string };
/** MAIN owns both its native calls and CONTENT's DOM write reservations. */
export function createDocumentWrites() {
  let tail = Promise.resolve();
  let owner: Owner | undefined;
  const currentOwner = () => owner;
  return {
    reserve(operationId: string) {
      const previous = tail;
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      tail = previous.then(() => done);
      const entry: Owner = { operationId, token: crypto.randomUUID() };
      let returned = false;
      let completed = false;
      return {
        async enter(): Promise<Result<void, Failure>> {
          const active = currentOwner();
          if (active)
            return Result.err({
              code: "operation_blocked",
              blockingOperationId: active.operationId,
            });
          await previous;
          if (owner)
            return Result.err({
              code: "operation_blocked",
              blockingOperationId: owner.operationId,
            });
          owner = entry;
          return Result.ok();
        },
        dispatched() {
          completed = false;
        },
        confirmed() {
          completed = true;
          if (returned && owner === entry) owner = undefined;
        },
        finish(notDispatched = false) {
          returned = true;
          if ((completed || notDispatched) && owner === entry) owner = undefined;
          release();
        },
      };
    },
    acquire(operationId: string): Result<string, Failure> {
      if (owner)
        return Result.err({ code: "operation_blocked", blockingOperationId: owner.operationId });
      owner = { operationId, token: crypto.randomUUID() };
      return Result.ok(owner.token);
    },
    release(token: string): Result<void, Failure> {
      if (!owner || owner.token !== token) return Result.err({ code: "executor_mismatch" });
      owner = undefined;
      return Result.ok();
    },
  };
}

// Persist in this document's MAIN realm across bundle reinjection. This is
// execution state only, never an authorization source or a historical ledger.
const key = Symbol.for("mpctl.document-writes.v1");
export function documentWritesFor(document?: Document): ReturnType<typeof createDocumentWrites> {
  if (!document) return createDocumentWrites();
  const state = document as Document & { [key]?: ReturnType<typeof createDocumentWrites> };
  return (state[key] ??= createDocumentWrites());
}
