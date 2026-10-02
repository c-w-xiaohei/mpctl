import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test/browser",
  testMatch: "**/*.spec.ts",
  timeout: 300_000,
  expect: { timeout: 10_000 },
  workers: 1,
  reporter: "list",
  outputDir: "./test-results",
  use: { trace: "retain-on-failure" },
});
