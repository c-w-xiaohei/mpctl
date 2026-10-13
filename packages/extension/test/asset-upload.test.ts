import { describe, expect, test } from "bun:test";
import { Result } from "better-result";
import { uploadAsset } from "../src/mp/asset-upload";

type TestFile = { name: string; type: string; size: number };

const dialogSelector = ".weui-desktop-dialog";
const inputSelector = '.weui-desktop-upload_global-media input[type="file"][accept*="bmp"]';
const cardSelector = ".weui-desktop-img-picker__item";

function makePage(
  options: {
    cards?: string[];
    thumbnailUrl?: string;
    newCardFilename?: string;
    newCardUntitledThenNamedAfterMs?: number;
    createCardOnChange?: boolean;
    onNewCardTitleRead?: () => void;
    setter?: (file: TestFile) => void;
  } = {},
) {
  const cards = [...(options.cards ?? [])].map((name) => makeCard(name));
  let assigned: TestFile | undefined;
  let changeCount = 0;
  let currentDialog:
    | {
        isConnected: boolean;
        ownerDocument: {
          defaultView: { getComputedStyle: () => { display: string; visibility: string } };
          createTreeWalker: () => { currentNode: { textContent: string }; nextNode: () => boolean };
        };
        textContent: string;
        hidden: boolean;
        getClientRects: () => object[];
        querySelectorAll: (selector: string) => unknown[];
      }
    | undefined;
  class TestFile {
    name: string;
    type: string;
    size: number;
    constructor(parts: Blob[], name: string, init: { type: string }) {
      this.name = name;
      this.type = init.type;
      this.size = parts.reduce((size, part) => size + part.size, 0);
    }
  }
  class TestTransfer {
    items: { add(file: TestFile): void };
    files: TestFile[] = [];
    constructor() {
      this.items = { add: (file) => this.files.push(file) };
    }
  }
  class TestEvent {
    constructor(
      public type: string,
      _init: { bubbles: boolean },
    ) {}
  }
  const input = {
    isConnected: true,
    disabled: false,
    multiple: true,
    type: "file",
    accept: "image/bmp, image/png, image/jpeg, image/jpg, image/gif, image/webp",
    set files(files: TestFile[]) {
      assigned = files[0];
      options.setter?.(files[0]!);
    },
    get files() {
      return [];
    },
    dispatchEvent(event: TestEvent) {
      if (event.type === "change") {
        changeCount++;
        if (options.createCardOnChange !== false) {
          const filename = options.newCardFilename ?? assigned?.name ?? "";
          const card = makeCard(
            options.newCardUntitledThenNamedAfterMs === undefined ? filename : "",
            options.thumbnailUrl,
            options.onNewCardTitleRead,
          );
          cards.push(card);
          if (options.newCardUntitledThenNamedAfterMs !== undefined)
            setTimeout(() => card.setTitle?.(filename), options.newCardUntitledThenNamedAfterMs);
        }
        assigned = undefined; // The page may clear the control after handling the file.
      }
      return true;
    },
  };
  const dialog = {
    isConnected: true,
    ownerDocument: {
      defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      createTreeWalker: () => {
        let read = false;
        return {
          currentNode: { textContent: "选择图片" },
          nextNode: () => !read && ((read = true), true),
        };
      },
    },
    textContent: "选择图片 上传文件 取消 下一步",
    hidden: false,
    getClientRects: () => [{}],
    querySelectorAll(selector: string) {
      if (selector === inputSelector) return [input];
      if (selector === cardSelector) return cards;
      return [];
    },
  };
  currentDialog = dialog;
  const document = {
    defaultView: {
      Blob,
      File: TestFile,
      DataTransfer: TestTransfer,
      Event: TestEvent,
      getComputedStyle: () => ({ display: "block", visibility: "visible" }),
    },
    querySelectorAll(selector: string) {
      if (selector === dialogSelector) return currentDialog ? [currentDialog] : [];
      if (selector === cardSelector) return cards;
      return [];
    },
  } as unknown as Document;
  return {
    document,
    input,
    get changeCount() {
      return changeCount;
    },
    cards,
    replaceDialog() {
      currentDialog = { ...dialog, querySelectorAll: () => [] };
    },
  };
}

function makeCard(
  filename: string,
  thumbnailUrl = "https://mmbiz.qpic.cn/mmbiz_png/example/300?wx_fmt=png",
  onTitleRead?: () => void,
) {
  let currentFilename = filename;
  return {
    isConnected: true,
    className: "weui-desktop-img-picker__item",
    setTitle(value: string) {
      currentFilename = value;
    },
    querySelector(selector: string) {
      if (selector === ".weui-desktop-img-picker__img-title")
        return {
          get textContent() {
            onTitleRead?.();
            return currentFilename;
          },
        };
      if (selector === ".weui-desktop-img-picker__img-thumb") {
        return {
          style: { backgroundImage: `url("${thumbnailUrl}")` },
          getAttribute: (name: string) =>
            name === "style" ? `background-image: url("${thumbnailUrl}");` : null,
        };
      }
      return null;
    },
  };
}

