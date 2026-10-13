import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import {
  readArticleFields,
  validateArticleFieldUpdate,
  writeArticleFields,
} from "../src/mp/article-fields";

const titleSelector = 'div[contenteditable="true"]';
const authorSelector = 'input#author[name="author"]';
const summarySelector = 'textarea#js_description[name="digest"]';

function control(
  tagName: string,
  attributes: Record<string, string>,
  options: { value?: string; text?: string; visible?: boolean; connected?: boolean } = {},
) {
  return {
    tagName: tagName.toUpperCase(),
    isConnected: options.connected ?? true,
    hidden: false,
    type: attributes.type ?? (tagName.toLowerCase() === "input" ? "text" : undefined),
    value: options.value ?? "",
    innerText: options.text ?? "",
    textContent: options.text ?? "",
    getAttribute: (name: string) => attributes[name] ?? null,
    hasAttribute: (name: string) => name in attributes,
    getClientRects: () => (options.visible === false ? [] : [{}]),
    ownerDocument: {
      defaultView: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
      },
    },
  };
}

function page(controls: { title?: unknown[]; author?: unknown[]; summary?: unknown[] } = {}) {
  return {
    querySelectorAll(selector: string) {
      if (selector === titleSelector) return controls.title ?? [];
      if (selector === authorSelector) return controls.author ?? [];
      if (selector === summarySelector) return controls.summary ?? [];
      return [];
    },
  } as unknown as Document;
}

