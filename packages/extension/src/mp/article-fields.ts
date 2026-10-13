import { Result } from "better-result";
import {
  articleFieldUpdateInputSchema,
  type FieldsEffect,
  type Failure,
  type OperationResult,
} from "@mpctl/contracts";
import * as v from "valibot";
import {
  canWriteTitleInput,
  resolveTitleControl,
  titleInputAlreadyMatches,
  writeTitleInput,
  type TitleInputTarget,
} from "./title-input";

export type ArticleFields = { title: string; author: string; summary: string };
export type ArticleFieldsError = { code: "fields_unavailable" | "page_failed" };
export type ArticleFieldsResult = import("better-result").Result<ArticleFields, ArticleFieldsError>;
export type ArticleFieldUpdate = v.InferOutput<typeof articleFieldUpdateInputSchema>;
export type ArticleFieldName = keyof ArticleFieldUpdate;
export type FieldsObservation = { effect: FieldsEffect; result: OperationResult; ended: boolean };
type FieldsGuard = () => import("better-result").Result<
  void,
  { code: "not_logged_in" | "target_unavailable" | "route_changed" | "page_failed" }
>;
export function initialFieldsEffect(fields: ArticleFieldUpdate): FieldsEffect {
  return {
    outcome: "not_dispatched",
    requested: (["title", "author", "summary"] as const).filter(
      (name) => fields[name] !== undefined,
    ),
    attempted: [],
    confirmed: [],
    unknown: [],
  };
}

export async function hashArticleFields(fields: ArticleFields) {
  return Result.tryPromise({
    try: async () => {
      const bytes = new TextEncoder().encode(
        JSON.stringify([fields.title, fields.author, fields.summary]),
      );
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    },
    catch: () => ({ code: "page_failed" as const }),
  });
}

export function validateArticleFieldUpdate(value: unknown) {
  const parsed = v.safeParse(articleFieldUpdateInputSchema, value);
  if (!parsed.success) return Result.err({ code: "invalid_fields" as const });
  return Result.ok(parsed.output);
}

const authorSelector = 'input#author[name="author"]';
const summarySelector = 'textarea#js_description[name="digest"]';

/** Reads only the three candidate controls; selector semantics require current-page verification. */
export function readArticleFields(document: Document): ArticleFieldsResult {
  return Result.try({
    try: () => {
      const title = resolveTitleControl(document);
      const author = uniqueVisible(
        [...document.querySelectorAll<HTMLInputElement>(authorSelector)].filter(
          (element) =>
            element.tagName === "INPUT" &&
            element.getAttribute("id") === "author" &&
            element.getAttribute("name") === "author" &&
            element.type === "text",
        ),
      );
      const summary = uniqueVisible(
        [...document.querySelectorAll<HTMLTextAreaElement>(summarySelector)].filter(
          (element) =>
            element.tagName === "TEXTAREA" &&
            element.getAttribute("id") === "js_description" &&
            element.getAttribute("name") === "digest",
        ),
      );
      if (!title || !author || !summary) return undefined;
      return { title: title.innerText, author: author.value, summary: summary.value };
    },
    catch: () => ({ code: "page_failed" as const }),
  }).andThen((fields) =>
    fields ? Result.ok(fields) : Result.err({ code: "fields_unavailable" as const }),
  );
}

function uniqueVisible<T extends HTMLElement>(elements: T[]): T | undefined {
  const visible = elements.filter(isVisible);
  return visible.length === 1 ? visible[0] : undefined;
}

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected || element.hidden || element.getAttribute("aria-hidden") === "true")
    return false;
  const style = element.ownerDocument.defaultView?.getComputedStyle(element);
  return (
    style !== undefined &&
    style.display !== "none" &&
    style.visibility !== "hidden" &&
    style.visibility !== "collapse" &&
    element.getClientRects().length > 0
  );
}

