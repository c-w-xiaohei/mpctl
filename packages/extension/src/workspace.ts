import { Result } from "better-result";
import { NexusError } from "@nexus-js/core";
import * as v from "valibot";
import {
  articleResultCodec,
  workspaceResultCodec,
  articleFieldsResultCodec,
  articleStateResultCodec,
  articleCheckResultCodec,
  articleCoverResultCodec,
  assetListResultCodec,
  assetImageResultCodec,
  listArticlesResultCodec,
  cleanupWorkspaceResultCodec,
  operationResultCodec,
  articleNewInputSchema,
  articleOpenInputSchema,
  articleCurrentInputSchema,
  writeBodyInputSchema,
  updateFieldsInputSchema,
  assetUploadInputSchema,
  operationIdSchema,
  articleCoverSetInputSchema,
  articleSaveInputSchema,
  assetRequestDigest,
  validAssetSignature,
  type WorkspaceService,
  type Failure,
  type OperationEffect,
  type OperationResult,
  type OperationReply,
  type OperationWireResult,
  type InteractionIssue,
} from "@mpctl/contracts";
import { createOperations, type Operations, type OperationTarget } from "./operations";
import {
  classifyAppmsgUrl,
  appmsgRouteIdentity,
  type PageBinding,
  type createPageManager,
  type NavigationProgress,
} from "./pages";
import { hashBody } from "./mp/body-hash";
import { hashArticleFields, initialFieldsEffect } from "./mp/article-fields";
import { checkArticle } from "./mp/article-check";
import { bodyRequestDigest } from "./page-contracts";
import {
  fieldsRequestDigest,
  coverRequestDigest,
  bodyCoverRequestDigest,
  saveRequestDigest,
} from "./background-contracts";

type Pages = ReturnType<typeof createPageManager>;
type Reference = { binding: PageBinding; groupId?: string };
type Facts = { effect: OperationEffect; result: OperationResult };
const failure = (code: Failure["code"]): OperationResult => ({ status: "error", error: { code } });
const success: OperationResult = { status: "ok", value: {} };
const zeroHash = "0".repeat(64);
const businessFailure = ({
  code,
  cause,
  cleanup,
  blockingOperationId,
  confirmationTimedOut,
}: Failure): Failure => ({
  code,
  ...(cause ? { cause } : {}),
  ...(cleanup ? { cleanup } : {}),
  ...(blockingOperationId ? { blockingOperationId } : {}),
  ...(confirmationTimedOut ? { confirmationTimedOut } : {}),
});
type ReadError = import("@mpctl/contracts").WorkspaceError;
type PageError = {
  code: string;
  readFailure?: import("@mpctl/contracts").ReadFailure;
  cleanupFailed?: true;
  baselineHash?: string;
  observedFailure?: { kind: "domain" | "runtime" | "nexus" | "protocol"; causeCode: string };
};
const observations = new WeakMap<object, NonNullable<PageError["observedFailure"]>>();
function readError(error: PageError): ReadError {
  const known = [
    "target_unavailable",
    "target_ambiguous",
    "not_logged_in",
    "cover_unavailable",
    "asset_ambiguous",
    "asset_upload_unknown",
    "asset_too_large",
    "asset_list_failed",
    "cleanup_failed",
    "dialog_unavailable",
    "library_open_unknown",
    "invalid_payload",
  ];
  const value: ReadError = {
    code:
      error.code === "navigation_failed"
        ? "target_unavailable"
        : known.includes(error.code)
          ? (error.code as ReadError["code"])
          : "page_failed",
    ...(error.readFailure ? { readFailure: error.readFailure } : {}),
    ...(error.cleanupFailed ? { cleanupFailed: true } : {}),
    ...(error.baselineHash ? { baselineHash: error.baselineHash } : {}),
  };
  const observed = error.observedFailure ?? observations.get(error);
  if (observed) observations.set(value, observed);
  return value;
}
function boundary(
  error: PageError,
  at: NonNullable<Failure["cause"]>["at"] = "bg.preflight",
): Failure {
  const observed =
    error.observedFailure ??
    observations.get(error) ??
    (error.readFailure
      ? { kind: error.readFailure.kind, causeCode: error.readFailure.causeCode }
      : { kind: "domain" as const, causeCode: error.code });
  const code = [
    "not_logged_in",
    "content_conflict",
    "target_unavailable",
    "target_ambiguous",
    "cover_unavailable",
    "hash_failed",
    "invalid_result_envelope",
  ].includes(error.code)
    ? (error.code as Failure["code"])
    : "page_failed";
  return { code, cause: { at, kind: observed.kind, code: observed.causeCode } };
}
function digestRequest(compute: () => Promise<string>) {
  return Result.tryPromise({
    try: compute,
    catch: (): InteractionIssue => ({ failure: { code: "hash_failed" } }),
  });
}

