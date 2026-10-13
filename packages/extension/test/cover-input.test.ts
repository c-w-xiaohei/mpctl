import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { selectArticleCoverFromLibrary } from "../src/mp/cover-input";

const candidate = {
  filename: "cover.png",
  thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/asset/300?wx_fmt=png",
};
const baseline = {
  primary: { visible: true, url: "https://mmbiz.qpic.cn/mmbiz_png/current/0" },
  square: { visible: false, url: null },
};
const cropUrl = "https://mmbiz.qpic.cn/mmbiz_png/asset/0?wx_fmt=png";

function fixture(
  options: {
    cards?: { name: string; thumb: string }[];
    afterConfirm?: () => void;
    closeDelayMs?: number;
    previewDelayMs?: number;
    holdCropOpen?: boolean;
    hideCropAfterConfirm?: boolean;
    preserveCoverHash?: boolean;
    malformedCrop?: boolean;
  } = {},
) {
  let cover = baseline;
  let changed = false;
  let dialogs: FakeDialog[] = [];
  let confirms = 0;
  let cardClicks = 0;
  const cardItems = (
    options.cards ?? [{ name: candidate.filename, thumb: candidate.thumbnailUrl }]
  ).map((data) => new FakeCard(data.name, data.thumb, () => cardClicks++));
  const selection = new FakeDialog(
    "选择图片",
    cardItems,
    () => {},
    () => {
      crop.isConnected = true;
    },
  );
  const next = new FakeButton("下一步", () => {
    selection.isConnected = false;
    crop.isConnected = true;
  });
  selection.buttons = [next, new FakeButton("取消", () => (selection.isConnected = false))];
  const crop = new FakeDialog(
    "编辑封面",
    [],
    () => {
      confirms++;
      options.afterConfirm?.();
      const apply = () => {
        if (options.hideCropAfterConfirm) crop.visible = false;
        else if (!options.holdCropOpen) crop.isConnected = false;
        if (!options.preserveCoverHash)
          cover = {
            primary: { visible: true, url: cropUrl },
            square: { visible: false, url: null },
          };
      };
      if (options.closeDelayMs) setTimeout(apply, options.closeDelayMs);
      else apply();
      if (options.previewDelayMs) {
        cover = baseline;
        setTimeout(() => {
          if (!options.preserveCoverHash)
            cover = {
              primary: { visible: true, url: cropUrl },
              square: { visible: false, url: null },
            };
        }, options.previewDelayMs);
      }
      changed = true;
    },
    () => {},
  );
  crop.isConnected = false;
  crop.images = [new FakeImage(options.malformedCrop ? "https://example.com/not-qpic" : cropUrl)];
  crop.buttons = [
    new FakeButton("上一步", () => {}),
    new FakeButton("确认", () => crop.confirm()),
    new FakeButton("取消", () => {}, false),
    new FakeButton("", () => (crop.isConnected = false), true, "weui-desktop-dialog__close-btn"),
  ];
  dialogs = [selection, crop];
  const document = {
    defaultView: {
      getComputedStyle: (el: FakeElement) => ({
        display: el.isConnected && el.visible ? "block" : "none",
        visibility: "visible",
      }),
    },
    querySelectorAll(selector: string) {
      if (selector === ".weui-desktop-dialog") return dialogs.filter((d) => d.isConnected);
      if (selector === "#js_cover_area") return [area];
      return [];
    },
  } as unknown as Document;
  const area = new FakeElement("");
  area.tagName = "DIV";
  area.ownerDocument = document;
  area.querySelectorAll = (selector: string) => {
    if (selector === ".js_cover_preview_new")
      return [attach(preview(cover.primary.url, cover.primary.visible, document), area)];
    if (selector === ".js_cover_preview_square")
      return [attach(preview(cover.square.url, cover.square.visible, document), area)];
    return [];
  };
  return {
    document,
    guard: () => Result.ok(undefined),
    get confirms() {
      return confirms;
    },
    get cardClicks() {
      return cardClicks;
    },
    get changed() {
      return changed;
    },
    selection,
    crop,
    replaceDialog(dialog: FakeDialog) {
      dialogs = [dialog];
    },
  };
}

class FakeElement {
  isConnected = true;
  hidden = false;
  parentElement: FakeElement | null = null;
  tagName: string;
  className = "";
  style = { backgroundImage: "none" };
  ownerDocument = {
    baseURI: "https://mp.weixin.qq.com/",
    defaultView: {
      getComputedStyle: (element: FakeElement) => ({
        display: element.isConnected && element.visible ? "block" : "none",
        visibility: "visible",
      }),
    },
  } as unknown as Document;
  constructor(
    public textContent: string,
    public onClick: () => void = () => {},
    public visible = true,
  ) {
    this.tagName = "BUTTON";
  }
  getClientRects() {
    return this.visible ? [{}] : [];
  }
  get classList() {
    return { contains: (name: string) => this.className.split(/\s+/).includes(name) };
  }
  click() {
    this.onClick();
  }
  querySelectorAll(_selector: string): FakeElement[] {
    return [];
  }
  querySelector(_selector: string): FakeElement | null {
    return null;
  }
}

