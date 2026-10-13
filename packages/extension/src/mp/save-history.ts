import { Result, type Result as BetterResult } from "better-result";

export type SaveHistoryError = { code: "history_unavailable" } | { code: "target_lost" };
type ManualSnapshot = { portal: HTMLElement; table: HTMLTableElement };
export type SaveHistoryResult = BetterResult<ManualSnapshot, SaveHistoryError>;
export type SaveHistoryGuard = () => BetterResult<void, { code: "target_lost" }>;

const MAX_HISTORY_ROWS = 1001;
const manualEntries = new WeakMap<ManualSnapshot, string[]>();
const HISTORY_CONTAINER = ".appmsg_history_new";
const HISTORY_TABLE = "table.appmsg_history_table";
const HISTORY_ROWS = "tr.appmsg_history_tr";
const CELL_CLASSES = [
  "appmsg_history_time",
  "appmsg_history_author",
  "appmsg_history_source",
  "appmsg_history_opr",
] as const;
const HEADER = ["操作时间", "操作人", "来源", "操作"];

type HistorySnapshot = { rows: string[][]; portal: HTMLElement; table: HTMLTableElement };
type HistorySnapshotError = { code: "history_unavailable" };

function checkGuard(guard: SaveHistoryGuard): BetterResult<void, { code: "target_lost" }> {
  const checked = Result.try({
    try: guard,
    catch: () => ({ code: "target_lost" as const }),
  });
  if (checked.isErr()) return checked;
  return checked.value.isErr() ? checked.value : Result.ok(undefined);
}

function isVisible(element: Element, document: Document): boolean {
  if (!element.isConnected || (element as HTMLElement).hidden) return false;
  if (element.getClientRects().length === 0) return false;
  const style = document.defaultView?.getComputedStyle(element);
  return style !== undefined && style.display !== "none" && style.visibility !== "hidden";
}

export function isHistoryPortalVisible(document: Document): boolean {
  const portal = locateHistoryPortal(document);
  return Boolean(portal && isVisible(portal, document));
}

export function getHistoryPortal(
  document: Document,
): BetterResult<HTMLElement | undefined, { code: "history_unavailable" }> {
  return Result.try({
    try: () => {
      const portals = [...document.querySelectorAll<HTMLElement>("#history_pop")];
      if (portals.length === 0) return undefined;
      if (
        portals.length !== 1 ||
        portals[0]!.tagName !== "DIV" ||
        portals[0]!.id !== "history_pop" ||
        !portals[0]!.classList.contains("appmsg_history_popup")
      )
        return null;
      return portals[0]!;
    },
    catch: () => ({ code: "history_unavailable" as const }),
  }).andThen((portal) =>
    portal === null ? Result.err({ code: "history_unavailable" as const }) : Result.ok(portal),
  );
}

function locateHistoryPortal(document: Document): HTMLElement | undefined {
  const found = getHistoryPortal(document);
  return found.isOk() ? found.value : undefined;
}

function snapshotRows(document: Document): BetterResult<HistorySnapshot, HistorySnapshotError> {
  const captured = Result.try({
    try: () => {
      const containers = document.querySelectorAll<HTMLElement>(HISTORY_CONTAINER);
      if (containers.length !== 1 || !isVisible(containers[0]!, document)) return undefined;
      const portalResult = getHistoryPortal(document);
      if (portalResult.isErr()) return undefined;
      const portal = portalResult.value;
      if (!portal || !isVisible(portal, document)) return undefined;
      const tables = [...portal.querySelectorAll<HTMLTableElement>(HISTORY_TABLE)];
      if (
        tables.length !== 1 ||
        tables[0]!.tagName !== "TABLE" ||
        !tables[0]!.classList.contains("appmsg_history_table") ||
        !isVisible(tables[0]!, document)
      )
        return undefined;
      const table = tables[0]!;
      const rowList = table.querySelectorAll<HTMLTableRowElement>(HISTORY_ROWS);
      if (rowList.length === 0 || rowList.length > MAX_HISTORY_ROWS) return undefined;
      const rows = Array.from(rowList);
      if (rows.some((row) => row.closest("table") !== table)) return undefined;
      const cells = rows.map((row) => {
        const cellList = row.querySelectorAll(":scope > td");
        if (cellList.length !== 4) return undefined;
        const rowCells = Array.from(cellList);
        const values = rowCells.map((cell, index) => {
          if (!(cell as HTMLElement).classList.contains(CELL_CLASSES[index]!)) return undefined;
          return cell.textContent?.trim();
        });
        if (values.some((value) => value === undefined)) return undefined;
        return values as string[];
      });
      if (cells.some((row) => row === undefined)) return undefined;
      const validRows = cells as string[][];
      if (!HEADER.every((value, index) => validRows[0]![index] === value)) return undefined;
      return { rows: validRows.slice(1), portal, table };
    },
    catch: () => ({ code: "history_unavailable" as const }),
  });
  if (captured.isErr()) return captured;
  return captured.value === undefined
    ? Result.err({ code: "history_unavailable" })
    : Result.ok(captured.value);
}

function sameHistoryNodes(
  document: Document,
  portal: HTMLElement,
  table: HTMLTableElement,
): boolean {
  const currentPortal = getHistoryPortal(document);
  if (currentPortal.isErr() || currentPortal.value !== portal || !isVisible(portal, document))
    return false;
  const tables = [...portal.querySelectorAll<HTMLTableElement>(HISTORY_TABLE)];
  return (
    tables.length === 1 &&
    tables[0] === table &&
    table.isConnected &&
    table.classList.contains("appmsg_history_table") &&
    isVisible(table, document)
  );
}

export function readManualSaveHistory(
  document: Document,
  guard: SaveHistoryGuard,
): SaveHistoryResult {
  const initialGuard = checkGuard(guard);
  if (initialGuard.isErr()) return initialGuard;
  const snapshot = snapshotRows(document);
  if (snapshot.isErr()) return snapshot;
  const afterSnapshotGuard = checkGuard(guard);
  if (afterSnapshotGuard.isErr()) return afterSnapshotGuard;

  const { rows, portal, table } = snapshot.value;
  return Result.try({
    try: () => {
      if (!sameHistoryNodes(document, portal, table))
        return Result.err({ code: "history_unavailable" as const });
      const finalGuard = checkGuard(guard);
      if (finalGuard.isErr()) return Result.err(finalGuard.error);
      if (!sameHistoryNodes(document, portal, table))
        return Result.err({ code: "history_unavailable" as const });
      const result = { portal, table };
      manualEntries.set(
        result,
        rows.filter((row) => row[3] === "手动保存").map((row) => JSON.stringify(row)),
      );
      return Result.ok(result);
    },
    catch: () => ({ code: "history_unavailable" as const }),
  }).andThen((result) => result);
}

export function hasNewManualSave(before: ManualSnapshot, after: ManualSnapshot): boolean {
  const beforeEntries = manualEntries.get(before),
    afterEntries = manualEntries.get(after);
  if (!beforeEntries || !afterEntries) return false;
  const frequencies = new Map<string, number>();
  for (const entry of beforeEntries) frequencies.set(entry, (frequencies.get(entry) ?? 0) + 1);
  for (const entry of afterEntries) {
    const count = frequencies.get(entry) ?? 0;
    if (count === 0) return true;
    frequencies.set(entry, count - 1);
  }
  return false;
}
