import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { hasNewManualSave, readManualSaveHistory } from "../src/mp/save-history";

const guard = () => Result.ok(undefined);

function makeHistory(
  rows: string[][],
  options: {
    visible?: boolean;
    containerCount?: number;
    onCellRead?: (value: string) => void;
  } = {},
) {
  let clicks = 0;
  let writes = 0;
  const makeCell = (className: string, text: string) => ({
    textContent: text,
    classList: { contains: (name: string) => name === className },
  });
  const header = ["操作时间", "操作人", "来源", "操作"];
  const classes = [
    "appmsg_history_time",
    "appmsg_history_author",
    "appmsg_history_source",
    "appmsg_history_opr",
  ];
  const rowNodes = [header, ...rows].map((values) => ({
    click: () => clicks++,
    closest: () => table,
    querySelectorAll: (selector: string) =>
      selector === ":scope > td"
        ? values.map((value, index) => {
            const cell = {
              ...makeCell(classes[index]!, value),
              click: () => clicks++,
            };
            Object.defineProperty(cell, "textContent", {
              get() {
                options.onCellRead?.(value);
                return value;
              },
            });
            return cell;
          })
        : [],
  }));
  const table = {
    click: () => clicks++,
    isConnected: true,
    hidden: false,
    tagName: "TABLE",
    classList: { contains: (name: string) => name === "appmsg_history_table" },
    getClientRects: () => (options.visible === false ? [] : [{}]),
    querySelectorAll: (selector: string) => (selector === "tr.appmsg_history_tr" ? rowNodes : []),
  };
  const portal = {
    id: "history_pop",
    tagName: "DIV",
    classList: { contains: (name: string) => name === "appmsg_history_popup" },
    isConnected: true,
    hidden: false,
    getClientRects: () => (options.visible === false ? [] : [{}]),
    querySelectorAll: (selector: string) =>
      selector === "table.appmsg_history_table" ? [table] : [],
  };
  const region = {
    click: () => clicks++,
    isConnected: true,
    hidden: false,
    getClientRects: () => (options.visible === false ? [] : [{}]),
    querySelectorAll: (selector: string) => (selector === "tr.appmsg_history_tr" ? rowNodes : []),
  };
  const container = {
    click: () => clicks++,
    isConnected: true,
    hidden: false,
    getClientRects: () => (options.visible === false ? [] : [{}]),
    parentElement: region,
  };
  const document = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
    querySelectorAll: (selector: string) => {
      if (selector === ".appmsg_history_new")
        return Array(options.containerCount ?? 1).fill(container);
      if (selector === "#history_pop") return [portal];
      return [];
    },
  };
  return {
    document: document as unknown as Document,
    get clicks() {
      return clicks;
    },
    get writes() {
      return writes;
    },
    onClick() {
      clicks++;
    },
    onWrite() {
      writes++;
    },
    disconnect() {
      container.isConnected = false;
    },
  };
}

