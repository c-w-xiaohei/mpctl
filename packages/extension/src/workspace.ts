import { Result } from "better-result";
import { NexusError } from "@nexus-js/core";
import {
  articleResultCodec,
  articleFieldsResultCodec,
  articleCheckResultCodec,
  articleCoverResultCodec,
  articleCoverSetInputSchema,
  articleSaveInputSchema,
  assetListResultCodec,
  assetPayloadSchema,
  assetRequestDigest,
  assetUploadInputSchema,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  type ArticleResult,
  type WorkspaceService,
  type WorkspaceWireResult,
  writeBodyInputSchema,
  operationResultCodec,
  updateFieldsInputSchema,
  type Failure,
  type OperationWireResult,
  articleNewInputSchema,
  articleOpenInputSchema,
  articleCurrentInputSchema,
  createOperationId,
  type ArticleNewInput,
  type ArticleOpenInput,
  type NavigationEffect,
} from "@mpctl/contracts";
import type { ArticleNavigationStage } from "@mpctl/contracts";
import {
  classifyAppmsgUrl,
  appmsgRouteIdentity,
  type PageBinding,
  type NavigationProgress,
  type createPageManager,
} from "./pages";
import { hashBody } from "./mp/body-hash";
import { hashArticleFields } from "./mp/article-fields";
import { initialFieldsEffect, type FieldsObservation } from "./mp/article-fields";
import {
  fieldsRequestDigest,
  coverRequestDigest,
  bodyCoverRequestDigest,
  saveRequestDigest,
} from "./background-contracts";
import { checkArticle } from "./mp/article-check";
import * as v from "valibot";
import { bodyRequestDigest } from "./page-contracts";
import {
  createOperations,
  type Operations,
  type BodyObservation,
  type OperationTarget,
  type OperationObservation,
} from "./operations";

type Pages = ReturnType<typeof createPageManager>;
type Binding = PageBinding;
type ArticleBinding = { binding: Binding; groupId?: string };
function materialFingerprint(
  binding: Binding,
  card: { filename: string; thumbnailUrl?: string },
): string {
  return JSON.stringify([
    binding.tabId,
    binding.documentId,
    card.filename,
    card.thumbnailUrl ?? null,
  ]);
}
type FailureCode =
  | "target_unavailable"
  | "target_ambiguous"
  | "content_conflict"
  | "not_logged_in"
  | "page_failed"
  | "write_unknown"
  | "invalid_fields"
  | "field_update_unknown"
  | "invalid_asset"
  | "asset_upload_unknown"
  | "asset_ambiguous"
  | "asset_too_large"
  | "asset_list_failed"
  | "cleanup_failed"
  | "dialog_unavailable"
  | "library_open_unknown"
  | "invalid_payload"
  | "unsupported"
  | "cover_unavailable"
  | "cover_input_unavailable"
  | "cover_update_unknown"
  | "save_control_unavailable"
  | "history_unavailable"
  | "save_unknown";
type ObservedFailure = { kind: "domain" | "nexus" | "protocol" | "runtime"; causeCode: string };
type ValidationError = import("@mpctl/contracts").ServiceError<
  import("@mpctl/contracts").WorkspaceError
> & { observedFailure?: ObservedFailure };
type ValidationResult = import("better-result").Result<void, ValidationError>;
const fail = <T>(
  code: FailureCode,
  facts?: {
    cleanupFailed?: true;
    baselineHash?: string;
    readFailure?: import("@mpctl/contracts").ReadFailure;
  },
): import("@mpctl/contracts").WorkspaceResult<T> =>
  Result.err({
    code,
    ...facts,
  });

const ok = <T>(value: T): import("@mpctl/contracts").WorkspaceResult<T> => Result.ok(value);

async function encodeWorkspace<T>(
  codec: {
    serialize(
      value: import("@mpctl/contracts").WorkspaceResult<T>,
    ): Promise<
      import("better-result").Result<WorkspaceWireResult<T>, { code: "invalid_result_envelope" }>
    >;
  },
  result: import("@mpctl/contracts").WorkspaceResult<T>,
): Promise<WorkspaceWireResult<T>> {
  // Local admission/Nexus observations are not extra read wire fields. Mutations
  // convert them once into Failure at the business boundary instead.
  const wireResult = Result.mapError(result, (error: ValidationError) => {
    const { observedFailure: _observedFailure, ...wireError } = error;
    return wireError;
  });
  const encoded = await codec.serialize(wireResult);
  return Result.isError(encoded)
    ? { status: "error" as const, error: encoded.error }
    : encoded.value;
}

function observedFailure(error: unknown): ObservedFailure {
  return {
    kind: error instanceof NexusError ? "nexus" : "runtime",
    causeCode: error instanceof NexusError ? error.code : "unexpected_exception",
  };
}

