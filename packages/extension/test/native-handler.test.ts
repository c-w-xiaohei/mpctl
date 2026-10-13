import { expect, test } from "bun:test";
import { nativeHandlerFixtureScript } from "./native-handler-fixture";
import { captureNativeNewEditorUrl, captureNativeDraftEditorUrl } from "../src/pages";
import { installIdbFixture } from "./idb-fixture";
import { navigationFixture } from "./browser/fixtures/navigation-workspace";

export function installNativeHandlerFixture(saved: boolean) {
  const before = {
    window: globalThis.window,
    document: globalThis.document,
    localStorage: globalThis.localStorage,
    location: globalThis.location,
  };
  const location = new URL(
    saved
      ? "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77"
      : "https://mp.weixin.qq.com/cgi-bin/home?t=home",
  );
  const scripts: any[] = [];
  const writes: string[] = [];
  const events: Record<string, (() => void)[]> = {};
  const link = { href: "javascript:;", addEventListener() {} };
  const control: any = {
    textContent: "文章",
    dataset: { appid: "A" },
    hidden: false,
    getAttribute: (key: string) => (key === "data-appid" ? "A" : null),
    getClientRects: () => [1],
    querySelector: () => link,
    querySelectorAll: () => [link],
    addEventListener: (name: string, action: () => void) => (events[name] ??= []).push(action),
  };
  const page: any = { open: () => null };
  const app = { append() {}, __vue__: undefined };
  const document: any = {
    location,
    scripts,
    head: { append: (script: any) => scripts.push(script) },
    querySelector: (selector: string) => (selector === "#app" ? app : control),
    querySelectorAll: () => [control],
    createElement: (tag: string) =>
      tag === "script"
        ? { textContent: "" }
        : {
            set href(value: string) {
              const u = new URL(value, location.href);
              this.search = u.search;
              this.hash = u.hash;
            },
            search: "",
            hash: "",
          },
  };
  control.ownerDocument = {
    defaultView: { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
  };
  Object.assign(globalThis, {
    window: page,
    document,
    location,
    localStorage: { setItem: (key: string) => writes.push(key) },
  });
  new Function(nativeHandlerFixtureScript(saved))();
  return { page, document, control, writes, release: () => Object.assign(globalThis, before) };
}

for (const shape of [
  "inherited",
  "component",
  "slot",
  "alias",
  "combined",
  "ambiguous",
  "accessor-options",
] as const)
  test(`H1/H2 saved ${shape} association`, async () => {
    const f = installNativeHandlerFixture(true);
    try {
      const vm = f.page.nativeHandlerVm;
      const edit = vm._vnode.children[0].componentInstance._vnode;
      if (shape === "inherited" || shape === "combined") {
        const sections = {
          methods: vm.$options.methods,
          computed: vm.$options.computed,
          data: vm.$options.data,
        };
        for (const key of Object.keys(sections)) delete vm.$options[key];
        Object.setPrototypeOf(vm.$options, sections);
        const methods = vm.$parent.$options.methods;
        delete vm.$parent.$options.methods;
        Object.setPrototypeOf(vm.$parent.$options, { methods });
      }
      if (shape === "component")
        vm._vnode = { children: [{ componentInstance: { _vnode: { children: [edit] } } }] };
      if (shape === "slot") vm._vnode = { componentOptions: { children: [edit] } };
      if (shape === "alias" || shape === "combined")
        vm._vnode = {
          children: [edit],
          componentInstance: { _vnode: edit },
          componentOptions: { children: [edit] },
        };
      if (shape === "ambiguous") vm._vnode = { children: [edit, { ...edit }] };
      if (shape === "accessor-options")
        Object.defineProperty(vm.$options, "methods", {
          get() {
            throw new Error("must not invoke options accessor");
          },
        });
      if (shape === "alias") vm._vnode.children.push(vm._vnode);
      const response = await captureNativeDraftEditorUrl("A");
      const refused = shape === "ambiguous" || shape === "accessor-options";
      expect(response).toMatchObject({
        kind: refused ? "control_unavailable" : "captured",
        ended: true,
      });
      expect(f.page.nativeHandlerCounts.invocation).toBe(refused ? 0 : 1);
      expect(f.writes).toEqual(refused ? [] : ["previousLength"]);
    } finally {
      f.release();
    }
  });

test("changed callback-bearing native option refuses before getter/native effects", async () => {
  const f = installNativeHandlerFixture(true);
  try {
    f.page.nativeHandlerVm.$options.methods.editAppmsg = () =>
      Promise.resolve(window.open("https://mp.weixin.qq.com/"));
    expect(await captureNativeDraftEditorUrl("A")).toEqual({
      kind: "control_unavailable",
      ended: true,
    });
    expect(f.writes).toEqual([]);
    expect(f.page.nativeHandlerCounts.report).toBe(0);
  } finally {
    f.release();
  }
});

for (const saved of [false, true])
  test(`issued ${saved ? "saved" : "new"} actual native owner completes once; history does not reacquire`, async () => {
    const restore = installIdbFixture();
    const native = installNativeHandlerFixture(saved);
    const f = await navigationFixture();
    try {
      f.api.executeMain = async (input: { args?: string[] }) => {
        f.counters.capture++;
        expect((await f.operations.pending()).unwrap()[0]!.snapshot.state).toBe("issued");
        expect(native.writes).toEqual([]);
        return [{ result: await captureNativeNewEditorUrl(input.args?.[0]) }];
      };
      const input = saved ? { operationId: f.id(), candidate: "A" } : { operationId: f.id() };
      const first = await f.decode(
        saved
          ? await f.workspace.openArticle(input as { operationId: string; candidate: string })
          : await f.workspace.newArticle(input),
      );
      expect(first.snapshot).toMatchObject({
        state: "settled",
        result: { status: "ok" },
        effect: { pageCreated: true, targetBound: true },
      });
      const counts = { ...f.counters };
      const nativeCounts = { ...native.page.nativeHandlerCounts };
      f.expire();
      expect(
        (
          await f.decode(
            saved
              ? await f.workspace.openArticle(input as { operationId: string; candidate: string })
              : await f.workspace.newArticle(input),
          )
        ).snapshot,
      ).toEqual(first.snapshot);
      expect((await f.decode(await f.workspace.getOperation(input.operationId))).snapshot).toEqual(
        first.snapshot,
      );
      expect(f.counters).toEqual(counts);
      expect(native.page.nativeHandlerCounts).toEqual(nativeCounts);
      expect(counts).toEqual({ create: 1, group: 1, capture: 1, reload: 0, read: 1, set: 0 });
      expect(nativeCounts.invocation).toBe(1);
      expect(nativeCounts.dom).toBe(0);
    } finally {
      f.dispose();
      native.release();
      restore();
    }
  });

test("native MAIN reply lost after actual method is unresolved and adds zero calls on history", async () => {
  const restore = installIdbFixture();
  const native = installNativeHandlerFixture(false);
  const f = await navigationFixture();
  try {
    f.api.executeMain = async () => {
      f.counters.capture++;
      await captureNativeNewEditorUrl();
      throw new Error("lost MAIN reply");
    };
    const input = { operationId: f.id() };
    const first = await f.decode(await f.workspace.newArticle(input));
    expect(first.snapshot.state).toBe("unresolved");
    expect((await f.decode(await f.workspace.newArticle(input))).snapshot).toEqual(first.snapshot);
    expect(native.page.nativeHandlerCounts.invocation).toBe(1);
    expect(f.counters).toEqual({ create: 0, group: 0, capture: 1, reload: 0, read: 0, set: 0 });
  } finally {
    f.dispose();
    native.release();
    restore();
  }
});

test("native exception after getter dispatch preserves finite runtime cause and unresolved owner", async () => {
  const restore = installIdbFixture();
  const native = installNativeHandlerFixture(true);
  const f = await navigationFixture();
  try {
    Object.defineProperty(native.page.nativeHandlerCounts, "emit", {
      get: () => 0,
      set() {
        throw new Error("private parent exception");
      },
    });
    f.api.executeMain = async () => {
      f.counters.capture++;
      return [{ result: await captureNativeDraftEditorUrl("A") }];
    };
    const response = await f.decode(
      await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
    );
    expect(response.snapshot).toMatchObject({
      state: "unresolved",
      result: {
        error: {
          cause: { at: "bg.navigation", kind: "runtime", code: "native_handler_exception" },
        },
      },
    });
    expect(JSON.stringify(response)).not.toContain("private");
    expect(native.writes).toEqual(["previousLength"]);
    expect(f.counters.create).toBe(0);
    expect(native.page.nativeHandlerCounts.invocation).toBe(1);
  } finally {
    f.dispose();
    native.release();
    restore();
  }
});

for (const variant of [
  "multiple",
  "wrong-target",
  "exception",
  "parent-emit",
  "source-loss",
  "split",
  "helper",
  "candidate",
] as const)
  test(`native ${variant} preserves truthful dispatch knowledge`, async () => {
    const f = installNativeHandlerFixture(true);
    try {
      const vm = f.page.nativeHandlerVm;
      if (variant === "split") Object.defineProperty(vm, "isMul", { value: true });
      if (variant === "helper")
        f.page.openUrl = () => {
          throw new Error("unreviewed helper");
        };
      if (variant === "candidate") vm.source.app_id = "different";
      if (variant === "parent-emit")
        Object.defineProperty(f.page.nativeHandlerCounts, "emit", {
          get: () => 0,
          set() {
            throw new Error("native parent error");
          },
        });
      // Actual supported native method still calls this reviewed getter internally.
      // Its synchronous localStorage boundary supplies controlled interruptions.
      const original = localStorage.setItem;
      (localStorage as any).setItem = () => {
        if (variant === "multiple") {
          f.page.open(
            "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=A",
          );
        }
        if (variant === "wrong-target") {
          f.page.open(
            "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=B",
          );
        }
        if (variant === "exception") throw new Error("write refused");
        if (variant === "source-loss")
          f.document.location = new URL("https://mp.weixin.qq.com/cgi-bin/home");
        return original.call(localStorage, "previousLength", "1");
      };
      const reply = await captureNativeDraftEditorUrl("A");
      if (["split", "helper", "candidate"].includes(variant)) {
        expect(reply).toEqual({ kind: "control_unavailable", ended: true });
        expect(f.writes).toEqual([]);
      } else if (variant === "multiple") expect(reply).toEqual({ kind: "ambiguous", ended: true });
      else if (variant === "wrong-target")
        expect(reply).toEqual({ kind: "unsupported", ended: true });
      else expect(reply).toMatchObject({ ended: false });
      expect(f.page.nativeHandlerCounts.dom).toBe(0);
    } finally {
      f.release();
    }
  });
