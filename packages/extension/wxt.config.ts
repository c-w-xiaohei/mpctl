import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "mpctl",
    description: "Local HTML workflow for MP article bodies",
    permissions: ["storage", "tabs", "tabGroups", "webNavigation", "scripting"],
    host_permissions: ["https://mp.weixin.qq.com/*"],
    web_accessible_resources: [
      {
        resources: ["mp-main-world.js"],
        matches: ["https://mp.weixin.qq.com/*"],
      },
    ],
  },
});
