import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { hasUniqueObservedCurrentItem, listDraftGroups, openDraftGroup } from "../src/mp/drafts";
import { appmsgRouteIdentity } from "../src/pages";

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

  test("does not click an edit link if its group ceased being unique", () => {
    let clicked = 0;
    const card = {
      getAttribute(name: string) {
        return name === "data-appid" ? "group" : null;
      },
      querySelector(selector: string) {
        return selector === ".weui-desktop-tooltip__wrp.weui-desktop-link a" ? editLink : null;
      },
    };
    const editLink = {
      hidden: false,
      getAttribute() {
        return null;
      },
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {
        clicked++;
      },
    };
    const document = { querySelectorAll: () => [card] } as unknown as Document;
    expect(openDraftGroup(document, "group", () => false)).toEqual(
      Result.err({ code: "draft_unavailable" }),
    );
    expect(clicked).toBe(0);
  });

  test("returns a domain Err for an absent or ambiguous group", () => {
    const card = { getAttribute: () => "group" };
    const absent = { querySelectorAll: () => [] } as unknown as Document;
    const ambiguous = { querySelectorAll: () => [card, card] } as unknown as Document;

    expect(openDraftGroup(absent, "group")).toEqual(Result.err({ code: "draft_unavailable" }));
    expect(openDraftGroup(ambiguous, "group")).toEqual(Result.err({ code: "draft_unavailable" }));
  });

  test("maps DOM exceptions during draft opening to page_failed Err", () => {
    const document = {
      querySelectorAll() {
        throw new Error("detached page");
      },
    } as unknown as Document;

    expect(openDraftGroup(document, "group")).toEqual(Result.err({ code: "page_failed" }));
  });

  test("returns the observed Edit href instead of relying on a blocked synthetic popup", () => {
    const editLink = {
      href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=group",
      hidden: false,
      getAttribute: () => null,
      ownerDocument: {
        defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      },
      getClientRects: () => [1],
      click() {},
    };
    const card = {
      getAttribute: (name: string) => (name === "data-appid" ? "group" : null),
      querySelector: (selector: string) =>
        selector === ".weui-desktop-tooltip__wrp.weui-desktop-link a" ? editLink : null,
    };
    const document = { querySelectorAll: () => [card] } as unknown as Document;

    expect(openDraftGroup(document, "group", () => true)).toEqual(Result.ok(editLink.href));
  });

  test("rechecks route and group after Edit visibility lookup and before click", () => {
    let href = "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10";
    let clicked = 0;
    const initialRoute = appmsgRouteIdentity(href);
    const document = {
      location: {
        get href() {
          return href;
        },
      },
      querySelectorAll: () => [card],
    } as unknown as Document;
    const card = {
      getAttribute: (name: string) => (name === "data-appid" ? "group" : null),
      querySelector: (selector: string) =>
        selector === ".weui-desktop-tooltip__wrp.weui-desktop-link a" ? editLink : null,
    };
    const editLink = {
      hidden: false,
      getAttribute: () => null,
      ownerDocument: {
        defaultView: {
          getComputedStyle() {
            href =
              "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=10&count=10";
            return { display: "block", visibility: "visible" };
          },
        },
      },
      getClientRects: () => [1],
      click() {
        clicked++;
      },
    };

    const opened = openDraftGroup(document, "group", () => {
      const currentCards = [...document.querySelectorAll(".weui-desktop-card[data-appid]")];
      return (
        appmsgRouteIdentity(document.location.href) === initialRoute &&
        currentCards.filter((item) => item.getAttribute("data-appid") === "group").length === 1
      );
    });
    expect(clicked).toBe(0);
    expect(opened).toEqual(Result.err({ code: "draft_unavailable" }));
  });

  test("does not click an Edit link that is not visible", () => {
    let clicked = 0;
    const document = {
      querySelectorAll: () => [
        {
          getAttribute: (name: string) => (name === "data-appid" ? "group" : null),
          querySelector: () => ({
            hidden: true,
            getAttribute: () => null,
            ownerDocument: {
              defaultView: { getComputedStyle: () => ({ display: "none", visibility: "visible" }) },
            },
            getClientRects: () => [],
            click() {
              clicked++;
            },
          }),
        },
      ],
    } as unknown as Document;

    expect(openDraftGroup(document, "group", () => true)).toEqual(
      Result.err({ code: "draft_unavailable" }),
    );
    expect(clicked).toBe(0);
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
