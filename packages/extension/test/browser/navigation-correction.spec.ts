import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import path from "node:path";
let temp: string;
let bundle: string;
test.beforeAll(async () => {
  if (process.env.MPCTL_CORRECTION_REVIEW_BUNDLE) {
    bundle = await readFile(process.env.MPCTL_CORRECTION_REVIEW_BUNDLE, "utf8");
    return;
  }
  temp = await mkdtemp("/tmp/opencode/mpctl-t5-correction-");
  const output = path.join(temp, "entry.js");
  execFileSync("bun", [
    "build",
    "test/browser/fixtures/navigation-correction.ts",
    "--target=browser",
    "--format=esm",
    `--outfile=${output}`,
  ]);
  bundle = await readFile(output, "utf8");
});
test.afterAll(async () => {
  if (temp) await rm(temp, { recursive: true, force: true });
});

for (const completed of [false, true])
  test(`R2 native IDB placement docB ${completed ? "post-dispatch docC" : "no reload completion"}`, async () => {
    test.setTimeout(25000);
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("entry.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
      );
      await page.goto("https://r2.test/");
      const result = await page.evaluate(async (completed) => {
        const url = "https://r2.test/entry.js";
        const { navigationFixture, createOperations } = await import(url);
        const f = await navigationFixture();
        try {
          const list = {
            tabId: 2,
            documentId: "docB",
            url: "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77&begin=0&count=10&token=account",
          };
          const group = f.api.groupTabs;
          f.api.groupTabs = async (id: number) => {
            const value = await group(id);
            f.manager.observe(list);
            return value;
          };
          f.api.reloadTab = async () => {
            f.counters.reload++;
            if (completed) f.manager.observe({ ...list, documentId: "docC" });
          };
          const reply = await f.workspace.listArticles();
          const pending = (await f.operations.pending()).unwrap();
          const counts = { ...f.counters };
          const reopened = (await createOperations(f.database)).unwrap();
          const snapshot = pending[0]
            ? (await reopened.get(pending[0].snapshot.operationId)).unwrap().snapshot
            : undefined;
          const blocked = await reopened.maintenance(async () => {});
          return {
            reply,
            pending: pending.length,
            snapshot,
            blocked: blocked.isErr(),
            counts,
            after: f.counters,
          };
        } finally {
          f.dispose();
        }
      }, completed);
      expect(result.pending).toBe(completed ? 0 : 1);
      expect(result.blocked).toBe(!completed);
      expect(result.counts).toEqual({
        create: 0,
        group: 1,
        capture: 0,
        reload: 1,
        read: 0,
        set: 0,
      });
      if (!completed) {
        expect(result.snapshot.state).toBe("unresolved");
        expect(result.after).toEqual(result.counts);
      } else expect(result.reply.status).toBe("ok");
    } finally {
      await browser.close();
    }
  });
