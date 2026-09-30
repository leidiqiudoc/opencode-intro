// Renders index.html in headless Chromium, captures the OG canvas and any
// console/page errors, and writes a PNG per preset for visual inspection.
const { chromium } = require("playwright-core");
const path = require("path");
const fs = require("fs");

const FILE = "file://" + path.resolve(__dirname, "index.html");
const OUT = path.resolve(__dirname, ".render");
fs.mkdirSync(OUT, { recursive: true });

const CASES = [
  { title: "OpenCode 简介", sub: "从大模型原理到 Agent Loop 的完整拆解", theme: "terminal" },
  { title: "什么是大模型", sub: "小模型 vs 大模型：参数、算力与泛化能力", theme: "terminal" },
  { title: "常见大模型及厂商", sub: "OpenAI / Anthropic / DeepSeek / Qwen / Kimi", theme: "ocean" },
  { title: "OpenCode 自我说明", sub: "整体架构、Agent 体系、扩展系统与内置工具一览", theme: "paper" },
  { title: "上下文管理", sub: "System Prompt 构建与 Compaction 自动压缩", theme: "sunset" },
  { title: "内置工具一览", sub: "bash · edit · read · grep · webfetch · lsp", theme: "terminal" },
  {
    title: "这是一段特别特别长的标题用来验证换行与缩放逻辑在极端输入下依然不会溢出画布也不会把字切掉",
    sub: "极长标题压力测试",
    theme: "terminal"
  }
];

