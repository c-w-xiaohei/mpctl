import { Result } from "better-result";
import type { Result as Outcome } from "better-result";
import * as v from "valibot";
import {
  operationLedgerId,
  operationSnapshotSchema,
  writeBodyInputSchema,
  ledgerIdSchema,
  operationEffectSchema,
  fieldsEffectSchema,
  assetUploadInputSchema,
  articleCoverSetInputSchema,
  articleSaveInputSchema,
  articleNewInputSchema,
  articleOpenInputSchema,
  maintenanceInputSchema,
  type ArticleNewInput,
  type ArticleOpenInput,
  type MaintenanceInput,
  type ArticleCoverSetInput,
  type ArticleSaveInput,
  assetPayloadSchema,
  assetRequestDigest,
  validAssetSignature,
  type AssetUploadInput,
  updateFieldsInputSchema,
  operationResultSchema,
  type InteractionIssue,
  type Failure,
  type OperationReply,
  type OperationSnapshot,
  type BodyEffect,
  type OperationResult,
  type WriteBodyInput,
  type UpdateFieldsInput,
  type OperationEffect,
} from "@mpctl/contracts";
import { bodyRequestDigest } from "./page-contracts";
import {
  fieldsRequestDigest,
  fieldsRequestSignature,
  coverRequestDigest,
  bodyCoverRequestDigest,
  saveRequestDigest,
} from "./background-contracts";
import { initialFieldsEffect } from "./mp/article-fields";

export type OperationTarget = v.InferOutput<typeof bindingSchema>;
export type NavigationTarget = v.InferOutput<typeof navigationTargetSchema>;
export type NavigationBinding = v.InferOutput<typeof navigationBindingSchema>;
export type BodyObservation = { effect: BodyEffect; result: OperationResult; ended: boolean };
export type OperationObservation = {
  effect: OperationEffect;
  result: OperationResult;
  ended: boolean;
};
export type OperationRecord = v.InferOutput<typeof recordSchema>;
export type Execution = {
  issue(
    binding: OperationTarget | NavigationBinding,
    action: () => Promise<OperationObservation>,
  ): Promise<OperationObservation>;
  checkpoint(observation: OperationObservation): Promise<void>;
  bindTarget(binding: NavigationTarget, evidence?: OperationObservation): Promise<void>;
};
export type Operations = {
  ledgerId: string;
  keyLedger(): Promise<Outcome<string, InteractionIssue>>;
  run(
    request:
      | WriteBodyInput
      | UpdateFieldsInput
      | AssetUploadInput
      | ArticleCoverSetInput
      | ArticleSaveInput
      | ArticleNewInput
      | ArticleOpenInput
      | MaintenanceInput,
    work: (execution: Execution) => Promise<OperationObservation>,
  ): Promise<Outcome<OperationReply, InteractionIssue>>;
  get(id: string): Promise<Outcome<OperationReply, InteractionIssue>>;
  record(id: string): Promise<Outcome<OperationRecord, InteractionIssue>>;
  pending(): Promise<Outcome<OperationRecord[], InteractionIssue>>;
  observe(
    id: string,
    requestDigest: string,
    binding: OperationTarget,
    observation: OperationObservation,
  ): Promise<Outcome<OperationReply, InteractionIssue>>;
  maintenance<T>(action: () => Promise<T>): Promise<Outcome<T, InteractionIssue>>;
};
const bindingSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer()),
  documentId: v.pipe(v.string(), v.minLength(1)),
  route: v.pipe(v.string(), v.minLength(1)),
  executorId: ledgerIdSchema,
  groupId: v.optional(v.string()),
  contextDigest: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});
