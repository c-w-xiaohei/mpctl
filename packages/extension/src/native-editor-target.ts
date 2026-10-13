export type NativeTargetCapture =
  | { kind: "captured"; url: string; notDispatched?: true; ended?: boolean }
  | {
      kind: "ambiguous" | "unavailable" | "unsupported" | "control_unavailable";
      ended?: boolean;
      observedFailure?: { kind: "runtime"; causeCode: "native_handler_exception" };
    };

/** Serialized into MAIN by Chrome: every helper/constant must remain local.
 * Vue 2.7.15 home/index_gray + appmsg_publish_card ordinary-edit contract.
 * Fingerprints identify retained platform definitions, not arbitrary JS safety.
 * Reviewed report continuations only affect telemetry and source-local toptips;
 * neither is a resource used by native acquisition or the separate editor.
 */
export async function captureNativeNewEditorUrl(
  candidateId?: string,
): Promise<NativeTargetCapture> {
  const own = (object: any, key: string): any =>
    object == null ? undefined : Object.getOwnPropertyDescriptor(object, key)?.value;
  const descriptor = (object: any, key: string): PropertyDescriptor | undefined => {
    for (let current = object; current; current = Object.getPrototypeOf(current)) {
      const found = Object.getOwnPropertyDescriptor(current, key);
      if (found) return found;
    }
  };
  const data = (object: any, key: string): any => descriptor(object, key)?.value;
  const fingerprint = (value: unknown): number => {
    const text =
      typeof value === "function"
        ? Function.prototype.toString.call(value)
        : typeof value === "string"
          ? value
          : "";
    let hash = 2166136261;
    for (const character of text.replace(/\s+/g, ""))
      hash = Math.imul(hash ^ character.charCodeAt(0), 16777619);
    return hash >>> 0;
  };
  const visible = (element: HTMLElement) => {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    return (
      !element.hidden &&
      element.getAttribute?.("aria-hidden") !== "true" &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      element.getClientRects().length > 0
    );
  };
  const target = (input: unknown): string | undefined => {
    if (typeof input !== "string" && !(input instanceof URL)) return;
    try {
      const url = new URL(String(input), document.location.href);
      if (
        url.origin !== "https://mp.weixin.qq.com" ||
        url.pathname !== "/cgi-bin/appmsg" ||
        url.searchParams.get("action") !== "edit" ||
        url.searchParams.get("type") !== "77"
      )
        return;
      if (
        candidateId === undefined
          ? url.searchParams.get("t") === "media/appmsg_edit_v2" &&
            url.searchParams.get("isNew") === "1"
          : url.searchParams.get("t") === "media/appmsg_edit" &&
            url.searchParams.get("appmsgid") === candidateId
      )
        return url.href;
    } catch {
      /* No target construction or malformed-target forwarding. */
    }
  };
  const select = () =>
    [
      ...document.querySelectorAll<HTMLElement>(
        candidateId === undefined
          ? "div.new-creation__menu-item"
          : ".weui-desktop-card[data-appid]",
      ),
    ].filter((element) =>
      candidateId === undefined
        ? element.textContent?.trim() === "文章" && visible(element)
        : element.getAttribute("data-appid") === candidateId && visible(element),
    );
  const controls = select();
  if (controls.length !== 1) return { kind: "control_unavailable", ended: true };
  const control = controls[0]!;
  const links =
    candidateId === undefined
      ? []
      : [
          ...control.querySelectorAll<HTMLAnchorElement>(
            ".weui-desktop-tooltip__wrp.weui-desktop-link a",
          ),
        ];
  if (candidateId !== undefined && links.length !== 1)
    return { kind: "control_unavailable", ended: true };
  const link = links[0];
  const href = link && target(link.href);
  if (href) return { kind: "captured", url: href, notDispatched: true, ended: true };
  const locationBefore = document.location.href;
  const page = window as Window & { Vue?: any; openUrl?: unknown };
  const sourceUrl = new URL(locationBefore);
  if (
    sourceUrl.origin !== "https://mp.weixin.qq.com" ||
    (candidateId === undefined
      ? sourceUrl.pathname !== "/cgi-bin/home"
      : sourceUrl.pathname !== "/cgi-bin/appmsg" ||
        sourceUrl.searchParams.get("action") !== "list_card") ||
    own(page.Vue, "version") !== "2.7.15"
  )
    return { kind: "control_unavailable", ended: true };
  let vm: any;
  for (let element: HTMLElement | null = control; element; element = element.parentElement) {
    const instance = own(element, "__vue__");
    if (
      instance &&
      own(
        data(own(instance, "$options"), "methods"),
        candidateId === undefined ? "goAppmsg" : "editAppmsg",
      )
    ) {
      vm = instance;
      break;
    }
  }
  const options = own(vm, "$options");
  const methods = data(options, "methods");
  const computed = data(options, "computed");
  const method = own(methods, candidateId === undefined ? "goAppmsg" : "editAppmsg");
  const emit = descriptor(vm, "$emit")?.value;
  const nodes: any[] = [];
  const visited = new Set<unknown>();
  const visit = (node: any) => {
    if (!node || visited.has(node)) return;
    visited.add(node);
    if (own(node, "elm") === (link ?? control)) nodes.push(node);
    for (const child of own(node, "children") ?? []) visit(child);
    visit(own(own(node, "componentInstance"), "_vnode"));
    for (const child of own(own(node, "componentOptions"), "children") ?? []) visit(child);
  };
  const vnode = own(vm, "_vnode");
  visit(vnode);
  const node = nodes[0];
  const click = own(own(own(node, "data"), "on"), "click");
  const clickHandler = own(click, "fns");
  const openUrl = own(page, "openUrl");
  if (fingerprint(descriptor(own(page.Vue, "prototype"), "$tipsErr")?.value) !== 0x90998063)
    return { kind: "control_unavailable", ended: true };
  const inline = [...document.scripts]
    .map((script) => script.textContent ?? "")
    .find((text) => text.includes("function getLinkInfo(target, params)"));
  const helper = inline
    ?.match(/function getLinkInfo\(target, params\) \{[\s\S]*?\n  \}/)?.[0]
    .replace(/(token\s*:\s*)(['"])[^'"]*\2/g, "$1'[REDACTED]'");
  if (
    !vm ||
    nodes.length !== 1 ||
    own(node, "context") !== vm ||
    Array.isArray(clickHandler) ||
    fingerprint(openUrl) !== 0x36c7a9e8 ||
    fingerprint(helper) !== 0x7c0a4c40
  )
    return { kind: "control_unavailable", ended: true };
  // Finite already-loaded platform dependency contract, not module execution or
  // a site-wide code verifier. Includes the CGI timeout banner, not just success.
  const requiredModules: Record<string, number> = {
    "../../packages/mmbizweb-web2-common/modules/utils/cgi.js": 0xe6d01956,
    "../../packages/mmbizweb-web2-common/biz_common/utils/comm_report.js": 0x996ef329,
    "./src/pages/modules/utils/report.js": 0x91ae1302,
  };
  const foundModules = new Map<string, unknown>();
  for (const chunk of own(page, "webpackJsonp") ?? []) {
    const definitions = own(chunk, "1");
    for (const id of Object.keys(requiredModules)) {
      const definition = own(definitions, id);
      if (definition) foundModules.set(id, definition);
    }
  }
  if (
    Object.entries(requiredModules).some(([id, hash]) => fingerprint(foundModules.get(id)) !== hash)
  )
    return { kind: "control_unavailable", ended: true };
  // Identify the instantiated source-local banner itself. This is both closer
  // to the invoked timeout sink and smaller than fingerprinting the whole UI
  // library/base initializer (which contain unrelated components/account UI).
  const tipOptions: any[] = [];
  const tipVisited = new Set<unknown>();
  const visitTip = (component: any) => {
    if (!component || tipVisited.has(component)) return;
    tipVisited.add(component);
    const opts = own(component, "$options");
    if (data(opts, "_componentTag") === "mp-toptips" || data(opts, "name") === "mp-toptips")
      tipOptions.push(opts);
    for (const child of own(component, "$children") ?? []) visitTip(child);
  };
  visitTip(own(document.querySelector("#app"), "__vue__"));
  const supportedTip = (opts: any) => {
    const watch = data(opts, "watch");
    return (
      fingerprint(data(opts, "render")) === 0xd766fc48 &&
      fingerprint(data(opts, "data")) === 0x40296419 &&
      fingerprint(own(watch, "msg")) === 0x50f32432 &&
      fingerprint(own(watch, "type")) === 0x04c56291 &&
      fingerprint(own(watch, "value")) === 0x5f807812 &&
      fingerprint(own(watch, "isShow")) === 0x2c7d11bb
    );
  };
  if (tipOptions.length === 0 || !tipOptions.every(supportedTip))
    return { kind: "control_unavailable", ended: true };
  // Only reviewed Vue proxies/reactive fields; never evaluate editUrl here.
  const model = (object: any, key: string): any => {
    const field = descriptor(object, key);
    if (!field) return undefined;
    if ("value" in field) return field.value;
    const hash = fingerprint(field.get);
    if (hash !== 0x7e70aaf0 && hash !== 0x004db80e) throw new Error("unsupported model");
    if (hash === 0x7e70aaf0) {
      const backing = own(
        object,
        ["source", "type", "replacescene"].includes(key) ? "_props" : "_data",
      );
      const reactive = descriptor(backing, key);
      if (!reactive || fingerprint(reactive.get) !== 0x004db80e)
        throw new Error("unsupported proxy backing");
    }
    return field.get!.call(object);
  };
  let source: any;
  const splitHelper = own(vm, "needSplitMsg");
  const parent = own(vm, "$parent");
  const parentReport = own(parent, "report");
  // Vue 2's reviewed native initialization binds each option to its VM. Native
  // bind hides its target from ordinary MAIN; use the finite public native-bound
  // shape plus exact option/owner contract, not an arbitrary source-matched slot.
  // This deliberately rejects different-source callback helpers, not adversarial
  // same-text closures or a universal hidden-bound-target verifier.
  const nativeBound = (instance: unknown, option: any): boolean =>
    typeof instance === "function" &&
    typeof option === "function" &&
    /^function\s*(?:\w+)?\s*\(\)\s*\{\s*\[native code\]\s*\}$/.test(
      Function.prototype.toString.call(instance),
    ) &&
    instance.name === `bound ${option.name}` &&
    instance.length === option.length;
  const guard = () => {
    if (
      document.location.href !== locationBefore ||
      select().length !== 1 ||
      select()[0] !== control ||
      own(vm, "$options") !== options ||
      data(options, "methods") !== methods ||
      data(options, "computed") !== computed ||
      own(vm, "_vnode") !== vnode ||
      own(methods, candidateId === undefined ? "goAppmsg" : "editAppmsg") !== method ||
      own(page, "openUrl") !== openUrl ||
      own(node, "context") !== vm ||
      own(click, "fns") !== clickHandler ||
      descriptor(vm, "$emit")?.value !== emit
    )
      return false;
    if (candidateId === undefined) {
      const watcher = own(own(vm, "_computedWatchers"), "creationMenuItems");
      const menu = own(watcher, "value");
      const articles = Array.isArray(menu)
        ? menu.filter((entry) => own(entry, "id") === 0 && own(entry, "title") === "文章")
        : [];
      return (
        fingerprint(method) === 0x198986b2 &&
        fingerprint(own(methods, "handleCreationGo")) === 0x30d1f81a &&
        fingerprint(clickHandler) === 0xe88da37b &&
        own(watcher, "dirty") === false &&
        articles.length === 1 &&
        fingerprint(own(articles[0], "onClick")) === 0x2e87bc32
      );
    }
    if (
      fingerprint(method) !== 0x100ddc43 ||
      fingerprint(own(computed, "editUrl")) !== 0x0f373f40 ||
      fingerprint(descriptor(vm, "editUrl")?.get) !== 0x986dceed ||
      fingerprint(own(methods, "needSplitMsg")) !== 0x95ffca86 ||
      fingerprint(own(methods, "fixData")) !== 0x6f0c9206 ||
      fingerprint(data(options, "data")) !== 0xf6a71d01 ||
      own(vm, "$parent") !== parent ||
      own(vm, "needSplitMsg") !== splitHelper ||
      own(parent, "report") !== parentReport ||
      !nativeBound(splitHelper, own(methods, "needSplitMsg")) ||
      !nativeBound(parentReport, own(data(own(parent, "$options"), "methods"), "report"))
    )
      return false;
    const currentSource = model(vm, "source");
    const list = model(vm, "list");
    if (
      !currentSource ||
      (source && source !== currentSource) ||
      model(vm, "type") !== 77 ||
      model(vm, "isMul") !== false ||
      !Array.isArray(list) ||
      list.length !== 1 ||
      model(list[0], "share_page_type") !== 0 ||
      model(currentSource, "sent_result")
    )
      return false;
    const identity =
      model(currentSource, "app_id") || model(currentSource, "id") || model(currentSource, "msgid");
    const multi = model(currentSource, "multi_item");
    if (
      String(identity) !== candidateId ||
      (multi &&
        (!Array.isArray(multi) || multi.length !== 1 || model(multi[0], "share_page_type") !== 0))
    )
      return false;
    source = currentSource;
    // The native getter also consumes these fields. Reject custom/computed
    // variants before the issued method reaches that effectful URL evaluation.
    model(vm, "replacescene");
    model(vm, "isFromOldMsg");
    model(currentSource, "reply_type");
    model(currentSource, "title");
    const parentMethods = data(own(parent, "$options"), "methods");
    const event = own(own(vm, "_events"), "edit");
    const emitHandler =
      Array.isArray(event) && event.length === 1 ? own(event[0], "fns") : undefined;
    return (
      clickHandler === own(vm, "editAppmsg") &&
      nativeBound(clickHandler, method) &&
      emit === descriptor(own(page.Vue, "prototype"), "$emit")?.value &&
      emitHandler === own(parent, "editReport") &&
      nativeBound(emitHandler, own(parentMethods, "editReport")) &&
      fingerprint(own(parentMethods, "editReport")) === 0x0628e744 &&
      fingerprint(own(parentMethods, "report")) === 0x165a5e5e
    );
  };
  try {
    if (!guard()) return { kind: "control_unavailable", ended: true };
  } catch {
    return { kind: "control_unavailable", ended: true };
  }
  const originalOpen = page.open;
  const captured: string[] = [];
  let unsupported = false;
  const capture = ((url?: string | URL | null) => {
    const found = target(url);
    if (found) captured.push(found);
    else unsupported = true;
    return null;
  }) as typeof window.open;
  page.open = capture;
  try {
    if (candidateId === undefined) method.call(vm, 0);
    else method.call(vm, false, false);
    if (page.open !== capture || !guard()) return { kind: "unsupported", ended: false };
    if (unsupported) return { kind: "unsupported", ended: true };
    if (captured.length > 1) return { kind: "ambiguous", ended: true };
    return captured.length === 1
      ? { kind: "captured", url: captured[0]!, ended: true }
      : { kind: "unavailable", ended: true };
  } catch {
    return {
      kind: "unavailable",
      ended: false,
      observedFailure: { kind: "runtime", causeCode: "native_handler_exception" },
    };
  } finally {
    if (page.open === capture) page.open = originalOpen;
  }
}

export const captureNativeDraftEditorUrl = captureNativeNewEditorUrl;
