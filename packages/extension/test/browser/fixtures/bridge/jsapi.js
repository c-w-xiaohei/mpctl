(() => {
  let content = "";
  window.__mpctlFixtureCalls = [];
  window.__mpctlFixtureResults = [];
  document.documentElement.dataset.mpctlFixtureDocumentId = crypto.randomUUID();
  document.documentElement.dataset.mpctlReady = "yes";
  const appmsg = new URL(location.href);
  const savedGroup = appmsg.searchParams.get("appmsgid");
  if (appmsg.searchParams.get("action") === "list_card") {
    document.getElementById("draft-list").hidden = false;
    document.querySelectorAll(".weui-desktop-card").forEach((card) => {
      const link = card.querySelector("a");
      link.addEventListener("click", (event) => {
        event.preventDefault();
        const id = card.dataset.appid;
        window.open(
          `/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=${id}&lang=synthetic-saved-language&replaceScene=synthetic-scene&isSend=synthetic-send&isFreePublish=synthetic-free-publish&reprint_confirm=synthetic-reprint-confirm&token=synthetic-token`,
          "_blank",
        );
      });
    });
  } else if (savedGroup) {
    document.getElementById("fixture").hidden = true;
    document.getElementById("saved-editor").hidden = false;
    document.documentElement.dataset.mpctlFixtureGroup = savedGroup;
    const secondItemMode = localStorage.getItem("mpctl-fixture-second-item");
    if (secondItemMode) {
      const secondItem = document.createElement("div");
      secondItem.className = "js_appmsg_item appmsg_item_wrp";
      secondItem.dataset.msgindex = "1";
      if (secondItemMode === "hidden") secondItem.hidden = true;
      document.getElementById("saved-editor").append(secondItem);
    }
    content = `<p>body for ${savedGroup}</p>`;
  } else {
    document.getElementById("draft-list").hidden = true;
    document.getElementById("saved-editor").hidden = false;
  }
  document.getElementById("trusted-interaction")?.addEventListener("click", (event) => {
    document.documentElement.dataset.mpctlTrustedClick = String(event.isTrusted);
  });
  window.__MP_Editor_JSAPI__ = {
    invoke({ apiName, apiParam, sucCb, errCb }) {
      window.__mpctlFixtureCalls.push(apiName.replace("mp_editor_", ""));
      queueMicrotask(() => {
        if (apiName === "mp_editor_get_isready")
          return sucCb({ isReady: true, isNew: true, msg: "" });
        if (apiName === "mp_editor_get_content") return sucCb({ content, msg: "" });
        if (apiName === "mp_editor_set_content" && typeof apiParam?.content === "string") {
          content = apiParam.content;
          document.documentElement.dataset.mpctlBody = content;
          window.__mpctlFixtureResults.push({ apiName, content: apiParam.content });
          document.dispatchEvent(new CustomEvent("mpctl-fixture-updated", { detail: content }));
          return sucCb({ msg: "ok" });
        }
        errCb({ code: "unsupported" });
      });
    },
  };
})();