describe("native manual-save history reader", () => {
  test("keeps exact manual-save tuples private to their snapshots", async () => {
    const page = makeHistory([
      ["10-03 14:29", " Operator ", "网页版", "预览"],
      ["10-03 14:27", " Operator ", "网页版", "手动保存"],
    ]);
    const result = await readManualSaveHistory(page.document, guard);
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      const empty = readManualSaveHistory(makeHistory([]).document, guard).unwrap();
      expect(hasNewManualSave(empty, result.value)).toBe(true);
      const preview = readManualSaveHistory(
        makeHistory([["10-03 14:29", "Operator", "网页版", "预览"]]).document,
        guard,
      ).unwrap();
      expect(hasNewManualSave(empty, preview)).toBe(false);
      expect(JSON.stringify(result.value)).not.toContain("Operator");
    }
    expect(page.clicks).toBe(0);
    expect(page.writes).toBe(0);
  });

  test("accepts a recognized expanded history table with no data rows", async () => {
    const result = await readManualSaveHistory(makeHistory([]).document, guard);
    expect(result.isOk()).toBe(true);
    expect(hasNewManualSave(result.unwrap(), result.unwrap())).toBe(false);
  });

  test("rechecks the target after reading a preview-only snapshot", async () => {
    let connected = true;
    const page = makeHistory([["10-03 14:29", "Operator", "网页版", "预览"]], {
      onCellRead: (value) => {
        if (value === "预览") connected = false;
      },
    });
    const result = await readManualSaveHistory(page.document, () =>
      connected ? Result.ok(undefined) : Result.err({ code: "target_lost" as const }),
    );
    expect(result.isErr() && result.error.code).toBe("target_lost");
  });

  test("rejects more than 1001 total rows before reading any cell text", async () => {
    let cellReads = 0;
    const page = makeHistory(
      Array.from({ length: 1002 }, (_, index) => [
        `10-03 14:${String(index % 60).padStart(2, "0")}`,
        "Operator",
        "网页版",
        "预览",
      ]),
      { onCellRead: () => cellReads++ },
    );
    const result = await readManualSaveHistory(page.document, guard);
    expect(result.isErr() && result.error.code).toBe("history_unavailable");
    expect(cellReads).toBe(0);
  });

  test("accepts the local bound of header plus 1000 data rows", async () => {
    const result = await readManualSaveHistory(
      makeHistory(
        Array.from({ length: 1000 }, (_, index) => [
          `10-03 14:${String(index % 60).padStart(2, "0")}`,
          "Operator",
          "网页版",
          "手动保存",
        ]),
      ).document,
      guard,
    );
    expect(result.isOk()).toBe(true);
    expect(
      hasNewManualSave(
        readManualSaveHistory(makeHistory([]).document, guard).unwrap(),
        result.unwrap(),
      ),
    ).toBe(true);
  });

  test("returns unavailable for hidden or ambiguous history containers", async () => {
    for (const options of [{ visible: false }, { containerCount: 2 }]) {
      const result = await readManualSaveHistory(makeHistory([], options).document, guard);
      expect(result.isErr() && result.error.code).toBe("history_unavailable");
    }
  });

  test("returns unavailable for malformed rows instead of treating them as empty", async () => {
    const page = makeHistory([["10-03 14:27", "Operator", "网页版"]]);
    const result = await readManualSaveHistory(page.document, guard);
    expect(result.isErr() && result.error.code).toBe("history_unavailable");
  });

  test("returns unavailable when the expanded table is missing", async () => {
    const page = makeHistory([]);
    const portal = page.document.querySelectorAll("#history_pop")[0] as unknown as {
      querySelectorAll: (selector: string) => unknown[];
    };
    portal.querySelectorAll = () => [];
    const result = await readManualSaveHistory(page.document, guard);
    expect(result.isErr() && result.error.code).toBe("history_unavailable");
  });

  test("converts a throwing DOM getter and a throwing guard to typed errors", async () => {
    const cellPage = makeHistory([["10-03", "Operator", "网页版", "手动保存"]], {
      onCellRead() {
        throw new Error("cell read failed");
      },
    });
    const cellResult = readManualSaveHistory(cellPage.document, guard);
    expect(cellResult.isErr() && cellResult.error.code).toBe("history_unavailable");
    const page = makeHistory([]);
    Object.defineProperty(page.document, "querySelectorAll", {
      get() {
        throw new Error("DOM detached");
      },
    });
    const domResult = await readManualSaveHistory(page.document, guard);
    expect(domResult.isErr() && domResult.error.code).toBe("history_unavailable");

    const guardResult = await readManualSaveHistory(makeHistory([]).document, () => {
      throw new Error("route lookup failed");
    });
    expect(guardResult.isErr() && guardResult.error.code).toBe("target_lost");
  });

  test("checks target guard after synchronous cell reads and refuses stale evidence", async () => {
    const page = makeHistory([["10-03 14:27", "Operator", "网页版", "手动保存"]]);
    let checks = 0;
    const result = await readManualSaveHistory(page.document, () => {
      checks++;
      if (checks === 2) page.disconnect();
      return page.document.querySelectorAll(".appmsg_history_new")[0]?.isConnected
        ? Result.ok(undefined)
        : Result.err({ code: "target_lost" as const });
    });
    expect(result.isErr() && result.error.code).toBe("target_lost");
    expect(checks).toBe(2);
  });
});

describe("manual-save multiset comparison", () => {
  const snapshot = (rows: string[][]) =>
    readManualSaveHistory(makeHistory(rows).document, guard).unwrap();
  const same = ["10-03", "Operator", "网页版", "手动保存"];
  const old = ["10-02", "Operator", "网页版", "手动保存"];
  test("recognizes an added duplicate exact tuple and each changed column", () => {
    expect(hasNewManualSave(snapshot([same]), snapshot([same, same]))).toBe(true);
    for (const index of [0, 1, 2]) {
      const changed = same.map((value, position) =>
        position === index ? value + "different" : value,
      );
      expect(hasNewManualSave(snapshot([same]), snapshot([changed]))).toBe(true);
    }
    expect(hasNewManualSave(snapshot([same]), snapshot([[...same.slice(0, 3), "预览"]]))).toBe(
      false,
    );
  });

  test("does not treat identical or removed old entries as new saves", () => {
    expect(hasNewManualSave(snapshot([same, old]), snapshot([same, old]))).toBe(false);
    expect(hasNewManualSave(snapshot([same, old]), snapshot([same]))).toBe(false);
  });

  test("rejects unknown snapshot objects rather than accepting caller-supplied identities", () => {
    const known = snapshot([same]);
    expect(hasNewManualSave({ ...known }, known)).toBe(false);
    expect(hasNewManualSave(known, { ...known })).toBe(false);
  });
});