const navigationTargetSchema = v.strictObject({
  tabId: v.pipe(v.number(), v.integer()),
  documentId: v.pipe(v.string(), v.minLength(1)),
  route: v.pipe(v.string(), v.minLength(1)),
  groupId: v.optional(v.string()),
  contextDigest: v.optional(v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/))),
});
const navigationBindingSchema = v.strictObject({
  bg: v.literal(true),
  purpose: v.picklist(["new", "open", "maintenance"]),
  candidate: v.optional(v.string()),
  target: v.optional(navigationTargetSchema),
  source: v.optional(navigationTargetSchema),
});
const recordSchema = v.strictObject({
  schemaVersion: v.literal(2),
  ledgerId: ledgerIdSchema,
  requestDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  localRequestDigest: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
  owner: ledgerIdSchema,
  binding: v.optional(bindingSchema),
  navigationBinding: v.optional(navigationBindingSchema),
  // Legacy BG pointer/navigation completion remains authoritative for old records.
  bgEffects: v.optional(v.picklist(["pending", "complete"])),
  snapshot: operationSnapshotSchema,
  createdAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
  updatedAt: v.optional(v.pipe(v.number(), v.finite(), v.minValue(0))),
});
const metaSchema = v.strictObject({
  schemaVersion: v.literal(2),
  ledgerId: ledgerIdSchema,
  keyLedgerId: ledgerIdSchema,
  owner: ledgerIdSchema,
});
function readMeta(value: unknown) {
  const parsed = v.safeParse(metaSchema, value);
  if (!parsed.success) throw new OperationFault("ledger_incompatible");
  return parsed.output;
}
const observationSchema = v.pipe(
  v.strictObject({
    effect: operationEffectSchema,
    result: operationResultSchema,
    ended: v.boolean(),
  }),
  v.check(
    (observation) =>
      observation.result.status !== "ok" ||
      (observation.ended && observation.effect.outcome === "confirmed"),
  ),
);
class OperationFault extends Error {
  constructor(readonly code: Failure["code"]) {
    super(code);
  }
}
const errorObservation = (
  code: Failure["code"],
  effect: BodyEffect = { outcome: "not_dispatched" },
  ended = true,
): BodyObservation => ({ effect, result: { status: "error", error: { code } }, ended });
function readRecord(value: unknown): OperationRecord {
  const parsed = v.safeParse(recordSchema, value);
  if (
    !parsed.success ||
    (!parsed.output.binding &&
      !parsed.output.navigationBinding &&
      (parsed.output.snapshot.state === "issued" ||
        parsed.output.snapshot.state === "unresolved" ||
        parsed.output.snapshot.effect.outcome !== "not_dispatched")) ||
    ((parsed.output.snapshot.operation === "cover" ||
      parsed.output.snapshot.operation === "save") &&
      parsed.output.snapshot.state !== "accepted" &&
      parsed.output.binding !== undefined &&
      parsed.output.bgEffects === undefined)
  )
    throw new OperationFault("ledger_incompatible");
  const navigation = ["new", "open", "maintenance"].includes(parsed.output.snapshot.operation);
  if (
    (parsed.output.binding && navigation) ||
    (parsed.output.navigationBinding &&
      (!navigation ||
        parsed.output.navigationBinding.purpose !== parsed.output.snapshot.operation ||
        parsed.output.snapshot.state === "accepted" ||
        (parsed.output.snapshot.operation === "open" &&
          !parsed.output.navigationBinding.candidate) ||
        (parsed.output.snapshot.operation === "open" &&
          parsed.output.navigationBinding.target &&
          parsed.output.navigationBinding.target.groupId !==
            parsed.output.navigationBinding.candidate) ||
        (parsed.output.snapshot.operation !== "open" &&
          parsed.output.navigationBinding.candidate !== undefined))) ||
    ("targetBound" in parsed.output.snapshot.effect &&
      parsed.output.snapshot.effect.targetBound &&
      !parsed.output.navigationBinding?.target)
  )
    throw new OperationFault("ledger_incompatible");
  return parsed.output;
}
function mergeEffect(old: OperationEffect, next: OperationEffect, ended: boolean): OperationEffect {
  if ("navigation" in old || "navigation" in next) {
    if (!("navigation" in old) || !("navigation" in next))
      throw new OperationFault("evidence_conflict");
    if (
      (old.pageCreated && !next.pageCreated) ||
      (old.targetBound && !next.targetBound) ||
      old.auxiliaryCreated.some((role) => !next.auxiliaryCreated.includes(role)) ||
      (old.bodyHash && old.bodyHash !== next.bodyHash)
    )
      throw new OperationFault("evidence_conflict");
    if (old.outcome === "confirmed" && next.outcome !== "confirmed")
      throw new OperationFault("evidence_conflict");
    return old.outcome === "unknown" && next.outcome === "not_dispatched"
      ? { ...next, outcome: "unknown" }
      : next;
  }
  if ("maintenance" in old || "maintenance" in next) {
    if (!("maintenance" in old) || !("maintenance" in next))
      throw new OperationFault("evidence_conflict");
    if (
      (old.placements ?? 0) > (next.placements ?? 0) ||
      old.auxiliaryCreated?.some((role) => !next.auxiliaryCreated?.includes(role))
    )
      throw new OperationFault("evidence_conflict");
    return old.outcome === "confirmed" ? old : next;
  }
  if ("persistence" in old || "persistence" in next) {
    if (!("persistence" in old) || !("persistence" in next))
      throw new OperationFault("evidence_conflict");
    if (old.outcome === "confirmed") {
      if (old.persistence === "verified" && ended && next.persistence !== "verified")
        throw new OperationFault("evidence_conflict");
      if (ended && next.outcome === "not_dispatched") throw new OperationFault("evidence_conflict");
      if (old.persistence === "verified") {
        if (next.persistence === "verified" && JSON.stringify(old) !== JSON.stringify(next))
          throw new OperationFault("evidence_conflict");
        return old;
      }
      return next.outcome === "confirmed" ? next : old;
    }
    return old.outcome === "unknown" && next.outcome === "not_dispatched" ? old : next;
  }
  if ("cover" in old || "cover" in next) {
    if (!("cover" in old) || !("cover" in next)) throw new OperationFault("evidence_conflict");
    if (old.outcome === "confirmed") {
      if (
        (ended && next.outcome === "not_dispatched") ||
        (next.outcome === "confirmed" && old.coverHash !== next.coverHash)
      )
        throw new OperationFault("evidence_conflict");
      return old;
    }
    return old.outcome === "unknown" && next.outcome === "not_dispatched" ? old : next;
  }
  if ("filename" in old || "filename" in next) {
    if (!("filename" in old) || !("filename" in next) || old.filename !== next.filename)
      throw new OperationFault("evidence_conflict");
    if (old.outcome === "confirmed") {
      if (
        (ended && next.outcome === "not_dispatched") ||
        (next.outcome === "confirmed" && next.thumbnailUrl !== old.thumbnailUrl)
      )
        throw new OperationFault("evidence_conflict");
      return old;
    }
    return old.outcome === "unknown" && next.outcome === "not_dispatched" ? old : next;
  }
  if ("requested" in old || "requested" in next) {
    if (
      !("requested" in old) ||
      !("requested" in next) ||
      JSON.stringify(old.requested) !== JSON.stringify(next.requested)
    )
      throw new OperationFault("evidence_conflict");
    // Terminal receipts describe the complete original execution, not a running
    // subset. Validate history before union so union cannot hide contradictions.
    if (
      ended &&
      (old.attempted.some((name) => !next.attempted.includes(name)) ||
        old.confirmed.some((name) => !next.confirmed.includes(name)))
    )
      throw new OperationFault("evidence_conflict");
    if (old.fieldsHash && next.fieldsHash && old.fieldsHash !== next.fieldsHash)
      throw new OperationFault("evidence_conflict");
    if (old.outcome === "confirmed") {
      if (
        (ended && next.outcome === "not_dispatched") ||
        next.attempted.some((name) => !old.attempted.includes(name))
      )
        throw new OperationFault("evidence_conflict");
      return old;
    }
    const order = ["title", "author", "summary"] as const;
    const attempted = order.filter(
      (name) => old.attempted.includes(name) || next.attempted.includes(name),
    );
    const confirmed = order.filter(
      (name) => old.confirmed.includes(name) || next.confirmed.includes(name),
    );
    const unknown = attempted.filter((name) => !confirmed.includes(name));
    const outcome =
      next.outcome === "confirmed"
        ? "confirmed"
        : confirmed.length
          ? "partial"
          : old.outcome === "unknown" || next.outcome === "unknown" || attempted.length
            ? "unknown"
            : "not_dispatched";
    return v.parse(fieldsEffectSchema, {
      outcome,
      requested: old.requested,
      attempted,
      confirmed,
      unknown,
      ...(next.fieldsHash ? { fieldsHash: next.fieldsHash } : {}),
    });
  }
  if (old.outcome === "confirmed") {
    if (
      next.outcome === "not_dispatched" ||
      (next.outcome === "confirmed" && next.bodyHash !== old.bodyHash)
    )
      throw new OperationFault("evidence_conflict");
    return old;
  }
  if (old.outcome === "unknown" && next.outcome === "not_dispatched") return old; // Historical uncertainty is not evidence of dispatch. End facts merge separately.
  return next;
}
// The Promise resolves only on transaction complete, never request success.
function transact<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: unknown) => void) => void,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let value: T;
    let failure: unknown;
    const fail = (error: unknown) => {
      failure = error;
      try {
        tx.abort();
      } catch {
        /* already inactive */
      }
    };
    tx.oncomplete = () => (failure ? reject(failure) : resolve(value));
    tx.onabort = () => reject(failure ?? new OperationFault("storage_failed"));
    tx.onerror = () => {
      failure ??= new OperationFault("storage_failed");
    };
    try {
      work(
        tx,
        (result) => {
          value = result;
        },
        fail,
      );
    } catch (error) {
      fail(error);
    }
  });
}
export async function createOperations(
  databaseName = "mpctl.operations",
): Promise<Outcome<Operations, InteractionIssue>> {
  let openedDb: IDBDatabase | undefined;
  const issue = (error: unknown, operationId?: string): InteractionIssue => ({
    ...(operationId ? { operationId } : {}),
    failure: {
      code: error instanceof OperationFault ? error.code : "storage_failed",
      cause: {
        at:
          error instanceof OperationFault &&
          (error.code === "invalid_asset" || error.code === "hash_failed")
            ? "bg.preflight"
            : "bg.persistence",
        kind: "runtime",
        code: error instanceof OperationFault ? error.code : "storage_failed",
      },
    },
  });
  try {
    const owner = crypto.randomUUID();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const opened = indexedDB.open(databaseName, 1);
      opened.onupgradeneeded = (event) => {
        if (event.oldVersion !== 0) {
          opened.transaction?.abort();
          return;
        }
        opened.result.createObjectStore("operations", { keyPath: "snapshot.operationId" });
        const ledgerId = crypto.randomUUID();
        opened.result
          .createObjectStore("meta")
          .add({ ledgerId, keyLedgerId: ledgerId, owner, schemaVersion: 2 }, "ledger");
      };
      opened.onsuccess = () => resolve(opened.result);
      opened.onerror = () =>
        reject(
          new OperationFault(
            opened.error?.name === "VersionError" ? "ledger_incompatible" : "storage_failed",
          ),
        );
      opened.onblocked = () => reject(new OperationFault("storage_failed"));
    });
    openedDb = db;
    db.onversionchange = () => db.close();
    const ledgerId = await transact<string>(
      db,
      ["meta", "operations"],
      "readwrite",
      (tx, done, fail) => {
        const meta = tx.objectStore("meta").get("ledger");
        meta.onsuccess = () => {
          try {
            const value = readMeta(meta.result);
            done(value.ledgerId);
            tx.objectStore("meta").put({ ...value, owner }, "ledger");
            const all = tx.objectStore("operations").openCursor();
            all.onsuccess = () => {
              try {
                const cursor = all.result;
                if (!cursor) return;
                const record = readRecord(cursor.value);
                if (
                  record.ledgerId !== value.ledgerId ||
                  record.snapshot.operationId !== cursor.primaryKey
                )
                  throw new OperationFault("ledger_incompatible");
                if (record.snapshot.state === "accepted") {
                  record.snapshot = {
                    ...record.snapshot,
                    state: "settled",
                    result: { status: "error", error: { code: "operation_interrupted" } },
                  };
                  cursor.update(record);
                } else if (record.snapshot.state === "issued") {
                  record.snapshot = {
                    ...record.snapshot,
                    state: "unresolved",
                    result: { status: "error", error: { code: "operation_unresolved" } },
                  };
                  cursor.update(record);
                }
                cursor.continue();
              } catch (error) {
                fail(error);
              }
            };
          } catch (error) {
            fail(error);
          }
        };
      },
    );
    type Task = {
      signature: string | Promise<string>;
      promise: Promise<Outcome<OperationReply, InteractionIssue>>;
      active: boolean;
    };
    const tasks = new Map<string, Task>();
    let maintenance = false;
    const checkId = (id: string) => {
      const ledger = operationLedgerId(id);
      if (!ledger) throw new OperationFault("invalid_operation");
    };
    const ownedMeta = (value: unknown) => {
      const meta = readMeta(value);
      if (meta.ledgerId !== ledgerId) throw new OperationFault("ledger_incompatible");
      if (meta.owner !== owner) throw new OperationFault("execution_closed");
      return meta;
    };
    const checkedRecord = (value: unknown) => {
      const record = readRecord(value);
      if (record.ledgerId !== ledgerId) throw new OperationFault("ledger_incompatible");
      return record;
    };
    const record = async (id: string): Promise<Outcome<OperationRecord, InteractionIssue>> => {
      try {
        checkId(id);
        return Result.ok(
          await transact<OperationRecord>(
            db,
            ["meta", "operations"],
            "readonly",
            (tx, done, fail) => {
              const meta = tx.objectStore("meta").get("ledger");
              meta.onsuccess = () => {
                try {
                  const value = readMeta(meta.result);
                  if (value.ledgerId !== ledgerId) throw new OperationFault("ledger_incompatible");
                  const request = tx.objectStore("operations").get(id);
                  request.onsuccess = () => {
                    try {
                      if (!request.result)
                        throw new OperationFault(
                          operationLedgerId(id) === value.keyLedgerId
                            ? "operation_not_found"
                            : "ledger_mismatch",
                        );
                      const record = checkedRecord(request.result);
                      if (record.snapshot.operationId !== id)
                        throw new OperationFault("ledger_incompatible");
                      done(record);
                    } catch (error) {
                      fail(error);
                    }
                  };
                } catch (error) {
                  fail(error);
                }
              };
            },
          ),
        );
      } catch (error) {
        return Result.err(issue(error, id));
      }
    };
    const get: Operations["get"] = async (id) => {
      const stored = await record(id);
      if (stored.isErr()) return Result.err(stored.error);
      const snapshot = stored.value.snapshot;
      return Result.ok({
        snapshot,
        ...((snapshot.state === "accepted" || snapshot.state === "issued") && !tasks.get(id)?.active
          ? { issue: issue(new OperationFault("operation_unresolved"), id) }
          : {}),
      });
    };
    const update = async (id: string, change: (record: OperationRecord) => void) =>
      transact<OperationSnapshot>(db, ["meta", "operations"], "readwrite", (tx, done, fail) => {
        const store = tx.objectStore("operations");
        const meta = tx.objectStore("meta").get("ledger");
        meta.onsuccess = () => {
          try {
            ownedMeta(meta.result);
            const request = store.get(id);
            request.onsuccess = () => {
              try {
                const value = checkedRecord(request.result);
                if (value.snapshot.operationId !== id)
                  throw new OperationFault("ledger_incompatible");
                change(value);
                readRecord(value);
                store.put(value);
                done(value.snapshot);
              } catch (error) {
                fail(error);
              }
            };
          } catch (error) {
            fail(error);
          }
        };
      });
    const checkedObservation = (record: OperationRecord, observation: OperationObservation) => {
      const parsed = v.parse(observationSchema, observation);
      if ((record.snapshot.operation === "fields") !== "requested" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      if ((record.snapshot.operation === "upload") !== "filename" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      if ((record.snapshot.operation === "cover") !== "cover" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      if ((record.snapshot.operation === "save") !== "persistence" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      if (["new", "open"].includes(record.snapshot.operation) !== "navigation" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      if ((record.snapshot.operation === "maintenance") !== "maintenance" in parsed.effect)
        throw new OperationFault("evidence_conflict");
      return parsed;
    };
    const saveObservation = (record: OperationRecord, observation: OperationObservation) => {
      observation = checkedObservation(record, observation);
      const effect = mergeEffect(record.snapshot.effect, observation.effect, observation.ended);
      if (record.snapshot.state === "settled") {
        if (
          observation.ended &&
          (JSON.stringify(record.snapshot.result) !== JSON.stringify(observation.result) ||
            JSON.stringify(record.snapshot.effect) !== JSON.stringify(effect))
        )
          throw new OperationFault("evidence_conflict");
        return;
      }
      record.snapshot = v.parse(
        operationSnapshotSchema,
        observation.ended
          ? { ...record.snapshot, state: "settled", effect, result: observation.result }
          : {
              ...record.snapshot,
              state: "unresolved",
              effect,
              result:
                observation.result.status === "error"
                  ? observation.result
                  : { status: "error", error: { code: "operation_unresolved" } },
            },
      );
    };
    const operations: Operations = {
      ledgerId,
      async keyLedger() {
        try {
          const epoch = await transact<string>(db, ["meta"], "readonly", (tx, done, fail) => {
            const request = tx.objectStore("meta").get("ledger");
            request.onsuccess = () => {
              try {
                const meta = ownedMeta(request.result);
                done(meta.keyLedgerId);
              } catch (error) {
                fail(error);
              }
            };
          });
          return Result.ok(epoch);
        } catch (error) {
          return Result.err(issue(error));
        }
      },
      record,
      get,
      async maintenance(action) {
        if (maintenance || tasks.size)
          return Result.err(issue(new OperationFault("operation_blocked")));
        maintenance = true;
        try {
          const pending = await operations.pending();
          if (pending.isErr()) return Result.err(pending.error);
          if (pending.value.length)
            return Result.err(issue(new OperationFault("operation_blocked")));
          return Result.ok(await action());
        } catch (error) {
          return Result.err(issue(error));
        } finally {
          maintenance = false;
        }
      },
      async pending() {
        try {
          return Result.ok(
            await transact<OperationRecord[]>(
              db,
              ["meta", "operations"],
              "readonly",
              (tx, done, fail) => {
                const meta = tx.objectStore("meta").get("ledger");
                meta.onsuccess = () => {
                  try {
                    ownedMeta(meta.result);
                    const request = tx.objectStore("operations").getAll();
                    request.onsuccess = () => {
                      try {
                        done(
                          request.result
                            .map(checkedRecord)
                            .filter((record) => record.snapshot.state !== "settled"),
                        );
                      } catch (error) {
                        fail(error);
                      }
                    };
                  } catch (error) {
                    fail(error);
                  }
                };
              },
            ),
          );
        } catch (error) {
          return Result.err(issue(error));
        }
      },
      async observe(id, digest, binding, observation) {
        try {
          checkId(id);
          const target = v.safeParse(bindingSchema, binding);
          const evidence = v.safeParse(observationSchema, observation);
          if (!target.success || !evidence.success) throw new OperationFault("evidence_conflict");
          observation = evidence.output;
          const snapshot = await update(id, (record) => {
            if (
              record.requestDigest !== digest ||
              JSON.stringify(record.binding) !== JSON.stringify(target.output)
            )
              throw new OperationFault("evidence_conflict");
            observation = checkedObservation(record, observation);
            // Narrow native receipts cannot erase BG-owned first cause/cleanup.
            // Interruption placeholders may acquire the original native cause.
            if (
              (record.snapshot.operation === "cover" || record.snapshot.operation === "save") &&
              "result" in record.snapshot &&
              record.snapshot.result.status === "error"
            ) {
              const previous = record.snapshot.result.error;
              const incoming =
                observation.result.status === "error" ? observation.result.error : undefined;
              const placeholder =
                previous.code === "operation_unresolved" ||
                previous.code === "operation_interrupted";
              if (
                !placeholder &&
                incoming &&
                previous.cause?.at.startsWith("content.") &&
                previous.cause.at === incoming.cause?.at &&
                (previous.code !== incoming.code ||
                  JSON.stringify(previous.cause) !== JSON.stringify(incoming.cause))
              )
                throw new OperationFault("evidence_conflict");
              if (!placeholder)
                observation = {
                  ...observation,
                  result: {
                    status: "error",
                    error: {
                      ...previous,
                      ...(!previous.cause && previous.code === incoming?.code && incoming.cause
                        ? { cause: incoming.cause }
                        : {}),
                      ...((previous.cleanup ?? incoming?.cleanup)
                        ? { cleanup: previous.cleanup ?? incoming?.cleanup }
                        : {}),
                    },
                  },
                };
              else if (incoming && previous.cleanup)
                observation = {
                  ...observation,
                  result: { status: "error", error: { ...incoming, cleanup: previous.cleanup } },
                };
            }
            if (tasks.get(id)?.active && record.snapshot.state !== "settled") {
              record.snapshot = v.parse(operationSnapshotSchema, {
                ...record.snapshot,
                effect: mergeEffect(record.snapshot.effect, observation.effect, observation.ended),
              });
              return;
            }
            saveObservation(
              record,
              record.bgEffects === "pending" ? { ...observation, ended: false } : observation,
            );
          });
          return Result.ok({ snapshot });
        } catch (error) {
          const old = await get(id);
          const diagnostic = {
            ...issue(error, id),
            uncommitted: { effect: observation.effect, result: observation.result },
          };
          return old.isOk()
            ? Result.ok({ ...old.value, issue: diagnostic })
            : Result.err(diagnostic);
        }
      },
      run(request, work) {
        // Exact payload reservation precedes async digest and claim; mismatches never share a Promise.
        const parsed = v.safeParse(
          v.union([
            writeBodyInputSchema,
            updateFieldsInputSchema,
            assetUploadInputSchema,
            articleCoverSetInputSchema,
            articleSaveInputSchema,
            articleNewInputSchema,
            articleOpenInputSchema,
            maintenanceInputSchema,
          ]),
          request,
        );
        if (!parsed.success)
          return Promise.resolve(Result.err(issue(new OperationFault("invalid_operation"))));
        request = parsed.output;
        if (
          "blob" in request &&
          !v.safeParse(assetPayloadSchema, {
            blob: request.blob,
            filename: request.filename,
            mimeType: request.mimeType,
          }).success
        )
          return Promise.resolve(
            Result.err(issue(new OperationFault("invalid_asset"), request.operationId)),
          );
        const id = request.operationId;
        const target =
          "article" in request
            ? request.article
            : "candidate" in request
              ? request.candidate
              : null;
        const expectedHash = "expectedHash" in request ? request.expectedHash : null;
        let operation: OperationSnapshot["operation"];
        let initialEffect: OperationEffect;
        let values: unknown;
        let localDigest: () => Promise<string>;
        let uploadDigest: Promise<string> | undefined;
        switch (true) {
          case "blob" in request: {
            operation = "upload";
            initialEffect = { outcome: "not_dispatched", filename: request.filename };
            const payload = {
              blob: request.blob,
              filename: request.filename,
              mimeType: request.mimeType,
            };
            // Defer Blob adapters until after tasks.set below: reentrant reads must see the reservation.
            uploadDigest = Promise.resolve().then(() => assetRequestDigest(payload));
            localDigest = () => uploadDigest!;
            break;
          }
          case "fields" in request:
            operation = "fields";
            initialEffect = initialFieldsEffect(request.fields);
            values = fieldsRequestSignature(request.fields, request.expectedHash);
            localDigest = () => fieldsRequestDigest(request.fields, request.expectedHash);
            break;
          case "asset" in request:
            operation = "cover";
            initialEffect = { cover: true, outcome: "not_dispatched" };
            values = [request.asset, request.expectedCoverHash];
            localDigest = () => coverRequestDigest(request.asset, request.expectedCoverHash);
            break;
          case "bodyImage" in request:
            operation = "cover";
            initialEffect = { cover: true, outcome: "not_dispatched" };
            values = [request.bodyImage, request.expectedBodyHash, request.expectedCoverHash];
            localDigest = () => bodyCoverRequestDigest(request);
            break;
          case "expectedBodyHash" in request:
            operation = "save";
            initialEffect = { outcome: "not_dispatched", persistence: "unverified" };
            values = [
              request.expectedBodyHash,
              request.expectedFieldsHash,
              request.expectedCoverHash,
            ];
            localDigest = () => saveRequestDigest(request);
            break;
          case "html" in request:
            operation = "body";
            initialEffect = { outcome: "not_dispatched" };
            values = request.html;
            localDigest = () => bodyRequestDigest(request.html, request.expectedHash);
            break;
          default:
            operation =
              "maintenance" in request ? "maintenance" : "candidate" in request ? "open" : "new";
            initialEffect =
              operation === "maintenance"
                ? { maintenance: true, outcome: "not_dispatched" }
                : {
                    navigation: true,
                    outcome: "not_dispatched",
                    pageCreated: false,
                    auxiliaryCreated: [],
                    targetBound: false,
                  };
            values = "maintenance" in request ? request.maintenance : null;
            localDigest = () =>
              bodyRequestDigest(
                JSON.stringify([
                  operation,
                  "candidate" in request ? request.candidate : null,
                  values,
                ]),
                "0".repeat(64),
              );
        }
        const signature = uploadDigest
          ? uploadDigest.then((local) => JSON.stringify([operation, target, local]))
          : JSON.stringify([operation, target, values, expectedHash]);
        if (typeof signature !== "string") void signature.catch(() => undefined);
        const existing = tasks.get(id);
        if (existing) {
          if (typeof signature === "string" && typeof existing.signature === "string")
            return signature === existing.signature
              ? existing.promise
              : Promise.resolve(Result.err(issue(new OperationFault("operation_conflict"), id)));
          return Promise.all([existing.signature, signature]).then(
            ([old, next]) =>
              old === next
                ? existing.promise
                : Result.err(issue(new OperationFault("operation_conflict"), id)),
            () => Result.err(issue(new OperationFault("hash_failed"), id)),
          );
        }
        let resolve!: (result: Outcome<OperationReply, InteractionIssue>) => void;
        const task: Task = {
          signature,
          active: true,
          promise: new Promise((done) => {
            resolve = done;
          }),
        };
        tasks.set(id, task);
        void run().then(resolve, (error) => resolve(Result.err(issue(error, id))));
        return task.promise;
        async function run(): Promise<Outcome<OperationReply, InteractionIssue>> {
          let observation: OperationObservation | undefined;
          let consumed = false;
          let closed = false;
          let hashing = true;
          let acquired = false;
          let actionTask: Promise<OperationObservation> | undefined;
          try {
            checkId(id);
            const local = await localDigest();
            await signature;
            const digest = await bodyRequestDigest(
              JSON.stringify([operation, target, local]),
              expectedHash ?? "0".repeat(64),
            );
            hashing = false;
            const claimed = await transact<{ acquired: boolean; record: OperationRecord }>(
              db,
              ["meta", "operations"],
              "readwrite",
              (tx, done, fail) => {
                const store = tx.objectStore("operations");
                const meta = tx.objectStore("meta").get("ledger");
                meta.onsuccess = () => {
                  try {
                    const epoch = ownedMeta(meta.result);
                    const lookup = store.get(id);
                    lookup.onsuccess = () => {
                      try {
                        if (lookup.result) {
                          const value = checkedRecord(lookup.result);
                          if (value.snapshot.operationId !== id)
                            throw new OperationFault("ledger_incompatible");
                          if (value.requestDigest !== digest)
                            throw new OperationFault("operation_conflict");
                          done({ acquired: false, record: value });
                          return;
                        }
                        if (operationLedgerId(id) !== epoch.keyLedgerId)
                          throw new OperationFault("ledger_mismatch");
                        if (maintenance) throw new OperationFault("operation_blocked");
                        const value: OperationRecord = {
                          schemaVersion: 2,
                          ledgerId,
                          owner,
                          requestDigest: digest,
                          localRequestDigest: local,
                          snapshot: v.parse(operationSnapshotSchema, {
                            operationId: id,
                            operation,
                            state: "accepted",
                            effect: initialEffect,
                          }),
                        };
                        // Never forget a consumed key. Storage failures refuse
                        // the claim before any work or native action can run.
                        store.add(value);
                        done({ acquired: true, record: value });
                      } catch (error) {
                        fail(error);
                      }
                    };
                  } catch (error) {
                    fail(error);
                  }
                };
              },
            );
            if (!claimed.acquired) {
              task.active = false;
              return get(id);
            }
            acquired = true;
            const execution: Execution = {
              issue(binding, action) {
                if (closed) return Promise.reject(new OperationFault("execution_closed"));
                if (consumed) return Promise.reject(new OperationFault("execution_consumed"));
                consumed = true;
                actionTask = (async () => {
                  await update(id, (record) => {
                    if (
                      record.owner !== owner ||
                      record.requestDigest !== digest ||
                      record.snapshot.state !== "accepted"
                    )
                      throw new OperationFault("execution_closed");
                    if ("bg" in binding) {
                      record.navigationBinding = v.parse(navigationBindingSchema, binding);
                      if (record.navigationBinding.purpose !== operation)
                        throw new OperationFault("evidence_conflict");
                    } else record.binding = v.parse(bindingSchema, binding);
                    if (operation === "cover" || operation === "save")
                      record.bgEffects = "complete";
                    record.snapshot = { ...record.snapshot, state: "issued" };
                  });
                  return action();
                })();
                // Track even if work fails to await its one consumed action.
                void actionTask.catch(() => undefined);
                return actionTask;
              },
              async bindTarget(binding, evidence) {
                if (evidence) observation = evidence;
                await update(id, (record) => {
                  if (
                    closed ||
                    record.owner !== owner ||
                    record.snapshot.state !== "issued" ||
                    !record.navigationBinding
                  )
                    throw new OperationFault("execution_closed");
                  const target = v.parse(navigationTargetSchema, binding);
                  if (
                    record.navigationBinding.target &&
                    JSON.stringify(record.navigationBinding.target) !== JSON.stringify(target)
                  )
                    throw new OperationFault("evidence_conflict");
                  record.navigationBinding.target = target;
                  if (evidence) {
                    checkedObservation(record, evidence);
                    record.snapshot = v.parse(operationSnapshotSchema, {
                      ...record.snapshot,
                      effect: mergeEffect(record.snapshot.effect, evidence.effect, evidence.ended),
                    });
                  }
                });
              },
              async checkpoint(evidence) {
                // Capture before the transaction: an abort must not erase confirmation.
                observation = evidence;
                await update(id, (record) => {
                  if (
                    closed ||
                    record.owner !== owner ||
                    record.requestDigest !== digest ||
                    record.snapshot.state !== "issued"
                  )
                    throw new OperationFault("execution_closed");
                  checkedObservation(record, evidence);
                  record.snapshot = v.parse(operationSnapshotSchema, {
                    ...record.snapshot,
                    effect: mergeEffect(record.snapshot.effect, evidence.effect, evidence.ended),
                  });
                });
              },
            };
            try {
              observation =
                "blob" in request &&
                !(await validAssetSignature({
                  blob: request.blob,
                  filename: request.filename,
                  mimeType: request.mimeType,
                }))
                  ? {
                      effect: initialEffect,
                      ended: true,
                      result: {
                        status: "error",
                        error: {
                          code: "invalid_asset",
                          cause: { at: "bg.preflight", kind: "domain", code: "signature_mismatch" },
                        },
                      },
                    }
                  : await work(execution);
            } finally {
              closed = true;
            }
            if (actionTask) observation = await actionTask;
            if (!consumed && observation.effect.outcome !== "not_dispatched")
              throw new OperationFault("evidence_conflict");
            const snapshot = await update(id, (record) => {
              if (record.owner !== owner || record.requestDigest !== digest)
                throw new OperationFault("execution_closed");
              saveObservation(record, observation!);
            });
            return Result.ok({ snapshot });
          } catch (error) {
            closed = true;
            if (hashing && !(error instanceof OperationFault))
              return Result.err(
                issue(
                  new OperationFault(v.isValiError(error) ? "invalid_asset" : "hash_failed"),
                  id,
                ),
              );
            if (!acquired) return Result.err(issue(error, id));
            if (actionTask) {
              try {
                observation = await actionTask;
              } catch {
                /* permission failure / action failure */
              }
            }
            let old = await get(id);
            if (old.isErr())
              return Result.err({
                ...issue(error, id),
                ...(observation
                  ? { uncommitted: { effect: observation.effect, result: observation.result } }
                  : {}),
              });
            if (!observation && old.value.snapshot.state === "accepted") {
              const persistence =
                error instanceof OperationFault && error.code === "storage_failed";
              observation = {
                ...errorObservation(
                  persistence
                    ? "operation_interrupted"
                    : error instanceof OperationFault
                      ? error.code
                      : "page_failed",
                ),
                effect: initialEffect,
              };
              try {
                const snapshot = await update(id, (record) => {
                  if (record.owner !== owner) throw new OperationFault("execution_closed");
                  saveObservation(record, observation!);
                });
                return Result.ok({ snapshot, ...(persistence ? { issue: issue(error, id) } : {}) });
              } catch {
                /* retain old committed fact */
              }
            }
            if (old.value.snapshot.state === "issued") {
              try {
                const snapshot = await update(id, (record) => {
                  if (record.owner !== owner || record.snapshot.state !== "issued") return;
                  record.snapshot = v.parse(operationSnapshotSchema, {
                    ...record.snapshot,
                    state: "unresolved",
                    effect:
                      !observation && record.snapshot.effect.outcome === "not_dispatched"
                        ? { ...record.snapshot.effect, outcome: "unknown" }
                        : record.snapshot.effect,
                    result: { status: "error", error: { code: "operation_unresolved" } },
                  });
                });
                old = Result.ok({ snapshot });
              } catch {
                /* retain the last committed issued fact and the persistence diagnostic */
              }
            }
            return Result.ok({
              ...old.value,
              issue: {
                ...issue(error, id),
                ...(observation
                  ? { uncommitted: { effect: observation.effect, result: observation.result } }
                  : {}),
              },
            });
          } finally {
            task.active = false;
            if (tasks.get(id) === task) tasks.delete(id);
          }
        }
      },
    };
    return Result.ok(operations);
  } catch (error) {
    openedDb?.close();
    return Result.err(issue(error));
  }
}