class FakeButton extends FakeElement {
  disabled = false;
  constructor(text: string, onClick: () => void, visible = true, cls = "") {
    super(text, onClick, visible);
    this.className = cls;
  }
}

class FakeCard extends FakeElement {
  title: FakeElement;
  thumbnail: FakeElement;
  constructor(name: string, thumb: string, click: () => void) {
    super("", () => {
      this.className = "weui-desktop-img-picker__item selected";
      click();
    });
    this.tagName = "DIV";
    this.title = new FakeElement(name);
    this.thumbnail = new FakeElement(thumb);
    this.thumbnail.style.backgroundImage = `url("${thumb}")`;
  }
  querySelector(selector: string) {
    return selector.includes("title") ? this.title : this.thumbnail;
  }
}

class FakeDialog extends FakeElement {
  buttons: FakeButton[] = [];
  images: FakeImage[] = [];
  constructor(
    public title: string,
    public cards: FakeCard[],
    private confirmAction: () => void,
    onNext: () => void,
  ) {
    super(title);
    this.textContent = title;
    this.onClick = onNext;
  }
  confirm() {
    this.confirmAction();
  }
  querySelectorAll(selector: string): FakeElement[] {
    if (selector === ".weui-desktop-img-picker__item") return this.cards;
    if (selector === "button") return this.buttons;
    if (selector === ".weui-desktop-dialog__close-btn")
      return this.buttons.filter((button) =>
        button.className.includes("weui-desktop-dialog__close-btn"),
      );
    if (selector === ".crop-img") return this.images;
    return [];
  }
}

class FakeImage extends FakeElement {
  naturalWidth = 640;
  naturalHeight = 360;
  constructor(public src: string) {
    super("");
    this.tagName = "IMG";
  }
}

function preview(url: string | null, visible: boolean, document: Document) {
  const element = new FakeElement("");
  element.tagName = "DIV";
  element.visible = visible;
  element.ownerDocument = document;
  element.style.backgroundImage = url ? `url("${url}")` : "none";
  return element;
}

function attach<T extends FakeElement>(element: T, parent: FakeElement): T {
  element.parentElement = parent;
  return element;
}

