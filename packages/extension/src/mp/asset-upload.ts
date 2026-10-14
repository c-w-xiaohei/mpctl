import { Result } from "better-result";
import {
  assetPayloadSchema,
  validAssetSignature,
  assetUploadTimeouts,
  type Failure,
} from "@mpctl/contracts";
import * as v from "valibot";
import {
  readMaterialCards,
  openMaterialLibrary,
  closeMaterialLibrary,
  type MaterialLibrarySession,
  type MaterialLibraryError,
} from "./material-library";

export type AssetUploadGuardError = {
  code: "not_logged_in" | "target_unavailable" | "route_changed" | "page_failed";
};
export type AssetUploadPayload = { blob: Blob; filename: string; mimeType: string };
export type AssetUploadObservation = Pick<
  import("../background-contracts").UploadReceipt,
  "effect" | "result" | "ended"
>;
export type AssetUploadGuard = () => import("better-result").Result<void, AssetUploadGuardError>;

const dialogSelector = ".weui-desktop-dialog";
const inputSelector = '.weui-desktop-upload_global-media input[type="file"][accept*="bmp"]';
const maxWaitMs = assetUploadTimeouts.native;

export async function uploadAsset(
  document: Document,
  payload: AssetUploadPayload,
  guard: AssetUploadGuard,
  options: { timeoutMs?: number; publish?: (observation: AssetUploadObservation) => void } = {},
): Promise<AssetUploadObservation> {
  let observation: AssetUploadObservation = {
    effect: { outcome: "not_dispatched", filename: payload.filename },
    ended: false,
  };
  const publish = (next: AssetUploadObservation) => {
    observation = next;
    options.publish?.(next);
  };
  const fail = (
    code: Failure["code"],
    stage: "upload_preflight" | "file_assign" | "upload_dispatch" | "upload_confirm",
    causeCode: string = code,
    outcome: "not_dispatched" | "unknown" = "not_dispatched",
    kind: "domain" | "runtime" = "domain",
  ): AssetUploadObservation => {
    publish({
      result: {
        status: "error",
        error: { code, cause: { at: `content.${stage}`, kind, code: causeCode } },
      },
      effect: { outcome, filename: payload.filename },
      ended: outcome === "not_dispatched",
    });
    return observation;
  };
  if (!v.safeParse(assetPayloadSchema, payload).success)
    return fail("invalid_payload", "upload_preflight");
  const dialog = uniqueVisibleDialog(document);
  const input = uniqueUsableInput(dialog);
  if (!dialog || !input) return fail("dialog_unavailable", "upload_preflight");
  const beforeResult = readMaterialCards(dialog);
  if (Result.isError(beforeResult))
    return fail(
      beforeResult.error.code,
      "upload_preflight",
      beforeResult.error.causeCode ?? "snapshot_incomplete",
      "not_dispatched",
      beforeResult.error.causeCode === "snapshot_read_exception" ? "runtime" : "domain",
    );
  const before = beforeResult.value;
  if (before.some((card) => card.filename === payload.filename))
    return fail("asset_ambiguous", "upload_preflight", "filename_exists");

  const view = document.defaultView;
  if (
    !view ||
    typeof view.File !== "function" ||
    typeof view.DataTransfer !== "function" ||
    typeof view.Event !== "function"
  )
    return fail(
      "page_failed",
      "upload_preflight",
      "file_api_unavailable",
      "not_dispatched",
      "runtime",
    );

  const nativeObjects = Result.try({
    try: () => {
      const file = new view.File([payload.blob], payload.filename, { type: payload.mimeType });
      const transfer = new view.DataTransfer();
      transfer.items.add(file);
      return transfer;
    },
    catch: () => ({ code: "page_failed" as const }),
  });
  if (Result.isError(nativeObjects))
    return fail(
      "page_failed",
      "upload_preflight",
      "file_construction_failed",
      "not_dispatched",
      "runtime",
    );

  const beforeAssignment = guard();
  if (Result.isError(beforeAssignment)) return fail(beforeAssignment.error.code, "file_assign");
  if (!sameDialogAndInput(document, dialog, input))
    return fail("page_failed", "file_assign", "dialog_or_input_changed");
  // A files setter may itself start native work, even when change is never dispatched.
  publish({ effect: { outcome: "unknown", filename: payload.filename }, ended: false });
  const assignment = Result.try({
    try: () => {
      input.files = nativeObjects.value.files;
    },
    catch: () => ({ code: "asset_upload_unknown" as const }),
  });
  if (Result.isError(assignment))
    return fail(
      "asset_upload_unknown",
      "file_assign",
      "file_assignment_failed",
      "unknown",
      "runtime",
    );

  const beforeEvent = guard();
  if (Result.isError(beforeEvent))
    return fail("asset_upload_unknown", "upload_dispatch", beforeEvent.error.code, "unknown");
  if (!sameDialogAndInput(document, dialog, input))
    return fail("asset_upload_unknown", "upload_dispatch", "dialog_or_input_changed", "unknown");
  const dispatch = Result.try({
    try: () => input.dispatchEvent(new view.Event("change", { bubbles: true })),
    catch: () => ({ code: "asset_upload_unknown" as const }),
  });
  if (Result.isError(dispatch))
    return fail(
      "asset_upload_unknown",
      "upload_dispatch",
      "change_dispatch_failed",
      "unknown",
      "runtime",
    );

  const timeout = Math.min(Math.max(options.timeoutMs ?? maxWaitMs, 0), maxWaitMs);
  const deadline = Date.now() + timeout;
  let confirmationCause = "confirmation_timeout";
  let confirmationKind: "domain" | "runtime" = "domain";
  while (Date.now() < deadline) {
    const currentGuard = guard();
    if (Result.isError(currentGuard))
      return fail("asset_upload_unknown", "upload_confirm", currentGuard.error.code, "unknown");
    // WebUploader replaces its file input synchronously after accepting change.
    // From dispatch onward the owned library and the resulting card, not the
    // consumed input element, identify the native upload we are observing.
    if (uniqueVisibleDialog(document) !== dialog)
      return fail("asset_upload_unknown", "upload_confirm", "dialog_or_input_changed", "unknown");
    const afterResult = readMaterialCards(dialog);
    // Preflight already proved this exact filename absent. Consume only a
    // complete snapshot; malformed intermediate cards share the same wait.
    const created = Result.isOk(afterResult)
      ? afterResult.value.filter((card) => card.filename === payload.filename)
      : [];
    if (created.length > 1)
      return fail("asset_upload_unknown", "upload_confirm", "filename_ambiguous", "unknown");
    const postReadGuard = guard();
    if (Result.isError(postReadGuard))
      return fail("asset_upload_unknown", "upload_confirm", postReadGuard.error.code, "unknown");
    if (uniqueVisibleDialog(document) !== dialog)
      return fail("asset_upload_unknown", "upload_confirm", "dialog_or_input_changed", "unknown");
    if (created.length === 1 && created[0]?.thumbnailUrl) {
      publish({
        effect: {
          outcome: "confirmed",
          filename: payload.filename,
          thumbnailUrl: created[0].thumbnailUrl,
        },
        ended: true,
        result: { status: "ok", value: {} },
      });
      return observation;
    }
    confirmationCause = Result.isError(afterResult)
      ? (afterResult.error.causeCode ?? "snapshot_incomplete")
      : created.length === 0
        ? "new_card_absent"
        : "thumbnail_unavailable";
    confirmationKind =
      Result.isError(afterResult) && afterResult.error.causeCode === "snapshot_read_exception"
        ? "runtime"
        : "domain";
    if (Date.now() >= deadline) break;
    await delay(Math.min(100, deadline - Date.now()));
  }
  publish({
    result: {
      status: "error",
      error: {
        code: "asset_upload_unknown",
        cause: { at: "content.upload_confirm", kind: confirmationKind, code: confirmationCause },
        confirmationTimedOut: true,
      },
    },
    effect: { outcome: "unknown", filename: payload.filename },
    ended: false,
  });
  return observation;
}

