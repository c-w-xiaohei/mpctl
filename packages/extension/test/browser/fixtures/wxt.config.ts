import { defineConfig } from "wxt";

export default defineConfig({
  root: ".",
  entrypointsDir: "test/browser/fixtures/bridge-extension",
  outDir: ".output/browser-bridge-fixture",
  modules: [],
  manifest: {
    name: "mpctl page bridge test fixture",
    version: "0.0.1",
    host_permissions: ["https://mp.weixin.qq.com/*"],
    web_accessible_resources: [
      {
        resources: ["bridge-main.js"],
        matches: ["https://mp.weixin.qq.com/*"],
      },
    ],
  },
});
