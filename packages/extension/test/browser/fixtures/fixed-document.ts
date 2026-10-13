import { articleResultCodec } from "@mpctl/contracts";
import { Result } from "better-result";
import type { Connection } from "@nexus-js/core";
import type { ContentStatusService } from "../../../src/background-contracts";
import { pageEditorToken } from "../../../src/page-contracts";
import { appmsgRouteIdentity, createPageManager } from "../../../src/pages";
import { createOperations } from "../../../src/operations";
import { createWorkspace } from "../../../src/workspace";

export function fixedDocumentStatus(document: Document) {
  return {
    async status() {
      return {
        status: "ok" as const,
        value: {
          state: "ready" as const,
          route: appmsgRouteIdentity(document.location.href)!,
          documentReady: true,
        },
      };
    },
  } satisfies ContentStatusService;
}

export async function fixedDocumentWorkspace(
  document: Document,
  documentId: string,
  connection: Connection,
) {
  const binding = { tabId: 1, documentId, url: document.location.href };
  const pages = createPageManager(
    {
      async getGroup() {},
      async createTab() {
        throw new Error("no navigation");
      },
      async groupTabs() {
        return 7;
      },
      async updateGroup() {},
      async queryGroup() {
        return [{ id: 1, url: binding.url }];
      },
      async getTab() {
        return { id: 1, url: binding.url };
      },
      async getFrame() {
        return { documentId: binding.documentId, url: binding.url };
      },
      async getSession() {
        return { managedGroupId: 7 };
      },
      async setSession() {},
    },
    async () => connection.get(pageEditorToken),
    undefined,
    undefined,
    async () => connection,
  );
  pages.observe(binding);
  const operations = (await createOperations()).unwrap();
  const workspace = createWorkspace({ pages, operations: Promise.resolve(Result.ok(operations)) });
  const article = (await articleResultCodec.deserialize(await workspace.currentArticle())).unwrap();
  return { pages, operations, workspace, article };
}