export function createWorkspace({
  pages,
  operations: configuredOperations,
}: {
  pages: Pages;
  operations?: Promise<Result<Operations, import("@mpctl/contracts").InteractionIssue>>;
}): WorkspaceService {
  let operations = configuredOperations;
  const ledger = () => (operations ??= createOperations());
  const encodeOperation = async (
    result: Parameters<typeof operationResultCodec.serialize>[0],
  ): Promise<OperationWireResult> => (await operationResultCodec.serialize(result)).unwrap();
  const bodyError = (code: Failure["code"]): BodyObservation => ({
    effect: { outcome: "not_dispatched" },
    ended: true,
    result: { status: "error", error: { code } },
  });
  const bodyBoundaryError = (
    error: {
      code: string;
      observedFailure?: ObservedFailure;
      readFailure?: import("@mpctl/contracts").ReadFailure;
    },
    at: NonNullable<Failure["cause"]>["at"],
  ): BodyObservation => {
    const code: Failure["code"] =
      error.code === "not_logged_in" ||
      error.code === "content_conflict" ||
      error.code === "target_unavailable" ||
      error.code === "target_ambiguous" ||
      error.code === "cover_unavailable" ||
      error.code === "hash_failed" ||
      error.code === "invalid_result_envelope"
        ? error.code
        : "page_failed";
    const observed =
      error.observedFailure ??
      (error.readFailure
        ? { kind: error.readFailure.kind, causeCode: error.readFailure.causeCode }
        : { kind: "domain" as const, causeCode: error.code });
    return {
      ...bodyError(code),
      result: {
        status: "error",
        error: { code, cause: { at, kind: observed.kind, code: observed.causeCode } },
      },
    };
  };
  const admissionError = (
    failure: Failure,
  ): Extract<WorkspaceWireResult<never>, { status: "error" }> => ({
    status: "error" as const,
    error: {
      code:
        failure.code === "operation_blocked" || failure.code === "relationship_unknown"
          ? failure.code
          : "storage_failed",
      ...(failure.blockingOperationId ? { blockingOperationId: failure.blockingOperationId } : {}),
    },
  });
  const activeWrites = new Map<string, { reference: ArticleBinding; sharedUi: boolean }>();
  // Admission reservations, not a second operation state machine. The ledger
  // retains unresolved owners after these live callbacks have actually stopped.
  const activeNavigation = new Map<string, ArticleBinding | undefined>();
  const sameTarget = (
    target: { tabId: number; documentId?: string; groupId?: string },
    candidate: ArticleBinding,
    durable = false,
  ) =>
    target.tabId === candidate.binding.tabId ||
    (durable && target.documentId === candidate.binding.documentId) ||
    !!(target.groupId && target.groupId === candidate.groupId);
  const sameAccount = (left: ArticleBinding, right: ArticleBinding) => {
    const context = new URL(left.binding.url).searchParams.get("token");
    return !!context && context === new URL(right.binding.url).searchParams.get("token");
  };
  const independentDurableTarget = async (
    target: { groupId?: string; contextDigest?: string },
    candidate: ArticleBinding,
  ) => {
    const context = new URL(candidate.binding.url).searchParams.get("token");
    return !!(
      target.groupId &&
      candidate.groupId &&
      target.groupId !== candidate.groupId &&
      context &&
      target.contextDigest === (await bodyRequestDigest(context, "0".repeat(64))) &&
      (await validate(candidate)).isOk()
    );
  };
  const conflict = async (
    candidate?: ArticleBinding,
    ownId?: string,
    sharedUi = false,
  ): Promise<Failure | undefined> => {
    const initialized = await ledger();
    if (initialized.isErr()) return initialized.error.failure;
    const records = await initialized.value.pending();
    if (records.isErr()) return records.error.failure;
    // Report a proven same-target blocker before broader, unbound reservations.
    // The latter must still protect candidates whose relationship is unknown.
    if (candidate) {
      const blocker = records.value.find((record) => {
        if (record.snapshot.operationId === ownId || record.snapshot.state === "accepted")
          return false;
        const target = record.binding ?? record.navigationBinding?.target;
        return target && sameTarget(target, candidate, true);
      });
      if (blocker)
        return { code: "operation_blocked", blockingOperationId: blocker.snapshot.operationId };
    }
    for (const [id, target] of activeNavigation) {
      if (id === ownId) continue;
      if (
        ownId &&
        activeNavigation.has(ownId) &&
        [...activeNavigation.keys()].indexOf(id) > [...activeNavigation.keys()].indexOf(ownId)
      )
        continue;
      if (!candidate || !target) return { code: "relationship_unknown", blockingOperationId: id };
      if (sameTarget({ ...target.binding, groupId: target.groupId }, candidate))
        return { code: "operation_blocked", blockingOperationId: id };
      if (
        !sharedUi &&
        target.groupId &&
        candidate.groupId &&
        sameAccount(target, candidate) &&
        (await validate(candidate)).isOk()
      )
        continue;
      return { code: "relationship_unknown", blockingOperationId: id };
    }
    for (const [id, entry] of activeWrites) {
      const active = entry.reference;
      if (id === ownId) continue;
      // A queued successor must not refuse the owner ahead of it on this document.
      if (
        ownId &&
        candidate &&
        active.binding.documentId === candidate.binding.documentId &&
        [...activeWrites.keys()].indexOf(id) > [...activeWrites.keys()].indexOf(ownId)
      )
        continue;
      if (!candidate || sameTarget({ ...active.binding, groupId: active.groupId }, candidate))
        return { code: "operation_blocked", blockingOperationId: id };
      if (
        sharedUi ||
        entry.sharedUi ||
        !active.groupId ||
        !candidate.groupId ||
        !sameAccount(active, candidate)
      )
        return { code: "relationship_unknown", blockingOperationId: id };
    }
    for (const record of records.value) {
      if (record.snapshot.operationId === ownId) continue;
      if (record.snapshot.state === "accepted" && activeNavigation.has(record.snapshot.operationId))
        continue;
      if (!record.binding) {
        // Active document writers were already compared above, including queue ownership.
        if (record.snapshot.state === "accepted" && activeWrites.has(record.snapshot.operationId))
          continue;
        const target = record.navigationBinding?.target;
        if (!candidate || !target)
          return { code: "relationship_unknown", blockingOperationId: record.snapshot.operationId };
        if (sameTarget(target, candidate, true))
          return { code: "operation_blocked", blockingOperationId: record.snapshot.operationId };
        if (
          !sharedUi &&
          record.snapshot.operation !== "maintenance" &&
          (await independentDurableTarget(target, candidate))
        )
          continue;
        return { code: "relationship_unknown", blockingOperationId: record.snapshot.operationId };
      }
      if (
        ownId &&
        record.snapshot.state === "accepted" &&
        [...activeWrites.keys()].indexOf(record.snapshot.operationId) >
          [...activeWrites.keys()].indexOf(ownId)
      )
        continue;
      const old = record.binding;
      if (!candidate)
        return { code: "operation_blocked", blockingOperationId: record.snapshot.operationId };
      if (sameTarget(old, candidate, true))
        return { code: "operation_blocked", blockingOperationId: record.snapshot.operationId };
      // Distinct validated managed saved articles in the same observed account context are independent.
      if (
        !sharedUi &&
        record.snapshot.operation !== "upload" &&
        record.snapshot.operation !== "cover" &&
        record.snapshot.operation !== "save" &&
        (await independentDurableTarget(old, candidate))
      )
        continue;
      return { code: "relationship_unknown", blockingOperationId: record.snapshot.operationId };
    }
  };
  const references = new Map<string, ArticleBinding>();
  const documentQueues = new Map<string, Promise<void>>();
  const queueDocument = (binding: Binding) => {
    const key = `${binding.tabId}:${binding.documentId}`;
    const previous = documentQueues.get(key) ?? Promise.resolve();
    let done!: () => void;
    const held = new Promise<void>((resolve) => {
      done = resolve;
    });
    const tail = previous.then(() => held);
    documentQueues.set(key, tail);
    return {
      previous,
      release() {
        done();
        if (documentQueues.get(key) === tail) documentQueues.delete(key);
      },
    };
  };
  const operationTarget = async (
    reference: ArticleBinding,
    executorId: string,
  ): Promise<OperationTarget> => {
    const context = new URL(reference.binding.url).searchParams.get("token");
    return {
      tabId: reference.binding.tabId,
      documentId: reference.binding.documentId,
      route: appmsgRouteIdentity(reference.binding.url)!,
      executorId,
      ...(reference.groupId ? { groupId: reference.groupId } : {}),
      ...(context ? { contextDigest: await bodyRequestDigest(context, "0".repeat(64)) } : {}),
    };
  };
  const matchesReceipt = (
    receipt: { operationId: string; executorId: string; requestDigest: string },
    id: string,
    target: OperationTarget,
    digest: string,
  ) =>
    receipt.operationId === id &&
    receipt.executorId === target.executorId &&
    receipt.requestDigest === digest;
  const receiptObservation = <T extends OperationObservation["effect"]>(receipt: {
    effect: T;
    ended: boolean;
    result?: OperationObservation["result"];
  }) => ({
    effect: receipt.effect,
    ended: receipt.ended,
    result: receipt.result ?? {
      status: "error" as const,
      error: { code: "operation_unresolved" as const },
    },
  });
  const assetReferences = new Map<
    string,
    { article: string; binding: Binding; filename: string; thumbnailUrl?: string }
  >();
  const remember = (
    binding: Binding,
    title: string,
    bodyHash: string,
    groupId?: string,
  ): import("@mpctl/contracts").WorkspaceResult<ArticleResult> => {
    const article = `ephemeral:${crypto.randomUUID()}`;
    for (const [asset, candidate] of assetReferences)
      if (candidate.binding.documentId !== binding.documentId) assetReferences.delete(asset);
    references.set(article, {
      binding,
      ...(groupId ? { groupId } : {}),
    });
    return ok({ article, title, bodyHash });
  };
  const pageFailure = (error: { code: string }): FailureCode => {
    switch (error.code) {
      case "navigation_failed":
        return "target_unavailable";
      case "target_unavailable":
      case "target_ambiguous":
      case "not_logged_in":
      case "cover_unavailable":
      case "asset_ambiguous":
      case "asset_upload_unknown":
      case "asset_too_large":
      case "asset_list_failed":
      case "cleanup_failed":
      case "dialog_unavailable":
      case "library_open_unknown":
      case "invalid_payload":
        return error.code;
      default:
        return "page_failed";
    }
  };
  const pageFailureResult = <T>(error: {
    code: string;
    readFailure?: import("@mpctl/contracts").ReadFailure;
    cleanupFailed?: true;
    baselineHash?: string;
  }): import("@mpctl/contracts").WorkspaceResult<T> =>
    fail(pageFailure(error), {
      ...(error.readFailure ? { readFailure: error.readFailure } : {}),
      ...(error.cleanupFailed ? { cleanupFailed: true } : {}),
      ...(error.baselineHash ? { baselineHash: error.baselineHash } : {}),
    });
  const validationFailure = (error: {
    code: string;
    observedFailure?: ObservedFailure;
  }): ValidationResult =>
    Result.err({
      code: pageFailure(error),
      observedFailure: error.observedFailure ?? { kind: "domain", causeCode: error.code },
    });
  const validate = async (reference: ArticleBinding): Promise<ValidationResult> => {
    const checked = await Result.tryPromise({
      try: async (): Promise<ValidationResult> => {
        const current = await pages.isCurrent(reference.binding);
        if (Result.isError(current)) return validationFailure(current.error);
        if (!current.value) return fail("target_unavailable");
        if (reference.groupId) {
          const saved = await pages.validateSavedArticle(reference.binding, reference.groupId);
          if (Result.isError(saved)) return validationFailure(saved.error);
          if (!saved.value.valid) return fail("target_unavailable");
        }
        const status = await pages.pageStatus(reference.binding);
        if (Result.isError(status)) return validationFailure(status.error);
        const stillCurrent = await pages.isCurrent(reference.binding);
        if (Result.isError(stillCurrent)) return validationFailure(stillCurrent.error);
        if (!stillCurrent.value) return fail("target_unavailable");
        if (status.value.state === "not_logged_in") return fail("not_logged_in");
        if (status.value.state !== "ready") return fail("page_failed");
        return Result.ok(undefined);
      },
      catch: (error): ValidationError => ({
        code: "page_failed",
        observedFailure: observedFailure(error),
      }),
    });
    return Result.isError(checked) ? Result.err(checked.error) : checked.value;
  };
  const navigationTracking = (onUncertain: (code: string, dispatchFailure?: boolean) => void) => {
    const navigatingTabs = new Set<number>();
    const reloads = new Set<{ tabId: number; documentId?: string; url: string }>();
    return {
      navigatingTabs,
      reloads,
      progress: {
        async dispatch<T>(code: string, action: () => Promise<T>) {
          try {
            return await action();
          } catch (error) {
            onUncertain(code, true);
            throw error;
          }
        },
        uncertain(code: string) {
          onUncertain(code);
        },
        tabRemoved(tabId: number) {
          navigatingTabs.delete(tabId);
        },
        sourceReady(binding?: PageBinding) {
          if (binding) navigatingTabs.delete(binding.tabId);
        },
        reloading(source: { tabId: number; documentId?: string; url: string }) {
          const attempt = { ...source };
          reloads.add(attempt);
          return (completed: PageBinding) => {
            if (
              source.documentId &&
              completed.tabId === source.tabId &&
              completed.documentId !== source.documentId &&
              appmsgRouteIdentity(completed.url) === appmsgRouteIdentity(source.url)
            )
              reloads.delete(attempt);
          };
        },
      },
    };
  };
  const navigation = async (
    input: ArticleNewInput | ArticleOpenInput,
  ): Promise<OperationWireResult> => {
    const initialized = await ledger();
    if (initialized.isErr()) return encodeOperation(initialized);
    let owns = false;
    const result = await initialized.value.run(input, async (execution) => {
      activeNavigation.set(input.operationId, undefined);
      owns = true;
      let effect: NavigationEffect = {
        navigation: true,
        outcome: "not_dispatched",
        pageCreated: false,
        auxiliaryCreated: [],
        targetBound: false,
      };
      let uncertain: string | undefined;
      let dispatchFailure: string | undefined;
      const tracking = navigationTracking((code, dispatch) => {
        uncertain ??= code;
        if (dispatch) dispatchFailure ??= code;
      });
      const { navigatingTabs, reloads } = tracking;
      const observation = (failure?: Failure): OperationObservation => ({
        effect,
        ended: !uncertain && navigatingTabs.size === 0 && reloads.size === 0,
        result: failure
          ? { status: "error", error: failure }
          : uncertain || reloads.size || navigatingTabs.size
            ? {
                status: "error",
                error: {
                  code: "operation_unresolved",
                  cause: {
                    at: "bg.navigation",
                    kind: "domain",
                    code: uncertain ?? "source_reload_end_unverified",
                  },
                },
              }
            : { status: "ok", value: {} },
      });
      let existing: PageBinding | undefined;
      if ("candidate" in input) {
        const found = await pages.findCurrentEditor({ candidate: input.candidate });
        if (found.isErr() && found.error.code === "target_ambiguous")
          return {
            ...observation(),
            result: bodyBoundaryError(found.error, "bg.preflight").result,
          };
        if (found.isOk()) existing = found.value;
      }
      const blocked = await conflict(
        existing && "candidate" in input
          ? { binding: existing, groupId: input.candidate }
          : undefined,
        input.operationId,
      );
      if (blocked) return observation(blocked);
      return execution.issue(
        {
          bg: true,
          purpose: "candidate" in input ? "open" : "new",
          ...("candidate" in input ? { candidate: input.candidate } : {}),
        },
        async () => {
          effect = { ...effect, outcome: "unknown" };
          const progress: NavigationProgress = {
            ...tracking.progress,
            async created(role, tabId) {
              if (tabId !== undefined) navigatingTabs.add(tabId);
              effect =
                role === "editor"
                  ? { ...effect, pageCreated: true }
                  : {
                      ...effect,
                      auxiliaryCreated: [...new Set([...effect.auxiliaryCreated, role])],
                    };
              await execution.checkpoint({
                ...observation({ code: "operation_unresolved" }),
                ended: false,
              });
            },
            async bound(binding) {
              const context = new URL(binding.url).searchParams.get("token");
              effect = { ...effect, targetBound: true };
              await execution.bindTarget(
                {
                  tabId: binding.tabId,
                  documentId: binding.documentId,
                  route: appmsgRouteIdentity(binding.url)!,
                  ...("candidate" in input ? { groupId: input.candidate } : {}),
                  ...(context
                    ? { contextDigest: await bodyRequestDigest(context, "0".repeat(64)) }
                    : {}),
                },
                { ...observation({ code: "operation_unresolved" }), ended: false },
              );
              navigatingTabs.delete(binding.tabId);
              activeNavigation.set(input.operationId, {
                binding,
                ...("candidate" in input ? { groupId: input.candidate } : {}),
              });
            },
          };
          const stopObserving = pages.observeNavigation?.(progress);
          try {
            const refused = (error: {
              code: string;
              stage?: ArticleNavigationStage;
              readFailure?: import("@mpctl/contracts").ReadFailure;
              observedFailure?: ObservedFailure;
            }): OperationObservation => {
              const original = bodyBoundaryError(error, "bg.navigation").result;
              const failure: Failure =
                original.status === "error" ? original.error : { code: "page_failed" };
              return observation({
                ...failure,
                ...(error.stage && !error.observedFailure && !error.readFailure
                  ? { cause: { at: "bg.navigation", kind: "domain", code: error.stage } }
                  : {}),
                ...(uncertain && !failure.cause
                  ? { cause: { at: "bg.navigation", kind: "runtime", code: uncertain } }
                  : {}),
                ...(dispatchFailure && failure.cause?.code === "unexpected_exception"
                  ? {
                      cause: {
                        at: "bg.navigation",
                        kind: "runtime",
                        code: `${dispatchFailure}_failed`,
                      },
                    }
                  : {}),
              });
            };
            let binding: PageBinding;
            if (existing) {
              const status = await pages.pageStatus(existing);
              if (status.isErr()) return refused(status.error);
              if (status.value.state === "not_logged_in") existing = undefined;
            }
            if (existing) {
              const source = await pages.findDraftList();
              if (source.isErr()) return refused(source.error);
              if (source.value && "candidate" in input) {
                const sourceContext = new URL(source.value.url).searchParams.get("token");
                const targetContext = new URL(existing.url).searchParams.get("token");
                if (sourceContext && targetContext && sourceContext !== targetContext)
                  return observation({ code: "relationship_unknown" });
                const candidates = await pages.listDraftGroups(source.value);
                if (candidates.isErr()) return refused(candidates.error);
                if (
                  candidates.value.filter((draft) => draft.groupId === input.candidate).length !== 1
                )
                  return observation({ code: "target_unavailable" });
              }
              binding = existing;
              await progress.bound(binding);
            } else if ("candidate" in input) {
              const list = await pages.ensureDraftList({}, progress);
              if (list.isErr()) return refused(list.error);
              const groups = await pages.listDraftGroups(list.value);
              if (groups.isErr()) return refused(groups.error);
              if (groups.value.filter((group) => group.groupId === input.candidate).length !== 1)
                return observation({ code: "target_unavailable" });
              const opened = await pages.openDraftGroup(list.value, input.candidate, progress);
              if (opened.isErr()) return refused(opened.error);
              if (!opened.value) return observation({ code: "target_unavailable" });
              binding = opened.value;
            } else {
              const opened = await pages.ensureEditorTab(progress);
              if (opened.isErr()) return refused(opened.error);
              binding = opened.value;
              if (classifyAppmsgUrl(binding.url).kind !== "new")
                return observation({ code: "target_unavailable" });
            }
            // The actual page owner reports binding even when reused. Never infer creation from success.
            if (!effect.targetBound) await progress.bound(binding);
            const reference = {
              binding,
              ...("candidate" in input ? { groupId: input.candidate } : {}),
            };
            const valid = await validate(reference);
            if (valid.isErr()) return refused(valid.error);
            const editor = await pages.open(binding);
            if (editor.isErr()) return refused(editor.error);
            const readiness = await editor.value.ready();
            if (readiness.isErr()) return refused(readiness.error);
            if (!readiness.value.isReady || !readiness.value.isNew)
              return refused({ code: "page_failed", stage: "editor_bootstrap_failed" });
            const content = await editor.value.getContent();
            if (content.isErr()) return refused(content.error);
            const hash = await hashBody(content.value);
            if (hash.isErr()) return observation({ code: "hash_failed" });
            const final = await validate(reference);
            if (final.isErr()) return refused(final.error);
            effect = { ...effect, outcome: "confirmed", bodyHash: hash.value };
            return observation();
          } finally {
            stopObserving?.();
          }
        },
      );
    });
    if (owns) activeNavigation.delete(input.operationId);
    return encodeOperation(result);
  };
  const maintain = async <T>(
    purpose: "article-list" | "asset-list" | "workspace-cleanup",
    action: (progress: NavigationProgress) => Promise<WorkspaceWireResult<T>>,
    reference?: ArticleBinding,
  ): Promise<WorkspaceWireResult<T>> => {
    const initialized = await ledger();
    if (initialized.isErr())
      return { status: "error", error: { code: "storage_failed", issue: initialized.error } };
    const epoch = await initialized.value.keyLedger();
    if (epoch.isErr())
      return { status: "error", error: { code: "storage_failed", issue: epoch.error } };
    const operationId = createOperationId(epoch.value);
    let output: WorkspaceWireResult<T> | undefined;
    const run = await initialized.value.run(
      { operationId, maintenance: purpose },
      async (execution) => {
        activeNavigation.set(operationId, undefined);
        const blocked = await conflict(reference, operationId, purpose === "asset-list");
        if (blocked)
          return {
            effect: { maintenance: true, outcome: "not_dispatched" },
            ended: true,
            result: { status: "error", error: blocked },
          };
        return execution.issue({ bg: true, purpose: "maintenance" }, async () => {
          if (reference) {
            const context = new URL(reference.binding.url).searchParams.get("token");
            await execution.bindTarget({
              tabId: reference.binding.tabId,
              documentId: reference.binding.documentId,
              route: appmsgRouteIdentity(reference.binding.url)!,
              ...(reference.groupId ? { groupId: reference.groupId } : {}),
              ...(context
                ? { contextDigest: await bodyRequestDigest(context, "0".repeat(64)) }
                : {}),
            });
          }
          let uncertain = false;
          const tracking = navigationTracking(() => {
            uncertain = true;
          });
          const { reloads, navigatingTabs } = tracking;
          let failure: Failure | undefined;
          let dialogEnded = false;
          let dialogDispatched = false;
          let effect: import("@mpctl/contracts").MaintenanceEffect = {
            maintenance: true,
            outcome: "unknown",
            auxiliaryCreated: [],
            placements: 0,
          };
          const checkpoint = () =>
            execution.checkpoint({
              effect,
              ended: false,
              result: { status: "error", error: { code: "operation_unresolved" } },
            });
          const progress: NavigationProgress = {
            ...tracking.progress,
            async created(role, tabId) {
              if (tabId !== undefined) navigatingTabs.add(tabId);
              if (role !== "editor")
                effect = {
                  ...effect,
                  auxiliaryCreated: [...new Set([...(effect.auxiliaryCreated ?? []), role])],
                };
              await checkpoint();
            },
            async placed() {
              effect = { ...effect, placements: (effect.placements ?? 0) + 1 };
              await checkpoint();
            },
            async bound() {},
            dialogEnded() {
              dialogEnded = true;
            },
            materialInvoked() {
              dialogDispatched = true;
            },
            failed(error) {
              if (error.ended !== undefined) dialogEnded = error.ended;
              const observed = bodyBoundaryError(error, "bg.navigation").result;
              if (error.failure) failure ??= error.failure;
              else if (observed.status === "error")
                failure ??= {
                  ...observed.error,
                  ...(error.stage && !error.observedFailure && !error.readFailure
                    ? { cause: { at: "bg.navigation", kind: "domain", code: error.stage } }
                    : {}),
                };
              if (error.cleanupFailed && failure && !failure.cleanup)
                failure = {
                  ...failure,
                  cleanup: {
                    at: "content.library_cleanup",
                    kind: "domain",
                    code: "cleanup_failed",
                  },
                };
            },
          };
          const stopObserving = pages.observeNavigation?.(progress);
          try {
            if (purpose === "asset-list") {
              const valid = reference
                ? await validate(reference)
                : Result.err({ code: "target_unavailable" as const });
              if (valid.isErr()) {
                progress.failed?.(valid.error);
                output = { status: "error", error: { code: pageFailure(valid.error) } };
              } else {
                output = await action(progress);
              }
            } else output = await action(progress);
            // A lost dialog reply does not prove that opening/owned cleanup stopped.
            if (dialogDispatched && output.status === "error" && !dialogEnded) uncertain = true;
            return {
              effect: {
                ...effect,
                outcome:
                  output.status === "ok"
                    ? "confirmed"
                    : purpose === "asset-list" && !dialogDispatched
                      ? "not_dispatched"
                      : "unknown",
              },
              ended: !uncertain && reloads.size === 0 && navigatingTabs.size === 0,
              result:
                output.status === "ok"
                  ? { status: "ok", value: {} }
                  : {
                      status: "error",
                      error: failure ?? {
                        code: "page_failed",
                        cause: { at: "bg.navigation", kind: "domain", code: output.error.code },
                      },
                    },
            };
          } finally {
            stopObserving?.();
          }
        });
      },
    );
    activeNavigation.delete(operationId);
    if (run.isErr())
      return {
        status: "error",
        error: { code: "storage_failed", issue: run.error },
      };
    if (run.value.issue)
      return {
        status: "error",
        error: { code: "storage_failed", snapshot: run.value.snapshot, issue: run.value.issue },
      };
    if (output) {
      const snapshot = run.value.snapshot;
      if (output.status === "error")
        return {
          status: "error",
          error:
            output.error.code === "invalid_result_envelope"
              ? { code: "page_failed", snapshot }
              : { ...output.error, snapshot },
        };
      return output;
    }
    const refused = admissionError(
      "result" in run.value.snapshot && run.value.snapshot.result.status === "error"
        ? run.value.snapshot.result.error
        : { code: "operation_unresolved" },
    );
    return {
      status: "error",
      error: {
        ...refused.error,
        code: refused.error.code === "invalid_result_envelope" ? "page_failed" : refused.error.code,
        snapshot: run.value.snapshot,
      },
    };
  };
  const service: WorkspaceService = {
    async cleanupWorkspace() {
      return maintain("workspace-cleanup", async (progress) => {
        const cleaned = await pages.cleanupWorkspace(progress);
        if (cleaned.isErr()) progress.failed?.(cleaned.error);
        return encodeWorkspace(
          cleanupWorkspaceResultCodec,
          Result.isError(cleaned) ? fail(pageFailure(cleaned.error)) : ok(cleaned.value),
        );
      });
    },
    async listArticles() {
      return maintain("article-list", async (progress) => {
        const list = await pages.ensureDraftList({ refresh: true }, progress);
        if (list.isErr()) progress.failed?.(list.error);
        if (Result.isError(list))
          return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(list.error)));
        const current = await pages.isCurrent(list.value);
        if (current.isErr()) progress.failed?.(current.error);
        if (Result.isError(current))
          return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(current.error)));
        if (!current.value)
          return encodeWorkspace(listArticlesResultCodec, fail("target_unavailable"));
        const groups = await pages.listDraftGroups(list.value);
        if (groups.isErr()) progress.failed?.(groups.error);
        if (Result.isError(groups))
          return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(groups.error)));
        const currentAfterRead = await pages.isCurrent(list.value);
        if (currentAfterRead.isErr()) progress.failed?.(currentAfterRead.error);
        if (Result.isError(currentAfterRead))
          return encodeWorkspace(
            listArticlesResultCodec,
            fail(pageFailure(currentAfterRead.error)),
          );
        if (!currentAfterRead.value)
          return encodeWorkspace(listArticlesResultCodec, fail("target_unavailable"));
        const counts = new Map<string, number>();
        for (const group of groups.value)
          counts.set(group.groupId, (counts.get(group.groupId) ?? 0) + 1);
        const usable = groups.value.filter(
          (group) => group.groupId.trim() && group.title.trim() && counts.get(group.groupId) === 1,
        );
        if (!usable.length) return encodeWorkspace(listArticlesResultCodec, fail("page_failed"));
        return encodeWorkspace(
          listArticlesResultCodec,
          ok(usable.map((group) => ({ candidate: group.groupId, title: group.title }))),
        );
      });
    },
    async openArticle(input) {
      const parsed = v.safeParse(articleOpenInputSchema, input);
      return parsed.success
        ? navigation(parsed.output)
        : encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
    },
    async newArticle(input) {
      const parsed = v.safeParse(articleNewInputSchema, input);
      return parsed.success
        ? navigation(parsed.output)
        : encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
    },
    async currentArticle(input) {
      const selection = v.safeParse(articleCurrentInputSchema, input ?? {});
      if (!selection.success || (selection.output.new && selection.output.candidate))
        return encodeWorkspace(articleResultCodec, fail("target_unavailable"));
      const found = await pages.findCurrentEditor(selection.output);
      if (Result.isError(found))
        return encodeWorkspace(articleResultCodec, fail(pageFailure(found.error)));
      if (!found.value) return encodeWorkspace(articleResultCodec, fail("target_unavailable"));
      const binding = found.value;
      const route = classifyAppmsgUrl(binding.url);
      const reference: ArticleBinding = {
        binding,
        ...(route.kind === "saved-editor" ? { groupId: route.groupId } : {}),
      };
      const valid = await validate(reference);
      if (Result.isError(valid)) return encodeWorkspace(articleResultCodec, valid);
      const editor = await pages.open(binding);
      if (Result.isError(editor))
        return encodeWorkspace(articleResultCodec, pageFailureResult(editor.error));
      const readiness = await editor.value.ready();
      if (Result.isError(readiness))
        return encodeWorkspace(articleResultCodec, pageFailureResult(readiness.error));
      if (!readiness.value.isReady || !readiness.value.isNew)
        return encodeWorkspace(articleResultCodec, fail("page_failed"));
      const content = await editor.value.getContent();
      if (Result.isError(content))
        return encodeWorkspace(articleResultCodec, pageFailureResult(content.error));
      const bodyHash = await hashBody(content.value);
      if (Result.isError(bodyHash)) return encodeWorkspace(articleResultCodec, fail("page_failed"));
      const finalValid = await validate(reference);
      if (Result.isError(finalValid)) return encodeWorkspace(articleResultCodec, finalValid);
      return encodeWorkspace(
        articleResultCodec,
        remember(binding, "", bodyHash.value, reference.groupId),
      );
    },
    async readBody(article) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(workspaceResultCodec, fail("target_unavailable"));
      const valid = await validate(reference);
      if (Result.isError(valid)) return encodeWorkspace(workspaceResultCodec, valid);
      const editor = await pages.open(reference.binding);
      if (Result.isError(editor))
        return encodeWorkspace(workspaceResultCodec, pageFailureResult(editor.error));
      const content = await editor.value.getContent();
      if (Result.isError(content))
        return encodeWorkspace(workspaceResultCodec, pageFailureResult(content.error));
      const bodyHash = await hashBody(content.value);
      if (Result.isError(bodyHash))
        return encodeWorkspace(workspaceResultCodec, fail("page_failed"));
      const finalValid = await validate(reference);
      if (Result.isError(finalValid)) return encodeWorkspace(workspaceResultCodec, finalValid);
      return encodeWorkspace(
        workspaceResultCodec,
        ok({ html: content.value, bodyHash: bodyHash.value }),
      );
    },
    async inspectArticle(article) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(articleFieldsResultCodec, fail("target_unavailable"));
      const valid = await validate(reference);
      if (Result.isError(valid)) return encodeWorkspace(articleFieldsResultCodec, valid);
      const fields = await pages.readArticleFields(reference.binding);
      if (Result.isError(fields))
        return encodeWorkspace(articleFieldsResultCodec, pageFailureResult(fields.error));
      const digest = await hashArticleFields(fields.value);
      if (Result.isError(digest))
        return encodeWorkspace(articleFieldsResultCodec, fail("page_failed"));
      const finalValid = await validate(reference);
      if (Result.isError(finalValid)) return encodeWorkspace(articleFieldsResultCodec, finalValid);
      return encodeWorkspace(
        articleFieldsResultCodec,
        ok({ ...fields.value, fieldsHash: digest.value }),
      );
    },
    async updateArticleFields(input) {
      const parsed = v.safeParse(updateFieldsInputSchema, input);
      if (!parsed.success)
        return encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      const refuse = (failure: Failure): FieldsObservation => ({
        effect: initialFieldsEffect(input.fields),
        result: { status: "error", error: failure },
        ended: true,
      });
      let ownsAdmission = false;
      let releaseQueue: (() => void) | undefined;
      const result = await initialized.value.run(input, async (execution) => {
        const reference = references.get(input.article);
        if (!reference) return refuse({ code: "target_unavailable" });
        activeWrites.set(input.operationId, { reference, sharedUi: false });
        ownsAdmission = true;
        const queue = queueDocument(reference.binding);
        releaseQueue = queue.release;
        await queue.previous;
        const blocked = await conflict(reference, input.operationId);
        if (blocked) return refuse(blocked);
        const valid = await validate(reference);
        if (valid.isErr())
          return {
            ...bodyBoundaryError(valid.error, "bg.preflight"),
            effect: initialFieldsEffect(input.fields),
          };
        const identity = await pages.fieldsIdentity(reference.binding);
        if (identity.isErr()) return refuse(identity.error);
        const binding = await operationTarget(reference, identity.value.executorId);
        const localDigest = await fieldsRequestDigest(input.fields, input.expectedHash);
        return execution.issue(binding, async () => {
          const receipt = await pages.updateArticleFields(
            reference.binding,
            input.fields,
            input.expectedHash,
            { operationId: input.operationId, executorId: binding.executorId },
          );
          if (receipt.isErr()) {
            const { notInvoked, ...failure } = receipt.error;
            const refused =
              notInvoked ||
              [
                "executor_mismatch",
                "invalid_operation",
                "operation_conflict",
                "ledger_full",
                "hash_failed",
              ].includes(receipt.error.code);
            return {
              effect: {
                ...initialFieldsEffect(input.fields),
                outcome: refused ? "not_dispatched" : "unknown",
              },
              ended: refused,
              result: { status: "error", error: failure },
            };
          }
          if (!matchesReceipt(receipt.value, input.operationId, binding, localDigest))
            return {
              effect: { ...initialFieldsEffect(input.fields), outcome: "unknown" },
              ended: false,
              result: { status: "error", error: { code: "evidence_conflict" } },
            };
          return receiptObservation(receipt.value);
        });
      });
      if (ownsAdmission) activeWrites.delete(input.operationId);
      releaseQueue?.();
      return encodeOperation(result);
    },
    async checkArticle(article) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(articleCheckResultCodec, fail("target_unavailable"));
      const initial = await validate(reference);
      if (Result.isError(initial)) return encodeWorkspace(articleCheckResultCodec, initial);
      const fields = await pages.readArticleFields(reference.binding);
      if (Result.isError(fields))
        return encodeWorkspace(articleCheckResultCodec, pageFailureResult(fields.error));
      const afterFields = await validate(reference);
      if (Result.isError(afterFields)) return encodeWorkspace(articleCheckResultCodec, afterFields);
      const editor = await pages.open(reference.binding);
      if (Result.isError(editor))
        return encodeWorkspace(articleCheckResultCodec, pageFailureResult(editor.error));
      const beforeBody = await validate(reference);
      if (Result.isError(beforeBody)) return encodeWorkspace(articleCheckResultCodec, beforeBody);
      const body = await editor.value.getContent();
      if (Result.isError(body))
        return encodeWorkspace(articleCheckResultCodec, pageFailureResult(body.error));
      const afterBody = await validate(reference);
      if (Result.isError(afterBody)) return encodeWorkspace(articleCheckResultCodec, afterBody);
      return encodeWorkspace(articleCheckResultCodec, ok(checkArticle(fields.value, body.value)));
    },
    async listAssets(article) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(assetListResultCodec, fail("target_unavailable"));
      const queue = queueDocument(reference.binding);
      await queue.previous;
      try {
        return await maintain(
          "asset-list",
          async (progress) => {
            const before = await validate(reference);
            if (before.isErr()) progress.failed?.(before.error);
            if (Result.isError(before)) return encodeWorkspace(assetListResultCodec, before);
            const listed = await pages.listMaterials(reference.binding, () =>
              progress.materialInvoked?.(),
            );
            if (listed.isErr()) progress.failed?.(listed.error);
            if (Result.isError(listed))
              return encodeWorkspace(assetListResultCodec, pageFailureResult(listed.error));
            progress.dialogEnded?.();
            const after = await validate(reference);
            if (after.isErr()) progress.failed?.(after.error);
            if (Result.isError(after)) return encodeWorkspace(assetListResultCodec, after);
            const cardFingerprints = listed.value.cards.map((card) =>
              materialFingerprint(reference.binding, card),
            );
            const visibleFingerprints = new Set(cardFingerprints);
            if (visibleFingerprints.size !== cardFingerprints.length)
              return encodeWorkspace(assetListResultCodec, fail("asset_list_failed"));
            const existingHandles = new Map<string, string>();
            for (const [handle, candidate] of assetReferences) {
              if (candidate.article !== article) continue;
              const fingerprint = materialFingerprint(candidate.binding, candidate);
              if (!existingHandles.has(fingerprint)) existingHandles.set(fingerprint, handle);
            }
            const cards = listed.value.cards.map((card, index) => {
              const existing = existingHandles.get(cardFingerprints[index]!);
              const asset = existing ?? `ephemeral:${crypto.randomUUID()}`;
              if (!existing)
                assetReferences.set(asset, { article, binding: reference.binding, ...card });
              return { asset, ...card };
            });
            for (const [handle, candidate] of assetReferences) {
              if (
                candidate.article === article &&
                !visibleFingerprints.has(materialFingerprint(candidate.binding, candidate))
              )
                assetReferences.delete(handle);
            }
            return encodeWorkspace(
              assetListResultCodec,
              ok({ scope: "visible-page" as const, cards }),
            );
          },
          reference,
        );
      } finally {
        queue.release();
      }
    },
    async uploadAsset(input) {
      const parsed = v.safeParse(assetUploadInputSchema, input);
      if (!parsed.success)
        return encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const payload = { blob: input.blob, filename: input.filename, mimeType: input.mimeType };
      if (!v.safeParse(assetPayloadSchema, payload).success)
        return encodeOperation(
          Result.err({ operationId: input.operationId, failure: { code: "invalid_asset" } }),
        );
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      const refuse = (failure: Failure): OperationObservation => ({
        effect: { outcome: "not_dispatched", filename: input.filename },
        result: { status: "error", error: failure },
        ended: true,
      });
      let ownsAdmission = false;
      let releaseQueue: (() => void) | undefined;
      const result = await initialized.value.run(input, async (execution) => {
        const reference = references.get(input.article);
        if (!reference) return refuse({ code: "target_unavailable" });
        activeWrites.set(input.operationId, { reference, sharedUi: true });
        ownsAdmission = true;
        const queue = queueDocument(reference.binding);
        releaseQueue = queue.release;
        await queue.previous;
        const blocked = await conflict(reference, input.operationId, true);
        if (blocked) return refuse(blocked);
        const valid = await validate(reference);
        if (valid.isErr())
          return {
            ...bodyBoundaryError(valid.error, "bg.preflight"),
            effect: { outcome: "not_dispatched", filename: input.filename },
          };
        const identity = await pages.materialIdentity(reference.binding);
        if (identity.isErr()) return refuse(identity.error);
        const binding = await operationTarget(reference, identity.value.executorId);
        const localDigest = await assetRequestDigest(payload);
        // Pure binding above; even menu/dialog opening belongs inside committed issue.
        return execution.issue(binding, async () => {
          const receipt = await pages.uploadMaterial(reference.binding, payload, {
            operationId: input.operationId,
            executorId: binding.executorId,
          });
          if (receipt.isErr()) {
            const { notInvoked, ...failure } = receipt.error;
            const refused =
              notInvoked ||
              [
                "executor_mismatch",
                "invalid_operation",
                "invalid_asset",
                "operation_conflict",
                "ledger_full",
                "hash_failed",
              ].includes(receipt.error.code);
            return {
              effect: { outcome: refused ? "not_dispatched" : "unknown", filename: input.filename },
              ended: refused,
              result: { status: "error", error: failure },
            };
          }
          if (!matchesReceipt(receipt.value, input.operationId, binding, localDigest))
            return {
              effect: { outcome: "unknown", filename: input.filename },
              ended: false,
              result: { status: "error", error: { code: "evidence_conflict" } },
            };
          if (receipt.value.result?.status === "ok") {
            const after = await validate(reference);
            if (after.isErr())
              return {
                ...bodyBoundaryError(after.error, "bg.preflight"),
                effect: receipt.value.effect,
                ended: receipt.value.ended,
              };
          }
          return receiptObservation(receipt.value);
        });
      });
      if (ownsAdmission) activeWrites.delete(input.operationId);
      releaseQueue?.();
      return encodeOperation(result);
    },
    async writeBody(input) {
      if (!v.safeParse(writeBodyInputSchema, input).success)
        return encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      let ownsAdmission = false;
      const result = await initialized.value.run(input, async (execution) => {
        const reference = references.get(input.article);
        if (!reference) return bodyError("target_unavailable");
        activeWrites.set(input.operationId, { reference, sharedUi: false });
        ownsAdmission = true;
        const queue = queueDocument(reference.binding);
        try {
          await queue.previous;
          const blocked = await conflict(reference, input.operationId);
          if (blocked)
            return { ...bodyError(blocked.code), result: { status: "error", error: blocked } };
          const valid = await validate(reference);
          if (valid.isErr()) return bodyBoundaryError(valid.error, "bg.preflight");
          const editor = await pages.open(reference.binding);
          if (editor.isErr()) return bodyBoundaryError(editor.error, "bg.preflight");
          const ready = await editor.value.ready();
          if (ready.isErr())
            return bodyBoundaryError(
              ready.error,
              ready.error.readFailure?.stage === "page_decode" ||
                ready.error.observedFailure?.kind === "domain"
                ? "bg.page_decode"
                : "bg.page_call",
            );
          const binding = await operationTarget(reference, ready.value.executorId);
          const localDigest = await bodyRequestDigest(input.html, input.expectedHash);
          return await execution.issue(binding, async () => {
            const unresolved = (code: Failure["code"]): BodyObservation => ({
              effect: { outcome: "unknown" },
              ended: false,
              result: { status: "error", error: { code } },
            });
            const receipt = await editor.value.setContent(input.html, input.expectedHash, {
              operationId: input.operationId,
              executorId: binding.executorId,
            });
            if (receipt.isErr()) {
              const { notInvoked, ...failure } = receipt.error;
              const refused =
                notInvoked ||
                [
                  "executor_mismatch",
                  "invalid_operation",
                  "operation_conflict",
                  "ledger_full",
                  "hash_failed",
                ].includes(receipt.error.code);
              return {
                ...(refused ? bodyError(receipt.error.code) : unresolved(receipt.error.code)),
                result: { status: "error", error: failure },
              };
            }
            const value = receipt.value;
            if (!matchesReceipt(value, input.operationId, binding, localDigest))
              return unresolved("evidence_conflict");
            return receiptObservation(value);
          });
        } finally {
          queue.release();
        }
      });
      if (ownsAdmission) activeWrites.delete(input.operationId);
      return encodeOperation(result);
    },
    async getOperation(id) {
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      const snapshot = await initialized.value.get(id);
      if (snapshot.isErr()) return encodeOperation(snapshot);
      const stored = await initialized.value.record(id);
      if (stored.isErr())
        return encodeOperation(Result.ok({ ...snapshot.value, issue: stored.error }));
      const record = stored.value;
      if (
        record.snapshot.state !== "unresolved" ||
        !record.binding ||
        record.snapshot.operation === "new" ||
        record.snapshot.operation === "open" ||
        record.snapshot.operation === "maintenance"
      )
        return encodeOperation(
          Result.ok({
            snapshot: record.snapshot,
            ...(record.snapshot.state === "settled"
              ? {}
              : snapshot.value.issue
                ? { issue: snapshot.value.issue }
                : {}),
          }),
        );
      const receipt =
        record.snapshot.operation === "body"
          ? await pages.getBodyReceipt(record.binding, id)
          : record.snapshot.operation === "fields"
            ? await pages.getFieldsReceipt(record.binding, id)
            : record.snapshot.operation === "upload"
              ? await pages.getUploadReceipt(record.binding, id)
              : await pages.getExecutionReceipt(record.binding, id, record.snapshot.operation);
      if (receipt.isErr() || !receipt.value)
        return encodeOperation(
          Result.ok({
            snapshot: record.snapshot,
            issue: {
              operationId: id,
              failure: receipt.isErr() ? receipt.error : { code: "receipt_missing" },
            },
          }),
        );
      const value = receipt.value;
      if (!matchesReceipt(value, id, record.binding, record.localRequestDigest))
        return encodeOperation(
          Result.ok({
            snapshot: record.snapshot,
            issue: { operationId: id, failure: { code: "evidence_conflict" } },
          }),
        );
      // Local BODY digest is stored independently of the stable original article ref digest.
      const evidence = {
        effect: value.effect,
        ended: value.ended && record.bgEffects !== "pending",
        result:
          (record.snapshot.operation === "save" || record.bgEffects === "pending") &&
          value.result?.status === "ok"
            ? record.snapshot.result.status === "error" &&
              !["operation_unresolved", "operation_interrupted"].includes(
                record.snapshot.result.error.code,
              )
              ? record.snapshot.result
              : {
                  status: "error" as const,
                  error: {
                    code: "operation_interrupted" as const,
                    cause: {
                      at:
                        record.snapshot.operation === "cover"
                          ? ("bg.pointer" as const)
                          : record.bgEffects === "pending"
                            ? ("bg.fresh_read" as const)
                            : ("bg.page_call" as const),
                      kind: "runtime" as const,
                      code:
                        record.snapshot.operation === "cover"
                          ? "pointer_end_unverified"
                          : record.bgEffects === "pending"
                            ? "persistence_unverified"
                            : "save_result_uncommitted",
                    },
                  },
                }
            : (value.result ?? {
                status: "error" as const,
                error: { code: "operation_unresolved" as const },
              }),
      };
      return encodeOperation(
        await initialized.value.observe(id, record.requestDigest, record.binding, evidence),
      );
    },
    async readArticleCover(article) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(articleCoverResultCodec, fail("target_unavailable"));
      const valid = await validate(reference);
      if (Result.isError(valid)) return encodeWorkspace(articleCoverResultCodec, valid);
      const read = await pages.readArticleCover(reference.binding);
      if (Result.isError(read))
        return encodeWorkspace(
          articleCoverResultCodec,
          fail(
            read.error.code === "not_logged_in"
              ? "not_logged_in"
              : read.error.code === "target_unavailable"
                ? "target_unavailable"
                : read.error.code === "cover_unavailable"
                  ? "cover_unavailable"
                  : "page_failed",
            {
              ...(read.error.readFailure ? { readFailure: read.error.readFailure } : {}),
              ...(read.error.cleanupFailed ? { cleanupFailed: true } : {}),
              ...(read.error.baselineHash ? { baselineHash: read.error.baselineHash } : {}),
            },
          ),
        );
      const final = await validate(reference);
      return encodeWorkspace(
        articleCoverResultCodec,
        Result.isError(final) ? final : ok({ coverHash: read.value }),
      );
    },
    async setArticleCover(input) {
      const parsed = v.safeParse(articleCoverSetInputSchema, input);
      if (!parsed.success)
        return encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      let owns = false;
      let release: (() => void) | undefined;
      const result = await initialized.value.run(input, async (execution) => {
        const initial = { cover: true as const, outcome: "not_dispatched" as const };
        const failure = (
          error: Failure,
          ended = true,
          effect: import("@mpctl/contracts").CoverEffect = initial,
        ): OperationObservation => ({ effect, ended, result: { status: "error", error } });
        const reference = references.get(input.article);
        const handle = "asset" in input ? assetReferences.get(input.asset) : undefined;
        if (!reference) return failure({ code: "target_unavailable" });
        activeWrites.set(input.operationId, { reference, sharedUi: true });
        owns = true;
        const queue = queueDocument(reference.binding);
        release = queue.release;
        await queue.previous;
        const blocked = await conflict(reference, input.operationId, true);
        if (blocked) return failure(blocked);
        if (
          "asset" in input &&
          (!handle ||
            handle.article !== input.article ||
            handle.binding.tabId !== reference.binding.tabId ||
            handle.binding.documentId !== reference.binding.documentId ||
            !handle.thumbnailUrl)
        )
          return failure({ code: "target_unavailable" });
        const valid = await validate(reference);
        if (valid.isErr())
          return { ...bodyBoundaryError(valid.error, "bg.preflight"), effect: initial };
        const current = await pages.readArticleCover(reference.binding);
        if (current.isErr())
          return { ...bodyBoundaryError(current.error, "bg.preflight"), effect: initial };
        if (current.value !== input.expectedCoverHash) return failure({ code: "content_conflict" });
        if ("bodyImage" in input) {
          const editor = await pages.open(reference.binding);
          if (editor.isErr())
            return { ...bodyBoundaryError(editor.error, "bg.preflight"), effect: initial };
          const identity = await editor.value.ready();
          if (identity.isErr())
            return { ...bodyBoundaryError(identity.error, "bg.preflight"), effect: initial };
          const binding = await operationTarget(reference, identity.value.executorId);
          const digest = await bodyCoverRequestDigest(input);
          return execution.issue(binding, async () => {
            const called = await pages.setCoverFromBody(reference.binding, {
              operationId: input.operationId,
              executorId: binding.executorId,
              bodyImage: input.bodyImage,
              expectedBodyHash: input.expectedBodyHash,
              expectedCoverHash: input.expectedCoverHash,
            });
            if (called.isErr()) {
              const { notInvoked, ...error } = called.error;
              return failure(
                error,
                !!notInvoked,
                notInvoked ? initial : { cover: true, outcome: "unknown" },
              );
            }
            const receipt = called.value;
            if (!matchesReceipt(receipt, input.operationId, binding, digest))
              return failure({ code: "evidence_conflict" }, false, {
                cover: true,
                outcome: "unknown",
              });
            const observation: OperationObservation = receiptObservation(receipt);
            if (receipt.result?.status === "ok") {
              const after = await validate(reference);
              if (after.isErr())
                observation.result = bodyBoundaryError(after.error, "bg.preflight").result;
            }
            return observation;
          });
        }
        const identity = await pages.coverIdentity(reference.binding);
        if (identity.isErr()) return failure(identity.error);
        const binding = await operationTarget(reference, identity.value.executorId);
        const digest = await coverRequestDigest(input.asset, input.expectedCoverHash);
        return execution.issue(binding, async () => {
          const called = await pages.setArticleCover(
            reference.binding,
            { filename: handle!.filename, thumbnailUrl: handle!.thumbnailUrl! },
            input.expectedCoverHash,
            { operationId: input.operationId, executorId: binding.executorId, asset: input.asset },
          );
          if (called.isErr()) {
            const { notInvoked, ...error } = called.error;
            return failure(
              error,
              !!notInvoked,
              notInvoked ? initial : { cover: true, outcome: "unknown" },
            );
          }
          const receipt = called.value;
          if (!matchesReceipt(receipt, input.operationId, binding, digest))
            return failure({ code: "evidence_conflict" }, false, {
              cover: true,
              outcome: "unknown",
            });
          const observation = receiptObservation(receipt);
          if (receipt.effect.outcome === "confirmed" && observation.result.status === "ok") {
            const after = await validate(reference);
            if (after.isErr())
              observation.result = bodyBoundaryError(after.error, "bg.preflight").result;
          }
          return observation;
        });
      });
      if (owns) activeWrites.delete(input.operationId);
      release?.();
      return encodeOperation(result);
    },
    async saveArticle(input) {
      if (!v.safeParse(articleSaveInputSchema, input).success)
        return encodeOperation(Result.err({ failure: { code: "invalid_operation" } }));
      const initialized = await ledger();
      if (initialized.isErr()) return encodeOperation(initialized);
      let owns = false;
      let release: (() => void) | undefined;
      const result = await initialized.value.run(input, async (execution) => {
        let effect: import("@mpctl/contracts").SaveEffect = {
          outcome: "not_dispatched",
          persistence: "unverified",
        };
        const failSave = (error: Failure, ended = true): OperationObservation => ({
          effect,
          ended,
          result: { status: "error", error },
        });
        const boundary = (
          error: {
            code: string;
            observedFailure?: ObservedFailure;
            readFailure?: import("@mpctl/contracts").ReadFailure;
          },
          at: NonNullable<Failure["cause"]>["at"],
          ended = true,
        ) => {
          const observation = bodyBoundaryError(error, at);
          return { ...observation, effect, ended };
        };
        const reference = references.get(input.article);
        if (!reference) return failSave({ code: "target_unavailable" });
        if (!reference.groupId) return failSave({ code: "unsupported" });
        activeWrites.set(input.operationId, { reference, sharedUi: true });
        owns = true;
        const queue = queueDocument(reference.binding);
        release = queue.release;
        await queue.previous;
        const blocked = await conflict(reference, input.operationId, true);
        if (blocked) return failSave(blocked);
        const valid = await validate(reference);
        if (valid.isErr()) return boundary(valid.error, "bg.preflight");
        const editor = await pages.open(reference.binding);
        if (editor.isErr()) return boundary(editor.error, "bg.preflight");
        const html = await editor.value.getContent();
        if (html.isErr()) return boundary(html.error, "bg.preflight");
        const bodyHash = await hashBody(html.value);
        if (bodyHash.isErr()) return boundary(bodyHash.error, "bg.preflight");
        const fields = await pages.readArticleFields(reference.binding);
        if (fields.isErr()) return boundary(fields.error, "bg.preflight");
        const fieldsHash = await hashArticleFields(fields.value);
        if (fieldsHash.isErr()) return boundary(fieldsHash.error, "bg.preflight");
        const cover = await pages.readArticleCover(reference.binding);
        if (cover.isErr()) return boundary(cover.error, "bg.preflight");
        if (
          bodyHash.value !== input.expectedBodyHash ||
          fieldsHash.value !== input.expectedFieldsHash ||
          cover.value !== input.expectedCoverHash
        )
          return failSave({ code: "content_conflict" });
        const finalValid = await validate(reference);
        if (finalValid.isErr()) return boundary(finalValid.error, "bg.preflight");
        const identity = await pages.coverIdentity(reference.binding);
        if (identity.isErr()) return failSave(identity.error);
        const binding = await operationTarget(reference, identity.value.executorId);
        const digest = await saveRequestDigest(input);
        return execution.issue(binding, async () => {
          const native = await pages.saveArticle(reference.binding, {
            operationId: input.operationId,
            executorId: binding.executorId,
            expectedBodyHash: input.expectedBodyHash,
            expectedFieldsHash: input.expectedFieldsHash,
            expectedCoverHash: input.expectedCoverHash,
          });
          if (native.isErr()) {
            const { notInvoked, ...error } = native.error;
            effect = {
              outcome: notInvoked ? "not_dispatched" : "unknown",
              persistence: "unverified",
            };
            return failSave(error, !!notInvoked);
          }
          const receipt = native.value;
          if (
            !matchesReceipt(receipt, input.operationId, binding, digest) ||
            receipt.effect.persistence !== "unverified"
          ) {
            effect = { outcome: "unknown", persistence: "unverified" };
            return failSave({ code: "evidence_conflict" }, false);
          }
          effect = receipt.effect;
          const nativeResult = receipt.result;
          if (effect.outcome !== "confirmed")
            return failSave(
              nativeResult?.status === "error"
                ? nativeResult.error
                : { code: "operation_unresolved" },
              receipt.ended,
            );
          return {
            effect,
            ended: receipt.ended,
            result:
              nativeResult?.status === "error" || (receipt.ended && nativeResult)
                ? nativeResult
                : { status: "error", error: { code: "operation_unresolved" } },
          };
        });
      });
      if (owns) activeWrites.delete(input.operationId);
      release?.();
      return encodeOperation(result);
    },
  };
  return service;
}
