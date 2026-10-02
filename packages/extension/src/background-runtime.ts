import { Nexus } from "@nexus-js/core";
import type { ChromeAdapterModel } from "@nexus-js/chrome";

// The background entrypoint configures this one Chrome communication domain.
export const backgroundNexus = new Nexus<ChromeAdapterModel>();