for (const saved of [false, true])
  test(`F1 associated ${saved ? "saved" : "new"} method avoids original late DOM popup without replay`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.request().url().endsWith("entry.js")
          ? route.fulfill({ contentType: "text/javascript", body: bundle })
          : route.fulfill({
              contentType: "text/html",
              body: '<!doctype html><div class="new-creation__menu-item">文章</div><div class="weui-desktop-card" data-appid="A"><div class="weui-desktop-tooltip__wrp weui-desktop-link"><a href="javascript:;">edit</a></div></div>',
            }),
      );
      await page.goto(
        saved
          ? "https://mp.weixin.qq.com/cgi-bin/appmsg?action=list_card&type=77"
          : "https://mp.weixin.qq.com/cgi-bin/home?t=home",
      );
      await page.evaluate(() => {
        document.querySelector(".new-creation__menu-item")!.textContent = "文章";
      });
      await page.addScriptTag({ content: nativeHandlerFixtureScript(saved) });
      const before = await page.evaluate(async (saved) => {
        const url = "https://mp.weixin.qq.com/entry.js";
        const { navigationFixture, captureNativeNewEditorUrl, captureNativeDraftEditorUrl } =
          await import(url);
        const f = await navigationFixture();
        const state = globalThis as any;
        state.f = f;
        const target = saved
          ? "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=A&token=account"
          : "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77&token=account";
        let release!: () => void;
        const originalHandler = new Promise<void>((done) => {
          release = done;
        });
        state.releaseOriginal = release;
        state.clicks = 0;
        state.realOpen = 0;
        const real = window.open.bind(window);
        window.open = ((...args: Parameters<typeof window.open>) => {
          state.realOpen++;
          return real(...args);
        }) as typeof window.open;
        const control = document.querySelector<HTMLElement>(
          saved ? ".weui-desktop-card a" : ".new-creation__menu-item",
        )!;
        control.addEventListener("click", () => {
          state.clicks++;
          window.open(target);
          void originalHandler.then(() => window.open(target));
        });
        f.api.executeMain = async () => {
          f.counters.capture++;
          return [
            {
              result: saved
                ? await captureNativeDraftEditorUrl("A")
                : await captureNativeNewEditorUrl(),
            },
          ];
        };
        const input = saved ? { operationId: f.id(), candidate: "A" } : { operationId: f.id() };
        state.input = input;
        const reply = await f.decode(
          saved ? await f.workspace.openArticle(input) : await f.workspace.newArticle(input),
        );
        state.reply = reply;
        const counts = { ...f.counters };
        const query = await f.decode(await f.workspace.getOperation(input.operationId));
        let cleanupQueries = 0;
        const queryGroups = f.api.queryGroups;
        f.api.queryGroups = async () => {
          cleanupQueries++;
          return queryGroups();
        };
        const blocked = await f.workspace.cleanupWorkspace();
        return {
          reply,
          query,
          blocked,
          cleanupQueries,
          counts,
          pending: (await f.operations.pending()).unwrap().length,
          realOpen: state.realOpen,
          clicks: state.clicks,
        };
      }, saved);
      expect(before.reply.snapshot).toMatchObject({
        state: "settled",
        effect: { pageCreated: true, targetBound: true, bodyHash: expect.any(String) },
      });
      expect(before.pending).toBe(0);
      expect(before.realOpen).toBe(0);
      expect(before.clicks).toBe(0);
      expect(before.blocked.status).toBe("ok");
      expect(before.blocked).toMatchObject({
        value: { tabsMoved: 0, groupsRemoved: 0, groupsRemaining: 1 },
      });
      expect(before.cleanupQueries).toBe(2);
      expect(before.counts).toEqual({
        create: 1,
        group: 1,
        capture: 1,
        reload: 0,
        read: 1,
        set: 0,
      });
      await page.evaluate(() => (globalThis as any).releaseOriginal());
      const after = await page.evaluate(async (saved) => {
        const s = globalThis as any;
        try {
          return {
            repeated: await s.f.decode(
              saved
                ? await s.f.workspace.openArticle(s.input)
                : await s.f.workspace.newArticle(s.input),
            ),
            query: await s.f.decode(await s.f.workspace.getOperation(s.input.operationId)),
            counts: s.f.counters,
            clicks: s.clicks,
            realOpen: s.realOpen,
          };
        } finally {
          s.f.dispose();
        }
      }, saved);
      expect(after.query.snapshot).toEqual(before.reply.snapshot);
      expect(after.repeated.snapshot).toEqual(before.reply.snapshot);
      expect(after.counts).toEqual(before.counts);
      expect(after.clicks).toBe(0);
      expect(after.realOpen).toBe(0);
      expect(browser.contexts()[0]!.pages()).toHaveLength(1);
    } finally {
      await browser.close();
    }
  });

test("F1 saved valid href is actual zero-dispatch end positive control", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("entry.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({
            contentType: "text/html",
            body: '<div class="weui-desktop-card" data-appid="A"><div class="weui-desktop-tooltip__wrp weui-desktop-link"><a href="https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit&action=edit&type=77&appmsgid=A&token=account">edit</a></div></div>',
          }),
    );
    await page.goto("https://mp.weixin.qq.com/");
    const reply = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/entry.js";
      const { navigationFixture, captureNativeDraftEditorUrl } = await import(url);
      const f = await navigationFixture();
      let clicks = 0;
      document.querySelector("a")!.addEventListener("click", () => clicks++);
      try {
        f.api.executeMain = async () => {
          f.counters.capture++;
          return [{ result: await captureNativeDraftEditorUrl("A") }];
        };
        return {
          reply: await f.decode(
            await f.workspace.openArticle({ operationId: f.id(), candidate: "A" }),
          ),
          clicks,
          pending: (await f.operations.pending()).unwrap().length,
        };
      } finally {
        f.dispose();
      }
    });
    expect(reply.clicks).toBe(0);
    expect(reply.pending).toBe(0);
    expect(reply.reply.snapshot).toMatchObject({ state: "settled", result: { status: "ok" } });
  } finally {
    await browser.close();
  }
});

