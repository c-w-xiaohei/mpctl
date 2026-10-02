import { Result } from "better-result";
import {
  articleResultCodec,
  cleanupWorkspaceResultCodec,
  listArticlesResultCodec,
  workspaceResultCodec,
  writeBodyResultCodec,
  type ArticleResult,
  type WorkspaceService,
  type WorkspaceWireResult,
} from "@mpctl/contracts";
import type { ArticleNavigationStage } from "@mpctl/contracts";
import { classifyAppmsgUrl, type PageBinding, type createPageManager } from "./pages";
import { hashBody } from "./mp/body-hash";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
} from "./page-contracts";

type Pages = ReturnType<typeof createPageManager>;
type Binding = PageBinding;
type ArticleBinding = { binding: Binding; groupId?: string };
type FailureCode =
  | "target_unavailable"
  | "target_ambiguous"
  | "content_conflict"
  | "not_logged_in"
  | "page_failed"
  | "write_unknown";
const fail = <T>(
  code: FailureCode,
  stage?: ArticleNavigationStage,
  pageCreated?: boolean,
): import("@mpctl/contracts").WorkspaceResult<T> =>
  Result.err({
    code,
    ...(stage ? { stage } : {}),
    ...(pageCreated ? { pageCreated: true } : {}),
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
  const encoded = await codec.serialize(result);
  return Result.isError(encoded)
    ? { status: "error" as const, error: encoded.error }
    : encoded.value;
}

async function readEditorResult<T>(
  codec: {
    deserialize(value: unknown): Promise<import("better-result").Result<T, { code: string }>>;
  },
  operation: () => unknown,
): Promise<import("better-result").Result<T, { code: string }>> {
  const remote = await Result.tryPromise({
    try: () => Promise.resolve(operation()),
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(remote)) return remote;
  return codec.deserialize(remote.value);
}

export function createWorkspace({ pages }: { pages: Pages }): WorkspaceService {
  const references = new Map<string, ArticleBinding>();
  const remember = (
    binding: Binding,
    title: string,
    bodyHash: string,
    groupId?: string,
  ): import("@mpctl/contracts").WorkspaceResult<ArticleResult> => {
    const article = `ephemeral:${crypto.randomUUID()}`;
    references.set(article, {
      binding,
      ...(groupId ? { groupId } : {}),
    });
    return ok({ article, title, bodyHash });
  };
  const pageFailure = (error: { code: string }): FailureCode => {
    if (error.code === "target_unavailable") return "target_unavailable";
    if (error.code === "target_ambiguous") return "target_ambiguous";
    if (error.code === "not_logged_in") return "not_logged_in";
    if (error.code === "navigation_failed") return "target_unavailable";
    return "page_failed";
  };
  const pageFailureResult = <T>(
    error: { code: string; stage?: ArticleNavigationStage; pageCreated?: boolean },
    pageCreated = false,
  ): import("@mpctl/contracts").WorkspaceResult<T> =>
    fail(
      pageFailure(error),
      error.code === "navigation_failed" ? error.stage : undefined,
      pageCreated || error.pageCreated,
    );
  const validate = async (
    reference: ArticleBinding,
    pageCreated = false,
  ): Promise<import("@mpctl/contracts").WorkspaceResult<void>> => {
    const current = await pages.isCurrent(reference.binding);
    if (Result.isError(current)) return pageFailureResult(current.error, pageCreated);
    if (!current.value) return fail("target_unavailable", undefined, pageCreated);
    if (reference.groupId) {
      const saved = await pages.validateSavedArticle(reference.binding, reference.groupId);
      if (Result.isError(saved)) return pageFailureResult(saved.error, pageCreated);
      if (!saved.value.valid) return fail("target_unavailable", undefined, pageCreated);
    }
    const status = await pages.pageStatus(reference.binding);
    if (Result.isError(status)) return pageFailureResult(status.error, pageCreated);
    const stillCurrent = await pages.isCurrent(reference.binding);
    if (Result.isError(stillCurrent)) return pageFailureResult(stillCurrent.error, pageCreated);
    if (!stillCurrent.value) return fail("target_unavailable", undefined, pageCreated);
    if (status.value.state === "not_logged_in")
      return fail("not_logged_in", undefined, pageCreated);
    if (status.value.state !== "ready") return fail("page_failed", undefined, pageCreated);
    return Result.ok(undefined);
  };
  return {
    async cleanupWorkspace() {
      const cleaned = await pages.cleanupWorkspace();
      return encodeWorkspace(
        cleanupWorkspaceResultCodec,
        Result.isError(cleaned) ? fail(pageFailure(cleaned.error)) : ok(cleaned.value),
      );
    },
    async listArticles() {
      const list = await pages.ensureDraftList();
      if (Result.isError(list))
        return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(list.error)));
      const current = await pages.isCurrent(list.value);
      if (Result.isError(current))
        return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(current.error)));
      if (!current.value)
        return encodeWorkspace(listArticlesResultCodec, fail("target_unavailable"));
      const groups = await pages.listDraftGroups(list.value);
      if (Result.isError(groups))
        return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(groups.error)));
      const currentAfterRead = await pages.isCurrent(list.value);
      if (Result.isError(currentAfterRead))
        return encodeWorkspace(listArticlesResultCodec, fail(pageFailure(currentAfterRead.error)));
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
    },
    async openArticle(groupId) {
      const list = await pages.ensureDraftList();
      if (Result.isError(list))
        return encodeWorkspace(articleResultCodec, pageFailureResult(list.error));
      const groups = await pages.listDraftGroups(list.value);
      if (Result.isError(groups))
        return encodeWorkspace(articleResultCodec, fail(pageFailure(groups.error)));
      const matches = groups.value.filter((group) => group.groupId === groupId);
      const listCurrent = await pages.isCurrent(list.value);
      if (Result.isError(listCurrent))
        return encodeWorkspace(articleResultCodec, fail(pageFailure(listCurrent.error)));
      if (matches.length !== 1 || !listCurrent.value)
        return encodeWorkspace(articleResultCodec, fail("target_unavailable"));
      let stage: ArticleNavigationStage = "native_target_missing";
      const opened = await pages.openDraftGroup(list.value, groupId);
      if (Result.isError(opened))
        return encodeWorkspace(articleResultCodec, pageFailureResult(opened.error));
      if (!opened.value)
        return encodeWorkspace(articleResultCodec, fail("target_unavailable", stage));
      const binding = opened.value;
      const reference = { binding, groupId };
      const valid = await validate(reference, true);
      if (Result.isError(valid)) return encodeWorkspace(articleResultCodec, valid);
      stage = "editor_bootstrap_failed";
      const editorResult = await pages.open(binding);
      if (Result.isError(editorResult))
        return encodeWorkspace(articleResultCodec, pageFailureResult(editorResult.error, true));
      const readiness = await readEditorResult(pageEditorReadyResultCodec, () =>
        editorResult.value.ready(),
      );
      if (Result.isError(readiness))
        return encodeWorkspace(articleResultCodec, pageFailureResult(readiness.error, true));
      if (!readiness.value.isReady || !readiness.value.isNew)
        return encodeWorkspace(articleResultCodec, fail("page_failed", stage, true));
      const content = await readEditorResult(pageEditorContentResultCodec, () =>
        editorResult.value.getContent(),
      );
      if (Result.isError(content))
        return encodeWorkspace(articleResultCodec, pageFailureResult(content.error, true));
      const bodyHash = await hashBody(content.value);
      if (Result.isError(bodyHash))
        return encodeWorkspace(articleResultCodec, fail("page_failed", stage, true));
      const finalValid = await validate(reference, true);
      if (Result.isError(finalValid))
        return encodeWorkspace(articleResultCodec, pageFailureResult(finalValid.error, true));
      return encodeWorkspace(
        articleResultCodec,
        remember(binding, matches[0]!.title, bodyHash.value, groupId),
      );
    },
    async newArticle() {
      const opened = await pages.ensureEditorTab();
      if (Result.isError(opened))
        return encodeWorkspace(articleResultCodec, pageFailureResult(opened.error));
      const binding = opened.value;
      const stage: ArticleNavigationStage = "editor_bootstrap_failed";
      if (classifyAppmsgUrl(binding.url).kind !== "new")
        return encodeWorkspace(articleResultCodec, fail("target_unavailable", undefined, true));
      const reference = { binding };
      const valid = await validate(reference, true);
      if (Result.isError(valid)) return encodeWorkspace(articleResultCodec, valid);
      const editor = await pages.open(binding);
      if (Result.isError(editor))
        return encodeWorkspace(articleResultCodec, pageFailureResult(editor.error, true));
      const readiness = await readEditorResult(pageEditorReadyResultCodec, () =>
        editor.value.ready(),
      );
      if (Result.isError(readiness))
        return encodeWorkspace(articleResultCodec, pageFailureResult(readiness.error, true));
      if (!readiness.value.isReady || !readiness.value.isNew)
        return encodeWorkspace(articleResultCodec, fail("page_failed", stage, true));
      const content = await readEditorResult(pageEditorContentResultCodec, () =>
        editor.value.getContent(),
      );
      if (Result.isError(content))
        return encodeWorkspace(articleResultCodec, pageFailureResult(content.error, true));
      const bodyHash = await hashBody(content.value);
      if (Result.isError(bodyHash))
        return encodeWorkspace(articleResultCodec, fail("page_failed", stage, true));
      const finalValid = await validate(reference, true);
      if (Result.isError(finalValid))
        return encodeWorkspace(articleResultCodec, pageFailureResult(finalValid.error, true));
      return encodeWorkspace(articleResultCodec, remember(binding, "", bodyHash.value));
    },
    async currentArticle() {
      const found = await pages.findCurrentEditor();
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
      const readiness = await readEditorResult(pageEditorReadyResultCodec, () =>
        editor.value.ready(),
      );
      if (Result.isError(readiness))
        return encodeWorkspace(articleResultCodec, pageFailureResult(readiness.error));
      if (!readiness.value.isReady || !readiness.value.isNew)
        return encodeWorkspace(articleResultCodec, fail("page_failed"));
      const content = await readEditorResult(pageEditorContentResultCodec, () =>
        editor.value.getContent(),
      );
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
      const content = await readEditorResult(pageEditorContentResultCodec, () =>
        editor.value.getContent(),
      );
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
    async writeBody(article, html, expectedHash) {
      const reference = references.get(article);
      if (!reference) return encodeWorkspace(writeBodyResultCodec, fail("target_unavailable"));
      if (!/^[0-9a-f]{64}$/.test(expectedHash))
        return encodeWorkspace(writeBodyResultCodec, fail("content_conflict"));
      const valid = await validate(reference);
      if (Result.isError(valid)) return encodeWorkspace(writeBodyResultCodec, valid);
      const editor = await pages.open(reference.binding);
      if (Result.isError(editor))
        return encodeWorkspace(writeBodyResultCodec, pageFailureResult(editor.error));
      const result = await readEditorResult(pageEditorWriteResultCodec, () =>
        editor.value.setContent(html, expectedHash),
      );
      if (Result.isError(result))
        return encodeWorkspace(
          writeBodyResultCodec,
          fail(
            result.error.code === "content_conflict"
              ? "content_conflict"
              : result.error.code === "write_unknown"
                ? "write_unknown"
                : "page_failed",
            undefined,
          ),
        );
      return encodeWorkspace(writeBodyResultCodec, ok({ bodyHash: result.value.bodyHash }));
    },
  };
}
