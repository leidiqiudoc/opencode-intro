// Generates the deployable card into ./docs by driving the real page in
// Chromium and clicking the actual "下载发布包" button, so the artifact is
// produced by the same code path a user would use.
//
// ./docs because GitHub Pages only offers "/" and "/docs" as a publishing
// source; "/docs" is served at the repo root path, so og:image stays
// https://<user>.github.io/<repo>/og/<slug>.png
const { chromium } = require("playwright-core");
const { execFileSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const ROOT = __dirname;
const OUT = path.join(ROOT, "docs");
const SITE = "https://leidiqiudoc.github.io/opencode-intro/";

(async () => {
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage({ viewport: { width: 1520, height: 1200 } });
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("dialog", async (d) => { console.log("  [dialog] " + d.message().split("\n")[0]); await d.accept(); });

  await page.goto("file://" + path.join(ROOT, "index.html"), { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);

  // default card content = PRESETS[0] ("OpenCode 简介"); just set the site URL
  await page.fill("#siteUrl", SITE);
  await page.waitForTimeout(300);

  const state = await page.evaluate(() => ({
    title: document.getElementById("title").value,
    subtitle: document.getElementById("subtitle").value,
    author: document.getElementById("author").value,
    hint: document.getElementById("siteUrlHint").textContent,
    status: document.getElementById("status").textContent
  }));
  console.log("  title: " + state.title);
  console.log("  sub:   " + state.subtitle);
  console.log("  hint:  " + state.hint);
  if (!/✓/.test(state.hint)) throw new Error("site URL not accepted: " + state.hint);

  const dl = await Promise.all([
    page.waitForEvent("download"),
    page.click("#downloadBundle")
  ]).then((r) => r[0]);

  const tmpZip = path.join(ROOT, ".render", "card.zip");
  fs.mkdirSync(path.dirname(tmpZip), { recursive: true });
  await dl.saveAs(tmpZip);

  // extract into docs/
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
  const py = `
import zipfile, sys, json
z = zipfile.ZipFile(sys.argv[1])
bad = z.testzip()
z.extractall(sys.argv[2])
print(json.dumps({"crc_ok": bad is None, "names": [i.filename for i in z.infolist()]}))
`;
  const info = JSON.parse(execFileSync("python3", ["-c", py, tmpZip, OUT], { encoding: "utf8" }));
  if (!info.crc_ok) throw new Error("zip CRC failure");
  console.log("  extracted: " + info.names.join("  |  "));

  // bypass Jekyll: it can mangle non-ASCII paths and is not needed here
  fs.writeFileSync(path.join(OUT, ".nojekyll"), "");

  await browser.close();
  if (errs.length) { console.error("page errors: " + errs.join("; ")); process.exit(1); }
  console.log("  done -> " + path.relative(ROOT, OUT));
})();