export function createWorkspace({
  pages,
  operations: configured,
}: {
  pages: Pages;
  operations?: Promise<Result<Operations, InteractionIssue>>;
}): WorkspaceService {
  let storage = configured;
  const ledger = () => (storage ??= createOperations());
  const references = new Map<string, Reference>();
  const assets = new Map<string, { article: string; filename: string; thumbnailUrl?: string }>();
  // Only live calls are joined here. This map never controls resource admission.
  const calls = new Map<
    string,
    { digest: string; task: Promise<Result<OperationReply, InteractionIssue>> }
  >();
  const encode = async (result: Result<OperationReply, InteractionIssue>) =>
    (await operationResultCodec.serialize(result)).unwrap();
  const remember = (reference: Reference) => {
    const article = `ephemeral:${crypto.randomUUID()}`;
    references.set(article, reference);
    return article;
  };
  const rememberAsset = (article: string, card: { filename: string; thumbnailUrl?: string }) => {
    const existing = [...assets].find(
      ([, value]) =>
        value.article === article &&
        value.filename === card.filename &&
        value.thumbnailUrl === card.thumbnailUrl,
    );
    const asset = existing?.[0] ?? `ephemeral:${crypto.randomUUID()}`;
    assets.set(asset, { article, ...card });
    return { asset, ...card };
  };
  const valid = async (reference: Reference): Promise<Result<void, ReadError>> => {
    try {
      const current = await pages.isCurrent(reference.binding);
      if (current.isErr()) return Result.err(readError(current.error));
      if (!current.value) return Result.err({ code: "target_unavailable" });
      if (reference.groupId) {
        const saved = await pages.validateSavedArticle(reference.binding, reference.groupId);
        if (saved.isErr()) return Result.err(readError(saved.error));
        if (!saved.value.valid) return Result.err({ code: "target_unavailable" });
      }
      const status = await pages.pageStatus(reference.binding);
      if (status.isErr()) return Result.err(readError(status.error));
      const after = await pages.isCurrent(reference.binding);
      if (after.isErr()) return Result.err(readError(after.error));
      if (!after.value) return Result.err({ code: "target_unavailable" });
      if (status.value.state === "not_logged_in") return Result.err({ code: "not_logged_in" });
      if (status.value.state !== "ready") return Result.err({ code: "page_failed" });
      return Result.ok();
    } catch (error) {
      return Result.err(
        readError({
          code: "page_failed",
          observedFailure: {
            kind: error instanceof NexusError ? "nexus" : "runtime",
            causeCode: error instanceof NexusError ? error.code : "unexpected_exception",
          },
        }),
      );
    }
  };
  const target = async (reference: Reference, executorId: string): Promise<OperationTarget> => {
    const context = new URL(reference.binding.url).searchParams.get("token");
    return {
      tabId: reference.binding.tabId,
      documentId: reference.binding.documentId,
      route: appmsgRouteIdentity(reference.binding.url)!,
      executorId,
      ...(reference.groupId ? { groupId: reference.groupId } : {}),
      ...(context ? { contextDigest: await bodyRequestDigest(context, zeroHash) } : {}),
    };
  };
  // Mechanical request coalescing only: no issue/checkpoint, resource locks or
  // universal completion evidence. Each business call produces its own facts.
  const submit = async (
    id: string,
    operation: OperationReply["snapshot"]["operation"],
    originalTarget: string | null,
    local: string,
    expected: string,
    initial: OperationEffect,
    work: (records: Operations) => Promise<Facts>,
  ): Promise<Result<OperationReply, InteractionIssue>> => {
    const hashed = await digestRequest(() =>
      bodyRequestDigest(JSON.stringify([operation, originalTarget, local]), expected),
    );
    if (hashed.isErr()) return hashed;
    const digest = hashed.value;
    const live = calls.get(id);
    if (live)
      return live.digest === digest
        ? live.task
        : Result.err({ failure: { code: "operation_conflict" } });
    const task = (async (): Promise<Result<OperationReply, InteractionIssue>> => {
      const records = await ledger();
      if (records.isErr()) return records;
      const claim = await records.value.claim({
        operationId: id,
        operation,
        requestDigest: digest,
        localRequestDigest: local,
        effect: initial,
      });
      if (claim.isErr()) return claim;
      if (!claim.value.acquired) return Result.ok({ snapshot: claim.value.record.snapshot });
      let facts: Facts;
      try {
        facts = await work(records.value);
      } catch {
        return Result.ok({
          snapshot: claim.value.record.snapshot,
          issue: { operationId: id, failure: { code: "page_failed" } },
        });
      }
      const recorded = await records.value.finish(id, facts.effect, facts.result);
      return recorded.isOk()
        ? recorded
        : Result.ok({
            snapshot: claim.value.record.snapshot,
            issue: { ...recorded.error, uncommitted: facts },
          });
    })();
    calls.set(id, { digest, task });
    try {
      return await task;
    } finally {
      if (calls.get(id)?.task === task) calls.delete(id);
    }
  };
  const body = async (reference: Reference) => {
    const before = await valid(reference);
    if (before.isErr()) return before;
    const editor = await pages.open(reference.binding);
    if (editor.isErr()) return Result.err(readError(editor.error));
    const content = await editor.value.getContent();
    if (content.isErr()) return Result.err(readError(content.error));
    const hash = await hashBody(content.value);
    if (hash.isErr()) return Result.err(readError(hash.error));
    const after = await valid(reference);
    return after.isErr() ? after : Result.ok({ html: content.value, bodyHash: hash.value });
  };
  const inspect = async (article: string) => {
    const reference = references.get(article);
    if (!reference) return Result.err({ code: "target_unavailable" as const });
    const before = await valid(reference);
    if (before.isErr()) return before;
    const fields = await pages.readArticleFields(reference.binding);
    if (fields.isErr()) return Result.err(readError(fields.error));
    const hash = await hashArticleFields(fields.value);
    if (hash.isErr()) return Result.err(readError(hash.error));
    const after = await valid(reference);
    return after.isErr() ? after : Result.ok({ ...fields.value, fieldsHash: hash.value });
  };
  const cover = async (article: string) => {
    const reference = references.get(article);
    if (!reference) return Result.err({ code: "target_unavailable" as const });
    const before = await valid(reference);
    if (before.isErr()) return before;
    const read = await pages.readArticleCover(reference.binding);
    if (read.isErr()) return Result.err(readError(read.error));
    const after = await valid(reference);
    return after.isErr() ? after : Result.ok({ coverHash: read.value });
  };
  const nativeFacts = (
    receipt: {
      operationId: string;
      executorId: string;
      requestDigest: string;
      effect: OperationEffect;
      result?: OperationResult;
    },
    id: string,
    executorId: string,
    digest: string,
    unknown: OperationEffect,
  ): Facts =>
    receipt.operationId !== id ||
    receipt.executorId !== executorId ||
    receipt.requestDigest !== digest
      ? { effect: unknown, result: failure("evidence_conflict") }
      : { effect: receipt.effect, result: receipt.result ?? failure("operation_unresolved") };
  const navigation = async (input: {
    operationId: string;
    candidate?: string;
  }): Promise<OperationWireResult> => {
    const operation = input.candidate === undefined ? "new" : "open";
    let opened: Reference | undefined;
    let hash: string | undefined;
    const initial = {
      navigation: true as const,
      outcome: "not_dispatched" as const,
      pageCreated: false,
      auxiliaryCreated: [] as ("home" | "draft-list")[],
      targetBound: false,
    };
    const local = await Result.tryPromise({
      try: () =>
        bodyRequestDigest(JSON.stringify([operation, input.candidate ?? null, null]), zeroHash),
      catch: () => ({ failure: { code: "hash_failed" as const } }),
    });
    if (local.isErr()) return encode(local);
    const reply = await submit(
      input.operationId,
      operation,
      input.candidate ?? null,
      local.value,
      zeroHash,
      initial,
      async () => {
        let effect: import("@mpctl/contracts").NavigationEffect = {
          ...initial,
          outcome: "unknown",
        };
        const refused = (error: PageError & { stage?: string }): Facts => ({
          effect,
          result: {
            status: "error",
            error: {
              code:
                error.code === "target_unavailable" ||
                error.code === "target_ambiguous" ||
                error.code === "not_logged_in"
                  ? error.code
                  : "page_failed",
              cause:
                error.stage && !error.observedFailure && !error.readFailure
                  ? { at: "bg.navigation", kind: "domain", code: error.stage }
                  : boundary(error, "bg.navigation").cause,
            },
          },
        });
        const progress: NavigationProgress = {
          async dispatch(_code, action) {
            return action();
          },
          uncertain() {},
          sourceReady() {},
          async created(role) {
            if (role === "editor") effect = { ...effect, pageCreated: true };
            else
              effect = {
                ...effect,
                auxiliaryCreated: [...new Set([...effect.auxiliaryCreated, role])],
              };
          },
          async bound() {
            effect = { ...effect, targetBound: true };
          },
        };
        let binding: PageBinding;
        if (input.candidate !== undefined) {
          const existing = await pages.findCurrentEditor({ candidate: input.candidate });
          if (existing.isErr()) return refused(existing.error);
          let shortcut = existing.value;
          if (shortcut) {
            const status = await pages.pageStatus(shortcut);
            if (status.isErr()) return refused(status.error);
            if (status.value.state === "not_logged_in") shortcut = undefined;
          }
          if (shortcut) {
            const source = await pages.findDraftList();
            if (source.isErr()) return refused(source.error);
            if (source.value) {
              const sourceContext = new URL(source.value.url).searchParams.get("token");
              const targetContext = new URL(shortcut.url).searchParams.get("token");
              if (sourceContext && targetContext && sourceContext !== targetContext)
                return { effect, result: failure("relationship_unknown") };
              const candidates = await pages.listDraftGroups(source.value);
              if (candidates.isErr()) return refused(candidates.error);
              if (candidates.value.filter((item) => item.groupId === input.candidate).length !== 1)
                return { effect, result: failure("target_unavailable") };
            }
            binding = shortcut;
          } else {
            const list = await pages.ensureDraftList({}, progress);
            if (list.isErr()) return refused(list.error);
            const groups = await pages.listDraftGroups(list.value);
            if (groups.isErr()) return refused(groups.error);
            if (groups.value.filter((item) => item.groupId === input.candidate).length !== 1)
              return { effect, result: failure("target_unavailable") };
            const page = await pages.openDraftGroup(list.value, input.candidate, progress);
            if (page.isErr()) return refused(page.error);
            if (!page.value) return refused({ code: "target_unavailable" });
            binding = page.value;
          }
        } else {
          const page = await pages.ensureEditorTab(progress);
          if (page.isErr()) return refused(page.error);
          binding = page.value;
          if (classifyAppmsgUrl(binding.url).kind !== "new")
            return { effect, result: failure("target_unavailable") };
        }
        const reference = { binding, ...(input.candidate ? { groupId: input.candidate } : {}) };
        const checked = await valid(reference);
        if (checked.isErr()) return refused(checked.error);
        const editor = await pages.open(binding);
        if (editor.isErr()) return refused(editor.error);
        const readiness = await editor.value.ready();
        if (readiness.isErr()) return refused(readiness.error);
        if (!readiness.value.isReady || !readiness.value.isNew)
          return refused({ code: "page_failed", stage: "editor_bootstrap_failed" });
        const read = await body(reference);
        if (read.isErr()) return refused(read.error);
        opened = reference;
        hash = read.value.bodyHash;
        return {
          effect: { ...effect, targetBound: true, outcome: "confirmed", bodyHash: hash },
          result: success,
        };
      },
    );
    if (reply.isOk() && opened && hash && !reply.value.issue) {
      const checked = await valid(opened);
      if (checked.isErr())
        return encode(Result.ok({ ...reply.value, issue: { failure: boundary(checked.error) } }));
      return encode(Result.ok({ ...reply.value, article: remember(opened), bodyHash: hash }));
    }
    return encode(reply);
  };
  return {
    async newArticle(input) {
      const parsed = v.safeParse(articleNewInputSchema, input);
      return parsed.success
        ? navigation(parsed.output)
        : encode(Result.err({ failure: { code: "invalid_operation" } }));
    },
    async openArticle(input) {
      const parsed = v.safeParse(articleOpenInputSchema, input);
      return parsed.success
        ? navigation(parsed.output)
        : encode(Result.err({ failure: { code: "invalid_operation" } }));
    },
    async currentArticle(input) {
      const parsed = v.safeParse(articleCurrentInputSchema, input ?? {});
      if (!parsed.success || (parsed.output.new && parsed.output.candidate))
        return (
          await articleResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const found = await pages.findCurrentEditor(parsed.output);
      if (found.isErr())
        return (await articleResultCodec.serialize(Result.err(readError(found.error)))).unwrap();
      if (!found.value)
        return (
          await articleResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const route = classifyAppmsgUrl(found.value.url);
      const reference = {
        binding: found.value,
        ...(route.kind === "saved-editor" ? { groupId: route.groupId } : {}),
      };
      const read = await body(reference);
      return (
        await articleResultCodec.serialize(
          read.isErr()
            ? read
            : Result.ok({ article: remember(reference), title: "", bodyHash: read.value.bodyHash }),
        )
      ).unwrap();
    },
    async readBody(article) {
      const reference = references.get(article);
      return (
        await workspaceResultCodec.serialize(
          reference ? await body(reference) : Result.err({ code: "target_unavailable" }),
        )
      ).unwrap();
    },
    async inspectArticle(article, options) {
      if (!options?.all)
        return (await articleFieldsResultCodec.serialize(await inspect(article))).unwrap();
      const read = async () => {
        const reference = references.get(article);
        if (!reference) return Result.err({ code: "target_unavailable" as const });
        const fields = await inspect(article);
        if (fields.isErr()) return fields;
        const content = await body(reference);
        if (content.isErr()) return content;
        const image = await cover(article);
        if (image.isErr()) return image;
        return Result.ok({
          article,
          ...fields.value,
          bodyHash: content.value.bodyHash,
          ...image.value,
        });
      };
      const before = await read();
      if (before.isErr()) return (await articleStateResultCodec.serialize(before)).unwrap();
      const after = await read();
      return (
        await articleStateResultCodec.serialize(
          after.isErr()
            ? after
            : JSON.stringify(before.value) === JSON.stringify(after.value)
              ? after
              : Result.err({ code: "content_conflict" }),
        )
      ).unwrap();
    },
    async readArticleCover(article) {
      return (await articleCoverResultCodec.serialize(await cover(article))).unwrap();
    },
    async checkArticle(article) {
      const reference = references.get(article);
      const fields = await inspect(article);
      if (!reference)
        return (
          await articleCheckResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      if (fields.isErr()) return (await articleCheckResultCodec.serialize(fields)).unwrap();
      const content = await body(reference);
      return (
        await articleCheckResultCodec.serialize(
          content.isErr() ? content : Result.ok(checkArticle(fields.value, content.value.html)),
        )
      ).unwrap();
    },
    async listArticles() {
      const list = await pages.ensureDraftList({ refresh: true });
      if (list.isErr())
        return (
          await listArticlesResultCodec.serialize(
            Result.err({
              ...readError(list.error),
              readFailure: list.error.readFailure ?? {
                stage: "page_acquire",
                kind: list.error.observedFailure?.kind ?? "domain",
                causeCode:
                  list.error.observedFailure?.causeCode ??
                  ("stage" in list.error ? list.error.stage : list.error.code),
                component: "drafts",
              },
            }),
          )
        ).unwrap();
      const before = await pages.isCurrent(list.value);
      if (before.isErr())
        return (
          await listArticlesResultCodec.serialize(Result.err(readError(before.error)))
        ).unwrap();
      if (!before.value)
        return (
          await listArticlesResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const groups = await pages.listDraftGroups(list.value);
      if (groups.isErr())
        return (
          await listArticlesResultCodec.serialize(
            Result.err({
              ...readError(groups.error),
              readFailure: groups.error.readFailure ?? {
                stage: "native_read",
                kind: groups.error.observedFailure?.kind ?? "domain",
                causeCode: groups.error.observedFailure?.causeCode ?? groups.error.code,
                component: "drafts",
              },
            }),
          )
        ).unwrap();
      const current = await pages.isCurrent(list.value);
      if (current.isErr() || !current.value)
        return (
          await listArticlesResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const counts = new Map<string, number>();
      for (const group of groups.value)
        counts.set(group.groupId, (counts.get(group.groupId) ?? 0) + 1);
      return (
        await listArticlesResultCodec.serialize(
          Result.ok(
            groups.value
              .filter(
                (group) =>
                  group.groupId.trim() && group.title.trim() && counts.get(group.groupId) === 1,
              )
              .map((group) => ({ candidate: group.groupId, title: group.title })),
          ),
        )
      ).unwrap();
    },
    async cleanupWorkspace() {
      const records = await ledger();
      if (records.isErr())
        return (
          await cleanupWorkspaceResultCodec.serialize(Result.err({ code: "storage_failed" }))
        ).unwrap();
      const key = await records.value.keyLedger();
      if (key.isErr())
        return (
          await cleanupWorkspaceResultCodec.serialize(Result.err({ code: "storage_failed" }))
        ).unwrap();
      const id = `op:${key.value}:${crypto.randomUUID()}`;
      let result: { groupsRemoved: number; tabsMoved: number; groupsRemaining: number } | undefined;
      const local = await bodyRequestDigest("cleanup", zeroHash);
      const reply = await submit(
        id,
        "maintenance",
        null,
        local,
        zeroHash,
        { maintenance: true, outcome: "not_dispatched" },
        async () => {
          let effect: import("@mpctl/contracts").MaintenanceEffect = {
            maintenance: true,
            outcome: "not_dispatched",
            placements: 0,
            auxiliaryCreated: [],
          };
          // Cleanup only moves tabs between groups. It does not reload, close or
          // replace any editor, so document write ownership is unaffected.
          const cleaned = await pages.cleanupWorkspace({
            async dispatch(_code, action) {
              effect.outcome = "unknown";
              return action();
            },
            async created(role) {
              if (role !== "editor")
                effect.auxiliaryCreated = [...new Set([...effect.auxiliaryCreated!, role])];
            },
            async placed() {
              effect.placements = (effect.placements ?? 0) + 1;
            },
            async bound() {},
            sourceReady() {},
            uncertain() {},
          });
          if (cleaned.isErr())
            return {
              effect,
              result: {
                status: "error",
                error: {
                  code: "page_failed",
                  cause: {
                    at: "bg.navigation",
                    kind: cleaned.error.observedFailure?.kind ?? "domain",
                    code: cleaned.error.observedFailure?.causeCode ?? cleaned.error.code,
                  },
                },
              },
            };
          result = cleaned.value;
          return { effect: { ...effect, outcome: "confirmed" }, result: success };
        },
      );
      if (reply.isErr())
        return (
          await cleanupWorkspaceResultCodec.serialize(
            Result.err({ code: "storage_failed", issue: reply.error }),
          )
        ).unwrap();
      if (result && !reply.value.issue)
        return (await cleanupWorkspaceResultCodec.serialize(Result.ok(result))).unwrap();
      const snapshot = reply.value.snapshot;
      return (
        await cleanupWorkspaceResultCodec.serialize(
          Result.err({
            code: "page_failed",
            snapshot,
            ...(reply.value.issue ? { issue: reply.value.issue } : {}),
          }),
        )
      ).unwrap();
    },
    async listAssets(article, options) {
      const reference = references.get(article);
      if (!reference)
        return (
          await assetListResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const checked = await valid(reference);
      if (checked.isErr()) return (await assetListResultCodec.serialize(checked)).unwrap();
      let uploaded: { filename: string; thumbnailUrl: string } | undefined;
      if (options !== undefined) {
        const parsed = v.safeParse(v.strictObject({ operation: operationIdSchema }), options);
        if (!parsed.success)
          return (
            await assetListResultCodec.serialize(Result.err({ code: "invalid_payload" }))
          ).unwrap();
        const records = await ledger();
        if (records.isErr())
          return (
            await assetListResultCodec.serialize(Result.err({ code: "storage_failed" }))
          ).unwrap();
        const stored = await records.value.record(parsed.output.operation);
        if (stored.isErr())
          return (
            await assetListResultCodec.serialize(Result.err({ code: "target_unavailable" }))
          ).unwrap();
        const { snapshot, binding } = stored.value;
        if (snapshot.operation !== "upload")
          return (
            await assetListResultCodec.serialize(Result.err({ code: "invalid_payload" }))
          ).unwrap();
        if (snapshot.effect.outcome !== "confirmed")
          return (
            await assetListResultCodec.serialize(Result.err({ code: "asset_upload_unknown" }))
          ).unwrap();
        const context = new URL(reference.binding.url).searchParams.get("token");
        // Rebind only within the original account context. Never treat a title
        // or filename in another account as the uploaded resource.
        if (
          !context ||
          !binding?.contextDigest ||
          binding.contextDigest !== (await bodyRequestDigest(context, zeroHash))
        )
          return (
            await assetListResultCodec.serialize(Result.err({ code: "relationship_unknown" }))
          ).unwrap();
        uploaded = snapshot.effect;
      }
      const listed = await pages.listMaterials(reference.binding);
      if (listed.isErr())
        return (await assetListResultCodec.serialize(Result.err(readError(listed.error)))).unwrap();
      const after = await valid(reference);
      if (after.isErr()) return (await assetListResultCodec.serialize(after)).unwrap();
      const fingerprint = (card: { filename: string; thumbnailUrl?: string }) =>
        JSON.stringify([card.filename, card.thumbnailUrl ?? null]);
      const visible = new Set(listed.value.cards.map(fingerprint));
      if (visible.size !== listed.value.cards.length)
        return (
          await assetListResultCodec.serialize(Result.err({ code: "asset_list_failed" }))
        ).unwrap();
      const cards = listed.value.cards.map((card) => {
        return rememberAsset(article, card);
      });
      for (const [handle, card] of assets)
        if (card.article === article && !visible.has(fingerprint(card))) assets.delete(handle);
      const selected = uploaded
        ? cards.filter((card) => fingerprint(card) === fingerprint(uploaded!))
        : cards;
      if (uploaded && selected.length !== 1)
        return (
          await assetListResultCodec.serialize(
            Result.err({ code: selected.length ? "asset_ambiguous" : "target_unavailable" }),
          )
        ).unwrap();
      return (
        await assetListResultCodec.serialize(Result.ok({ scope: "visible-page", cards: selected }))
      ).unwrap();
    },
    async getOperation(id) {
      const records = await ledger();
      if (records.isErr()) return encode(records);
      const stored = await records.value.record(id);
      if (stored.isErr()) return encode(stored);
      const record = stored.value;
      if (
        record.schemaVersion === 2 ||
        !record.binding ||
        record.snapshot.effect.outcome === "confirmed" ||
        record.snapshot.effect.outcome === "not_dispatched" ||
        calls.has(id)
      )
        return encode(Result.ok({ snapshot: record.snapshot }));
      const receipt =
        record.snapshot.operation === "body"
          ? await pages.getBodyReceipt(record.binding, id)
          : record.snapshot.operation === "fields"
            ? await pages.getFieldsReceipt(record.binding, id)
            : record.snapshot.operation === "upload"
              ? await pages.getUploadReceipt(record.binding, id)
              : record.snapshot.operation === "cover" || record.snapshot.operation === "save"
                ? await pages.getExecutionReceipt(record.binding, id, record.snapshot.operation)
                : Result.ok(null);
      if (receipt.isErr() || !receipt.value)
        return encode(
          Result.ok({
            snapshot: record.snapshot,
            issue: {
              operationId: id,
              failure: receipt.isErr() ? receipt.error : { code: "receipt_missing" },
            },
          }),
        );
      if (receipt.value.operationId !== id)
        return encode(
          Result.ok({
            snapshot: record.snapshot,
            issue: { failure: { code: "evidence_conflict" } },
          }),
        );
      const recorded = await records.value.receipt(id, receipt.value);
      return encode(
        recorded.isOk()
          ? recorded
          : Result.ok({ snapshot: record.snapshot, issue: recorded.error }),
      );
    },
    async writeBody(input) {
      const parsed = v.safeParse(writeBodyInputSchema, input);
      if (!parsed.success) return encode(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const hashed = await Result.tryPromise({
        try: () => bodyRequestDigest(input.html, input.expectedHash),
        catch: () => ({ failure: { code: "hash_failed" as const } }),
      });
      if (hashed.isErr()) return encode(hashed);
      const local = hashed.value;
      return encode(
        await submit(
          input.operationId,
          "body",
          input.article,
          local,
          input.expectedHash,
          { outcome: "not_dispatched" },
          async (records) => {
            const reference = references.get(input.article);
            const refused = (error: Failure): Facts => ({
              effect: { outcome: "not_dispatched" },
              result: { status: "error", error },
            });
            if (!reference) return refused({ code: "target_unavailable" });
            const checked = await valid(reference);
            if (checked.isErr()) return refused(boundary(checked.error));
            const editor = await pages.open(reference.binding);
            if (editor.isErr()) return refused(boundary(editor.error));
            const identity = await editor.value.ready();
            if (identity.isErr())
              return refused(
                boundary(
                  identity.error,
                  identity.error.readFailure?.stage === "page_decode"
                    ? "bg.page_decode"
                    : "bg.page_call",
                ),
              );
            const binding = await target(reference, identity.value.executorId);
            const bound = await records.bind(input.operationId, binding);
            if (bound.isErr()) return refused(bound.error.failure);
            const receipt = await editor.value.setContent(input.html, input.expectedHash, {
              operationId: input.operationId,
              executorId: binding.executorId,
            });
            if (receipt.isErr())
              return {
                effect: receipt.error.notInvoked
                  ? { outcome: "not_dispatched" as const }
                  : { outcome: "unknown" as const },
                result: { status: "error", error: businessFailure(receipt.error) },
              };
            return nativeFacts(receipt.value, input.operationId, binding.executorId, local, {
              outcome: "unknown",
            });
          },
        ),
      );
    },
    async updateArticleFields(input) {
      const parsed = v.safeParse(updateFieldsInputSchema, input);
      if (!parsed.success) return encode(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const initial = initialFieldsEffect(input.fields);
      const hashed = await digestRequest(() =>
        fieldsRequestDigest(input.fields, input.expectedHash),
      );
      if (hashed.isErr()) return encode(hashed);
      const local = hashed.value;
      return encode(
        await submit(
          input.operationId,
          "fields",
          input.article,
          local,
          input.expectedHash,
          initial,
          async (records) => {
            const refused = (error: Failure): Facts => ({
              effect: initial,
              result: { status: "error", error },
            });
            const reference = references.get(input.article);
            if (!reference) return refused({ code: "target_unavailable" });
            const checked = await valid(reference);
            if (checked.isErr()) return refused(boundary(checked.error));
            const identity = await pages.fieldsIdentity(reference.binding);
            if (identity.isErr()) return refused(identity.error);
            const binding = await target(reference, identity.value.executorId);
            const bound = await records.bind(input.operationId, binding);
            if (bound.isErr()) return refused(bound.error.failure);
            const receipt = await pages.updateArticleFields(
              reference.binding,
              input.fields,
              input.expectedHash,
              { operationId: input.operationId, executorId: binding.executorId },
            );
            const unknown = { ...initial, outcome: "unknown" as const };
            return receipt.isErr()
              ? {
                  effect: receipt.error.notInvoked ? initial : unknown,
                  result: { status: "error", error: businessFailure(receipt.error) },
                }
              : nativeFacts(receipt.value, input.operationId, binding.executorId, local, unknown);
          },
        ),
      );
    },
    async resolveAsset(article, asset) {
      const reference = references.get(article);
      const card = assets.get(asset);
      if (!reference || !card || card.article !== article || !card.thumbnailUrl)
        return (
          await assetImageResultCodec.serialize(Result.err({ code: "target_unavailable" }))
        ).unwrap();
      const checked = await valid(reference);
      if (checked.isErr()) return (await assetImageResultCodec.serialize(checked)).unwrap();
      const image = await pages.resolveImage(reference.binding, {
        filename: card.filename,
        thumbnailUrl: card.thumbnailUrl,
      });
      return (
        await assetImageResultCodec.serialize(
          image.isErr() ? Result.err(readError(image.error)) : Result.ok(image.value),
        )
      ).unwrap();
    },
    async uploadAsset(input) {
      const parsed = v.safeParse(assetUploadInputSchema, input);
      if (!parsed.success) return encode(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const payload = { blob: input.blob, filename: input.filename, mimeType: input.mimeType };
      if (!(await validAssetSignature(payload)))
        return encode(Result.err({ failure: { code: "invalid_asset" } }));
      const hashed = await digestRequest(() => assetRequestDigest(payload));
      if (hashed.isErr()) return encode(hashed);
      const local = hashed.value;
      let card: { filename: string; thumbnailUrl: string } | undefined;
      const initial = { outcome: "not_dispatched" as const, filename: input.filename };
      const reply = await submit(
        input.operationId,
        "upload",
        input.article,
        local,
        zeroHash,
        initial,
        async (records) => {
          const refused = (error: Failure): Facts => ({
            effect: initial,
            result: { status: "error", error },
          });
          const reference = references.get(input.article);
          if (!reference) return refused({ code: "target_unavailable" });
          const checked = await valid(reference);
          if (checked.isErr()) return refused(boundary(checked.error));
          const identity = await pages.materialIdentity(reference.binding);
          if (identity.isErr()) return refused(identity.error);
          const binding = await target(reference, identity.value.executorId);
          const bound = await records.bind(input.operationId, binding);
          if (bound.isErr()) return refused(bound.error.failure);
          const receipt = await pages.uploadMaterial(reference.binding, payload, {
            operationId: input.operationId,
            executorId: binding.executorId,
          });
          const unknown = { ...initial, outcome: "unknown" as const };
          if (receipt.isErr())
            return {
              effect: receipt.error.notInvoked ? initial : unknown,
              result: { status: "error", error: businessFailure(receipt.error) },
            };
          const facts = nativeFacts(
            receipt.value,
            input.operationId,
            binding.executorId,
            local,
            unknown,
          );
          if (facts.result.status === "ok" && receipt.value.effect.outcome === "confirmed") {
            const after = await valid(reference);
            if (after.isErr())
              return { ...facts, result: { status: "error", error: boundary(after.error) } };
            card = {
              filename: receipt.value.effect.filename,
              thumbnailUrl: receipt.value.effect.thumbnailUrl,
            };
          }
          return facts;
        },
      );
      if (reply.isOk() && card && !reply.value.issue) {
        const reference = references.get(input.article)!;
        const checked = await valid(reference);
        if (checked.isErr())
          return encode(Result.ok({ ...reply.value, issue: { failure: boundary(checked.error) } }));
        return encode(Result.ok({ ...reply.value, asset: rememberAsset(input.article, card) }));
      }
      return encode(reply);
    },
    async setArticleCover(input) {
      const parsed = v.safeParse(articleCoverSetInputSchema, input);
      if (!parsed.success) return encode(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const hashed = await digestRequest(() =>
        "bodyImage" in input
          ? bodyCoverRequestDigest(input)
          : coverRequestDigest(input.asset, input.expectedCoverHash),
      );
      if (hashed.isErr()) return encode(hashed);
      const local = hashed.value;
      const initial = { cover: true as const, outcome: "not_dispatched" as const };
      return encode(
        await submit(
          input.operationId,
          "cover",
          input.article,
          local,
          zeroHash,
          initial,
          async (records) => {
            const refused = (error: Failure): Facts => ({
              effect: initial,
              result: { status: "error", error },
            });
            const reference = references.get(input.article);
            if (!reference) return refused({ code: "target_unavailable" });
            const checked = await valid(reference);
            if (checked.isErr()) return refused(boundary(checked.error));
            const source = "asset" in input ? assets.get(input.asset) : undefined;
            if (
              "asset" in input &&
              (!source || source.article !== input.article || !source.thumbnailUrl)
            )
              return refused({ code: "target_unavailable" });
            const current = await pages.readArticleCover(reference.binding);
            if (current.isErr()) return refused(boundary(current.error));
            if (current.value !== input.expectedCoverHash)
              return refused({ code: "content_conflict" });
            let executorId: string;
            if ("bodyImage" in input) {
              const editor = await pages.open(reference.binding);
              if (editor.isErr()) return refused(boundary(editor.error));
              const ready = await editor.value.ready();
              if (ready.isErr()) return refused(boundary(ready.error));
              executorId = ready.value.executorId;
            } else {
              const identity = await pages.coverIdentity(reference.binding);
              if (identity.isErr()) return refused(identity.error);
              executorId = identity.value.executorId;
            }
            const bound = await records.bind(
              input.operationId,
              await target(reference, executorId),
            );
            if (bound.isErr()) return refused(bound.error.failure);
            const receipt =
              "bodyImage" in input
                ? await pages.setCoverFromBody(reference.binding, {
                    operationId: input.operationId,
                    executorId,
                    bodyImage: input.bodyImage,
                    expectedBodyHash: input.expectedBodyHash,
                    expectedCoverHash: input.expectedCoverHash,
                  })
                : await pages.setArticleCover(
                    reference.binding,
                    { filename: source!.filename, thumbnailUrl: source!.thumbnailUrl! },
                    input.expectedCoverHash,
                    { operationId: input.operationId, executorId, asset: input.asset },
                  );
            const unknown = { cover: true as const, outcome: "unknown" as const };
            if (receipt.isErr())
              return {
                effect: receipt.error.notInvoked ? initial : unknown,
                result: { status: "error", error: businessFailure(receipt.error) },
              };
            const facts = nativeFacts(receipt.value, input.operationId, executorId, local, unknown);
            if (facts.result.status === "ok") {
              const after = await valid(reference);
              if (after.isErr())
                return { ...facts, result: { status: "error", error: boundary(after.error) } };
            }
            return facts;
          },
        ),
      );
    },
    async saveArticle(input) {
      const parsed = v.safeParse(articleSaveInputSchema, input);
      if (!parsed.success) return encode(Result.err({ failure: { code: "invalid_operation" } }));
      input = parsed.output;
      const hashed = await digestRequest(() => saveRequestDigest(input));
      if (hashed.isErr()) return encode(hashed);
      const local = hashed.value;
      const initial = { outcome: "not_dispatched" as const, persistence: "unverified" as const };
      return encode(
        await submit(
          input.operationId,
          "save",
          input.article,
          local,
          zeroHash,
          initial,
          async (records) => {
            const refused = (error: Failure): Facts => ({
              effect: initial,
              result: { status: "error", error },
            });
            const reference = references.get(input.article);
            if (!reference) return refused({ code: "target_unavailable" });
            const checked = await valid(reference);
            if (checked.isErr()) return refused(boundary(checked.error));
            const identity = await pages.coverIdentity(reference.binding);
            if (identity.isErr()) return refused(identity.error);
            const binding = await target(reference, identity.value.executorId);
            const previous = await records.savedRequests(binding);
            if (previous.isErr()) return refused(previous.error.failure);
            const blocker = previous.value.find(
              (item) => item.snapshot.operationId !== input.operationId,
            );
            if (blocker)
              return refused({
                code: "operation_blocked",
                blockingOperationId: blocker.snapshot.operationId,
              });
            const content = await body(reference);
            if (content.isErr()) return refused(boundary(content.error));
            const fields = await inspect(input.article);
            if (fields.isErr()) return refused(boundary(fields.error));
            const image = await cover(input.article);
            if (image.isErr()) return refused(boundary(image.error));
            if (
              content.value.bodyHash !== input.expectedBodyHash ||
              fields.value.fieldsHash !== input.expectedFieldsHash ||
              image.value.coverHash !== input.expectedCoverHash
            )
              return refused({ code: "content_conflict" });
            const bound = await records.bind(input.operationId, binding);
            if (bound.isErr()) return refused(bound.error.failure);
            const pending = await records.savedRequests(binding);
            if (pending.isErr()) return refused(pending.error.failure);
            const overlapping = pending.value.find(
              (record) => record.snapshot.operationId !== input.operationId,
            );
            if (overlapping)
              return refused({
                code: "operation_blocked",
                blockingOperationId: overlapping.snapshot.operationId,
              });
            const receipt = await pages.saveArticle(reference.binding, {
              operationId: input.operationId,
              executorId: binding.executorId,
              expectedBodyHash: input.expectedBodyHash,
              expectedFieldsHash: input.expectedFieldsHash,
              expectedCoverHash: input.expectedCoverHash,
            });
            const unknown = { ...initial, outcome: "unknown" as const };
            return receipt.isErr()
              ? {
                  effect: receipt.error.notInvoked ? initial : unknown,
                  result: { status: "error", error: businessFailure(receipt.error) },
                }
              : nativeFacts(receipt.value, input.operationId, binding.executorId, local, unknown);
          },
        ),
      );
    },
  };
}
