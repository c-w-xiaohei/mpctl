import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Selected sanitized platform definitions are canonical test inputs, not tmp
// review packets. The fixture executes native behavior, not a production bypass.
const platform = JSON.parse(
  readFileSync(
    path.join(
      fileURLToPath(new URL(".", import.meta.url)),
      "fixtures/native-handler/platform.json",
    ),
    "utf8",
  ),
);
export function nativeHandlerFixtureScript(
  saved = false,
  delayedTelemetry = false,
  candidate?: string,
) {
  const { home, draft, model, dependencies, modules, telemetry, tip } = platform;
  const helper = home.linkHelper.split("  /**")[0].replace("[REDACTED]", "synthetic-new-token");
  const definitions = {
    go: home.methods.goAppmsg,
    handle: home.methods.handleCreationGo,
    edit: draft.methods.editAppmsg,
    split: draft.methods.needSplitMsg,
    getter: draft.computed.editUrl,
    data: model.dataDefinition,
    fix: model.fixData,
    parentEdit: dependencies.parentEdit[0].fns.boundTarget,
    parentReport: dependencies.parentEdit[0].parentReport.boundTarget,
    open: home.openUrl,
  };
  return `(() => {
    const definitions = ${JSON.stringify(definitions)};
    const counters = window.nativeHandlerCounts = { invocation: 0, target: 0, getter: 0, report: 0, emit: 0, dom: 0 };
    let Q = { setSum() { counters.invocation++; counters.report++; return this; }, send() {} };
    let b = { report() { counters.invocation++; counters.report++; } };
    const p = { getUrlParam(name, url) { return new URL(url, location.href).searchParams.get(name); } };
    const $ = [7,8,10];
    const N = () => { counters.report++; };
    const native = source => eval('(' + source + ')');
    window.webpackJsonp = [[[], Object.fromEntries(${JSON.stringify(modules)}.map(entry => [entry.id, native(entry.source)]))]];
    window.Vue = { version: '2.7.15' };
    const q = { type: 'success', msg: '', isShow: false };
    window.Vue.prototype = { $tipsErr: native(${JSON.stringify(tip.tipsErr)}) };
    const tipOptions = { _componentTag: 'mp-toptips', render: native(${JSON.stringify(tip.component.definitions.render)}), data: native(${JSON.stringify(tip.component.definitions.data)}), watch: Object.fromEntries(Object.entries(${JSON.stringify(tip.component.definitions.watch)}).map(([key, value]) => [key, native(value)])) };
    let app = document.querySelector('#app');
    if (!app || !app.append) { app = document.createElement('div'); app.id = 'app'; document.body?.append(app); }
    app.__vue__ = { $children: [{ $options: tipOptions }] };
    window.wx = { commonData: { uin: '0', acl: { material_acl: { can_app_msg: true } } } };
    window.wx.commonData.data = { t: 'offline', lang: 'zh_CN', uin: '0' }; window.navigator = navigator;
    if (${delayedTelemetry}) {
      const native = source => eval('(' + source + ')');
      const tipDefinitions = ${JSON.stringify(tip.component.definitions)};
      const tipWatch = Object.fromEntries(Object.entries(tipDefinitions.watch).map(([key, value]) => [key, native(value)]));
      const tips = { value: false, type: 'success', msg: '', duration: 60000, offset: 0, $emit(name, value) { q.isShow = value; } };
      Object.assign(tips, native(tipDefinitions.data).call(tips));
      const show = Object.getOwnPropertyDescriptor(tips, 'isShow').value; let isShow = show;
      Object.defineProperty(tips, 'isShow', { get() { return isShow; }, set(value) { if (isShow !== value) { isShow = value; tipWatch.isShow.call(tips, value); } } });
      // Actual retained render with a minimal DOM VNode host. Text is escaped by
      // textContent, just as Vue's _v/_s; no fake business callback or ended flag.
      tips._self = tips;
      tips._s = String; tips._v = text => document.createTextNode(text);
      tips.$createElement = (tag, data, children) => { const el = document.createElement(tag === 'transition' ? 'div' : tag); const content = Array.isArray(data) ? data : children || []; for (const child of content) el.append(child); if (data && data.class) el.className = data.class.join(' '); if (data && data.staticClass) el.className = data.staticClass; return el; };
      for (const key of ['type','msg','isShow']) { let value = q[key]; Object.defineProperty(q, key, { get() { return value; }, set(next) { if (value === next) return; value = next; tipWatch[key === 'isShow' ? 'value' : key].call(tips, next); if (key === 'isShow' && next) { const banner = native(tipDefinitions.render).call(tips); banner.style.cssText = 'position:fixed;top:0;width:100%;z-index:50000;pointer-events:auto'; document.body.append(banner); counters.tip = (counters.tip || 0) + 1; } } }); }
      let release; const fingerprint = new Promise(done => { release = done; });
      window.releaseNativeTelemetry = () => release({ get: async () => ({ visitorId: 'offline' }) });
      let reached; window.nativeTelemetryDone = new Promise(done => { reached = done; });
      const dependency = id => {
        if (id.endsWith('/js/ajax.js')) return options => { if (options.url === '/mp/jsmonitor?' || options.url === '/cgi-bin/webreport') { options.error({}, 'timeout'); reached(); } };
        if (id.includes('@fingerprintjs/')) return { load: () => fingerprint };
        if (id.endsWith('/str_util.js')) return { format: text => text };
        if (id.endsWith('/object.js')) return { clone: value => ({ ...value }) };
        if (id.endsWith('/url.js')) return { parseQuery: () => ({}) };
        if (id.endsWith('/monitor.js')) return { setSum() {}, send() {} };
        throw new Error('unsupported dependency');
      };
      const module = { exports: {} }; window.webpackJsonp[0][1]['../../packages/mmbizweb-web2-common/modules/utils/cgi.js'](module, module.exports, dependency);
      const B = module.exports; let U = Array.from({ length: 61 }, () => 'offline_0_1'); const ae = {};
      ae.setSum = native(${JSON.stringify(telemetry.setSum.source)}); ae.send = native(${JSON.stringify(telemetry.send.source)}); Q = ae;
      const reportModule = { exports: {} }; window.webpackJsonp[0][1]['../../packages/mmbizweb-web2-common/biz_common/utils/comm_report.js'](reportModule, reportModule.exports, dependency);
      const ne = reportModule.exports; const k = B;
      b = { report: native(${JSON.stringify(dependencies.dependencies[0].source)}) };
      window.nativeTipState = tips;
    }
    ${helper}
    window.openUrl = native(definitions.open);
    const script = document.createElement('script'); script.type = 'text/plain'; script.textContent = ${JSON.stringify(helper)}; document.head.append(script);
    const control = document.querySelector(${JSON.stringify(saved ? (candidate ? `.weui-desktop-card[data-appid="${candidate}"]` : ".weui-desktop-card[data-appid]") : ".new-creation__menu-item")});
    if (!control) return;
    const vm = { $options: { methods: {} }, _computedWatchers: {} };
    control.__vue__ = vm;
    if (${saved}) {
      vm.source = { app_id: control.dataset.appid, multi_item: [{ share_page_type: 0 }] };
      vm.type = 77; vm.replacescene = 0; vm.isFromOldMsg = ''; vm.isMul = false; vm.list = [{ share_page_type: 0 }];
      const reactiveRead = value => { const ae = undefined, b = value, $i = { target: undefined }, Ui = () => false, F = false; return eval('(' + ${JSON.stringify(model.data.list.getter)} + ')'); };
      const proxyRead = (v, b) => eval('(' + ${JSON.stringify(model.vm.list.getter)} + ')');
      vm._props = {}; vm._data = {};
      for (const key of ['source','type','replacescene','list','isMul','isFromOldMsg']) {
        const backing = ['source','type','replacescene'].includes(key) ? '_props' : '_data';
        const value = vm[key]; Object.defineProperty(vm[backing], key, { configurable: true, get: reactiveRead(value) });
        Object.defineProperty(vm, key, { configurable: true, get: proxyRead(backing, key) });
      }
      vm.$options.methods.editAppmsg = native(definitions.edit);
      vm.$options.methods.needSplitMsg = native(definitions.split); vm.needSplitMsg = vm.$options.methods.needSplitMsg.bind(vm);
      vm.$options.methods.fixData = native(definitions.fix);
      vm.$options.data = native(definitions.data);
      vm.$options.computed = { editUrl: native(definitions.getter) };
      const l = 'editUrl'; const $i = { target: undefined };
      const computedNative = source => eval('(' + source + ')');
      vm._computedWatchers.editUrl = { dirty: true, value: undefined, evaluate() { counters.getter++; this.value = vm.$options.computed.editUrl.call(vm); this.dirty = false; } };
      Object.defineProperty(vm, 'editUrl', { get: computedNative(${JSON.stringify(model.vmProto.editUrl.getter)}) });
      vm.editAppmsg = vm.$options.methods.editAppmsg.bind(vm);
      const parent = { $options: { methods: { editReport: native(definitions.parentEdit), report: native(definitions.parentReport) } } };
      parent.report = parent.$options.methods.report.bind(parent); parent.editReport = parent.$options.methods.editReport.bind(parent);
      vm.$parent = parent;
      const editEvent = function () { return editEvent.fns.apply(parent, arguments); }; editEvent.fns = parent.editReport;
      vm._events = { edit: [editEvent] }; vm.$emit = function (name, arg) { counters.emit++; editEvent(arg); };
      window.Vue.prototype.$emit = vm.$emit;
      const link = control.querySelector('a'); vm._vnode = { elm: link, context: vm, data: { on: { click: { fns: vm.editAppmsg } } } };
      const editNode = vm._vnode;
      vm._vnode = { children: [{ componentInstance: { _vnode: editNode }, componentOptions: { children: [editNode] } }] };
      const sections = { methods: vm.$options.methods, computed: vm.$options.computed, data: vm.$options.data };
      for (const key of Object.keys(sections)) delete vm.$options[key]; Object.setPrototypeOf(vm.$options, sections);
      const parentSections = { methods: parent.$options.methods }; delete parent.$options.methods; Object.setPrototypeOf(parent.$options, parentSections);
      link.addEventListener('click', () => { counters.dom++; vm.editAppmsg(); });
    } else {
      const e = vm;
      const article = { title: '文章', id: 0, onClick: native('function V(){return e.goAppmsg(0)}') };
      vm.$options.methods.goAppmsg = native(definitions.go); vm.goAppmsg = vm.$options.methods.goAppmsg.bind(vm);
      vm.$options.methods.handleCreationGo = native(definitions.handle);
      vm._computedWatchers.creationMenuItems = { dirty: false, value: [article] };
      vm._vnode = { elm: control, context: vm, data: { on: { click: { fns: native('function($event){return handleCreationGo($event, creation)}') } } } };
      control.addEventListener('click', () => { counters.dom++; vm.goAppmsg(0); });
    }
    window.nativeHandlerVm = vm;
  })();`;
}

export function nativeHomeHtml(html: string) {
  return html
    .replace(
      /document\.getElementById\("new-article"\)\.addEventListener\("click",[\s\S]*?\n      \}\);/,
      "",
    )
    .replace("</body>", () => `<script>${nativeHandlerFixtureScript()}</script></body>`);
}