export async function uploadMaterial(
  document: Document,
  payload: import("@mpctl/contracts").AssetPayload,
  guard: AssetUploadGuard,
  publish: (observation: AssetUploadObservation) => void,
): Promise<AssetUploadObservation> {
  let observation: AssetUploadObservation = {
    effect: { outcome: "not_dispatched", filename: payload.filename },
    ended: false,
  };
  let uiPending = false;
  let opened: MaterialLibrarySession | undefined;
  let nativeEnded = true;
  let failure: Failure | undefined;
  const libraryFailure = (
    error: MaterialLibraryError,
    at: "content.library_open" | "content.library_cleanup",
  ): Failure => ({
    code: error.code,
    cause: {
      at,
      kind: error.observedFailure?.kind ?? "domain",
      code: error.observedFailure?.causeCode ?? error.causeCode ?? error.code,
    },
  });
  try {
    const initial = guard();
    if (!(await validAssetSignature(payload)))
      failure = {
        code: "invalid_asset",
        cause: { at: "content.preflight", kind: "domain", code: "signature_mismatch" },
      };
    else if (initial.isErr())
      failure = {
        code: initial.error.code,
        cause: { at: "content.guard", kind: "domain", code: initial.error.code },
      };
    else {
      const opening = await openMaterialLibrary(document, guard, {
        onMenuObserved: () => {
          uiPending = false;
        },
        onDispatch: () => {
          uiPending = true;
        },
      });
      if (opening.isErr()) failure = libraryFailure(opening.error, "content.library_open");
      else {
        opened = opening.value;
        uiPending = false;
        observation = await uploadAsset(document, payload, guard, {
          publish: (native) => {
            observation = native;
            // Native file end is not end of this operation's owned library cleanup.
            publish({
              ...native,
              ended: false,
              result: native.result?.status === "error" ? native.result : undefined,
            });
          },
        });
        nativeEnded = observation.ended;
        if (observation.result?.status === "error") failure = observation.result.error;
      }
    }
  } catch {
    nativeEnded = observation.effect.outcome === "not_dispatched";
    failure = {
      code: "page_failed",
      cause: { at: "content.upload_preflight", kind: "runtime", code: "unexpected_exception" },
    };
  }
  // Closing an upload dialog destroys its native uploader. Keep it visible
  // while completion is unknown so observation can continue without cancelling
  // or concealing the original work.
  if (opened?.opened && nativeEnded) {
    try {
      const closed = await closeMaterialLibrary(document, opened.dialog, guard, {
        onDispatch: () => {
          uiPending = true;
        },
      });
      if (closed.isErr()) {
        const cleanup = libraryFailure(closed.error, "content.library_cleanup");
        failure = failure ? { ...failure, cleanup: cleanup.cause } : cleanup;
      } else uiPending = false;
    } catch {
      const cause = {
        at: "content.library_cleanup" as const,
        kind: "runtime" as const,
        code: "unexpected_exception",
      };
      failure = failure ? { ...failure, cleanup: cause } : { code: "cleanup_failed", cause };
    }
  }
  observation = {
    ...observation,
    ended: nativeEnded && !uiPending,
    result: failure ? { status: "error", error: failure } : { status: "ok", value: {} },
  };
  publish(observation);
  return observation;
}

