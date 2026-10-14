import { Result } from "better-result";
import * as v from "valibot";
import {
  ledgerIdSchema,
  operationLedgerId,
  operationSnapshotSchema,
  type OperationSnapshot,
  type OperationEffect,
  type OperationResult,
  type OperationReply,
  type InteractionIssue,
  type Failure,
  type BodyEffect,
} from "@mpctl/contracts";

// Receipt types remain useful to the native adapters; they do not control storage.
export type OperationObservation = {
  effect: OperationEffect;
  result: OperationResult;
  ended: boolean;
};
export type BodyObservation = { effect: BodyEffect; result: OperationResult; ended: boolean };
const targetSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer()),
  documentId: v.string(),
  route: v.string(),
  executorId: ledgerIdSchema,
  groupId: v.optional(v.string()),
  contextDigest: v.optional(v.string()),
});
export type OperationTarget = v.InferOutput<typeof targetSchema>;
const navigationTargetSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer()),
  documentId: v.string(),
  route: v.string(),
  groupId: v.optional(v.string()),
  contextDigest: v.optional(v.string()),
});
export type NavigationTarget = v.InferOutput<typeof navigationTargetSchema>;
const navigationSchema = v.strictObject({
  bg: v.literal(true),
  purpose: v.picklist(["new", "open", "maintenance"]),
  candidate: v.optional(v.string()),
  target: v.optional(navigationTargetSchema),
  source: v.optional(navigationTargetSchema),
});
export type NavigationBinding = v.InferOutput<typeof navigationSchema>;
// Old records are read, never normalized into successful new executions.
const recordSchema = v.strictObject({
  schemaVersion: v.union([v.literal(2), v.literal(3)]),
  ledgerId: ledgerIdSchema,
  requestDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  localRequestDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  owner: ledgerIdSchema,
  snapshot: operationSnapshotSchema,
  binding: v.optional(targetSchema),
  navigationBinding: v.optional(navigationSchema),
  bgEffects: v.optional(v.picklist(["pending", "complete"])),
  createdAt: v.optional(v.number()),
  updatedAt: v.optional(v.number()),
});
export type OperationRecord = v.InferOutput<typeof recordSchema>;
const metaSchema = v.strictObject({
  schemaVersion: v.union([v.literal(2), v.literal(3)]),
  ledgerId: ledgerIdSchema,
  keyLedgerId: ledgerIdSchema,
  owner: ledgerIdSchema,
});
type Outcome<T> = Result<T, InteractionIssue>;
export type Claim = {
  operationId: string;
  operation: OperationSnapshot["operation"];
  requestDigest: string;
  localRequestDigest: string;
  effect: OperationEffect;
};
export type Operations = {
  ledgerId: string;
  keyLedger(): Promise<Outcome<string>>;
  claim(input: Claim): Promise<Outcome<{ acquired: boolean; record: OperationRecord }>>;
  bind(id: string, target: OperationTarget): Promise<Outcome<void>>;
  finish(
    id: string,
    effect: OperationEffect,
    result: OperationResult,
  ): Promise<Outcome<OperationReply>>;
  get(id: string): Promise<Outcome<OperationReply>>;
  record(id: string): Promise<Outcome<OperationRecord>>;
  savedRequests(target: OperationTarget): Promise<Outcome<OperationRecord[]>>;
  receipt(
    id: string,
    receipt: {
      executorId: string;
      requestDigest: string;
      effect: OperationEffect;
      ended: boolean;
      result?: OperationResult;
    },
  ): Promise<Outcome<OperationReply>>;
};
class StorageFault extends Error {
  constructor(readonly code: Failure["code"]) {
    super(code);
  }
}
function parse<T>(schema: v.BaseSchema<unknown, T, v.BaseIssue<unknown>>, value: unknown): T {
  const parsed = v.safeParse(schema, value);
  if (!parsed.success) throw new StorageFault("ledger_incompatible");
  return parsed.output;
}
// Transaction completion, rather than request success, is the durable boundary.
function transaction<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(["meta", "operations"], mode);
    let output: T;
    let error: unknown;
    const fail = (reason: unknown) => {
      error = reason;
      try {
        tx.abort();
      } catch {
        /* already closed */
      }
    };
    tx.oncomplete = () => resolve(output);
    tx.onabort = () => reject(error ?? new StorageFault("storage_failed"));
    tx.onerror = () => {
      error ??= new StorageFault("storage_failed");
    };
    try {
      work(
        tx,
        (value) => {
          output = value;
        },
        fail,
      );
    } catch (reason) {
      fail(reason);
    }
  });
}

