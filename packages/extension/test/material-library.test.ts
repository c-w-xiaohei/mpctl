import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { createMaterialPageService } from "../entrypoints/mp.content";
import { materialUploadResultCodec, materialListResultCodec } from "../src/background-contracts";
import {
  closeMaterialLibrary,
  openMaterialLibrary,
  readMaterialLibrary,
} from "../src/mp/material-library";

const guard = () => Result.ok(undefined);

function makePage(
  options: {
    existing?: "body" | "cover";
    openFails?: boolean;
    cards?: FakeElement[];
  } = {},
) {
  let clicks = 0;
  let cancels = 0;
  let bodyWrites = 0;
  let currentDialog: FakeElement | undefined;
  const bodyDialog = makeDialog("确定", () => {
    currentDialog = bodyDialog;
  });
  const menuChoice = new FakeElement("从图片库选择", () => {
    clicks++;
    if (!options.openFails)
      currentDialog = makeDialog(
        "确定",
        () => {},
        () => {
          cancels++;
          if (currentDialog) currentDialog.isConnected = false;
          currentDialog = undefined;
        },
      );
  });
  const menu = new FakeElement("图片", () => {
    clicks++;
    pageDropdownVisible = true;
  });
  menu.children = [menuChoice];
  const unrelated = new FakeElement("从图片库选择", () => {
    bodyWrites++;
  });
  let pageDropdownVisible = false;
  const page = {
    get clicks() {
      return clicks;
    },
    get bodyWrites() {
      return bodyWrites;
    },
    get cancels() {
      return cancels;
    },
    get dialog() {
      return currentDialog;
    },
    changeDialog(dialog: FakeElement | undefined) {
      if (!dialog && currentDialog) currentDialog.isConnected = false;
      currentDialog = dialog;
    },
    document: {
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      querySelectorAll(selector: string) {
        if (selector === "li#js_editor_insertimage") return [menu];
        if (selector === ".js_img_from_local")
          return pageDropdownVisible ? [menuChoice, unrelated] : [unrelated];
        if (selector === ".weui-desktop-dialog") return currentDialog ? [currentDialog] : [];
        if (selector === ".unrelated") return [unrelated];
        return [];
      },
    } as unknown as Document,
  };
  if (options.existing === "body") currentDialog = makeDialog("确定", () => {});
  if (options.existing === "cover") currentDialog = makeDialog("下一步", () => {});
  if (currentDialog && options.cards) currentDialog.cards = options.cards;
  return page;
}

class FakeElement {
  isConnected = true;
  hidden = false;
  children: FakeElement[] = [];
  constructor(
    public textContent: string,
    private onClick: () => void = () => {},
  ) {}
  get ownerDocument() {
    return {
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      createTreeWalker: (root: FakeElement) => {
        const nodes = root.children.filter((child) => child.kind === "text");
        let index = -1;
        return {
          currentNode: undefined as FakeElement | undefined,
          nextNode() {
            index++;
            if (index >= nodes.length) return null;
            this.currentNode = nodes[index];
            return this.currentNode;
          },
        };
      },
    };
  }
  getClientRects() {
    return [{}];
  }
  querySelector(selector: string) {
    if (selector === ".weui-desktop-img-picker__img-title") return this.title;
    if (selector === ".weui-desktop-img-picker__img-thumb") return this.thumbnail;
    return selector === ".js_img_from_local" ? undefined : null;
  }
  click() {
    this.onClick();
  }
  querySelectorAll(selector: string) {
    if (selector === "button") return this.children.filter((child) => child.kind === "button");
    if (selector === ".js_img_from_local") return this.children;
    if (selector === ".weui-desktop-img-picker__item") return this.cards;
    return [];
  }
  kind = "element";
  className = "";
  closeClicks = 0;
  cards: FakeElement[] = [];
  title: FakeElement | undefined;
  thumbnail: FakeElement | undefined;
  getAttribute: (name: string) => string | null = () => null;
  tagName = "DIV";
  classList = { contains: (name: string) => this.className.split(/\s+/).includes(name) };
}

function makeDialog(
  confirm: string,
  onConfirm: () => void,
  onCancel: () => void = () => {},
  options: { unknownButton?: boolean; closeButton?: boolean } = { closeButton: true },
): FakeElement {
  const dialog = new FakeElement("选择图片");
  const title = new FakeElement("选择图片");
  title.kind = "text";
  const button = (text: string, action: () => void) => {
    const element = new FakeElement(text, action);
    element.kind = "button";
    element.tagName = "BUTTON";
    return element;
  };
  const close = button("", () => {
    dialog.closeClicks++;
  });
  close.className = "weui-desktop-dialog__close-btn";
  dialog.children = [
    title,
    ...(options.closeButton === false ? [] : [close]),
    button(confirm, onConfirm),
    button("取消", onCancel),
    ...(options.unknownButton ? [button("未知操作", () => {})] : []),
  ];
  return dialog;
}

