import { Nexus } from "@nexus-js/core";
import type { ChromeAdapterModel } from "@nexus-js/chrome";
import { hasProtocolVersion } from "@mpctl/contracts";

export type PreparationAppMeta = { protocolVersion: string };
export type ContentAppMeta = PreparationAppMeta & { editorReady: boolean; loginExpired?: boolean };

export { hasProtocolVersion as hasPreparationVersion };

// The background entrypoint configures this one Chrome communication domain.
export const backgroundNexus = new Nexus<ChromeAdapterModel<PreparationAppMeta>>();