(async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  const errors = [];
  const isTestArtifact = (t) => t.includes("willReadFrequently");
  page.on("console", (m) => {
    if ((m.type() === "error" || m.type() === "warning") && !isTestArtifact(m.text())) {
      errors.push(m.type() + ": " + m.text());
    }
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
  page.on("dialog", async (d) => { console.log("  [dialog] " + d.message().split("\n")[0]); await d.dismiss(); });

  await page.goto(FILE, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  const results = [];
  for (const c of CASES) {
    // measure content bounds with the background decoration off, otherwise the
    // intentional grid + radial glow makes every pixel "ink"
    await page.evaluate(() => {
      const g = document.getElementById("showGrid");
      if (g.checked) { g.checked = false; g.dispatchEvent(new Event("change", { bubbles: true })); }
    });

    await page.evaluate((cfg) => {
      const set = (id, v) => {
        const n = document.getElementById(id);
        n.value = v;
        n.dispatchEvent(new Event("input", { bubbles: true }));
      };
      set("title", cfg.title);
      set("subtitle", cfg.sub);
      document.querySelector(`.theme-swatch[data-theme="${cfg.theme}"]`).click();
    }, c);
    await page.waitForTimeout(120);

    const info = await page.evaluate(() => {
      const cv = document.getElementById("og");
      const g = cv.getContext("2d", { willReadFrequently: true });
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      let minX = cv.width, maxX = 0, minY = cv.height, maxY = 0;
      const bg = [d[0], d[1], d[2]];
      for (let y = 0; y < cv.height; y++) {
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) {
            if (x < minX) minX = x; if (x > maxX) maxX = x;
            if (y < minY) minY = y; if (y > maxY) maxY = y;
          }
        }
      }
      return {
        size: [cv.width, cv.height],
        status: document.getElementById("status").textContent,
        snippet: document.getElementById("snippet").textContent,
        ink: { minX, maxX, minY, maxY },
        fontSizeVal: document.getElementById("fontSizeVal").textContent
      };
    });

    // 84px horizontal padding each side; 1px tolerance for the accent bar.
    // Vertically the accent bar starts at 82 and the footer descender ends ~592.
    const ink = info.ink;
    const ok = info.size[0] === 1200 && info.size[1] === 630
      && ink.minX >= 83 && ink.maxX <= 1117
      && ink.minY >= 80 && ink.maxY <= 600;
    results.push({ case: c, info, ok });

    const name = c.title.replace(/[^\w一-龥]+/g, "-").slice(0, 20) + "-" + c.theme + ".png";
    await page.locator("#og").screenshot({ path: path.join(OUT, name) });

    // restore decoration for the saved screenshot
    await page.evaluate(() => {
      const g = document.getElementById("showGrid");
      g.checked = true;
      g.dispatchEvent(new Event("change", { bubbles: true }));
    });
  }

  // exercise the 2x export path end to end via a real click + download
  const dl = await Promise.all([
    page.waitForEvent("download"),
    page.click("#download2x")
  ]).then((r) => r[0]);
  const dlPath = path.join(OUT, "export-2x.png");
  await dl.saveAs(dlPath);
  const buf = fs.readFileSync(dlPath);
  // PNG IHDR: width/height are big-endian uint32 at byte 16 and 20
  const exported = { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), name: dl.suggestedFilename(), bytes: buf.length };

  // the canvas must be restored to 1x afterwards
  await page.waitForTimeout(300);
  const restored = await page.evaluate(() => {
    const cv = document.getElementById("og");
    const g = cv.getContext("2d", { willReadFrequently: true });
    const d = g.getImageData(0, 0, cv.width, cv.height).data;
    let ink = 0;
    const bg = [d[0], d[1], d[2]];
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) ink++;
    }
    return { size: [cv.width, cv.height], ink };
  });

  await page.locator(".stage").screenshot({ path: path.join(OUT, "_full-ui.png") });

  // full page, with the default preset restored
  await page.evaluate(() => {
    const p = document.getElementById("preset");
    p.selectedIndex = 0;
    p.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.setViewportSize({ width: 1520, height: 1400 });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, "_page.png"), fullPage: true });

  console.log("=== renders ===");
  for (const r of results) {
    const ink = r.info.ink;
    console.log(
      (r.ok ? "  ok   " : "  FAIL ") +
      r.case.theme.padEnd(9) +
      " " + r.info.fontSizeVal.padEnd(16) +
      " ink x[" + ink.minX + "," + ink.maxX + "] y[" + ink.minY + "," + ink.maxY + "]" +
      "  " + r.case.title.slice(0, 14)
    );
  }

  console.log("\n=== 2x export ===");
  const exportOk = exported.w === 2400 && exported.h === 1260;
  console.log((exportOk ? "  ok   " : "  FAIL ") + "exported " + exported.w + "x" + exported.h +
    "  " + exported.name + "  " + (exported.bytes / 1024).toFixed(0) + "KB");
  const restoreOk = restored.size[0] === 1200 && restored.size[1] === 630 && restored.ink > 500;
  console.log((restoreOk ? "  ok   " : "  FAIL ") + "canvas restored to " + restored.size.join("x") +
    " with " + restored.ink + " ink px");

  // clipboard + share link
  const ctxPage = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const cp = await ctxPage.newPage();
  await cp.goto(FILE, { waitUntil: "load" });
  await cp.click("#copySnippet");
  const clip = await cp.evaluate(() => navigator.clipboard.readText());
  const clipOk = clip.includes('property="og:image"') && clip.includes("1200") && clip.includes("//og/") === false;
  console.log((clipOk ? "  ok   " : "  FAIL ") + "copy meta 标签 -> clipboard (" + clip.length + " chars)");

  await cp.click("#copyLink");
  const clip2 = await cp.evaluate(() => navigator.clipboard.readText());
  const linkOk = /[?&]title=/.test(clip2) && /[?&]theme=/.test(clip2);
  console.log((linkOk ? "  ok   " : "  FAIL ") + "copy 分享链接 -> clipboard");

  // the shared link must round-trip back into the same render
  const rt = await ctxPage.newPage();
  await rt.goto(clip2.replace(/^file:\/\//, "file://"), { waitUntil: "load" });
  const roundTrip = await rt.evaluate(() => ({
    title: document.getElementById("title").value,
    theme: document.querySelector('.theme-swatch[aria-pressed="true"]').dataset.theme,
    ink: (() => {
      const cv = document.getElementById("og");
      const g = cv.getContext("2d", { willReadFrequently: true });
      const d = g.getImageData(0, 0, cv.width, cv.height).data;
      const bg = [d[0], d[1], d[2]];
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
      }
      return n;
    })()
  }));
  const rtOk = roundTrip.ink > 500 && roundTrip.theme;
  console.log((rtOk ? "  ok   " : "  FAIL ") + "share link round-trips (theme=" + roundTrip.theme + ", ink=" + roundTrip.ink + ")");
  await ctxPage.close();

  // publish bundle: real download, then validate the zip with the system unzip
  await page.fill("#siteUrl", "https://example.com/opencode-intro/");
  await page.waitForTimeout(150);
  const zipDl = await Promise.all([
    page.waitForEvent("download"),
    page.click("#downloadBundle")
  ]).then((r) => r[0]);
  const zipPath = path.join(OUT, "og-card.zip");
  await zipDl.saveAs(zipPath);

  // Validate the zip with Python's zipfile. macOS ships Info-ZIP 6.0, which
  // mis-decodes UTF-8 member names and is not a fair judge of the archive.
  const { execFileSync } = require("child_process");
  const py = `
import zipfile, json, sys, os
p = sys.argv[1]
out = sys.argv[2]
z = zipfile.ZipFile(p)
bad = z.testzip()
names = z.infolist()
z.extractall(out)
print(json.dumps({
  "crc_ok": bad is None,
  "names": [i.filename for i in names],
  "sizes": {i.filename: i.file_size for i in names},
  "utf8_flag": all((i.flag_bits & 0x800) != 0 for i in names),
}))
`;
  const extracted = path.join(OUT, "unzipped");
  fs.rmSync(extracted, { recursive: true, force: true });
  const meta = JSON.parse(execFileSync("python3", ["-c", py, zipPath, extracted], { encoding: "utf8" }));

  const hasIndex = meta.names.includes("index.html");
  const pngName = meta.names.find((n) => n.startsWith("og/") && n.endsWith(".png"));
  const zipOk = meta.crc_ok && hasIndex && !!pngName && meta.utf8_flag;
  console.log((zipOk ? "  ok   " : "  FAIL ") + "zip integrity, UTF-8 names, contents");
  console.log("         " + meta.names.join("  |  "));
  if (!meta.utf8_flag) console.log("  FAIL  UTF-8 filename flag not set");

  // every member name must be a legal path component (<=255 bytes)
  for (const n of meta.names) {
    const len = Buffer.byteLength(n.split("/").pop(), "utf8");
    if (len > 255) console.log("  FAIL  member name too long: " + len + " bytes");
  }

  const pageHtml = fs.readFileSync(path.join(extracted, "index.html"), "utf8");
  const png = fs.readFileSync(path.join(extracted, pngName));
  const metaChecks = {
    "absolute og:image": /property="og:image" content="https:\/\/example\.com\/opencode-intro\/og\//.test(pageHtml),
    "no placeholder left": !pageHtml.includes("{{SITE_URL}}"),
    "og:url set": /property="og:url" content="https:\/\/example\.com\/opencode-intro\/"/.test(pageHtml),
    "twitter card": /name="twitter:card" content="summary_large_image"/.test(pageHtml),
    "dimensions": /og:image:width" content="1200"/.test(pageHtml) && /og:image:height" content="630"/.test(pageHtml),
    "CTA to juejin": /href="https:\/\/juejin\.cn\/post\/7690398241330544666"/.test(pageHtml),
    // the <img src> is absolute (naive scrapers do not resolve relative URLs)
    // and must end with the member name the zip actually contains
    "img tag matches og:image": new RegExp('<img src="https://[^"]*' + pngName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + '"').test(pageHtml)
  };
  for (const [k, v] of Object.entries(metaChecks)) {
    console.log((v ? "  ok   " : "  FAIL ") + "  " + k);
  }
  const pngOk = png.readUInt32BE(16) === 1200 && png.readUInt32BE(20) === 630;
  console.log((pngOk ? "  ok   " : "  FAIL ") + "  bundled PNG is " + png.readUInt32BE(16) + "x" + png.readUInt32BE(20) +
    " (" + (png.length / 1024).toFixed(0) + "KB)");

  // The page references its image by absolute URL, so the site origin is
  // intercepted and served from the extracted bundle: hermetic, and it also
  // proves the absolute URL maps onto a file that actually exists. The origin
  // comes from the page itself (this suite uses a fake site address).
  const sitePrefix = (pageHtml.match(/property="og:image" content="(.*?)\/og\/[^"]*"/) || [])[1] + "/";
  if (!sitePrefix || sitePrefix === "undefined/") throw new Error("could not derive site prefix from og:image");
  const deployed = await browser.newPage();
  const depErrors = [];
  const missing = [];
  deployed.on("pageerror", (e) => depErrors.push(e.message));
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  await deployed.route(new RegExp("^" + esc(sitePrefix)), (route) => {
    const rel = decodeURIComponent(new URL(route.request().url()).pathname).replace(sitePrefix.replace(/^https?:\/\/[^/]+/, ""), "");
    const f = path.join(extracted, rel);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      route.fulfill({
        status: 200,
        contentType: rel.endsWith(".png") ? "image/png" : "text/html; charset=utf-8",
        body: fs.readFileSync(f)
      });
    } else {
      missing.push(rel);
      route.fulfill({ status: 404, body: "not found" });
    }
  });
  await deployed.goto("file://" + path.join(extracted, "index.html"), { waitUntil: "load" });
  await deployed.evaluate(() => document.fonts.ready);
  const depInfo = await deployed.evaluate(() => {
    const img = document.querySelector(".card img");
    return {
      loaded: img.complete && img.naturalWidth > 0,
      natural: [img.naturalWidth, img.naturalHeight],
      src: img.getAttribute("src"),
      ogImage: (document.querySelector('meta[property="og:image"]') || {}).content
    };
  });
  console.log((depInfo.loaded && depInfo.natural[0] === 1200 && missing.length === 0 ? "  ok   " : "  FAIL ") +
    "  deployed page renders, absolute hero image resolves " + depInfo.natural.join("x"));
  if (missing.length) console.log("  FAIL  absolute URL 404s: " + missing.join(", "));
  console.log("         img src  → " + depInfo.src);
  console.log("         og:image → " + depInfo.ogImage);
  if (depErrors.length) console.log("  FAIL  deployed page errors: " + depErrors.join("; "));
  await deployed.screenshot({ path: path.join(OUT, "_deployed.png") });
  await deployed.close();

  const bundleOk = zipOk && Object.values(metaChecks).every(Boolean) && pngOk && depInfo.loaded && !depErrors.length && !missing.length;

  console.log("\n=== card preview panel ===");
  const pv = await page.evaluate(() => {
    const a = document.getElementById("previewA");
    const g = a.getContext("2d", { willReadFrequently: true });
    const d = g.getImageData(0, 0, a.width, a.height).data;
    const bg = [d[0], d[1], d[2]];
    let n = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (Math.abs(d[i] - bg[0]) + Math.abs(d[i + 1] - bg[1]) + Math.abs(d[i + 2] - bg[2]) > 24) n++;
    }
    return {
      ink: n,
      titleA: document.getElementById("pvTitleA").textContent,
      domainA: document.getElementById("pvDomainA").textContent,
      descB: document.getElementById("pvDescB").textContent
    };
  });
  const pvOk = pv.ink > 500 && pv.titleA.length > 0 && /example\.com/.test(pv.domainA);
  console.log((pvOk ? "  ok   " : "  FAIL ") + "previews mirror the canvas (ink=" + pv.ink + ")");
  console.log("         title: " + pv.titleA);
  console.log("         domain: " + pv.domainA);
  console.log("         wx desc: " + pv.descB);

  console.log("\n=== meta snippet sample ===");
  console.log(results[0].info.snippet);

  console.log("\n=== console errors ===");
  console.log(errors.length ? errors.join("\n") : "  none");

  const failed = results.filter((r) => !r.ok).length + (errors.length ? 1 : 0) + (exportOk ? 0 : 1) + (restoreOk ? 0 : 1) + (bundleOk ? 0 : 1) + (pvOk ? 0 : 1);
  console.log(failed ? "\n" + failed + " PROBLEM(S)" : "\nall rendered clean");
  await browser.close();
  process.exit(failed ? 1 : 0);
})();