export async function writeArticleFields(
  document: Document,
  fields: ArticleFieldUpdate,
  guard: FieldsGuard = () => Result.ok(),
  observeEffect?: (effect: FieldsEffect) => void,
): Promise<FieldsObservation> {
  const effect = initialFieldsEffect(fields);
  observeEffect?.(effect);
  // Recovery reads must still refer to the original control, not a same-value replacement.
  const attemptedControls = new Map<ArticleFieldName, HTMLElement>();
  let titleTarget: TitleInputTarget | undefined;
  let titleEnded = true;
  const dispatched = (name: ArticleFieldName, target: HTMLElement) => {
    effect.attempted.push(name);
    attemptedControls.set(name, target);
    effect.unknown = effect.attempted.filter((field) => !effect.confirmed.includes(field));
    effect.outcome = effect.confirmed.length ? "partial" : "unknown";
  };
  const checked = () =>
    Result.try({ try: guard, catch: () => ({ code: "page_failed" as const }) }).andThen(
      (result) => result,
    );
  const failure = (
    code: Failure["code"],
    at: NonNullable<Failure["cause"]>["at"],
    cause: string = code,
  ): FieldsObservation =>
    uncertainResult(document, fields, effect, checked, attemptedControls, titleTarget, titleEnded, {
      code,
      cause: { at, kind: "domain", code: cause },
    });
  const confirmed = (name: ArticleFieldName) => {
    effect.confirmed.push(name);
    effect.unknown = effect.attempted.filter((field) => !effect.confirmed.includes(field));
    effect.outcome = "partial";
  };
  const confirm = (name: ArticleFieldName) => {
    if (effect.confirmed.includes(name)) return;
    const valid = checked();
    if (valid.isErr()) return;
    const value = readFieldValue(document, name);
    if (
      value.isOk() &&
      (name === "title"
        ? titleInputAlreadyMatches(document, fields.title ?? "")
        : fieldMatches(name, value.value, fields[name]))
    )
      confirmed(name);
  };
  try {
    const valid = checked();
    if (valid.isErr()) return failure(valid.error.code, "content.guard");
    const current = readArticleFields(document);
    if (current.isErr()) return failure(current.error.code, "content.preflight");
    if (fields.title !== undefined) {
      const titleCapability = canWriteTitleInput(document);
      if (titleCapability) return failure(titleCapability, "content.preflight");
    }
    for (const name of ["author", "summary"] as const) {
      if (fields[name] === undefined) continue;
      const candidate = resolveWritableControl(document, name);
      if (!candidate || !hasNativeSetter(candidate) || !hasEventConstructor(candidate))
        return failure(candidate ? "page_failed" : "fields_unavailable", "content.preflight");
    }
    for (const name of ["title", "author", "summary"] as const) {
      const value = fields[name];
      if (value === undefined) continue;
      const guarded = checked();
      if (guarded.isErr()) return failure(guarded.error.code, "content.guard");
      if (name === "title") {
        const before = readArticleFields(document);
        if (before.isErr()) return failure(before.error.code, "content.readback");
        if (titleInputAlreadyMatches(document, value)) continue;
        const written = await writeTitleInput(document, value, checked, {
          onDispatched: (target) => {
            titleTarget = target;
            titleEnded = false;
            dispatched("title", target.element);
          },
        });
        if (written.isErr()) {
          const cause =
            written.error.code === "title_update_unknown"
              ? (written.error.causeCode ?? written.error.code)
              : written.error.code;
          const code =
            cause === "route_changed" || cause === "target_unavailable" || cause === "not_logged_in"
              ? cause
              : written.error.code === "title_update_unknown"
                ? "field_update_unknown"
                : "page_failed";
          const observation = failure(code, "content.title_mirror", cause);
          if (written.error.code === "title_update_unknown")
            observation.ended = written.error.ended;
          return observation;
        }
        // writeTitleInput already confirmed visible text and its original mirror.
        // A later guard failure cannot erase that same-target observation.
        titleEnded = true;
        if (written.value.dispatched) confirmed("title");
        continue;
      }
      const element = resolveWritableControl(document, name);
      if (!element) return failure("fields_unavailable", "content.field_edit");
      if (!hasNativeSetter(element) || !hasEventConstructor(element))
        return failure("page_failed", "content.field_edit");
      const before = readArticleFields(document);
      if (before.isErr()) return failure(before.error.code, "content.readback");
      if (before.value[name] === value) continue;
      const immediateGuard = checked();
      if (immediateGuard.isErr()) return failure(immediateGuard.error.code, "content.guard");
      if (!setNativeValue(element, value, () => dispatched(name, element)))
        return failure("page_failed", "content.field_edit");
      const beforeEventsGuard = checked();
      if (Result.isError(beforeEventsGuard) || resolveWritableControl(document, name) !== element)
        return failure(
          beforeEventsGuard.isErr() ? beforeEventsGuard.error.code : "fields_unavailable",
          "content.guard",
        );
      element.dispatchEvent(
        new element.ownerDocument.defaultView!.Event("input", { bubbles: true }),
      );
      const afterEventsGuard = checked();
      if (Result.isError(afterEventsGuard) || resolveWritableControl(document, name) !== element)
        return failure(
          afterEventsGuard.isErr() ? afterEventsGuard.error.code : "fields_unavailable",
          "content.guard",
        );
      element.dispatchEvent(
        new element.ownerDocument.defaultView!.Event("change", { bubbles: true }),
      );
      const afterChangeGuard = checked();
      if (Result.isError(afterChangeGuard) || resolveWritableControl(document, name) !== element)
        return failure(
          afterChangeGuard.isErr() ? afterChangeGuard.error.code : "fields_unavailable",
          "content.guard",
        );
      confirm(name);
    }
    const after = readArticleFields(document);
    if (after.isErr()) return failure(after.error.code, "content.readback");
    const post = checked();
    if (post.isErr()) return failure(post.error.code, "content.guard");
    if (
      effect.requested.some((name) =>
        name === "title"
          ? !titleInputAlreadyMatches(document, fields.title ?? "")
          : !fieldMatches(name, after.value[name], fields[name]),
      )
    )
      return failure("field_update_unknown", "content.readback");
    const hash = await hashArticleFields(after.value);
    if (hash.isErr()) return failure("hash_failed", "content.readback");
    const afterHashGuard = checked();
    if (afterHashGuard.isErr()) return failure(afterHashGuard.error.code, "content.guard");
    const final = readArticleFields(document);
    if (final.isErr()) return failure(final.error.code, "content.readback");
    const finalGuard = checked();
    if (finalGuard.isErr()) return failure(finalGuard.error.code, "content.guard");
    if (JSON.stringify(final.value) !== JSON.stringify(after.value))
      return failure("field_update_unknown", "content.readback");
    effect.unknown = effect.attempted.filter((name) => !effect.confirmed.includes(name));
    if (effect.unknown.length) return failure("field_update_unknown", "content.readback");
    return {
      effect: { ...effect, outcome: "confirmed", fieldsHash: hash.value },
      ended: true,
      result: { status: "ok", value: {} },
    };
  } catch {
    return uncertainResult(
      document,
      fields,
      effect,
      checked,
      attemptedControls,
      titleTarget,
      titleEnded,
      {
        code: "page_failed",
        cause: { at: "content.field_edit", kind: "runtime", code: "unexpected_exception" },
      },
    );
  }
}

