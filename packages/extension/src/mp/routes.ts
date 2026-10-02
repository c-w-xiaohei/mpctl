export const editorPageUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77";
export const draftListUrl =
  "https://mp.weixin.qq.com/cgi-bin/appmsg?begin=0&count=10&type=77&action=list_card";

export type AppmsgRoute =
  | { kind: "home" }
  | { kind: "new" }
  | { kind: "saved-editor"; groupId: string }
  | { kind: "draft-list"; begin: string; count: string }
  | { kind: "unsupported" };

export function classifyAppmsgUrl(value: string | undefined): AppmsgRoute {
  if (!value) return { kind: "unsupported" };
  try {
    const url = new URL(value);
    if (url.origin !== "https://mp.weixin.qq.com") return { kind: "unsupported" };
    if (
      url.pathname === "/cgi-bin/home" &&
      !url.hash &&
      hasExactQueryKeys(url.searchParams, ["t", "lang", "token"])
    )
      return { kind: "home" };
    if (url.pathname !== "/cgi-bin/appmsg") return { kind: "unsupported" };
    const action = uniqueParam(url.searchParams, "action");
    const type = uniqueParam(url.searchParams, "type");
    const t = uniqueParam(url.searchParams, "t");
    const appmsgId = uniqueParam(url.searchParams, "appmsgid");
    const isNew = uniqueParam(url.searchParams, "isNew");
    const begin = uniqueParam(url.searchParams, "begin");
    const count = uniqueParam(url.searchParams, "count");
    if (action === "list_card" && type === "77") {
      if (
        !hasOnlyObservedQueryKeys(
          url.searchParams,
          ["action", "type", "begin", "count"],
          ["lang"],
        ) ||
        t !== null ||
        appmsgId !== null ||
        isNew !== null ||
        !begin ||
        !count ||
        !/^\d+$/.test(begin) ||
        !/^\d+$/.test(count)
      )
        return { kind: "unsupported" };
      return { kind: "draft-list", begin, count };
    }
    if (
      t === "media/appmsg_edit_v2" &&
      action === "edit" &&
      type === "77" &&
      isNew === "1" &&
      appmsgId === null &&
      begin === null &&
      count === null &&
      hasOnlyObservedQueryKeys(
        url.searchParams,
        ["t", "action", "type", "isNew"],
        ["lang", "createType"],
      )
    )
      return { kind: "new" };
    if (
      t === "media/appmsg_edit" &&
      action === "edit" &&
      type === "77" &&
      appmsgId &&
      isNew === null &&
      begin === null &&
      count === null &&
      hasOnlyObservedQueryKeys(
        url.searchParams,
        ["t", "action", "type", "appmsgid"],
        ["lang", "replaceScene", "isSend", "isFreePublish", "reprint_confirm"],
      )
    )
      return { kind: "saved-editor", groupId: appmsgId };
    return { kind: "unsupported" };
  } catch {
    return { kind: "unsupported" };
  }
}

function uniqueParam(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  return values.length === 0 ? null : values.length === 1 ? values[0]! : "";
}

function hasOnlyObservedQueryKeys(
  params: URLSearchParams,
  routeKeys: string[],
  contextKeys: string[] = [],
): boolean {
  const allowed = new Set([...routeKeys, "token", "timestamp", "isMul", ...contextKeys]);
  const counts = new Map<string, number>();
  for (const key of params.keys()) {
    if (!allowed.has(key)) return false;
    counts.set(key, (counts.get(key) ?? 0) + 1);
    if (counts.get(key)! > 1) return false;
  }
  return true;
}

function hasExactQueryKeys(params: URLSearchParams, expected: string[]): boolean {
  const keys = [...params.keys()];
  return (
    keys.length === expected.length &&
    expected.every((key) => keys.filter((item) => item === key).length === 1)
  );
}

export function appmsgRouteIdentity(value: string | undefined): string | undefined {
  const route = classifyAppmsgUrl(value);
  switch (route.kind) {
    case "home":
      return "mp-home";
    case "draft-list":
      return `appmsg|list_card|type=77|begin=${route.begin}|count=${route.count}`;
    case "new":
      return "appmsg|media/appmsg_edit_v2|edit|type=77|isNew=1";
    case "saved-editor":
      return `appmsg|media/appmsg_edit|edit|type=77|appmsgid=${route.groupId}`;
    case "unsupported":
      return undefined;
  }
}

export function isEditorPageUrl(value: string | undefined): boolean {
  const route = classifyAppmsgUrl(value);
  return route.kind === "new" || route.kind === "saved-editor";
}
export function isHomePageUrl(value: string | undefined): boolean {
  return classifyAppmsgUrl(value).kind === "home";
}
export function isDraftListUrl(value: string | undefined): boolean {
  return classifyAppmsgUrl(value).kind === "draft-list";
}
