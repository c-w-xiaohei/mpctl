import { describe, expect, test } from "bun:test";
import { hasUniqueObservedCurrentItem, listDraftGroups } from "../src/mp/drafts";

describe("article identity evidence", () => {
  test("lists only non-empty unique observed appid cards and their titles", () => {
    const document = draftListFixture([
      { id: "fixture-group-17", title: "Fixture draft" },
      { id: "", title: "Invalid" },
    ]);
    expect(listDraftGroups(document)).toEqual([
      { groupId: "fixture-group-17", title: "Fixture draft" },
    ]);
  });

  test("refuses duplicate group candidates instead of picking one card", () => {
    const document = draftListFixture([
      { id: "duplicate", title: "A" },
      { id: "duplicate", title: "B" },
    ]);
    expect(listDraftGroups(document)).toEqual([]);
  });

  test("does not parse an observed card without a title as a usable group", () => {
    const document = draftListFixture([{ id: "missing-title", title: "" }]);

    expect(listDraftGroups(document)).toEqual([]);
  });

  test("accepts only exactly one visible first current-item marker", () => {
    const item = (index: string, visible = true, current = true) => ({
      hidden: !visible,
      classList: { contains: (name: string) => name === "current" && current },
      getAttribute(name: string) {
        return name === "data-msgindex" ? index : null;
      },
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ display: visible ? "block" : "none", visibility: "visible" }),
        },
      },
      getClientRects: () => (visible ? [1] : []),
    });
    expect(
      hasUniqueObservedCurrentItem({ querySelectorAll: () => [item("0")] } as unknown as Document),
    ).toBe(true);
    expect(
      hasUniqueObservedCurrentItem({
        querySelectorAll: () => [item("0", true, true), item("1", false, false)],
      } as unknown as Document),
    ).toBe(true);
    expect(
      hasUniqueObservedCurrentItem({
        querySelectorAll: () => [item("0"), item("1")],
      } as unknown as Document),
    ).toBe(false);
    expect(
      hasUniqueObservedCurrentItem({ querySelectorAll: () => [item("1")] } as unknown as Document),
    ).toBe(false);
  });

  test("rejects a visible non-current appmsg item beside the observed first item", () => {
    const item = (index: string, current: boolean) => ({
      hidden: false,
      classList: { contains: (name: string) => name === "current" && current },
      getAttribute(name: string) {
        return name === "data-msgindex" ? index : null;
      },
      ownerDocument: {
        defaultView: {
          getComputedStyle: () => ({ display: "block", visibility: "visible" }),
        },
      },
      getClientRects: () => [1],
    });

    expect(
      hasUniqueObservedCurrentItem({
        querySelectorAll: (selector: string) =>
          selector === ".js_appmsg_item"
            ? [item("0", true), item("1", false)]
            : selector === ".js_appmsg_item.current"
              ? [item("0", true)]
              : [],
      } as unknown as Document),
    ).toBe(false);
  });
});

function draftListFixture(cards: Array<{ id: string; title: string }>): Document {
  const elements = cards.map(({ id, title }) => ({
    getAttribute(name: string) {
      return name === "data-appid" ? id : null;
    },
    querySelector(selector: string) {
      return selector === ".weui-desktop-publish__cover__title" ? { textContent: title } : null;
    },
  }));
  return {
    querySelectorAll(selector: string) {
      return selector === ".weui-desktop-card[data-appid]" ? elements : [];
    },
  } as unknown as Document;
}