function isRenderedEmptyTitle(value: string): boolean {
  return value === "" || value === "\n";
}

function uncertainResult(
  document: Document,
  fields: ArticleFieldUpdate,
  effect: FieldsEffect,
  guard: FieldsGuard,
  attemptedControls: ReadonlyMap<ArticleFieldName, HTMLElement>,
  titleTarget: TitleInputTarget | undefined,
  ended: boolean,
  failure: Failure,
): FieldsObservation {
  for (const name of effect.attempted) {
    if (effect.confirmed.includes(name)) continue;
    const valid = Result.try({
      try: guard,
      catch: () => ({ code: "page_failed" as const }),
    }).andThen((result) => result);
    if (Result.isError(valid)) {
      continue;
    }
    try {
      if (
        name !== "title" &&
        resolveWritableControl(document, name) !== attemptedControls.get(name)
      )
        continue;
      const value = readFieldValue(document, name);
      if (
        Result.isOk(value) &&
        (name === "title"
          ? !!titleTarget && titleInputAlreadyMatches(document, fields.title ?? "", titleTarget)
          : fieldMatches(name, value.value, fields[name]))
      )
        effect.confirmed.push(name);
    } catch {
      // Recovery is best-effort evidence only; a second DOM error never replaces the first cause.
    }
  }
  effect.unknown = effect.attempted.filter((name) => !effect.confirmed.includes(name));
  effect.outcome = effect.confirmed.length
    ? "partial"
    : effect.attempted.length
      ? "unknown"
      : "not_dispatched";
  return { effect, result: { status: "error", error: failure }, ended };
}

