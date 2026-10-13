import { Nexus } from "@nexus-js/core";
import { protocolVersion } from "@mpctl/contracts";
import { mountMainWorldBridge } from "../../../entrypoints/mp-main-world";
import { createPageEndpoint } from "../../../src/transport/page-bridge";
import {
  pageEditorToken,
  pageEditorReadyResultCodec,
  pageEditorWriteResultCodec,
} from "../../../src/page-contracts";

export async function peerClosePreflight(mode: "peer" | "unavailable") {
  const channelId = crypto.randomUUID();
  const eventNames = { fromIsolated: `${channelId}:in`, fromMain: `${channelId}:out` };
  const script = document.createElement("script");
  Object.assign(script.dataset, {
    mpctlChannel: channelId,
    mpctlInbound: eventNames.fromIsolated,
    mpctlOutbound: eventNames.fromMain,
  });
  let release!: () => void;
  let reached!: () => void;
  const entered = new Promise<void>((done) => {
    reached = done;
  });
  const counts = { read: 0, set: 0 };
  (window as any).__MP_Editor_JSAPI__ = {
    invoke(request: any) {
      if (request.apiName === "mp_editor_get_isready")
        request.sucCb({ isReady: true, isNew: true });
      else if (request.apiName === "mp_editor_get_content") {
        counts.read++;
        release = () => request.sucCb({ content: "before" });
        reached();
      } else {
        counts.set++;
        request.sucCb({});
      }
    },
  };
  let stopped!: (value: unknown) => void;
  const observed = new Promise<any>((done) => {
    stopped = done;
  });
  const serialize = pageEditorWriteResultCodec.serialize;
  pageEditorWriteResultCodec.serialize = async (result) => {
    if (result.isOk() && result.value.ended) stopped(result.value);
    return serialize(result);
  };
  const isolated = createPageEndpoint({
    target: document,
    channelId,
    side: "isolated",
    eventNames,
  });
  const client = new Nexus().configure({
    endpoint: { implementation: isolated, meta: { app: { protocolVersion } } },
  });
  const mounted = (await mountMainWorldBridge(script)).unwrap();
  try {
    await client.ready();
    const remote = (await client.connect({ target: {} })).get(pageEditorToken);
    const ready = (await pageEditorReadyResultCodec.deserialize(await remote.ready())).unwrap();
    const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("before"));
    const hash = [...new Uint8Array(bytes)].map((n) => n.toString(16).padStart(2, "0")).join("");
    const pending = Nexus.safeCall(
      remote.setContent("next", hash, {
        operationId: `op:${crypto.randomUUID()}:${crypto.randomUUID()}`,
        executorId: ready.executorId,
      }),
    );
    await entered;
    if (mode === "peer") isolated.close();
    else delete (window as any).__MP_Editor_JSAPI__;
    release();
    const lost = (await pending).isErr();
    const receipt = await observed;
    return { lost, counts, receipt };
  } finally {
    pageEditorWriteResultCodec.serialize = serialize;
    isolated.close();
    await mounted.dispose();
  }
}
