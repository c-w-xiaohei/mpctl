import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { saveArticle } from "../src/mp/article-save";

type FakeElement = {
  tagName: string;
  textContent: string;
  isConnected: boolean;
  hidden: boolean;
  id?: string;
  disabled: boolean;
  classList: { contains(name: string): boolean };
  children: FakeElement[];
  click(): void;
  getAttribute(name: string): string | null;
  getClientRects(): object[];
  querySelectorAll(selector: string): FakeElement[];
  parentElement?: FakeElement;
  closest(selector: string): FakeElement | null;
};

function element(
  tagName: string,
  textContent = "",
  classes: string[] = [],
  children: FakeElement[] = [],
  click: () => void = () => {},
): FakeElement {
  const node: FakeElement = {
    tagName: tagName.toUpperCase(),
    textContent,
    isConnected: true,
    hidden: false,
    disabled: false,
    classList: { contains: (name) => classes.includes(name) },
    children,
    click,
    getAttribute: () => null,
    getClientRects: () => [{}],
    querySelectorAll(selector) {
      if (selector === "*") return descendants(this);
      if (selector === "table") return descendants(this).filter((node) => node.tagName === "TABLE");
      if (selector === "p") return descendants(this).filter((node) => node.tagName === "P");
      if (selector === "table.appmsg_history_table")
        return descendants(this).filter(
          (node) => node.tagName === "TABLE" && node.classList.contains("appmsg_history_table"),
        );
      if (selector === "tr.appmsg_history_tr")
        return descendants(this).filter(
          (node) => node.tagName === "TR" && node.classList.contains("appmsg_history_tr"),
        );
      if (selector === ":scope > td") return this.children.filter((node) => node.tagName === "TD");
      if (selector === "tr.appmsg_history_tr")
        return descendants(this).filter(
          (node) => node.tagName === "TR" && node.classList.contains("appmsg_history_tr"),
        );
      return [];
    },
    closest(selector) {
      return closestTable(this, selector);
    },
  };
  for (const child of children) child.parentElement = node;
  return node;
}

function closestTable(start: FakeElement, selector: string): FakeElement | null {
  if (selector !== "table") return null;
  if (start.tagName === "TABLE") return start;
  return start.parentElement ? closestTable(start.parentElement, selector) : null;
}

function descendants(node: FakeElement): FakeElement[] {
  return node.children.flatMap((child) => [child, ...descendants(child)]);
}

function attach(parent: FakeElement, ...children: FakeElement[]) {
  parent.children = children;
  for (const child of children) child.parentElement = parent;
  return parent;
}

function fixture(
  options: {
    badHistory?: boolean;
    buttonEffectThenThrow?: boolean;
    noFreshRow?: boolean;
    cleanupFails?: boolean;
    alreadyOpen?: boolean;
    collapseOnSave?: boolean;
    delayedFreshRow?: boolean;
  } = {},
) {
  let expanded = false;
  let saves = 0;
  let toggles = 0;
  const historyRow = (source: string) =>
    element(
      "tr",
      "",
      ["appmsg_history_tr"],
      [
        element("td", "17:12", ["appmsg_history_time"]),
        element("td", "operator", ["appmsg_history_author"]),
        element("td", source, ["appmsg_history_source"]),
        element("td", "手动保存", ["appmsg_history_opr"]),
      ],
    );
  const header = element(
    "tr",
    "",
    ["appmsg_history_tr"],
    [
      element("td", "操作时间", ["appmsg_history_time"]),
      element("td", "操作人", ["appmsg_history_author"]),
      element("td", "来源", ["appmsg_history_source"]),
      element("td", "操作", ["appmsg_history_opr"]),
    ],
  );
  let table = attach(
    element("table", "", ["appmsg_history_table"]),
    ...(options.badHistory ? [] : [header, historyRow("后台")]),
  );
  let portal = attach(element("div", "", ["appmsg_history_popup", "history_overflow_auto"]), table);
  portal.id = "history_pop";
  portal.hidden = true;
  portal.isConnected = false;
  const label = element("p", "历史版本");
  const container = attach(element("div", "", ["appmsg_history_new"]), label);
  container.id = "history_bt";
  const launcher = container;
  const region = attach(element("div", "", ["appmsg_history_container"]), container);
  const setExpanded = (next: boolean) => {
    expanded = next;
    portal.hidden = !next;
    portal.isConnected = next;
  };
  launcher.click = () => {
    toggles++;
    if (options.cleanupFails && saves > 0 && expanded) return;
    setExpanded(!expanded);
  };
  if (options.alreadyOpen) setExpanded(true);
  const preview = element("button", "预览");
  const publish = element("button", "发表");
  const save = element("button", "保存为草稿", [], [], () => {
    saves++;
    if (options.collapseOnSave && expanded) {
      setExpanded(false);
    }
    const addRow = () => {
      const row = historyRow("后台");
      table.children.push(row);
      row.parentElement = table;
    };
    if (!options.noFreshRow && options.delayedFreshRow) setTimeout(addRow, 2);
    else if (!options.noFreshRow) addRow();
    if (options.buttonEffectThenThrow) throw new Error("reply lost after native save");
  });
  const document = {
    querySelectorAll(selector: string) {
      if (selector === ".appmsg_history_new") return [container];
      if (selector === "#history_pop") return portal.isConnected ? [portal] : [];
      if (selector === "button") return [preview, publish, save];
      if (selector === "tr.appmsg_history_tr")
        return descendants(region).filter(
          (n) => n.tagName === "TR" && n.classList.contains("appmsg_history_tr"),
        );
      return [];
    },
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
  } as unknown as Document;
  return {
    document,
    save,
    launcher,
    table,
    portal,
    replacePortalWithFreshHistory() {
      const replacementTable = attach(
        element("table", "", ["appmsg_history_table"]),
        header,
        historyRow("后台"),
        historyRow("后台刷新出的新手动行"),
      );
      const replacementPortal = attach(
        element("div", "", ["appmsg_history_popup", "history_overflow_auto"]),
        replacementTable,
      );
      replacementPortal.id = "history_pop";
      replacementPortal.hidden = false;
      replacementPortal.isConnected = true;
      portal.isConnected = false;
      portal = replacementPortal;
    },
    replaceTableWithFreshHistory() {
      table = attach(
        element("table", "", ["appmsg_history_table"]),
        header,
        historyRow("后台"),
        historyRow("后台刷新出的新手动行"),
      );
      attach(portal, table);
    },
    currentPortalTables() {
      return portal.querySelectorAll("table.appmsg_history_table");
    },
    get toggles() {
      return toggles;
    },
    get saves() {
      return saves;
    },
    get expanded() {
      return expanded;
    },
  };
}