function fieldMatches(
  name: ArticleFieldName,
  actual: string,
  intended: string | undefined,
): boolean {
  return (
    actual === intended || (name === "title" && intended === "" && isRenderedEmptyTitle(actual))
  );
}

function readFieldValue(document: Document, name: ArticleFieldName) {
  return Result.try({
    try: () => {
      if (name === "title") {
        const fields = readArticleFields(document);
        return Result.isOk(fields) ? fields.value.title : undefined;
      }
      const element = resolveWritableControl(document, name);
      if (!element) return undefined;
      return name === "author"
        ? (element as HTMLInputElement).value
        : (element as HTMLTextAreaElement).value;
    },
    catch: () => ({ code: "fields_unavailable" as const }),
  }).andThen((value) =>
    value === undefined ? Result.err({ code: "fields_unavailable" as const }) : Result.ok(value),
  );
}

function setNativeValue(
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
  onDispatched: () => void,
): boolean {
  const prototype =
    element.tagName === "INPUT"
      ? element.ownerDocument.defaultView?.HTMLInputElement.prototype
      : element.ownerDocument.defaultView?.HTMLTextAreaElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
  if (!setter) return false;
  onDispatched();
  setter.call(element, value);
  return true;
}

function resolveWritableControl(document: Document, name: ArticleFieldName) {
  if (name === "author")
    return uniqueVisible(
      [...document.querySelectorAll<HTMLInputElement>(authorSelector)].filter(
        (element) =>
          element.tagName === "INPUT" &&
          element.type === "text" &&
          element.getAttribute("id") === "author" &&
          element.getAttribute("name") === "author" &&
          !element.disabled &&
          !element.readOnly,
      ),
    );
  return uniqueVisible(
    [...document.querySelectorAll<HTMLTextAreaElement>(summarySelector)].filter(
      (element) =>
        element.tagName === "TEXTAREA" &&
        element.getAttribute("id") === "js_description" &&
        element.getAttribute("name") === "digest" &&
        !element.disabled &&
        !element.readOnly,
    ),
  );
}

function hasNativeSetter(element: HTMLInputElement | HTMLTextAreaElement): boolean {
  const prototype =
    element.tagName === "INPUT"
      ? element.ownerDocument.defaultView?.HTMLInputElement.prototype
      : element.ownerDocument.defaultView?.HTMLTextAreaElement.prototype;
  return typeof Object.getOwnPropertyDescriptor(prototype, "value")?.set === "function";
}

function hasEventConstructor(element: HTMLElement): boolean {
  return (
    typeof element.ownerDocument.defaultView?.Event === "function" &&
    typeof element.dispatchEvent === "function"
  );
}
