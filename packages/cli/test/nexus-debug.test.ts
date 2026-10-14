import { afterAll, afterEach, expect, spyOn, test } from "bun:test";
import * as nexus from "@nexus-js/core";
import { configureNexusDebug } from "@mpctl/contracts/nexus-debug";

const configure = spyOn(nexus, "configureNexusLogger").mockImplementation(() => {});
afterEach(() => configure.mockClear());
afterAll(() => configure.mockRestore());

test("debug handler keeps framework codes and excludes private argument objects", () => {
  const lines: string[] = [];
  configureNexusDebug("cli", true, (line) => lines.push(line));
  const options = configure.mock.calls.at(-1)![0];
  expect(options.enabled).toBe(true);
  expect(options.level).toBe(nexus.LogLevel.DEBUG);
  options.handler!(
    nexus.LogLevel.DEBUG,
    "Nexus-L2",
    "Relay forwarding failed",
    new nexus.NexusError("private token and URL", "E_CALL_TIMEOUT"),
    { credential: "private-credential", html: "private-body" },
    "private-string",
  );
  expect(lines).toEqual([
    "[mpctl:cli] [DEBUG] [Nexus-L2] Relay forwarding failed (E_CALL_TIMEOUT)",
  ]);
});

test("disabled setup disables Nexus logging and broken log sinks do not throw", () => {
  configureNexusDebug("broker", false, () => {
    throw new Error("sink unavailable");
  });
  const options = configure.mock.calls.at(-1)![0];
  expect(options.enabled).toBe(false);
  expect(() =>
    options.handler!(nexus.LogLevel.WARN, "Nexus-L3", "Scope cleanup failed"),
  ).not.toThrow();
});
