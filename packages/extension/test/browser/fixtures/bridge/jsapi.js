(() => {
  let content = "";
  window.__mpctlFixtureCalls = [];
  window.__mpctlFixtureResults = [];
  document.documentElement.dataset.mpctlFixtureDocumentId = crypto.randomUUID();
  document.documentElement.dataset.mpctlReady = "yes";
  const title = document.querySelector('[data-placeholder="请在这里输入标题"]');
  const titleMirror = document.getElementById("title");
  title?.addEventListener("input", () => {
    titleMirror.value = title.innerText === "\n" ? "" : title.innerText;
  });
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
    if (localStorage.getItem("mpctl-fixture-empty-cover") === "yes") {
      const preview = document.querySelector(".js_cover_preview_new");
      preview.hidden = true;
      preview.style.backgroundImage = "none";
    }
    const secondItemMode = localStorage.getItem("mpctl-fixture-second-item");
    if (secondItemMode) {
      const secondItem = document.createElement("div");
      secondItem.className = "js_appmsg_item appmsg_item_wrp";
      secondItem.dataset.msgindex = "1";
      if (secondItemMode === "hidden") secondItem.hidden = true;
      document.getElementById("saved-editor").append(secondItem);
    }
    const persisted = JSON.parse(localStorage.getItem("mpctl-fixture-saved-state") ?? "{}")[
      savedGroup
    ];
    content = persisted?.body ?? `<p>body for ${savedGroup}</p>`;
    if (persisted) {
      title.textContent = persisted.title;
      titleMirror.value = persisted.title;
      document.getElementById("author").value = persisted.author;
      document.getElementById("js_description").value = persisted.summary;
      document.querySelector(".js_cover_preview_new").style.backgroundImage = persisted.cover;
    }
  } else {
    document.getElementById("draft-list").hidden = true;
    document.getElementById("saved-editor").hidden = false;
  }
  const editorImageMenu = document.getElementById("js_editor_insertimage");
  const imageLibrary = document.getElementById("synthetic-image-library");
  const imageChoice = editorImageMenu.querySelector(".js_img_from_local");
  const imageInput = imageLibrary.querySelector(
    '.weui-desktop-upload_global-media input[type="file"]',
  );
  const imageCards = imageLibrary.querySelector(".weui-desktop-img-picker__list");
  const imageState = (window.__mpctlFixtureAssets = {
    changes: [],
    bodyBefore: content,
    openCount: 0,
    cancelCount: 0,
    cardCount: 0,
    cardDelayMs: 0,
    coverTrace: [],
    nativeSaveCount: 0,
  });
  if (savedGroup === "fixture-group-1") {
    const card = document.createElement("article");
    card.className = "weui-desktop-img-picker__item";
    card.dataset.filename = "saved-cover-candidate.png";
    const label = document.createElement("span");
    label.className = "weui-desktop-img-picker__img-title";
    label.textContent = card.dataset.filename;
    const thumb = document.createElement("span");
    thumb.className = "weui-desktop-img-picker__img-thumb";
    thumb.style.backgroundImage =
      'url("https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png")';
    card.append(label, thumb);
    imageCards.append(card);
    imageState.cardCount = 1;
  }
  editorImageMenu.hidden = false;
  editorImageMenu.addEventListener("click", () => {
    imageChoice.hidden = false;
  });
  imageChoice.addEventListener("click", () => {
    imageLibrary.hidden = false;
    imageState.openCount++;
  });
  const closeLibrary = () => {
    if (document.documentElement.dataset.mpctlUploadMode === "cleanup-fails") return;
    imageLibrary.hidden = true;
    imageState.cancelCount++;
  };
  imageLibrary
    .querySelector('[data-library-action="cancel"]')
    .addEventListener("click", closeLibrary);
  imageLibrary
    .querySelector(".weui-desktop-dialog__close-btn")
    .addEventListener("click", closeLibrary);
  imageInput.addEventListener("change", async (event) => {
    const file = imageInput.files?.[0];
    if (!file) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await crypto.subtle
      .digest("SHA-256", bytes)
      .then((digest) =>
        [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join(""),
      );
    const record = {
      trusted: event.isTrusted,
      nativeFile: file instanceof File,
      name: file.name,
      type: file.type,
      size: file.size,
      sha256,
    };
    imageState.changes.push(record);
    document.documentElement.dataset.mpctlAssetReceived = JSON.stringify(record);
    if (imageCards.querySelector(`[data-filename="${CSS.escape(file.name)}"]`)) {
      imageState.duplicateRejected = true;
      return;
    }
    const card = document.createElement("article");
    card.className = "weui-desktop-img-picker__item";
    card.dataset.filename = file.name;
    const title = document.createElement("span");
    title.className = "weui-desktop-img-picker__img-title";
    title.textContent =
      document.documentElement.dataset.mpctlUploadMode === "blank-title" ? "" : file.name;
    const thumb = document.createElement("span");
    thumb.className = "weui-desktop-img-picker__img-thumb";
    thumb.setAttribute(
      "style",
      'background-image: url("https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png");',
    );
    card.append(title, thumb);
    setTimeout(() => {
      imageCards.append(card);
      imageState.cardCount++;
    }, imageState.cardDelayMs);
  });
  imageLibrary.querySelector('[data-library-action="confirm"]').addEventListener("click", () => {
    imageLibrary.hidden = true;
  });
  const coverArea = document.getElementById("js_cover_area");
  const coverLibrary = document.getElementById("synthetic-cover-library");
  const coverCrop = document.getElementById("synthetic-cover-crop");
  const coverCards = coverLibrary.querySelector(".weui-desktop-img-picker__list");
  const coverUrl = "https://mmbiz.qpic.cn/mmbiz_png/synthetic-library-card/300?wx_fmt=png";
  const primaryCover = coverArea.querySelector(".js_cover_preview_new");
  const squareCover = coverArea.querySelector(".js_cover_preview_square");
  const primaryWrapper = primaryCover.querySelector(".js_chooseCoverWrap");
  const squareWrapper = squareCover.querySelector(".js_chooseCoverWrap");
  const coverDropdown = primaryWrapper.querySelector(".cover-dropdown");
  imageState.coverHoverEvents = { primaryPreview: 0, primaryWrapper: 0, square: 0 };
  const observeHover = (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest(".js_cover_preview_new") === primaryCover)
      imageState.coverHoverEvents.primaryPreview++;
    if (target?.closest(".js_chooseCoverWrap") === primaryWrapper)
      imageState.coverHoverEvents.primaryWrapper++;
    if (
      target?.closest(".js_cover_preview_square") === squareCover ||
      target?.closest(".js_chooseCoverWrap.preview-square") === squareWrapper
    )
      imageState.coverHoverEvents.square++;
  };
  document.addEventListener("mousemove", observeHover, true);
  const setNegativeMode = (mode) => {
    if (mode === "wrong-label")
      coverDropdown.querySelector(".js_imagedialog").textContent = "从正文选择";
    else if (mode === "duplicate" && !coverDropdown.querySelector("[data-cover-menu-duplicate]")) {
      const extra = document.createElement("a");
      extra.className = "pop-opr__button js_imagedialog";
      extra.textContent = "从图片库选择";
      extra.dataset.coverMenuDuplicate = "";
      coverDropdown.append(extra);
    } else if (mode === "visible-item-hidden-ancestor") primaryWrapper.hidden = true;
    else if (mode === "replace-primary") {
      window.__coverOriginalPrimary = primaryCover;
      primaryCover.replaceWith(primaryCover.cloneNode(true));
    } else if (mode === "guard-loss") {
      const current = new URL(location.href);
      current.searchParams.set("appmsgid", "fixture-route-drift");
      history.replaceState(null, "", current);
    }
  };
  window.addEventListener("mpctl-fixture-cover-negative-mode", (event) => {
    setNegativeMode(event.detail);
  });
  coverArea.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest(".js_chooseCover") : null;
    if (target && target.closest(".js_cover_preview_new") === primaryCover)
      imageState.coverTrace.push("primary-launcher");
  });
  squareCover.querySelector(".js_chooseCover").addEventListener("click", () => {
    imageState.coverTrace.push("square-launcher");
  });
  coverArea
    .querySelector("#js_cover_area a.pop-opr__button.js_imagedialog")
    .addEventListener("click", () => {
      imageState.coverTrace.push("library-menu");
      if (imageState.cardCount === 0) return;
      coverCards.replaceChildren();
      for (const card of imageCards.querySelectorAll(".weui-desktop-img-picker__item")) {
        const clone = card.cloneNode(true);
        coverCards.append(clone);
      }
      coverLibrary.hidden = false;
    });
  coverCards.addEventListener("click", (event) => {
    const target =
      event.target instanceof Element
        ? event.target.closest(".weui-desktop-img-picker__item")
        : null;
    if (!target) return;
    imageState.coverTrace.push("card");
    coverCards.querySelectorAll(".weui-desktop-img-picker__item").forEach((card) => {
      card.classList.toggle("selected", card === target);
    });
  });
  const coverNext = coverLibrary.querySelector("button");
  coverNext.addEventListener("click", async () => {
    const card = coverCards.querySelector(".weui-desktop-img-picker__item");
    if (!card?.classList.contains("selected")) return;
    imageState.coverTrace.push("next");
    coverLibrary.remove();
    const cropImage = coverCrop.querySelector(".crop-img");
    try {
      await cropImage.decode();
    } catch {
      imageState.coverTrace.push("crop-image-decode-failed");
      return;
    }
    imageState.coverTrace.push(`crop-image:${cropImage.naturalWidth}x${cropImage.naturalHeight}`);
    coverCrop.hidden = false;
  });
  coverLibrary.querySelectorAll("button")[1].addEventListener("click", () => {
    coverLibrary.hidden = true;
  });
  coverCrop.querySelector("button:nth-of-type(2)").addEventListener("click", () => {
    imageState.coverTrace.push("confirm");
    coverArea.querySelector(".js_cover_preview_new").style.backgroundImage =
      `url("${coverUrl.replace("/300?", "/0?")}")`;
    coverCrop.hidden = true;
    imageState.coverConfirms = (imageState.coverConfirms ?? 0) + 1;
  });
  coverCrop.querySelector(".weui-desktop-dialog__close-btn").addEventListener("click", () => {
    coverCrop.hidden = true;
  });
  const historyLauncher = document.getElementById("history_bt");
  let historyPortal;
  let historyTable;
  const createHistoryPortal = () => {
    historyPortal = document.createElement("div");
    historyPortal.id = "history_pop";
    historyPortal.className = "appmsg_history_popup history_overflow_auto";
    historyTable = document.createElement("table");
    historyTable.className = "appmsg_history_table";
    const tbody = document.createElement("tbody");
    const header = document.createElement("tr");
    header.className = "appmsg_history_tr";
    for (const [cellClass, value] of [
      ["appmsg_history_time", "操作时间"],
      ["appmsg_history_author", "操作人"],
      ["appmsg_history_source", "来源"],
      ["appmsg_history_opr", "操作"],
    ]) {
      const cell = document.createElement("td");
      cell.className = cellClass;
      cell.textContent = value;
      header.append(cell);
    }
    const row = document.createElement("tr");
    row.className = "appmsg_history_tr";
    for (const [cellClass, value] of [
      ["appmsg_history_time", "2026-10-03 10:00"],
      ["appmsg_history_author", "Fixture"],
      ["appmsg_history_source", "mpctl-fixture"],
      ["appmsg_history_opr", "手动保存"],
    ]) {
      const cell = document.createElement("td");
      cell.className = cellClass;
      cell.textContent = value;
      row.append(cell);
    }
    tbody.append(header, row);
    historyTable.append(tbody);
    historyPortal.append(historyTable);
    document.getElementById("synthetic-history-portal-host").append(historyPortal);
  };
  historyLauncher.addEventListener("click", () => {
    if (!historyPortal?.isConnected) createHistoryPortal();
    else historyPortal.hidden = !historyPortal.hidden;
  });
  const nativeSave = document.getElementById("synthetic-native-save");
  nativeSave?.addEventListener("click", () => {
    imageState.nativeSaveCount++;
    localStorage.setItem(
      "mpctl-fixture-total-native-saves",
      String(Number(localStorage.getItem("mpctl-fixture-total-native-saves") ?? "0") + 1),
    );
    historyPortal.hidden = true;
    const canonicalBodyMode = localStorage.getItem("mpctl-fixture-canonical-save-body");
    if (canonicalBodyMode === "yes")
      content = content.replace(
        '<img src="fixture-image.png">',
        '<img data-fromlib="1" src="fixture-image.png">',
      );
    const row = document.createElement("tr");
    row.className = "appmsg_history_tr";
    for (const [cellClass, value] of [
      ["appmsg_history_time", "2026-10-03 10:01"],
      ["appmsg_history_author", "Fixture"],
      ["appmsg_history_source", "mpctl-fixture"],
      ["appmsg_history_opr", "手动保存"],
    ]) {
      const cell = document.createElement("td");
      cell.className = cellClass;
      cell.textContent = value;
      row.append(cell);
    }
    historyTable.querySelector("tbody")?.append(row);
    const group = savedGroup ?? "fixture-group-new";
    const persisted = {
      body: content,
      title: document.querySelector('[data-placeholder="请在这里输入标题"]')?.innerText ?? "",
      author: document.querySelector("#author")?.value ?? "",
      summary: document.querySelector("#js_description")?.value ?? "",
      cover: document.querySelector(".js_cover_preview_new")?.style.backgroundImage ?? "",
    };
    const store = JSON.parse(localStorage.getItem("mpctl-fixture-saved-state") ?? "{}");
    store[group] = persisted;
    localStorage.setItem("mpctl-fixture-saved-state", JSON.stringify(store));
    document.documentElement.dataset.mpctlNativeSaveCount = String(
      Number(document.documentElement.dataset.mpctlNativeSaveCount ?? "0") + 1,
    );
  });
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
        if (apiName === "mp_editor_change_cover" && typeof apiParam?.oriImgUrl === "string") {
          // Synthetic response/preview only, not real platform acceptance.
          window.__mpctlFixtureResults.push({ apiName, apiParam });
          const mode = document.documentElement.dataset.mpctlBodyCoverMode;
          if (mode === "timeout") return;
          if (mode === "error") return errCb({ opaque: true });
          document.querySelector(".js_cover_preview_new").style.backgroundImage =
            `url("${apiParam.oriImgUrl}")`;
          return sucCb({});
        }
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
