import { chromium, expect, test } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

let temporary: string, bundle: string;
test.beforeAll(async () => {
  temporary = await mkdtemp("/tmp/opencode/mpctl-asset-image-");
  const entry = path.join(temporary, "entry.ts");
  await writeFile(
    entry,
    `export { resolveAssetImage } from ${JSON.stringify(path.resolve("src/mp/asset-image.ts"))}; export { Result } from ${JSON.stringify(path.resolve("node_modules/better-result"))};`,
  );
  execFileSync("bun", [
    "build",
    entry,
    "--target=browser",
    "--format=esm",
    `--outfile=${temporary}/image.js`,
  ]);
  bundle = await readFile(`${temporary}/image.js`, "utf8");
});
test.afterAll(async () => {
  if (temporary) await rm(temporary, { recursive: true, force: true });
});

for (const mode of ["native-source", "unchanged-thumbnail", "cleanup-failed"] as const) {
  test(`asset resolution ${mode} reads native conversion without changing article or saving`, async () => {
    const browser = await chromium.launch({
      executablePath: process.env.MPCTL_CHROMIUM_EXECUTABLE,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.route("**/*", (route) =>
        route.fulfill(
          route.request().url().endsWith("/image.js")
            ? { contentType: "text/javascript", body: bundle }
            : {
                contentType: "text/html; charset=utf-8",
                body: '<meta charset="utf-8"><article>unchanged</article><li id="js_editor_insertimage">图片<ul><li class="js_img_from_local">从图片库选择</li></ul></li>',
              },
        ),
      );
      await page.goto("https://mp.weixin.qq.com/fixture");
      const result = await page.evaluate(async (mode) => {
        const url = "https://mp.weixin.qq.com/image.js";
        const { resolveAssetImage, Result } = await import(url);
        const thumbnailUrl = "https://mmbiz.qpic.cn/mmbiz_png/thumbnail/300";
        const nativeUrl = "https://mmbiz.qpic.cn/mmbiz_png/native-converted-identity/0?wx_fmt=png";
        let clicks = 0,
          releases = 0,
          cancels = 0;
        document.querySelector<HTMLElement>(".js_img_from_local")!.onclick = () => {
          const dialog = document.createElement("div");
          dialog.className = "weui-desktop-dialog";
          dialog.innerHTML =
            '<h3>选择图片</h3><button class="weui-desktop-dialog__close-btn">关闭</button><div class="weui-desktop-upload_global-media"></div><button>确定</button><button>取消</button>';
          document.body.append(dialog);
          const model = { $options: { name: "mp-image-dialog" }, selectedImgs: [] as unknown[] };
          Object.assign(dialog.querySelector(".weui-desktop-upload_global-media")!, {
            __vue__: model,
          });
          setTimeout(() => {
            const card = document.createElement("div");
            card.className = "weui-desktop-img-picker__item";
            card.innerHTML = `<i class="weui-desktop-img-picker__img-thumb" style="background-image:url('${thumbnailUrl}')"></i><strong class="weui-desktop-img-picker__img-title">image.png</strong>`;
            card.onclick = () => {
              clicks++;
              setTimeout(() => {
                model.selectedImgs = [
                  {
                    name: "image.png",
                    url: mode === "unchanged-thumbnail" ? thumbnailUrl : nativeUrl,
                    fileId: 123,
                    format: "png",
                    aiStatus: 1,
                  },
                ];
              }, 20);
            };
            dialog.append(card);
          }, 30);
          dialog.querySelectorAll("button")[2]!.onclick = () => {
            cancels++;
            if (mode !== "cleanup-failed") dialog.remove();
          };
        };
        const image = await resolveAssetImage(
          document,
          { filename: "image.png", thumbnailUrl },
          () => Result.ok(),
          () => releases++,
        );
        return {
          image,
          clicks,
          releases,
          cancels,
          body: document.querySelector("article")!.innerHTML,
          nativeUrl,
        };
      }, mode);
      expect(result.clicks).toBe(1);
      expect(result.cancels).toBe(1);
      expect(result.body).toBe("unchanged");
      expect(result.releases).toBe(mode === "cleanup-failed" ? 0 : 1);
      if (mode === "native-source") {
        expect(result.image.value.src).toBe(result.nativeUrl);
        expect(result.image.value.html).toContain('data-imgfileid="123"');
      } else
        expect(result.image.error.code).toBe(
          mode === "cleanup-failed" ? "cleanup_failed" : "target_unavailable",
        );
    } finally {
      await browser.close();
    }
  });
}