describe("readArticleFields", () => {
  test("reads the unique visible title editor and actual typed values without trimming", () => {
    const bodyEditor = control(
      "div",
      { contenteditable: "true", "data-placeholder": "正文" },
      { text: "body heading" },
    );
    const hiddenTitleMirror = control("textarea", { id: "title" }, { value: "hidden fallback" });
    const document = page({
      title: [
        bodyEditor,
        control(
          "div",
          { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
          { text: " 标题　" },
        ),
      ],
      author: [
        control("input", { id: "author", name: "author", type: "text" }, { value: " 作者 " }),
      ],
      summary: [control("textarea", { id: "js_description", name: "digest" }, { value: "" })],
    });
    expect(readArticleFields(document)).toEqual(
      Result.ok({ title: " 标题　", author: " 作者 ", summary: "" }),
    );
    expect(hiddenTitleMirror).toBeDefined();
  });

  test("rejects absent, hidden, disconnected, or ambiguous matching controls", () => {
    const validTitle = control("div", {
      contenteditable: "true",
      "data-placeholder": "请在这里输入标题",
    });
    const validAuthor = control("input", { id: "author", name: "author", type: "text" });
    const validSummary = control("textarea", { id: "js_description", name: "digest" });
    expect(readArticleFields(page({ author: [validAuthor], summary: [validSummary] }))).toEqual(
      Result.err({ code: "fields_unavailable" }),
    );
    expect(
      readArticleFields(
        page({
          title: [validTitle],
          author: [control("input", { id: "author", name: "author" }, { visible: false })],
          summary: [validSummary],
        }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
    expect(
      readArticleFields(
        page({
          title: [validTitle],
          author: [control("textarea", { id: "author", name: "author" })],
          summary: [validSummary],
        }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
    expect(
      readArticleFields(
        page({
          title: [validTitle],
          author: [control("input", { id: "author", name: "author", type: "email" })],
          summary: [validSummary],
        }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
    expect(
      readArticleFields(
        page({
          title: [validTitle],
          author: [validAuthor],
          summary: [control("div", { id: "js_description", name: "digest" })],
        }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
    expect(
      readArticleFields(
        page({
          title: [validTitle],
          author: [validAuthor],
          summary: [
            control("textarea", { id: "js_description", name: "digest" }, { connected: false }),
          ],
        }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
    expect(
      readArticleFields(
        page({ title: [validTitle], author: [validAuthor, validAuthor], summary: [validSummary] }),
      ),
    ).toEqual(Result.err({ code: "fields_unavailable" }));
  });

  test("converts DOM query and field getter exceptions to typed page failures", () => {
    const brokenQuery = {
      querySelectorAll() {
        throw new Error("query failed");
      },
    } as unknown as Document;
    expect(readArticleFields(brokenQuery)).toEqual(Result.err({ code: "page_failed" }));

    const brokenTitle = control("div", {
      contenteditable: "true",
      "data-placeholder": "请在这里输入标题",
    });
    Object.defineProperty(brokenTitle, "innerText", {
      get() {
        throw new Error("read failed");
      },
    });
    expect(
      readArticleFields(
        page({
          title: [brokenTitle],
          author: [control("input", { id: "author", name: "author" })],
          summary: [control("textarea", { id: "js_description", name: "digest" })],
        }),
      ),
    ).toEqual(Result.err({ code: "page_failed" }));
  });
});

describe("article field updates", () => {
  test("accepts bounded title and rejects unknown/invalid fields while preserving clears", () => {
    expect(validateArticleFieldUpdate({ author: "" })).toEqual(Result.ok({ author: "" }));
    expect(validateArticleFieldUpdate({ summary: "🌱".repeat(60) })).toEqual(
      Result.ok({ summary: "🌱".repeat(60) }),
    );
    expect(validateArticleFieldUpdate({ title: "🌱".repeat(32) })).toEqual(
      Result.ok({ title: "🌱".repeat(32) }),
    );
    for (const value of [
      {},
      { typo: "no" },
      { title: "🌱".repeat(33) },
      { title: "a\nb" },
      { title: "a\0b" },
      { author: null },
      { author: "🌱".repeat(5) },
      { author: "a\nb" },
      { summary: "x".repeat(121) },
    ])
      expect(validateArticleFieldUpdate(value)).toEqual(Result.err({ code: "invalid_fields" }));
  });

  test("writes only requested visible inputs using native setter and bubbling events", async () => {
    const writes: string[] = [];
    const input = {
      ...control("input", { id: "author", name: "author", type: "text" }, { value: "old" }),
      disabled: false,
      readOnly: false,
    } as Record<string, unknown>;
    const summary = {
      ...control("textarea", { id: "js_description", name: "digest" }, { value: "prior" }),
      disabled: false,
      readOnly: false,
    } as Record<string, unknown>;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "title" },
    );
    const target = (value: Record<string, unknown>, key: string) => {
      let current = value[key];
      Object.defineProperty(value, key, {
        get: () => current,
        set: (next) => {
          current = next;
          writes.push(key);
        },
        configurable: true,
      });
      value.dispatchEvent = (event: Event) => {
        writes.push(`${key}:${event.type}`);
        return true;
      };
    };
    target(input, "value");
    target(summary, "value");
    const nativeInput = {
      set(this: Record<string, unknown>, value: string) {
        this.value = value;
      },
    };
    const doc = page({ title: [title], author: [input], summary: [summary] }) as Document;
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            get value(): string {
              return String(input.value);
            },
            set value(value: string) {
              nativeInput.set!.call(input, value);
            },
          },
        },
        HTMLTextAreaElement: {
          prototype: {
            get value(): string {
              return String(summary.value);
            },
            set value(value: string) {
              nativeInput.set!.call(summary, value);
            },
          },
        },
        Event: class {
          type: string;
          constructor(type: string) {
            this.type = type;
          }
        },
      },
    });
    Object.defineProperty(input, "ownerDocument", { value: doc });
    Object.defineProperty(summary, "ownerDocument", { value: doc });
    expect(await writeArticleFields(doc, { author: "新作者" })).toEqual(
      expect.objectContaining({
        effect: expect.objectContaining({
          outcome: "confirmed",
          requested: ["author"],
          attempted: ["author"],
          confirmed: ["author"],
          unknown: [],
          fieldsHash: expect.stringMatching(/^[0-9a-f]{64}$/),
        }),
        ended: true,
        result: { status: "ok", value: {} },
      }),
    );
    expect(writes).toEqual(["value", "value:input", "value:change"]);
  });

  test("reports a throwing native setter as a dispatched unknown field, not a clean failure", async () => {
    const el = control(
      "input",
      { id: "author", name: "author", type: "text" },
      { value: "before" },
    ) as Record<string, unknown>;
    Object.defineProperty(el, "disabled", { value: false });
    Object.defineProperty(el, "readOnly", { value: false });
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "Title" },
    );
    const doc = page({
      title: [title],
      author: [el],
      summary: [control("textarea", { id: "js_description", name: "digest" })],
    }) as Document;
    Object.defineProperty(el, "ownerDocument", { value: doc });
    Object.defineProperty(el, "dispatchEvent", { value: () => true });
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(_value: string) {
              el.value = _value;
              throw new Error("setter failed after dispatch");
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    expect(await writeArticleFields(doc, { author: "after" })).toEqual(
      expect.objectContaining({
        effect: {
          outcome: "partial",
          requested: ["author"],
          attempted: ["author"],
          confirmed: ["author"],
          unknown: [],
        },
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "content.field_edit", kind: "runtime", code: "unexpected_exception" },
          },
        },
        ended: true,
      }),
    );
  });

  test("stops before summary dispatch if author events invalidate the summary control", async () => {
    const events: string[] = [];
    const author = control(
      "input",
      { id: "author", name: "author", type: "text" },
      { value: "old" },
    ) as Record<string, unknown>;
    const summary = control(
      "textarea",
      { id: "js_description", name: "digest" },
      { value: "old summary" },
    ) as Record<string, unknown>;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "title" },
    );
    const doc = page({ title: [title], author: [author], summary: [summary] }) as Document;
    const install = (element: Record<string, unknown>, key: string, value: string) => {
      let current = value;
      Object.defineProperty(element, key, {
        get: () => current,
        set: (next) => {
          current = next as string;
        },
        configurable: true,
      });
      element.disabled = false;
      element.readOnly = false;
      Object.defineProperty(element, "ownerDocument", { value: doc });
      element.dispatchEvent = (event: Event) => {
        events.push(`${key}:${event.type}`);
        if (key === "value" && event.type === "input") summary.isConnected = false;
        return true;
      };
      return { get: () => current };
    };
    const a = install(author, "value", "old");
    const s = install(summary, "value", "old summary");
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(value: string) {
              author.value = value;
            },
          },
        },
        HTMLTextAreaElement: {
          prototype: {
            set value(value: string) {
              summary.value = value;
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    Object.defineProperty(author, "ownerDocument", { value: doc });
    Object.defineProperty(summary, "ownerDocument", { value: doc });
    const result = await writeArticleFields(doc, { author: "new", summary: "new summary" });
    expect(result.result.status).toBe("error");
    expect(result.effect).toEqual({
      outcome: "partial",
      requested: ["author", "summary"],
      attempted: ["author"],
      confirmed: ["author"],
      unknown: [],
    });
    expect(a.get()).toBe("new");
    expect(s.get()).toBe("old summary");
    expect(events).toEqual(["value:input", "value:change"]);
  });

  test("treats an absent native setter as a known pre-dispatch failure", async () => {
    const author = {
      ...control("input", { id: "author", name: "author", type: "text" }, { value: "old" }),
      disabled: false,
      readOnly: false,
    } as Record<string, unknown>;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "title" },
    );
    const doc = page({
      title: [title],
      author: [author],
      summary: [control("textarea", { id: "js_description", name: "digest" })],
    }) as Document;
    Object.defineProperty(author, "ownerDocument", { value: doc });
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: { prototype: {} },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    expect(await writeArticleFields(doc, { author: "new" })).toEqual({
      effect: {
        outcome: "not_dispatched",
        requested: ["author"],
        attempted: [],
        confirmed: [],
        unknown: [],
      },
      ended: true,
      result: {
        status: "error",
        error: {
          code: "page_failed",
          cause: { at: "content.preflight", kind: "domain", code: "page_failed" },
        },
      },
    });
  });

  test("reports partial uncertainty when a later native setter disappears after author dispatch", async () => {
    const author = control(
      "input",
      { id: "author", name: "author", type: "text" },
      { value: "old" },
    ) as Record<string, unknown>;
    const summary = control(
      "textarea",
      { id: "js_description", name: "digest" },
      { value: "old summary" },
    ) as Record<string, unknown>;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "Title" },
    );
    const doc = page({ title: [title], author: [author], summary: [summary] }) as Document;
    Object.defineProperty(author, "ownerDocument", { value: doc });
    Object.defineProperty(summary, "ownerDocument", { value: doc });
    author.disabled = false;
    author.readOnly = false;
    summary.disabled = false;
    summary.readOnly = false;
    summary.dispatchEvent = () => true;
    author.dispatchEvent = (event: Event) => {
      if (event.type === "change") {
        Object.defineProperty(doc, "defaultView", {
          value: {
            getComputedStyle: () => ({ display: "block", visibility: "visible" }),
            HTMLInputElement: {
              prototype: {
                set value(value: string) {
                  author.value = value;
                },
              },
            },
            HTMLTextAreaElement: { prototype: {} },
            Event: class {
              constructor(readonly type: string) {}
            },
          },
        });
      }
      return true;
    };
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(value: string) {
              author.value = value;
            },
          },
        },
        HTMLTextAreaElement: {
          prototype: {
            set value(value: string) {
              summary.value = value;
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
      configurable: true,
    });
    expect(await writeArticleFields(doc, { author: "new", summary: "new summary" })).toEqual(
      expect.objectContaining({
        effect: {
          outcome: "partial",
          requested: ["author", "summary"],
          attempted: ["author"],
          confirmed: ["author"],
          unknown: [],
        },
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "content.field_edit", kind: "domain", code: "page_failed" },
          },
        },
        ended: true,
      }),
    );
    expect(author.value).toBe("new");
    expect(summary.value).toBe("old summary");
  });

  test("keeps prior dispatch facts when the next field read throws", async () => {
    let failSummaryRead = false;
    let authorValue = "old";
    const author = control("input", { id: "author", name: "author", type: "text" }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(author, "value", { get: () => authorValue, configurable: true });
    author.disabled = false;
    author.readOnly = false;
    const summary = control("textarea", { id: "js_description", name: "digest" }) as Record<
      string,
      unknown
    >;
    Object.defineProperty(summary, "value", {
      get() {
        if (failSummaryRead) throw new Error("summary getter failed after author dispatch");
        return "old summary";
      },
      configurable: true,
    });
    summary.disabled = false;
    summary.readOnly = false;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "Title" },
    );
    const doc = page({ title: [title], author: [author], summary: [summary] }) as Document;
    Object.defineProperty(author, "ownerDocument", { value: doc });
    Object.defineProperty(summary, "ownerDocument", { value: doc });
    author.dispatchEvent = (event: Event) => {
      if (event.type === "input") failSummaryRead = true;
      return true;
    };
    summary.dispatchEvent = () => true;
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(value: string) {
              authorValue = value;
            },
          },
        },
        HTMLTextAreaElement: {
          prototype: {
            set value(value: string) {
              summary.value = value;
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    const result = await writeArticleFields(doc, { author: "new", summary: "new summary" });
    expect(result).toEqual(
      expect.objectContaining({
        effect: {
          outcome: "partial",
          requested: ["author", "summary"],
          attempted: ["author"],
          confirmed: ["author"],
          unknown: [],
        },
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "content.readback", kind: "domain", code: "page_failed" },
          },
        },
        ended: true,
      }),
    );
    expect(authorValue).toBe("new");
  });

  test("keeps recovery guard exceptions inside the field Result as unknown", async () => {
    const el = control(
      "input",
      { id: "author", name: "author", type: "text" },
      { value: "old" },
    ) as Record<string, unknown>;
    Object.defineProperty(el, "disabled", { value: false });
    Object.defineProperty(el, "readOnly", { value: false });
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "Title" },
    );
    const doc = page({
      title: [title],
      author: [el],
      summary: [control("textarea", { id: "js_description", name: "digest" })],
    }) as Document;
    Object.defineProperty(el, "ownerDocument", { value: doc });
    Object.defineProperty(el, "dispatchEvent", { value: () => true });
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(value: string) {
              el.value = value;
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    let guardCalls = 0;
    const result = await writeArticleFields(doc, { author: "new" }, () => {
      guardCalls++;
      if (guardCalls >= 4) throw new Error("target getter failed during recovery");
      return Result.ok();
    });
    expect(result).toEqual(
      expect.objectContaining({
        effect: {
          outcome: "unknown",
          requested: ["author"],
          attempted: ["author"],
          confirmed: [],
          unknown: ["author"],
        },
        result: {
          status: "error",
          error: {
            code: "page_failed",
            cause: { at: "content.guard", kind: "domain", code: "page_failed" },
          },
        },
        ended: true,
      }),
    );
  });

  test("exposes internal changed-field facts separately from requested no-op fields", async () => {
    const author = control(
      "input",
      { id: "author", name: "author", type: "text" },
      { value: "same" },
    ) as Record<string, unknown>;
    const summary = control(
      "textarea",
      { id: "js_description", name: "digest" },
      { value: "old summary" },
    ) as Record<string, unknown>;
    const title = control(
      "div",
      { contenteditable: "true", "data-placeholder": "请在这里输入标题" },
      { text: "Title" },
    );
    const doc = page({ title: [title], author: [author], summary: [summary] }) as Document;
    for (const element of [author, summary]) {
      Object.defineProperty(element, "ownerDocument", { value: doc });
      element.disabled = false;
      element.readOnly = false;
      element.dispatchEvent = () => true;
    }
    Object.defineProperty(doc, "defaultView", {
      value: {
        getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        HTMLInputElement: {
          prototype: {
            set value(value: string) {
              author.value = value;
            },
          },
        },
        HTMLTextAreaElement: {
          prototype: {
            set value(value: string) {
              summary.value = value;
            },
          },
        },
        Event: class {
          constructor(readonly type: string) {}
        },
      },
    });
    const result = await writeArticleFields(doc, { author: "same", summary: "new summary" });
    expect(result.result.status).toBe("ok");
    expect(result.effect).toMatchObject({
      outcome: "confirmed",
      requested: ["author", "summary"],
      attempted: ["summary"],
      confirmed: ["summary"],
      unknown: [],
    });
  });
});
