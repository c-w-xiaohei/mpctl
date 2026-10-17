import { expect, test } from "bun:test";
import { unzipSync } from "fflate";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { version } from "../packages/extension/package.json";

test("release ZIP contains the independently versioned, loadable production extension", async () => {
  const output = path.resolve(import.meta.dir, "../packages/extension/.output");
  const archive = unzipSync(
    new Uint8Array(await readFile(path.join(output, `mpctl-extension-v${version}.zip`))),
  );
  const manifest = JSON.parse(new TextDecoder().decode(archive["manifest.json"]));
  expect(manifest.name).toBe("mpctl");
  expect(manifest.manifest_version).toBe(3);
  expect(manifest.version_name ?? manifest.version).toBe(version);
  expect(manifest.version).toBe(version.split("-")[0]);
  const resources = [
    manifest.background.service_worker,
    manifest.action.default_popup,
    ...Object.values(manifest.icons),
    ...manifest.content_scripts.flatMap((script: { js: string[] }) => script.js),
    ...manifest.web_accessible_resources.flatMap(
      (resource: { resources: string[] }) => resource.resources,
    ),
  ];
  for (const resource of resources) expect(archive[resource as string]?.length).toBeGreaterThan(0);
  for (const [name, content] of Object.entries(archive)) {
    expect(name.startsWith("/") || name.split("/").includes("..")).toBe(false);
    expect(name.endsWith(".map") || name.startsWith("src/")).toBe(false);
    expect(content).toEqual(new Uint8Array(await readFile(path.join(output, "chrome-mv3", name))));
  }
});