function uniqueVisibleDialog(document: Document): HTMLElement | undefined {
  const candidates = [...document.querySelectorAll<HTMLElement>(dialogSelector)].filter(
    (dialog) => dialog.isConnected && !dialog.hidden && isVisible(dialog) && hasDialogTitle(dialog),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function hasDialogTitle(dialog: HTMLElement): boolean {
  const document = dialog.ownerDocument;
  if (!document.createTreeWalker) return false;
  const walker = document.createTreeWalker(dialog, 4);
  let matches = 0;
  while (walker.nextNode()) {
    if (walker.currentNode.textContent?.trim() === "选择图片") matches++;
  }
  return matches === 1;
}

function uniqueUsableInput(dialog: HTMLElement | undefined): HTMLInputElement | undefined {
  if (!dialog) return undefined;
  const candidates = [...dialog.querySelectorAll<HTMLInputElement>(inputSelector)].filter(
    (input) =>
      input.isConnected &&
      input.type === "file" &&
      input.multiple &&
      !input.disabled &&
      input.accept.toLowerCase().includes("image/png") &&
      input.accept.toLowerCase().includes("image/jpeg") &&
      input.accept.toLowerCase().includes("image/gif") &&
      input.accept.toLowerCase().includes("image/webp"),
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function sameDialogAndInput(
  document: Document,
  dialog: HTMLElement,
  input: HTMLInputElement,
): boolean {
  return (
    uniqueVisibleDialog(document) === dialog &&
    uniqueUsableInput(dialog) === input &&
    input.isConnected
  );
}

function isVisible(element: HTMLElement): boolean {
  const view = element.ownerDocument.defaultView;
  if (!view) return false;
  const style = view.getComputedStyle(element);
  return (
    style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