describe("selectArticleCoverFromLibrary", () => {
  test("refuses a BODY-style 确定 modal without clicking anything", async () => {
    const page = fixture();
    page.selection.buttons = [new FakeButton("确定", () => (page.selection.isConnected = false))];
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard);
    expect(result.result?.status).toBe("error");
    expect(page.cardClicks).toBe(0);
    expect(page.confirms).toBe(0);
  });

  test("an initial throwing guard is a pre-dispatch page error with zero UI clicks", async () => {
    const page = fixture();
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      throw new Error("guard unavailable");
    });
    expect(result.result).toMatchObject({ status: "error", error: { code: "page_failed" } });
    expect(page.cardClicks).toBe(0);
    expect(page.confirms).toBe(0);
  });

  test("a throwing cancel preserves the selection guard error and records cleanup failure", async () => {
    const page = fixture();
    let checks = 0;
    page.selection.buttons[1]!.onClick = () => {
      throw new Error("cancel failed");
    };
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      return checks === 5 ? Result.err({ code: "route_changed" }) : Result.ok(undefined);
    });
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "route_changed", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.confirms).toBe(0);
  });

  test("a cancel that leaves the owned selection modal open reports cleanup failure", async () => {
    const page = fixture();
    let checks = 0;
    page.selection.buttons[1]!.onClick = () => {};
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      return checks === 5 ? Result.err({ code: "route_changed" }) : Result.ok(undefined);
    });
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "route_changed", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.confirms).toBe(0);
  });

  test("does not cancel a replacement dialog after guard loss", async () => {
    const page = fixture();
    let checks = 0;
    let replacementClicks = 0;
    const original = page.selection.buttons[1]!;
    original.onClick = () => {
      replacementClicks++;
      page.selection.isConnected = false;
    };
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      if (checks === 5) {
        page.selection.isConnected = false;
        const replacement = new FakeDialog(
          "选择图片",
          [],
          () => {},
          () => {},
        );
        replacement.buttons = [new FakeButton("取消", () => replacementClicks++)];
        page.replaceDialog(replacement);
        return Result.err({ code: "route_changed" });
      }
      return Result.ok(undefined);
    });
    expect(result.result).toMatchObject({ status: "error", error: { code: "route_changed" } });
    expect(replacementClicks).toBe(0);
    expect(page.confirms).toBe(0);
  });

  test("a DOM query throw during cleanup preserves the primary guard error and reports cleanup failure", async () => {
    const page = fixture();
    let checks = 0;
    const originalQuery = page.document.querySelectorAll.bind(page.document);
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      if (checks === 5) {
        page.document.querySelectorAll = (() => {
          throw new Error("DOM changed during cleanup");
        }) as typeof page.document.querySelectorAll;
        return Result.err({ code: "route_changed" });
      }
      return Result.ok(undefined);
    });
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "route_changed", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.confirms).toBe(0);
    page.document.querySelectorAll = originalQuery;
  });

  test("an owner connectivity getter throw during cleanup preserves the primary error", async () => {
    const page = fixture();
    let checks = 0;
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      if (checks === 5) {
        Object.defineProperty(page.selection, "isConnected", {
          configurable: true,
          get() {
            throw new Error("owner was detached during cleanup");
          },
        });
        return Result.err({ code: "route_changed" });
      }
      return Result.ok(undefined);
    });
    expect(result.result).toMatchObject({
      status: "error",
      error: { code: "route_changed", cleanup: { code: "cleanup_failed" } },
    });
    expect(page.confirms).toBe(0);
  });

  test("selects only the exact filename-and-thumbnail match then confirms once", async () => {
    const page = fixture({
      cards: [
        { name: candidate.filename, thumb: "https://mmbiz.qpic.cn/mmbiz_png/other/300" },
        { name: candidate.filename, thumb: candidate.thumbnailUrl },
      ],
    });
    const published: import("../src/mp/cover-input").CoverInputObservation[] = [];
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard, {
      publish: (observation) => published.push(structuredClone(observation)),
    });
    expect(
      published.some(
        (observation) => observation.effect.outcome === "confirmed" && !observation.ended,
      ),
    ).toBe(true);
    expect(published.at(-1)).toEqual(result);
    expect(result).toMatchObject({
      effect: { outcome: "confirmed" },
      ended: true,
      result: { status: "ok" },
    });
    expect(page.cardClicks).toBe(1);
    expect(page.confirms).toBe(1);
  });

  test("does not report success if crop remains open after confirm timeout", async () => {
    const page = fixture({ holdCropOpen: true });
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard, {
      timeoutMs: 20,
    });
    expect(result.result?.status).toBe("error");
    expect(page.confirms).toBe(1);
  });

  test("waits for delayed crop close and configured preview before reporting success", async () => {
    const page = fixture({ closeDelayMs: 35, previewDelayMs: 55 });
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard, {
      timeoutMs: 250,
    });
    expect(result).toMatchObject({
      effect: { outcome: "confirmed" },
      ended: true,
      result: { status: "ok" },
    });
    expect(page.confirms).toBe(1);
  });

  test("accepts the owned crop modal hidden in place after confirm then reads a fresh cover", async () => {
    const page = fixture({ hideCropAfterConfirm: true });
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard);
    expect(result).toMatchObject({
      effect: { outcome: "confirmed" },
      ended: true,
      result: { status: "ok" },
    });
    expect("coverHash" in result.effect && result.effect.coverHash).not.toBe("baseline");
    expect(page.confirms).toBe(1);
  });

  test("does not treat a hidden crop as closed while another native dialog remains visible", async () => {
    const page = fixture({
      hideCropAfterConfirm: true,
      afterConfirm: () => {
        const replacement = new FakeDialog(
          "unexpected",
          [],
          () => {},
          () => {},
        );
        page.replaceDialog(replacement);
      },
      preserveCoverHash: true,
    });
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard, {
      timeoutMs: 20,
    });
    expect(result).toMatchObject({
      effect: { outcome: "unknown", baselineHash: expect.any(String) },
      ended: false,
      result: { status: "error", error: { code: "cover_update_unknown" } },
    });
    expect(page.confirms).toBe(1);
  });

  test("accepts a valid fresh closed-dialog confirmation even when the preview hash is unchanged", async () => {
    const page = fixture({ preserveCoverHash: true });
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard);
    expect(result).toMatchObject({
      effect: { outcome: "confirmed" },
      ended: true,
      result: { status: "ok" },
    });
    expect(page.confirms).toBe(1);
  });

  test("guard loss after baseline reread but before confirm preserves primary error and never confirms", async () => {
    const page = fixture();
    let checks = 0;
    const guard = () => {
      checks++;
      return checks === 10 ? Result.err({ code: "route_changed" }) : Result.ok(undefined);
    };
    const result = await selectArticleCoverFromLibrary(page.document, candidate, guard);
    expect(result.result?.status).toBe("error");
    expect(page.confirms).toBe(0);
    expect(page.crop.isConnected).toBe(false);
  });

  test("malformed crop returns ordinary error and closes only the owned crop with native X", async () => {
    const page = fixture({ malformedCrop: true });
    let closeClicks = 0;
    page.crop.buttons[3]!.onClick = () => {
      closeClicks++;
      page.crop.isConnected = false;
    };
    const result = await selectArticleCoverFromLibrary(page.document, candidate, page.guard);
    expect(result.result?.status).toBe("error");
    expect(page.confirms).toBe(0);
    expect(closeClicks).toBe(1);
  });

  test("a guard loss after native confirmation is unknown and never retries", async () => {
    let checks = 0;
    const page = fixture();
    const result = await selectArticleCoverFromLibrary(page.document, candidate, () => {
      checks++;
      return checks > 10 ? Result.err({ code: "route_changed" }) : Result.ok(undefined);
    });
    expect(result.result?.status).toBe("error");
    expect(page.confirms).toBe(1);
  });
});