export async function createOperations(
  databaseName = "mpctl.operations",
): Promise<Outcome<Operations>> {
  const issue = (error: unknown, id?: string): InteractionIssue => ({
    ...(id ? { operationId: id } : {}),
    failure: { code: error instanceof StorageFault ? error.code : "storage_failed" },
  });
  let db: IDBDatabase | undefined;
  try {
    db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = indexedDB.open(databaseName, 1);
      open.onupgradeneeded = () => {
        open.result.createObjectStore("operations", { keyPath: "snapshot.operationId" });
        const ledgerId = crypto.randomUUID();
        open.result.createObjectStore("meta").add(
          {
            schemaVersion: 3,
            ledgerId,
            keyLedgerId: ledgerId,
            owner: crypto.randomUUID(),
          },
          "ledger",
        );
      };
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(new StorageFault("storage_failed"));
      open.onblocked = () => reject(new StorageFault("storage_failed"));
    });
    const database = db;
    database.onversionchange = () => database.close();
    const owner = crypto.randomUUID();
    const meta = await transaction<v.InferOutput<typeof metaSchema>>(
      database,
      "readwrite",
      (tx, done, fail) => {
        const request = tx.objectStore("meta").get("ledger");
        request.onsuccess = () => {
          try {
            const value = parse(metaSchema, request.result);
            // Fence the old writer without mutating a single historical operation.
            tx.objectStore("meta").put({ ...value, schemaVersion: 3, owner }, "ledger");
            done(value);
          } catch (error) {
            fail(error);
          }
        };
      },
    );
    async function access<T>(
      mode: IDBTransactionMode,
      work: (
        store: IDBObjectStore,
        done: (value: T) => void,
        fail: (error: unknown) => void,
      ) => void,
    ): Promise<T> {
      return transaction<T>(database, mode, (tx, done, fail) => {
        const request = tx.objectStore("meta").get("ledger");
        request.onsuccess = () => {
          try {
            const current = parse(metaSchema, request.result);
            if (current.ledgerId !== meta.ledgerId) throw new StorageFault("ledger_incompatible");
            if (mode === "readwrite" && current.owner !== owner)
              throw new StorageFault("execution_closed");
            work(tx.objectStore("operations"), done, fail);
          } catch (error) {
            fail(error);
          }
        };
      });
    }
    function checked(value: unknown, id?: string) {
      const record = parse(recordSchema, value);
      if (record.ledgerId !== meta.ledgerId || (id && record.snapshot.operationId !== id))
        throw new StorageFault("ledger_incompatible");
      return record;
    }
    const record: Operations["record"] = async (id) => {
      try {
        if (!operationLedgerId(id)) throw new StorageFault("invalid_operation");
        return Result.ok(
          await access<OperationRecord>("readonly", (store, done, fail) => {
            const request = store.get(id);
            request.onsuccess = () => {
              try {
                if (!request.result)
                  throw new StorageFault(
                    operationLedgerId(id) === meta.keyLedgerId
                      ? "operation_not_found"
                      : "ledger_mismatch",
                  );
                done(checked(request.result, id));
              } catch (error) {
                fail(error);
              }
            };
          }),
        );
      } catch (error) {
        return Result.err(issue(error, id));
      }
    };
    const get: Operations["get"] = async (id) => {
      const stored = await record(id);
      return stored.isErr() ? stored : Result.ok({ snapshot: stored.value.snapshot });
    };
    const change = async (
      id: string,
      update: (record: OperationRecord) => void,
    ): Promise<Outcome<OperationReply>> => {
      try {
        const snapshot = await access<OperationSnapshot>("readwrite", (store, done, fail) => {
          const request = store.get(id);
          request.onsuccess = () => {
            try {
              const value = checked(request.result, id);
              if (value.schemaVersion !== 3 || value.owner !== owner)
                throw new StorageFault("execution_closed");
              update(value);
              checked(value, id);
              store.put(value);
              done(value.snapshot);
            } catch (error) {
              fail(error);
            }
          };
        });
        return Result.ok({ snapshot });
      } catch (error) {
        return Result.err(issue(error, id));
      }
    };
    return Result.ok({
      ledgerId: meta.ledgerId,
      record,
      get,
      async keyLedger() {
        try {
          return Result.ok(
            await access<string>("readwrite", (_store, done) => done(meta.keyLedgerId)),
          );
        } catch (error) {
          return Result.err(issue(error));
        }
      },
      async claim(input) {
        try {
          if (!operationLedgerId(input.operationId)) throw new StorageFault("invalid_operation");
          return Result.ok(
            await access<{ acquired: boolean; record: OperationRecord }>(
              "readwrite",
              (store, done, fail) => {
                const request = store.get(input.operationId);
                request.onsuccess = () => {
                  try {
                    if (request.result) {
                      const old = checked(request.result, input.operationId);
                      if (old.requestDigest !== input.requestDigest)
                        throw new StorageFault("operation_conflict");
                      done({ acquired: false, record: old });
                      return;
                    }
                    if (operationLedgerId(input.operationId) !== meta.keyLedgerId)
                      throw new StorageFault("ledger_mismatch");
                    const value: OperationRecord = {
                      schemaVersion: 3,
                      ledgerId: meta.ledgerId,
                      owner,
                      requestDigest: input.requestDigest,
                      localRequestDigest: input.localRequestDigest,
                      snapshot: parse(operationSnapshotSchema, {
                        operationId: input.operationId,
                        operation: input.operation,
                        state: "unresolved",
                        effect: input.effect,
                        result: { status: "error", error: { code: "operation_unresolved" } },
                      }),
                    };
                    store.add(value);
                    done({ acquired: true, record: value });
                  } catch (error) {
                    fail(error);
                  }
                };
              },
            ),
          );
        } catch (error) {
          return Result.err(issue(error, input.operationId));
        }
      },
      async bind(id, target) {
        const result = await change(id, (value) => {
          if (value.binding || value.snapshot.state === "settled")
            throw new StorageFault("execution_closed");
          value.binding = parse(targetSchema, target);
          value.snapshot = parse(operationSnapshotSchema, {
            ...value.snapshot,
            effect: { ...value.snapshot.effect, outcome: "unknown" },
          });
        });
        return result.isErr() ? result : Result.ok();
      },
      async finish(id, effect, result) {
        return change(id, (value) => {
          if (value.snapshot.state === "settled") throw new StorageFault("execution_closed");
          // Settled describes a recorded response, never ownership of a resource.
          value.snapshot = parse(operationSnapshotSchema, {
            ...value.snapshot,
            state: "settled",
            effect,
            result,
          });
        });
      },
      async receipt(id, receipt) {
        try {
          const snapshot = await access<OperationSnapshot>("readwrite", (store, done, fail) => {
            const request = store.get(id);
            request.onsuccess = () => {
              try {
                const value = checked(request.result, id);
                if (value.schemaVersion === 2) {
                  done(value.snapshot);
                  return;
                }
                if (
                  value.binding?.executorId !== receipt.executorId ||
                  value.localRequestDigest !== receipt.requestDigest
                )
                  throw new StorageFault("evidence_conflict");
                if (
                  !v.safeParse(operationSnapshotSchema, {
                    ...value.snapshot,
                    state: "settled",
                    effect: receipt.effect,
                    result: receipt.result ?? {
                      status: "error",
                      error: { code: "operation_unresolved" },
                    },
                  }).success
                )
                  throw new StorageFault("evidence_conflict");
                if (value.snapshot.effect.outcome === "confirmed" || !receipt.result) {
                  done(value.snapshot);
                  return;
                }
                if (receipt.effect.outcome !== "confirmed" && !receipt.ended) {
                  done(value.snapshot);
                  return;
                }
                value.snapshot = parse(operationSnapshotSchema, {
                  ...value.snapshot,
                  state: "settled",
                  effect: receipt.effect,
                  result: receipt.result,
                });
                store.put(value);
                done(value.snapshot);
              } catch (error) {
                fail(error);
              }
            };
          });
          return Result.ok({ snapshot });
        } catch (error) {
          return Result.err(issue(error, id));
        }
      },
      async savedRequests(target) {
        try {
          return Result.ok(
            await access<OperationRecord[]>("readonly", (store, done, fail) => {
              const request = store.getAll();
              request.onsuccess = () => {
                try {
                  done(
                    request.result
                      .map((value: unknown) => checked(value))
                      .filter(
                        (value: OperationRecord) =>
                          value.snapshot.operation === "save" &&
                          value.binding &&
                          (value.binding.documentId === target.documentId ||
                            (target.groupId &&
                              target.contextDigest &&
                              value.binding.groupId === target.groupId &&
                              value.binding.contextDigest === target.contextDigest)) &&
                          value.snapshot.effect.outcome !== "confirmed" &&
                          (value.snapshot.effect.outcome === "unknown" ||
                            value.snapshot.state === "unresolved" ||
                            value.snapshot.state === "issued"),
                      ),
                  );
                } catch (error) {
                  fail(error);
                }
              };
            }),
          );
        } catch (error) {
          return Result.err(issue(error));
        }
      },
    });
  } catch (error) {
    db?.close();
    return Result.err(issue(error));
  }
}