const guard = () => Result.ok(undefined);
const payload = (filename = "new-image.png") => ({
  blob: new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }),
  filename,
  mimeType: "image/png",
});

describe("uploadAsset", () => {
  test("confirms the new filename card even when the page clears input.files after change", async () => {
    const page = makePage();
    const published: import("../src/mp/asset-upload").AssetUploadObservation[] = [];
    const result = await uploadAsset(page.document, payload(), guard, {
      timeoutMs: 30,
      publish: (observation) => published.push(structuredClone(observation)),
    });
    expect(published[0]).toMatchObject({ effect: { outcome: "unknown" }, ended: false });
    expect(published.at(-1)).toEqual(result);
    expect(result).toEqual({
      effect: {
        outcome: "confirmed",
        filename: "new-image.png",
        thumbnailUrl: "https://mmbiz.qpic.cn/mmbiz_png/example/300?wx_fmt=png",
      },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.changeCount).toBe(1);
    expect(page.cards).toHaveLength(1);
  });

  test("confirms a new native sz_mmbiz card and returns its original thumbnail URL", async () => {
    const thumbnailUrl = "https://mmbiz.qpic.cn/sz_mmbiz_png/native-card/300?wx_fmt=png";
    const page = makePage({ thumbnailUrl });

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 30 });

    expect(result).toEqual({
      effect: { outcome: "confirmed", filename: "new-image.png", thumbnailUrl },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.changeCount).toBe(1);
    expect(page.cards).toHaveLength(1);
  });

  test("waits for a dispatched native card title before confirming the exact filename", async () => {
    const thumbnailUrl = "https://mmbiz.qpic.cn/sz_mmbiz_png/native-card/300?wx_fmt=png";
    const page = makePage({ thumbnailUrl, newCardUntitledThenNamedAfterMs: 25 });

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 300 });

    expect(result).toEqual({
      effect: { outcome: "confirmed", filename: "new-image.png", thumbnailUrl },
      ended: true,
      result: { status: "ok", value: {} },
    });
    expect(page.changeCount).toBe(1);
    expect(page.cards).toHaveLength(1);
  });

  test("keeps a persistent blank-title card unknown after one dispatch", async () => {
    const page = makePage({ newCardFilename: "" });

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 25 });

    expect(result).toMatchObject({
      result: {
        status: "error",
        error: {
          code: "asset_upload_unknown",
          cause: { at: "content.upload_confirm", kind: "domain", code: "card_title_empty" },
          confirmationTimedOut: true,
        },
      },
      effect: { outcome: "unknown" },
      ended: false,
    });
    expect(page.changeCount).toBe(1);
    expect(page.cards).toHaveLength(1);
  });

  test("rejects an initially malformed snapshot before assigning or dispatching", async () => {
    const page = makePage({ cards: [""] });

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 25 });

    expect(result).toMatchObject({
      result: {
        status: "error",
        error: {
          code: "page_failed",
          cause: { at: "content.upload_preflight", kind: "domain", code: "card_title_empty" },
        },
      },
      effect: { outcome: "not_dispatched" },
      ended: true,
    });
    expect(page.changeCount).toBe(0);
  });

  test("returns unknown promptly if the guard changes while a post-dispatch card is malformed", async () => {
    let routeChanged = false;
    const page = makePage({
      newCardFilename: "",
      onNewCardTitleRead: () => {
        routeChanged = true;
      },
    });

    const result = await uploadAsset(
      page.document,
      payload(),
      () => (routeChanged ? Result.err({ code: "route_changed" }) : Result.ok(undefined)),
      { timeoutMs: 300 },
    );

    expect(result).toMatchObject({
      result: {
        status: "error",
        error: {
          code: "asset_upload_unknown",
          cause: { at: "content.upload_confirm", code: "route_changed" },
        },
      },
      effect: { outcome: "unknown" },
      ended: false,
    });
    expect(page.changeCount).toBe(1);
  });

  test("returns unknown promptly if the file input disconnects while a post-dispatch card is malformed", async () => {
    let input: ReturnType<typeof makePage>["input"] | undefined;
    const page = makePage({
      newCardFilename: "",
      onNewCardTitleRead: () => {
        if (input) input.isConnected = false;
      },
    });
    input = page.input;

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 300 });

    expect(result).toMatchObject({
      result: {
        status: "error",
        error: {
          code: "asset_upload_unknown",
          cause: { at: "content.upload_confirm", code: "dialog_or_input_changed" },
        },
      },
      effect: { outcome: "unknown" },
      ended: false,
    });
    expect(page.changeCount).toBe(1);
  });

  test("returns unknown promptly if the dialog is replaced while a post-dispatch card is malformed", async () => {
    let page: ReturnType<typeof makePage> | undefined;
    let replaced = false;
    page = makePage({
      newCardFilename: "",
      onNewCardTitleRead: () => {
        if (replaced) return;
        replaced = true;
        page?.replaceDialog();
      },
    });

    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 300 });

    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(page.changeCount).toBe(1);
  });

  test("rejects an existing filename before assigning files or dispatching", async () => {
    const page = makePage({ cards: ["new-image.png"] });
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 10 });
    expect(result.result?.status === "error" && result.result.error.code).toBe("asset_ambiguous");
    expect(page.changeCount).toBe(0);
  });

  test("converts a missing existing-card title hook to a typed error before dispatch", async () => {
    const page = makePage();
    page.cards.push({
      isConnected: true,
      className: "weui-desktop-img-picker__item",
      querySelector: () => null,
    } as unknown as ReturnType<typeof makeCard>);
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 5 });
    expect(result.result?.status === "error" && result.result.error.code).toBe("page_failed");
    expect(page.changeCount).toBe(0);
  });

  test("does not report success from progress or a card with a non-library thumbnail", async () => {
    const page = makePage({ thumbnailUrl: "https://evil.example/file.png" });
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 5 });
    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(page.changeCount).toBe(1);
  });

  test("returns unknown without retry when change dispatch throws after file assignment", async () => {
    const page = makePage();
    const input = page.input as unknown as {
      dispatchEvent: () => boolean;
    };
    input.dispatchEvent = () => {
      throw new Error("dispatch boundary");
    };
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 5 });
    expect(result).toMatchObject({
      result: {
        status: "error",
        error: {
          code: "asset_upload_unknown",
          cause: { at: "content.upload_dispatch", kind: "runtime", code: "change_dispatch_failed" },
        },
      },
      effect: { outcome: "unknown" },
      ended: false,
    });
    expect(page.changeCount).toBe(0);
  });

  test("returns unknown when the guard changes during files assignment without dispatching", async () => {
    const page = makePage();
    let checks = 0;
    const result = await uploadAsset(
      page.document,
      payload(),
      () => {
        checks++;
        return checks < 2 ? Result.ok(undefined) : Result.err({ code: "route_changed" });
      },
      { timeoutMs: 5 },
    );
    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(checks).toBe(2);
    expect(page.changeCount).toBe(0);
  });

  test("does not report success if route changes while reading the new card title", async () => {
    const page = makePage({
      onNewCardTitleRead: () => {
        routeChanged = true;
      },
    });
    let routeChanged = false;
    const result = await uploadAsset(
      page.document,
      payload(),
      () => (routeChanged ? Result.err({ code: "route_changed" }) : Result.ok(undefined)),
      { timeoutMs: 10 },
    );
    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(page.changeCount).toBe(1);
  });

  test("matches filenames exactly instead of trimming card titles", async () => {
    const page = makePage({ newCardFilename: " new-image.png " });
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 5 });
    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(page.changeCount).toBe(1);
  });

  test("rejects a guard failure before assigning files or dispatching", async () => {
    const page = makePage();
    const result = await uploadAsset(page.document, payload(), () =>
      Result.err({ code: "route_changed" }),
    );
    expect(result.result?.status === "error" && result.result.error.code).toBe("route_changed");
    expect(page.changeCount).toBe(0);
  });

  test("rejects mismatched MIME and oversized payloads before dispatch", async () => {
    const page = makePage();
    const mismatch = await uploadAsset(
      page.document,
      { ...payload(), mimeType: "image/jpeg" },
      guard,
    );
    const oversized = await uploadAsset(
      page.document,
      {
        blob: new Blob([new Uint8Array(2 * 1024 * 1024 + 1)], { type: "image/png" }),
        filename: "large.png",
        mimeType: "image/png",
      },
      guard,
    );
    expect(mismatch.result?.status === "error" && mismatch.result.error.code).toBe(
      "invalid_payload",
    );
    expect(oversized.result?.status === "error" && oversized.result.error.code).toBe(
      "invalid_payload",
    );
    expect(page.changeCount).toBe(0);
  });

  test("rejects a path-like filename and a MIME-inconsistent extension before dispatch", async () => {
    const page = makePage();
    const pathLike = await uploadAsset(
      page.document,
      { ...payload(), filename: "../image.png" },
      guard,
    );
    const extensionMismatch = await uploadAsset(
      page.document,
      { ...payload("image.jpg"), mimeType: "image/png" },
      guard,
    );
    expect(pathLike.result?.status === "error" && pathLike.result.error.code).toBe(
      "invalid_payload",
    );
    expect(
      extensionMismatch.result?.status === "error" && extensionMismatch.result.error.code,
    ).toBe("invalid_payload");
    expect(page.changeCount).toBe(0);
  });

  test("times out after one native event without retrying", async () => {
    const page = makePage({ createCardOnChange: false });
    const result = await uploadAsset(page.document, payload(), guard, { timeoutMs: 5 });
    expect(result.result?.status === "error" && result.result.error.code).toBe(
      "asset_upload_unknown",
    );
    expect(page.changeCount).toBe(1);
  });
});
