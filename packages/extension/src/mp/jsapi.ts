import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import type { PageEditorError, PageEditorService } from "../page-contracts";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
  pageEditorReceiptResultCodec,
  bodyExecutionSchema,
  bodyRequestDigest,
  type BodyReceipt,
  type BodyExecution,
} from "../page-contracts";
import * as v from "valibot";
import type { Failure } from "@mpctl/contracts";
import { hashBody } from "./body-hash";
import { classifyAppmsgUrl } from "./routes";
import { readArticleCover, hashArticleCover } from "./article-cover";
import { readArticleFields, hashArticleFields } from "./article-fields";
import {
  bodyCoverExecutionSchema,
  bodyCoverRequestDigest,
  coverWriteResultCodec,
  coverReceiptResultCodec,
  type BodyCoverExecution,
  type CoverReceipt,
} from "../background-contracts";

export type EditorRequest = {
  apiName:
    | "mp_editor_get_isready"
    | "mp_editor_get_content"
    | "mp_editor_set_content"
    | "mp_editor_change_cover";
  apiParam: Record<string, never> | { content: string } | { oriImgUrl: string };
  sucCb(value: unknown): void;
  errCb(error: unknown): void;
};

export interface EditorJsapi {
  invoke(request: EditorRequest): unknown;
}

export interface EditorServiceOptions {
  invoke: EditorJsapi["invoke"] | undefined;
  timeoutMs?: number;
  validateTarget?(): boolean;
  document?: Document;
}

type EditorOutcome<T> = Promise<import("better-result").Result<T, PageEditorError>>;