test("F5 actual menu observation exception retains runtime cause and zero choice dispatch", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("entry.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({
            contentType: "text/html",
            body: '<style>[hidden]{display:none!important}li,button{display:block;min-width:20px;min-height:20px}</style><li id="js_editor_insertimage"><div hidden><button class="js_img_from_local">从图片库选择</button></div></li>',
          }),
    );
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    );
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/entry.js";
      const { createMaterialPageService } = await import(url);
      let menu = 0;
      let choice = 0;
      document.querySelector("li")!.addEventListener("click", (e) => {
        if ((e.target as Element).closest("button")) choice++;
        else {
          menu++;
          document.querySelector<HTMLElement>("li div")!.hidden = false;
        }
      });
      const query = document.querySelectorAll.bind(document);
      document.querySelectorAll = ((selector: string) => {
        if (menu && selector === ".weui-desktop-dialog")
          throw new Error("private token must not leak");
        return query(selector);
      }) as typeof document.querySelectorAll;
      const response = await createMaterialPageService(document, () => true).list();
      return { response, menu, choice };
    });
    expect(result.menu).toBe(1);
    expect(result.choice).toBe(0);
    expect(result.response).toMatchObject({
      status: "error",
      error: {
        ended: false,
        failure: {
          cause: { at: "content.library_open", kind: "runtime", code: "dialog_observe_exception" },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private token");
  } finally {
    await browser.close();
  }
});

test("F5 domain refusal before dispatch and read error followed by cleanup observation exception preserve both origins", async () => {
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("entry.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({
            contentType: "text/html",
            body: '<meta charset="utf-8"><style>[hidden]{display:none!important}li,button{display:block;min-width:20px;min-height:20px}</style><li id="js_editor_insertimage"><div hidden><button class="js_img_from_local">从图片库选择</button></div></li>',
          }),
    );
    await page.goto(
      "https://mp.weixin.qq.com/cgi-bin/appmsg?t=media/appmsg_edit_v2&action=edit&isNew=1&type=77",
    );
    const result = await page.evaluate(async () => {
      const url = "https://mp.weixin.qq.com/entry.js";
      const { createMaterialPageService } = await import(url);
      let menu = 0;
      let choice = 0;
      let cleanup = false;
      const refusal = await createMaterialPageService(document, () => false).list();
      document.querySelector("li")!.addEventListener("click", (event) => {
        if ((event.target as Element).closest("button")) {
          choice++;
          const dialog = document.createElement("section");
          dialog.className = "weui-desktop-dialog";
          dialog.innerHTML =
            '<h2>选择图片</h2><div class="weui-desktop-img-picker__list"></div><button class="weui-desktop-dialog__close-btn">×</button><footer><button>确定</button><button>取消</button></footer>';
          document.body.append(dialog);
        } else {
          menu++;
          document.querySelector<HTMLElement>("li div")!.hidden = false;
        }
      });
      const query = document.querySelectorAll.bind(document);
      document.querySelectorAll = ((selector: string) => {
        if (cleanup && selector === ".weui-desktop-dialog")
          throw new Error("private cleanup token");
        const values = query(selector);
        if (selector === ".weui-desktop-dialog" && values.length) {
          const dialog = values[0]!;
          const local = dialog.querySelectorAll.bind(dialog);
          dialog.querySelectorAll = ((selector: string) => {
            if (selector === ".weui-desktop-img-picker__item") {
              cleanup = true;
              throw new Error("private read token");
            }
            return local(selector);
          }) as typeof dialog.querySelectorAll;
        }
        return values;
      }) as typeof document.querySelectorAll;
      return {
        refusal,
        response: await createMaterialPageService(document, () => true).list(),
        menu,
        choice,
      };
    });
    expect(result.refusal).toMatchObject({
      status: "error",
      error: { ended: true, failure: { cause: { kind: "domain", code: "target_unavailable" } } },
    });
    expect(result.menu).toBe(1);
    expect(result.choice).toBe(1);
    expect(result.response).toMatchObject({
      status: "error",
      error: {
        failure: {
          cause: { at: "content.readback" },
          cleanup: {
            at: "content.library_cleanup",
            kind: "runtime",
            code: "dialog_observe_exception",
          },
        },
      },
    });
    expect(JSON.stringify(result)).not.toContain("private");
  } finally {
    await browser.close();
  }
});

test("F2 native IDB original list reload remains unresolved across HOME fallback and ledger reopen", async () => {
  test.setTimeout(25000);
  const browser = await chromium.launch({
    executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
    args: ["--no-sandbox"],
  });
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) =>
      route.request().url().endsWith("entry.js")
        ? route.fulfill({ contentType: "text/javascript", body: bundle })
        : route.fulfill({ contentType: "text/html", body: "<!doctype html>" }),
    );
    await page.goto("https://correction.test/");
    const result = await page.evaluate(async () => {
      const url = "https://correction.test/entry.js";
      const { navigationFixture, createOperations } = await import(url);
      const f = await navigationFixture();
      try {
        const original = f.manager.isCurrent.bind(f.manager);
        // Use the fixture's real Result producer instead of a second workspace.
        f.manager.isCurrent = async (binding: any) => {
          const value = await original(binding);
          return binding.tabId === 2 ? value.map(() => false) : value;
        };
        const input = { operationId: f.id(), candidate: "A" };
        const first = await f.decode(await f.workspace.openArticle(input));
        const before = { ...f.counters };
        const reopened = (await createOperations(f.database)).unwrap();
        const status = (await reopened.get(input.operationId)).unwrap();
        const blocked = await reopened.maintenance(async () => {
          throw new Error("must not reload");
        });
        return {
          first,
          status,
          before,
          after: f.counters,
          blocked: blocked.isErr(),
          pending: (await reopened.pending()).unwrap().length,
        };
      } finally {
        f.dispose();
      }
    });
    expect(result.first.snapshot.state).toBe("unresolved");
    expect(result.status.snapshot).toEqual(result.first.snapshot);
    expect(result.pending).toBe(1);
    expect(result.blocked).toBe(true);
    expect(result.before).toEqual({ create: 0, group: 1, capture: 0, reload: 1, read: 0, set: 0 });
    expect(result.after).toEqual(result.before);
  } finally {
    await browser.close();
  }
});
import { nativeHandlerFixtureScript } from "../native-handler-fixture";
