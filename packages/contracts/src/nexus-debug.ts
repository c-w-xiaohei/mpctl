import { configureNexusLogger, LogLevel, NexusError } from "@nexus-js/core";

/** Configure each runtime separately; never dump payloads, identities or error objects. */
export function configureNexusDebug(
  context: "cli" | "broker" | "background" | "content" | "main" | "popup" | "connect",
  enabled: boolean,
  write: (line: string) => void = (line) => console.error(line),
) {
  configureNexusLogger({
    enabled,
    level: LogLevel.DEBUG,
    handler(level, scope, message, ...args) {
      // Current Nexus messages describe internal events; details may contain private data.
      // Only retain typed framework error codes, not messages/stacks or arbitrary objects.
      const codes = args
        .filter((value): value is NexusError => value instanceof NexusError)
        .map((error) => error.code)
        .filter((code) => /^E_[A-Z0-9_]+$/.test(code));
      try {
        write(
          `[mpctl:${context}] [${LogLevel[level]}] [${scope}] ${message}${codes.length ? ` (${codes.join(", ")})` : ""}`,
        );
      } catch {
        // Diagnostics must never change the outcome of a call or connection.
      }
    },
  });
}
