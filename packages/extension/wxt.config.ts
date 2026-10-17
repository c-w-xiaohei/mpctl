import { defineConfig } from "wxt";

const icons = {
  16: "icon/16.png",
  32: "icon/32.png",
  48: "icon/48.png",
  128: "icon/128.png",
};

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  manifest: {
    name: "mpctl",
    description: "WeChat draft editing for AI agents.",
    icons,
    action: {
      default_title: "mpctl",
      default_icon: icons,
    },
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