describe("native material library lifecycle", () => {
  test.each(["observe", "menu", "choice"] as const)(
    "R2 returned %s library runtime failure retains cause through upload wire",
    async (mode) => {
      const page = makePage();
      const menu = page.document.querySelectorAll<HTMLElement>(
        "li#js_editor_insertimage",
      )[0] as unknown as FakeElement;
      const originalQuery = page.document.querySelectorAll.bind(page.document);
      if (mode === "observe")
        page.document.querySelectorAll = () => {
          throw new Error("private observe exception");
        };
      if (mode === "menu")
        menu.click = () => {
          throw new Error("private menu exception");
        };
      if (mode === "choice")
        menu.children[0]!.click = () => {
          throw new Error("private choice exception");
        };
      const document = Object.assign(page.document, {
        location: {
          href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
        },
        querySelector: () => null,
      });
      const service = createMaterialPageService(document, () => true);
      const identity = await service.identity();
      if (identity.status !== "ok") throw new Error("identity unavailable");
      const result = await materialUploadResultCodec.deserialize(
        await service.upload(
          {
            blob: new Blob([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])], {
              type: "image/png",
            }),
            filename: "runtime.png",
            mimeType: "image/png",
          },
          {
            operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
            executorId: identity.value.executorId,
          },
        ),
      );
      expect(result).toMatchObject({
        value: {
          effect: { outcome: "not_dispatched" },
          result: {
            error: {
              cause: {
                at: "content.library_open",
                kind: "runtime",
                code: mode === "observe" ? "dialog_observe_exception" : "click_exception",
              },
            },
          },
        },
      });
      expect(page.bodyWrites).toBe(0);
      page.document.querySelectorAll = originalQuery;
    },
  );

  test("correction Q1 observes original hidden choice before guard refusal and before any choice dispatch", async () => {
    const page = makePage();
    const menu = page.document.querySelectorAll<HTMLElement>(
      "li#js_editor_insertimage",
    )[0] as unknown as FakeElement;
    const choice = menu.children[0]!;
    choice.hidden = true;
    const click = menu.click.bind(menu);
    menu.click = () => {
      click();
      choice.hidden = false;
    };
    let observed = false;
    const events: string[] = [];
    const result = await openMaterialLibrary(
      page.document,
      () => (observed ? Result.err({ code: "target_unavailable" }) : guard()),
      {
        onDispatch: () => {
          events.push("dispatch");
        },
        onMenuObserved: () => {
          observed = true;
          events.push("original-observed");
        },
      },
    );
    expect(result).toMatchObject({ error: { code: "target_unavailable" } });
    expect(events).toEqual(["dispatch", "original-observed"]);
    expect(page.clicks).toBe(1);
    expect(page.dialog).toBeUndefined();
  });

  test("R2 returned cancel runtime failure keeps the cleanup observer", async () => {
    const page = makePage({ existing: "body" });
    const dialog = page.dialog!;
    dialog.children.find((child) => child.textContent === "取消")!.click = () => {
      throw new Error("private cancel exception");
    };
    expect(
      await closeMaterialLibrary(page.document, dialog as unknown as HTMLElement, guard),
    ).toMatchObject({
      error: {
        code: "cleanup_failed",
        causeCode: "cancel_dispatch_failed",
        observedFailure: { kind: "runtime", causeCode: "click_exception" },
      },
    });
    expect(dialog.closeClicks).toBe(0);
  });

  test("R2 internal material read observations do not leak into the strict list codec", async () => {
    const page = makePage({ existing: "body" });
    let observations = 0;
    const originalQuery = page.document.querySelectorAll.bind(page.document);
    page.document.querySelectorAll = ((selector: string) => {
      if (selector === ".weui-desktop-dialog" && ++observations === 3)
        throw new Error("private later read failure");
      return originalQuery(selector);
    }) as typeof page.document.querySelectorAll;
    const document = Object.assign(page.document, {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      },
      querySelector: () => null,
    });
    expect(
      await materialListResultCodec.deserialize(
        await createMaterialPageService(document, () => true).list(),
      ),
    ).toEqual(
      Result.err({
        code: "page_failed",
        ended: true,
        failure: {
          code: "page_failed",
          cause: { at: "content.readback", kind: "runtime", code: "dialog_observe_exception" },
        },
      }),
    );
  });

  test("B-N3 material list refusal before native UI reports reliable end with zero clicks", async () => {
    const page = makePage();
    const document = Object.assign(page.document, {
      location: {
        href: "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
      },
      querySelector: () => null,
    });
    const result = await materialListResultCodec.deserialize(
      await createMaterialPageService(document, () => false).list(),
    );
    expect(result).toMatchObject(
      Result.err({
        code: "target_unavailable",
        ended: true,
        failure: {
          code: "target_unavailable",
          cause: { at: "content.library_open", kind: "domain", code: "target_unavailable" },
        },
      }),
    );
    expect(page.clicks).toBe(0);
  });
  test("reads visible card filenames and thumbnails from the current body dialog", async () => {
    const page = makePage({ existing: "body", cards: [makeCard("one.png")] });
    const result = await readMaterialLibrary(page.document, guard);
    expect(result).toEqual(
      Result.ok({
        scope: "visible-page",
        cards: [{ filename: "one.png", thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/one/1" }],
      }),
    );
    expect(page.clicks).toBe(0);
    expect(page.bodyWrites).toBe(0);
  });

  test("reads native sz_mmbiz thumbnail URLs without rewriting them", async () => {
    const thumbnailUrl = "https://mmbiz.qpic.cn/sz_mmbiz_png/native-card/300?wx_fmt=png";
    const page = makePage({ existing: "body", cards: [makeCard("native.png", thumbnailUrl)] });

    const result = await readMaterialLibrary(page.document, guard);

    expect(result).toEqual(
      Result.ok({
        scope: "visible-page",
        cards: [{ filename: "native.png", thumbnailUrl }],
      }),
    );
  });

  test("continues to omit thumbnails outside the exact HTTPS host and known path families", async () => {
    const urls = [
      "http://mmbiz.qpic.cn/mmbiz_png/card/300",
      "https://evil.example/mmbiz_png/card/300",
      "https://user@mmbiz.qpic.cn/mmbiz_png/card/300",
      "https://mmbiz.qpic.cn/upload/card/300",
    ];
    const page = makePage({
      existing: "body",
      cards: urls.map((url, index) => makeCard(`invalid-${index}.png`, url)),
    });

    const result = await readMaterialLibrary(page.document, guard);

    expect(result).toEqual(
      Result.ok({
        scope: "visible-page",
        cards: urls.map((_, index) => ({ filename: `invalid-${index}.png` })),
      }),
    );
  });

  test("returns an empty snapshot for a confirmed empty visible page", async () => {
    const page = makePage({ existing: "body" });
    expect(await readMaterialLibrary(page.document, guard)).toEqual(
      Result.ok({ scope: "visible-page", cards: [] }),
    );
  });

  test("rejects a cover modal before reading its cards", async () => {
    const page = makePage({ existing: "cover", cards: [makeCard("cover.png")] });
    const result = await readMaterialLibrary(page.document, guard);
    expect(Result.isError(result) && result.error.code).toBe("dialog_unavailable");
  });

  test("guard change during card reads does not return a snapshot", async () => {
    const page = makePage({ existing: "body", cards: [makeCard("one.png")] });
    let checks = 0;
    const result = await readMaterialLibrary(page.document, () =>
      ++checks === 1 ? Result.ok(undefined) : Result.err({ code: "route_changed" }),
    );
    expect(Result.isError(result) && result.error.code).toBe("route_changed");
  });

  test("a malformed visible card fails the complete snapshot", async () => {
    const page = makePage({ existing: "body", cards: [new FakeElement("")] });
    const result = await readMaterialLibrary(page.document, guard);
    expect(Result.isError(result) && result.error.code).toBe("page_failed");
  });

  test("opens only the body editor library dialog through its native menu", async () => {
    const page = makePage();
    const result = await openMaterialLibrary(page.document, guard, { timeoutMs: 30 });
    expect(Result.isOk(result)).toBe(true);
    if (Result.isOk(result)) expect(result.value.opened).toBe(true);
    expect(page.clicks).toBe(2);
    expect(page.bodyWrites).toBe(0);
  });

  test("reuses an already-open body library without taking ownership", async () => {
    const page = makePage({ existing: "body" });
    const result = await openMaterialLibrary(page.document, guard);
    expect(Result.isOk(result) && result.value.opened).toBe(false);
    expect(page.clicks).toBe(0);
  });

  test("owned cancel followed by a replacement dialog is not original UI completion", async () => {
    const page = makePage({ existing: "body" });
    const original = page.dialog!;
    original.children.find((child) => child.textContent === "取消")!.click = () => {
      page.changeDialog(
        makeDialog(
          "确定",
          () => {},
          () => {},
        ),
      );
    };
    expect(
      await closeMaterialLibrary(page.document, original as unknown as HTMLElement, guard, {
        timeoutMs: 30,
      }),
    ).toMatchObject({ error: { code: "cleanup_failed", causeCode: "dialog_changed" } });
  });

  test("recognizes the native visible close button but closes only via cancel", async () => {
    const page = makePage();
    const nativeDialog = makeDialog(
      "确定",
      () => {},
      () => {
        page.changeDialog(undefined);
      },
    );
    page.changeDialog(nativeDialog);
    const opened = await openMaterialLibrary(page.document, guard);
    expect(Result.isOk(opened) && opened.value.opened).toBe(false);
    const closed = await closeMaterialLibrary(
      page.document,
      nativeDialog as unknown as HTMLElement,
      guard,
      { timeoutMs: 30 },
    );
    expect(Result.isOk(closed)).toBe(true);
    expect(nativeDialog.closeClicks).toBe(0);
    expect(page.bodyWrites).toBe(0);
  });

  test("rejects an unknown visible dialog button", async () => {
    const page = makePage();
    const menu = page.document.querySelectorAll<HTMLElement>(
      "li#js_editor_insertimage",
    )[0] as unknown as FakeElement;
    menu.children[0] = new FakeElement("从图片库选择", () => {
      page.changeDialog(
        makeDialog(
          "确定",
          () => {},
          () => {},
          { unknownButton: true },
        ),
      );
    });
    const result = await openMaterialLibrary(page.document, guard, { timeoutMs: 30 });
    expect(Result.isError(result) && result.error.code).toBe("library_open_unknown");
    expect(page.bodyWrites).toBe(0);
  });

  test("guard failure while reusing an open body dialog returns error without action", async () => {
    const page = makePage({ existing: "body" });
    const result = await openMaterialLibrary(page.document, () =>
      Result.err({ code: "route_changed" }),
    );
    expect(Result.isError(result) && result.error.code).toBe("route_changed");
    expect(page.clicks).toBe(0);
  });

  test("rejects a cover dialog without clicking controls", async () => {
    const page = makePage({ existing: "cover" });
    const result = await openMaterialLibrary(page.document, guard);
    expect(Result.isError(result) && result.error.code).toBe("dialog_unavailable");
    expect(page.clicks).toBe(0);
  });

  test("guard drift after opening the menu prevents the library-choice click", async () => {
    const page = makePage();
    let checks = 0;
    const result = await openMaterialLibrary(page.document, () =>
      ++checks === 1 ? Result.ok(undefined) : Result.err({ code: "route_changed" }),
    );
    expect(Result.isError(result) && result.error.code).toBe("route_changed");
    expect(page.clicks).toBe(1);
  });

  test("timeout after one choice click is unknown and never retries", async () => {
    const page = makePage({ openFails: true });
    const result = await openMaterialLibrary(page.document, guard, { timeoutMs: 10 });
    expect(Result.isError(result) && result.error.code).toBe("library_open_unknown");
    expect(page.clicks).toBe(2);
  });

  test("closes only the exact owned dialog using cancel", async () => {
    const page = makePage();
    const opened = await openMaterialLibrary(page.document, guard, { timeoutMs: 30 });
    expect(Result.isOk(opened)).toBe(true);
    if (Result.isError(opened)) return;
    const result = await closeMaterialLibrary(page.document, opened.value.dialog, guard, {
      timeoutMs: 30,
    });
    expect(Result.isOk(result)).toBe(true);
    expect(page.clicks).toBe(2);
    expect(page.cancels).toBe(1);
    expect(page.bodyWrites).toBe(0);
  });

  test("refuses to cancel if the original dialog has been replaced", async () => {
    const page = makePage();
    const opened = await openMaterialLibrary(page.document, guard, { timeoutMs: 30 });
    expect(Result.isOk(opened)).toBe(true);
    if (Result.isError(opened)) return;
    page.changeDialog(new FakeElement("other dialog"));
    const result = await closeMaterialLibrary(page.document, opened.value.dialog, guard);
    expect(Result.isError(result) && result.error.code).toBe("cleanup_failed");
    expect(page.clicks).toBe(2);
    expect(page.bodyWrites).toBe(0);
  });
});

function makeCard(filename: string, url = "https://mmbiz.qpic.cn/mmbiz_png/one/1"): FakeElement {
  const card = new FakeElement("");
  const title = new FakeElement(filename);
  const thumbnail = new FakeElement("");
  thumbnail.getAttribute = (name) => (name === "style" ? `background-image: url("${url}");` : null);
  card.title = title;
  card.thumbnail = thumbnail;
  return card;
}