const guard = () => Result.ok();
const fast = { timeoutMs: 100, pollIntervalMs: 1 };

describe("native article save", () => {
  test.each(["open", "restore"] as const)(
    "correction F2 held %s native transition is not ended from the initial display state",
    async (stage) => {
      const page = fixture();
      const original = page.launcher.click;
      let release: (() => void) | undefined;
      let toggles = 0,
        ended = 0;
      page.launcher.click = () => {
        toggles++;
        if ((stage === "open" && toggles === 1) || (stage === "restore" && toggles === 2))
          release = original;
        else original();
      };
      const result = await saveArticle(page.document, guard, {
        ...fast,
        publish(observation) {
          if (observation.ended) ended++;
        },
      });
      expect(ended).toBe(0);
      expect(page.saves).toBe(stage === "open" ? 0 : 1);
      expect(toggles).toBe(stage === "open" ? 1 : 2);
      expect(result.result?.status).toBe("error");
      release!();
      expect(page.expanded).toBe(stage === "open");
      expect(page.saves).toBe(stage === "open" ? 0 : 1);
      expect(ended).toBe(0);
    },
  );
  test.each([false, true])(
    "correction F2 normal history end preserves initial-open=%s",
    async (alreadyOpen) => {
      const page = fixture({ alreadyOpen });
      let ended = 0;
      expect(
        await saveArticle(page.document, guard, {
          ...fast,
          publish(observation) {
            if (observation.ended) ended++;
          },
        }),
      ).toEqual({
        effect: { outcome: "confirmed", persistence: "unverified" },
        ended: true,
        result: { status: "ok", value: {} },
      });
      expect(ended).toBe(1);
      expect(page.saves).toBe(1);
      expect(page.expanded).toBe(alreadyOpen);
      expect(page.toggles).toBe(alreadyOpen ? 0 : 2);
    },
  );
  test("dispatches one exact draft-save click and confirms an identical fresh history row", async () => {
    const page = fixture();
    const result = await saveArticle(page.document, guard, fast);
    expect(result).toEqual({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.saves).toBe(1);
    expect(page.expanded).toBe(false);
  });

  test("does not click when the pre-save history snapshot is unreadable", async () => {
    const page = fixture({ badHistory: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result.result?.status).toBe("error");
    expect(page.saves).toBe(0);
  });

  test("refuses a portal replacement after baseline await before native SAVE", async () => {
    const page = fixture();
    const cell = page.table
      .querySelectorAll("tr.appmsg_history_tr")[1]!
      .querySelectorAll(":scope > td")[0]!;
    Object.defineProperty(cell, "textContent", {
      get() {
        queueMicrotask(() => page.replacePortalWithFreshHistory());
        return "17:12";
      },
    });
    const result = await saveArticle(page.document, guard, fast);
    expect(page.saves).toBe(0);
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "history_unavailable", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.toggles).toBe(1);
    expect(page.expanded).toBe(true);
  });

  test("refuses a same-portal table replacement after baseline await before native SAVE", async () => {
    const page = fixture();
    const cell = page.table
      .querySelectorAll("tr.appmsg_history_tr")[1]!
      .querySelectorAll(":scope > td")[0]!;
    Object.defineProperty(cell, "textContent", {
      get() {
        queueMicrotask(() => page.replaceTableWithFreshHistory());
        return "17:12";
      },
    });
    const result = await saveArticle(page.document, guard, fast);
    expect(page.currentPortalTables()).not.toContain(page.table);
    expect(page.saves).toBe(0);
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "history_unavailable", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.toggles).toBe(1);
  });

  test("returns unknown after one click when only old history remains", async () => {
    const page = fixture({ noFreshRow: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result.result).toMatchObject({ status: "error", error: { code: "save_unknown" } });
    expect(page.saves).toBe(1);
  });

  test("does not dispatch if the target guard is lost before save", async () => {
    const page = fixture();
    const result = await saveArticle(
      page.document,
      () => Result.err({ code: "target_lost" }),
      fast,
    );
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "target_unavailable", cause: { at: "content.guard", code: "target_lost" } },
    });
    expect(page.saves).toBe(0);
  });

  test("returns unknown without retry if the target guard is lost after save click", async () => {
    const page = fixture();
    const guarded = () =>
      page.saves > 0 ? Result.err({ code: "target_lost" as const }) : Result.ok();
    const result = await saveArticle(page.document, guarded, fast);
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "target_unavailable", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.saves).toBe(1);
  });

  test("preserves the uncertain boundary when the native click throws after its effect", async () => {
    const page = fixture({ buttonEffectThenThrow: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result.result).toMatchObject({ status: "error", error: { code: "save_unknown" } });
    expect(page.saves).toBe(1);
  });

  test("never treats preview or publish as the draft-save control", async () => {
    const page = fixture();
    page.save.textContent = "发表";
    const result = await saveArticle(page.document, guard, fast);
    expect(result.result?.status).toBe("error");
    expect(page.saves).toBe(0);
  });

  test("leaves a history display open when it was already open on entry", async () => {
    const page = fixture({ alreadyOpen: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result).toEqual({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.expanded).toBe(true);
  });

  test("retains confirmed stage fact when owned history cleanup fails", async () => {
    const page = fixture({ cleanupFails: true });
    const published: import("../src/mp/article-save").ArticleSaveObservation[] = [];
    const result = await saveArticle(page.document, guard, {
      ...fast,
      publish: (observation) => published.push(structuredClone(observation)),
    });
    expect(published).toContainEqual({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: false,
    });
    expect(published.at(-1)).toEqual(result);
    expect(result).toMatchObject({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: false,
      result: {
        status: "error",
        error: { code: "cleanup_failed", cleanup: { code: "cleanup_failed" } },
      },
    });
    expect(page.saves).toBe(1);
    expect(page.expanded).toBe(true);
  });

  test("preserves the unknown-save primary error when display cleanup also fails", async () => {
    const page = fixture({ noFreshRow: true, cleanupFails: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "save_unknown", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.saves).toBe(1);
  });

  test("reopens a native-collapsed history display once and confirms a delayed fresh row", async () => {
    const page = fixture({ collapseOnSave: true, delayedFreshRow: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result).toEqual({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.saves).toBe(1);
    expect(page.toggles).toBe(3);
    expect(page.expanded).toBe(false);
  });

  test("restores caller-owned initially open history after native save collapses it", async () => {
    const page = fixture({ alreadyOpen: true, collapseOnSave: true, delayedFreshRow: true });
    const result = await saveArticle(page.document, guard, fast);
    expect(result).toEqual({
      effect: { outcome: "confirmed", persistence: "unverified" },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.saves).toBe(1);
    expect(page.toggles).toBe(1);
    expect(page.expanded).toBe(true);
  });

  test("rejects non-finite wait options before interacting with the page", async () => {
    for (const options of [
      { timeoutMs: Number.NaN },
      { pollIntervalMs: Number.POSITIVE_INFINITY },
    ]) {
      const page = fixture();
      expect((await saveArticle(page.document, guard, options)).result).toMatchObject({
        status: "error",
        error: { code: "page_failed", cause: { kind: "domain", code: "invalid_options" } },
      });
      expect(page.saves).toBe(0);
      expect(page.toggles).toBe(0);
    }
  });

  test("rechecks the guard after resolving the final save button", async () => {
    const page = fixture();
    let buttonQueries = 0;
    const original = page.document.querySelectorAll.bind(page.document);
    page.document.querySelectorAll = ((selector: string) => {
      const result = original(selector);
      if (selector === "button" && ++buttonQueries === 2)
        Object.defineProperty(page.save, "textContent", { get: () => "保存为草稿" });
      return result;
    }) as typeof page.document.querySelectorAll;
    let guardChecks = 0;
    const guarded = () => {
      guardChecks++;
      return guardChecks === 5 ? Result.err({ code: "target_lost" as const }) : Result.ok();
    };
    const result = await saveArticle(page.document, guarded, fast);
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "target_unavailable", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.saves).toBe(0);
  });
});