export function createEditorService(options: EditorServiceOptions): PageEditorService {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let readyState: { isReady: true; isNew: boolean } | undefined;
  let writes = Promise.resolve();
  const executorId = crypto.randomUUID();
  const executions = new Map<
    string,
    {
      html?: string;
      expectedHash: string;
      execution: BodyExecution;
      digest: Promise<string>;
      promise: Promise<BodyReceipt | undefined>;
      receipt?: BodyReceipt;
      failure?: Failure;
    }
  >();
  const covers = new Map<
    string,
    { signature: string; task: Promise<void>; receipt?: CoverReceipt; failure?: Failure }
  >();

  const validateTarget = (): import("better-result").Result<void, PageEditorError> => {
    const checked = Result.try({
      try: () => options.validateTarget?.() ?? true,
      catch: () => ({ code: "target_unavailable" as const }),
    });
    if (Result.isError(checked)) return checked;
    return checked.value ? Result.ok() : Result.err({ code: "target_unavailable" });
  };

  function invoke(
    apiName: EditorRequest["apiName"],
    apiParam: EditorRequest["apiParam"],
    observation?: {
      dispatched(): void;
      callback(success: boolean): void;
      failed?(kind: "timeout" | "throw"): void;
    },
  ): EditorOutcome<unknown> {
    const target = validateTarget();
    if (Result.isError(target)) return Promise.resolve(target);

    return Promise.resolve(
      new Promise<import("better-result").Result<unknown, PageEditorError>>((resolve) => {
        let settled = false;
        const finish = (action: () => void) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          action();
        };
        const timer = setTimeout(
          () =>
            finish(() => {
              observation?.failed?.("timeout");
              resolve(Result.err({ code: "page_failed" }));
            }),
          timeoutMs,
        );
        const invoked = Result.try({
          try: () => {
            // Resolve the real native entry immediately before calling it. A local
            // unavailable adapter is not an issued native execution.
            const nativeInvoke = options.invoke;
            if (!nativeInvoke) {
              finish(() => resolve(Result.err({ code: "jsapi_unavailable" })));
              return;
            }
            observation?.dispatched();
            return nativeInvoke({
              apiName,
              apiParam,
              sucCb: (value) => {
                observation?.callback(true);
                finish(() => resolve(Result.ok(value)));
              },
              errCb: (error) => {
                observation?.callback(false);
                finish(() => resolve(Result.err(mapJsapiError(error))));
              },
            });
          },
          catch: mapJsapiError,
        });
        if (Result.isError(invoked)) {
          observation?.failed?.("throw");
          finish(() => resolve(Result.err(invoked.error)));
        }
      }),
    ).then((result) => result);
  }

  function ensureReady(): EditorOutcome<{ isReady: true; isNew: boolean }> {
    if (readyState) return Promise.resolve(Result.ok(readyState));
    return invoke("mp_editor_get_isready", {}).then((response) => {
      if (Result.isError(response)) return response;
      const value = response.value;
      const isReady = Result.try({
        try: () => isRecord(value) && value.isReady === true,
        catch: () => ({ code: "page_failed" as const }),
      });
      if (Result.isError(isReady)) return isReady;
      if (!isReady.value) return Result.err({ code: "editor_not_ready" });
      const isNew = Result.try({
        try: () => isRecord(value) && value.isNew,
        catch: () => ({ code: "identity_unavailable" as const }),
      });
      if (Result.isError(isNew)) return isNew;
      if (typeof isNew.value !== "boolean") return Result.err({ code: "identity_unavailable" });
      if (!isNew.value) return Result.err({ code: "unsupported_editor" });
      readyState = { isReady: true, isNew: isNew.value };
      return Result.ok(readyState);
    });
  }

  function getContent(): EditorOutcome<string> {
    return ensureReady().then((ready) => {
      if (Result.isError(ready)) return ready;
      return invoke("mp_editor_get_content", {}).then((response) => {
        if (Result.isError(response)) return response;
        const content = Result.try({
          try: () => {
            const value = response.value;
            return isRecord(value) && typeof value.content === "string"
              ? Result.ok(value.content)
              : Result.err({ code: "page_failed" as const });
          },
          catch: () => ({ code: "page_failed" as const }),
        });
        return Result.isError(content) ? content : content.value;
      });
    });
  }

  async function serialize<T, E extends { code: string }>(
    codec: {
      serialize(
        result: import("better-result").Result<T, E>,
      ): Promise<
        import("better-result").Result<
          SerializedResult<T, E | { code: "invalid_result_envelope" }>,
          { code: "invalid_result_envelope" }
        >
      >;
    },
    result: import("better-result").Result<T, E>,
  ): Promise<SerializedResult<T, E | { code: "invalid_result_envelope" }>> {
    const encoded = await codec.serialize(result);
    return Result.isOk(encoded) ? encoded.value : { status: "error", error: encoded.error };
  }

  return {
    async getCoverReceipt(operationId) {
      return serialize(
        coverReceiptResultCodec,
        Result.ok(covers.get(operationId)?.receipt ?? null),
      );
    },
    async setCoverFromBody(input: BodyCoverExecution) {
      const reject = async (code: Failure["code"]) =>
        serialize(coverWriteResultCodec, Result.err({ code }));
      if (!v.safeParse(bodyCoverExecutionSchema, input).success) return reject("invalid_operation");
      input = { ...input };
      if (input.executorId !== executorId) return reject("executor_mismatch");
      if (executions.has(input.operationId)) return reject("operation_conflict");
      const signature = JSON.stringify([
        input.executorId,
        input.bodyImage,
        input.expectedBodyHash,
        input.expectedCoverHash,
      ]);
      let entry = covers.get(input.operationId);
      if (entry) {
        if (entry.signature !== signature) return reject("operation_conflict");
        await entry.task;
        return entry.failure
          ? reject(entry.failure.code)
          : serialize(coverWriteResultCodec, Result.ok(entry.receipt!));
      }
      let finish!: () => void;
      entry = {
        signature,
        task: new Promise<void>((done) => {
          finish = done;
        }),
      };
      covers.set(input.operationId, entry); // Reserve all inputs before any await.
      const previous = writes;
      let release!: () => void;
      const node = new Promise<void>((done) => {
        release = done;
      });
      writes = previous.then(() => node);
      const receipt: CoverReceipt = {
        operationId: input.operationId,
        executorId,
        requestDigest: "0".repeat(64),
        effect: { cover: true, outcome: "not_dispatched" },
        ended: false,
      };
      let stopped = false;
      let callbackSuccess = false;
      let nativeFailure: "timeout" | "throw" | "error" | undefined;
      const fail = (
        code: Failure["code"],
        at: NonNullable<Failure["cause"]>["at"],
        causeCode: string = code,
      ) => {
        if (nativeFailure) {
          code = "cover_update_unknown";
          at = nativeFailure === "throw" ? "main.execution" : "main.jsapi_callback";
          causeCode =
            nativeFailure === "throw"
              ? "native_invoke_threw"
              : nativeFailure === "timeout"
                ? "native_callback_timeout"
                : "opaque_callback_error";
        }
        receipt.result = {
          status: "error",
          error: {
            code,
            cause: {
              at,
              kind: code === "hash_failed" || at === "main.execution" ? "runtime" : "domain",
              code: causeCode,
            },
          },
        };
      };
      try {
        receipt.requestDigest = await bodyCoverRequestDigest(input);
        entry.receipt = receipt;
        await previous;
        await (async () => {
          const document = options.document;
          if (!document?.defaultView?.DOMParser) {
            fail("unsupported", "main.preflight");
            return;
          }
          const route = classifyAppmsgUrl(document.location.href);
          if (route.kind !== "new" && route.kind !== "saved-editor") {
            fail("unsupported", "main.preflight");
            return;
          }
          const current = await getContent();
          if (current.isErr()) {
            fail(
              current.error.code === "target_unavailable" ? "target_unavailable" : "page_failed",
              "main.preflight",
              current.error.code,
            );
            return;
          }
          const bodyHash = await hashBody(current.value);
          if (bodyHash.isErr()) {
            fail("hash_failed", "main.preflight");
            return;
          }
          if (bodyHash.value !== input.expectedBodyHash) {
            fail("content_conflict", "main.preflight");
            return;
          }
          // Inert parse, no src/thumbnail fallback or URL transformation. Metadata is
          // supported shape only, not authentication of upload provenance.
          const parsed = new document.defaultView.DOMParser().parseFromString(
            current.value,
            "text/html",
          );
          const images = [...parsed.querySelectorAll("img")].filter(
            (image) =>
              !image.matches(
                '.separator, .wxw_separator, [data-type="separator"], [data-role="separator"]',
              ),
          );
          const image = images[input.bodyImage - 1];
          const source = image?.getAttribute("data-src");
          let url: URL | undefined;
          try {
            if (source) url = new URL(source);
          } catch {
            /* rejected below */
          }
          if (
            !image ||
            !source ||
            !source.startsWith("https://mmbiz.qpic.cn/") ||
            source !== source.trim() ||
            /[\s\\]/.test(source) ||
            !url ||
            url.protocol !== "https:" ||
            url.hostname !== "mmbiz.qpic.cn" ||
            url.username ||
            url.password ||
            url.port ||
            url.hash ||
            !/^\/(?:mmbiz_|sz_mmbiz_)/.test(url.pathname) ||
            !image.classList.contains("rich_pages") ||
            !image.classList.contains("wxw-img") ||
            !/^[1-9][0-9]*$/.test(image.getAttribute("data-imgfileid") ?? "") ||
            !["png", "jpeg", "jpg", "gif", "webp"].includes(
              image.getAttribute("data-type") ?? "",
            ) ||
            !/^(?:[1-9][0-9]*|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)$/.test(
              image.getAttribute("data-ratio") ?? "",
            ) ||
            !/^[1-9][0-9]*$/.test(image.getAttribute("data-w") ?? "")
          ) {
            fail("cover_input_unavailable", "main.preflight");
            return;
          }
          const cover = readArticleCover(document);
          const fields = readArticleFields(document);
          if (cover.isErr()) {
            fail(cover.error.code, "main.preflight");
            return;
          }
          if (fields.isErr()) {
            fail(fields.error.code, "main.preflight");
            return;
          }
          const coverHash = await hashArticleCover(cover.value);
          const fieldsHash = await hashArticleFields(fields.value);
          if (coverHash.isErr() || fieldsHash.isErr()) {
            fail("hash_failed", "main.preflight");
            return;
          }
          if (coverHash.value !== input.expectedCoverHash) {
            fail("content_conflict", "main.preflight");
            return;
          }
          const finalBody = await getContent();
          if (finalBody.isErr()) {
            fail("page_failed", "main.guard", finalBody.error.code);
            return;
          }
          if (finalBody.value !== current.value) {
            fail("content_conflict", "main.guard");
            return;
          }
          const finalCover = readArticleCover(document);
          const finalFields = readArticleFields(document);
          if (finalCover.isErr() || finalFields.isErr()) {
            fail("page_failed", "main.guard");
            return;
          }
          if (
            JSON.stringify(finalCover.value) !== JSON.stringify(cover.value) ||
            JSON.stringify(finalFields.value) !== JSON.stringify(fields.value)
          ) {
            fail("content_conflict", "main.guard");
            return;
          }
          if (validateTarget().isErr()) {
            fail("target_unavailable", "main.guard");
            return;
          }
          const written = await invoke(
            "mp_editor_change_cover",
            { oriImgUrl: source },
            {
              failed(kind) {
                nativeFailure ??= kind;
              },
              dispatched() {
                receipt.effect = { cover: true, outcome: "unknown" };
              },
              callback(success) {
                if (!success) nativeFailure ??= "error";
                if (success) {
                  callbackSuccess = true;
                  if (stopped) receipt.ended = true; // Facts only: no readback or outcome upgrade.
                }
              },
            },
          );
          if (written.isErr() || nativeFailure) {
            fail(
              receipt.effect.outcome === "not_dispatched" ? "page_failed" : "cover_update_unknown",
              "main.jsapi_callback",
              written.isErr() ? written.error.code : "opaque_callback_error",
            );
            return;
          }
          const updated = await getContent();
          if (updated.isErr()) {
            fail("page_failed", "main.readback", updated.error.code);
            return;
          }
          const updatedHash = await hashBody(updated.value);
          const updatedCover = readArticleCover(document);
          const updatedFields = readArticleFields(document);
          if (updatedHash.isErr()) {
            fail("hash_failed", "main.readback");
            return;
          }
          if (updatedCover.isErr()) {
            fail(updatedCover.error.code, "main.readback");
            return;
          }
          if (!updatedCover.value.primary.visible || !updatedCover.value.primary.url) {
            fail("cover_unavailable", "main.readback");
            return;
          }
          if (updatedFields.isErr()) {
            fail(updatedFields.error.code, "main.readback");
            return;
          }
          const updatedFieldsHash = await hashArticleFields(updatedFields.value);
          const updatedCoverHash = await hashArticleCover(updatedCover.value);
          if (updatedFieldsHash.isErr() || updatedCoverHash.isErr()) {
            fail("hash_failed", "main.readback");
            return;
          }
          if (validateTarget().isErr()) {
            fail("target_unavailable", "main.readback");
            return;
          }
          if (nativeFailure) {
            fail("cover_update_unknown", "main.jsapi_callback", "opaque_callback_error");
            return;
          }
          if (
            updatedHash.value !== input.expectedBodyHash ||
            updatedFieldsHash.value !== fieldsHash.value
          ) {
            fail("content_conflict", "main.readback");
            return;
          }
          Object.assign(receipt, {
            ended: true,
            effect: { cover: true, outcome: "confirmed", coverHash: updatedCoverHash.value },
            result: { status: "ok", value: {} },
          });
        })();
      } catch {
        if (!entry.receipt) entry.failure = { code: "hash_failed" };
        else
          fail(
            receipt.effect.outcome === "not_dispatched" ? "page_failed" : "cover_update_unknown",
            "main.execution",
          );
      } finally {
        stopped = true;
        receipt.ended = receipt.effect.outcome === "not_dispatched" || callbackSuccess;
        finish();
        release();
      }
      return entry.failure
        ? reject(entry.failure.code)
        : serialize(coverWriteResultCodec, Result.ok(receipt));
    },
    async ready() {
      const result = await ensureReady();
      return serialize(
        pageEditorReadyResultCodec,
        result.map((ready) => ({ ...ready, executorId })),
      );
    },
    async getContent() {
      const result = await getContent();
      return serialize(pageEditorContentResultCodec, result);
    },
    async getReceipt(operationId: string) {
      const entry = executions.get(operationId);
      return (
        await pageEditorReceiptResultCodec.serialize(Result.ok(entry?.receipt ?? null))
      ).unwrap();
    },
    async setContent(html: string, expectedHash: string, execution: BodyExecution) {
      const reject = async (code: Failure["code"]) =>
        (await pageEditorWriteResultCodec.serialize(Result.err({ code }))).unwrap();
      if (
        typeof html !== "string" ||
        typeof expectedHash !== "string" ||
        !/^[0-9a-f]{64}$/.test(expectedHash) ||
        !v.safeParse(bodyExecutionSchema, execution).success
      )
        return reject("invalid_operation");
      if (execution.executorId !== executorId) return reject("executor_mismatch");
      if (covers.has(execution.operationId)) return reject("operation_conflict");
      const existing = executions.get(execution.operationId);
      if (existing) {
        if (
          (existing.html !== undefined && existing.html !== html) ||
          existing.expectedHash !== expectedHash ||
          existing.execution.executorId !== execution.executorId
        )
          return reject("operation_conflict");
        if (existing.failure) return reject(existing.failure.code);
        try {
          if ((await existing.digest) !== (await bodyRequestDigest(html, expectedHash)))
            return reject("operation_conflict");
        } catch {
          return reject("hash_failed");
        }
        const receipt = await existing.promise;
        if (!receipt) return reject("hash_failed");
        return (await pageEditorWriteResultCodec.serialize(Result.ok(existing.receipt!))).unwrap();
      }
      // Reserve before hashing or entering the native queue. The original entry is never evicted.
      let resolve!: (receipt: BodyReceipt | undefined) => void;
      let resolveDigest!: (digest: string) => void;
      const entry: {
        html?: string;
        expectedHash: string;
        execution: BodyExecution;
        digest: Promise<string>;
        promise: Promise<BodyReceipt | undefined>;
        receipt?: BodyReceipt;
        failure?: Failure;
      } = {
        html,
        expectedHash,
        execution: { ...execution },
        digest: new Promise((done) => {
          resolveDigest = done;
        }),
        promise: new Promise((done) => {
          resolve = done;
        }),
      };
      executions.set(execution.operationId, entry);
      const previous = writes;
      let release!: () => void;
      const node = new Promise<void>((resolve) => {
        release = resolve;
      });
      // A failed digest may finish this node early, but successors still wait
      // for its predecessor's native work.
      writes = previous.then(() => node);
      let stopped = false;
      let callbackSuccess = false;
      let receipt: BodyReceipt = {
        ...execution,
        requestDigest: "0".repeat(64),
        effect: { outcome: "not_dispatched" },
        ended: false,
      };
      const fail = (
        code: Failure["code"],
        at: NonNullable<Failure["cause"]>["at"],
        causeCode: string = code,
      ) => {
        receipt.result = {
          status: "error",
          error: {
            code,
            cause: {
              at,
              kind: code === "hash_failed" || at === "main.execution" ? "runtime" : "domain",
              code: causeCode,
            },
          },
        };
      };
      try {
        receipt.requestDigest = await bodyRequestDigest(html, expectedHash);
        resolveDigest(receipt.requestDigest);
        entry.receipt = receipt;
        await previous;
        await (async () => {
          const current = await getContent();
          if (current.isErr()) {
            fail(
              current.error.code === "target_unavailable" ? "target_unavailable" : "page_failed",
              "main.preflight",
              current.error.code,
            );
            return;
          }
          const currentHash = await hashBody(current.value);
          if (currentHash.isErr()) {
            fail("hash_failed", "main.preflight");
            return;
          }
          if (currentHash.value !== expectedHash) {
            fail("content_conflict", "main.preflight");
            return;
          }
          const target = validateTarget();
          if (target.isErr()) {
            fail("target_unavailable", "main.guard");
            return;
          }
          const written = await invoke(
            "mp_editor_set_content",
            { content: html },
            {
              dispatched() {
                receipt.effect = { outcome: "unknown" };
              },
              callback(success) {
                if (!success) return; // Unspecified error callback is not proof native work stopped.
                callbackSuccess = true;
                if (stopped) receipt.ended = true; // Facts only; never resume readback after timeout.
              },
            },
          );
          if (written.isErr()) {
            fail(
              receipt.effect.outcome === "not_dispatched"
                ? written.error.code === "target_unavailable"
                  ? "target_unavailable"
                  : "page_failed"
                : "write_unknown",
              "main.jsapi_callback",
              written.error.code,
            );
            return;
          }
          const updated = await getContent();
          if (updated.isErr()) {
            fail("page_failed", "main.readback", updated.error.code);
            return;
          }
          const bodyHash = await hashBody(updated.value);
          if (bodyHash.isErr()) {
            fail("hash_failed", "main.readback");
            return;
          }
          if (validateTarget().isErr()) {
            fail("target_unavailable", "main.readback");
            return;
          }
          receipt.effect = { outcome: "confirmed", bodyHash: bodyHash.value };
          receipt.result = { status: "ok", value: {} };
        })();
      } catch {
        if (!entry.receipt) {
          entry.failure = { code: "hash_failed" };
          resolveDigest("");
        } else fail("page_failed", "main.execution");
      } finally {
        stopped = true;
        receipt.ended = receipt.effect.outcome === "not_dispatched" || callbackSuccess;
        entry.html = undefined;
        if (!entry.failure) entry.receipt = receipt;
        resolve(entry.receipt);
        release();
      }
      return entry.failure
        ? reject(entry.failure.code)
        : (await pageEditorWriteResultCodec.serialize(Result.ok(receipt))).unwrap();
    },
  };
}

function mapJsapiError(error: unknown): PageEditorError {
  return isRecord(error) && error.code === "jsapi_unavailable"
    ? { code: "jsapi_unavailable" }
    : { code: "page_failed" };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
