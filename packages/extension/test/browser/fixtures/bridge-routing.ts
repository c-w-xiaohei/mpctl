import type { BrowserContext, Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";

export async function routeBridgeFixture(
  context: BrowserContext,
  fixtureRoot: string,
  extension: string,
  diagnostics: string[],
) {
  diagnostics.push(`browser=${context.browser()?.version() ?? "unknown"}`);
  diagnostics.push(`manifest=${await readFile(path.join(extension, "manifest.json"), "utf8")}`);
  context.on("serviceworker", (worker) =>
    diagnostics.push(`serviceworker=${new URL(worker.url()).pathname}`),
  );
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/appmsg")
      return route.fulfill({
        path: path.join(fixtureRoot, "index.html"),
        contentType: "text/html",
      });
    if (url.hostname === "mp.weixin.qq.com" && url.pathname === "/cgi-bin/jsapi.js")
      return route.fulfill({
        path: path.join(fixtureRoot, "jsapi.js"),
        contentType: "text/javascript",
      });
    if (url.protocol === "chrome-extension:" || url.protocol === "devtools:")
      return route.continue();
    return route.abort("blockedbyclient");
  });
  await context.routeWebSocket("**/*", (route) =>
    route.close({ code: 1008, reason: "Offline fixture" }),
  );
}

export function collectBridgeDiagnostics(page: Page, diagnostics: string[]) {
  page.on("console", (message) => {
    if (message.type() === "error") diagnostics.push(`console.error=${sanitize(message.text())}`);
  });
  page.on("pageerror", (error) => diagnostics.push(`pageerror=${sanitize(error.message)}`));
  page.on("requestfailed", (request) => {
    const url = new URL(request.url());
    diagnostics.push(
      `requestfailed=${url.protocol}//${url.host}${url.pathname}:${request.failure()?.errorText}`,
    );
  });
}

function sanitize(message: string) {
  return message.replace(/https?:\/\/[^\s)]+/g, (value) => {
    const url = new URL(value);
    return `${url.protocol}//${url.host}${url.pathname}`;
  });
}
