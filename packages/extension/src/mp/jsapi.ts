import { Result } from "better-result";
import type { SerializedResult } from "better-result";
import type { PageEditorError, PageEditorService } from "../page-contracts";
import {
  pageEditorContentResultCodec,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
} from "../page-contracts";
import { hashBody } from "./body-hash";

export type EditorRequest = {
  apiName: "mp_editor_get_isready" | "mp_editor_get_content" | "mp_editor_set_content";
  apiParam: Record<string, never> | { content: string };
  sucCb(value: unknown): void;
  errCb(error: unknown): void;
};

export interface EditorJsapi {
  invoke(request: EditorRequest): unknown;
}

export interface EditorServiceOptions {
  invoke: EditorJsapi["invoke"];
  timeoutMs?: number;
  validateTarget?(): boolean;
}

type EditorOutcome<T> = Promise<import("better-result").Result<T, PageEditorError>>;

export function createEditorService(options: EditorServiceOptions): PageEditorService {
  const timeoutMs = options.timeoutMs ?? 5_000;
  let readyState: { isReady: true; isNew: boolean } | undefined;
  let writes = Promise.resolve();

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
          () => finish(() => resolve(Result.err({ code: "page_failed" }))),
          timeoutMs,
        );
        const invoked = Result.try({
          try: () =>
            options.invoke({
              apiName,
              apiParam,
              sucCb: (value) => finish(() => resolve(Result.ok(value))),
              errCb: (error) => finish(() => resolve(Result.err(mapJsapiError(error)))),
            }),
          catch: mapJsapiError,
        });
        if (Result.isError(invoked)) finish(() => resolve(Result.err(invoked.error)));
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

  async function serialize<T, E extends PageEditorError>(
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
    async ready() {
      const result = await ensureReady();
      return serialize(pageEditorReadyResultCodec, result);
    },
    async getContent() {
      const result = await getContent();
      return serialize(pageEditorContentResultCodec, result);
    },
    async setContent(html: string, expectedHash: string) {
      const previous = writes;
      let release!: () => void;
      writes = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;

      let dispatched = false;
      try {
        const result = await (async (): EditorOutcome<{ bodyHash: string }> => {
          if (typeof html !== "string" || !/^[0-9a-f]{64}$/.test(expectedHash))
            return Result.err({ code: "content_conflict" });
          const current = await getContent();
          if (Result.isError(current)) return current;
          const currentHash = await hashBody(current.value);
          if (Result.isError(currentHash)) return Result.err({ code: "page_failed" });
          if (currentHash.value !== expectedHash) return Result.err({ code: "content_conflict" });
          const target = validateTarget();
          if (Result.isError(target)) return target;

          dispatched = true;
          const written = await invoke("mp_editor_set_content", { content: html });
          if (Result.isError(written)) return Result.err({ code: "write_unknown" });
          const updated = await getContent();
          if (Result.isError(updated)) return Result.err({ code: "write_unknown" });
          const bodyHash = await hashBody(updated.value);
          return Result.isError(bodyHash)
            ? Result.err({ code: "write_unknown" })
            : Result.ok({ bodyHash: bodyHash.value });
        })();
        const finalResult =
          Result.isError(result) && dispatched
            ? Result.err({ code: "write_unknown" as const })
            : result;
        return serialize(pageEditorWriteResultCodec, finalResult);
      } finally {
        release();
      }
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
