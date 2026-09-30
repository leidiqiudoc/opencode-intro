// Serves ./card over HTTP and asserts the deployed page is self-consistent:
// every asset the HTML references resolves, and og:image points at a real file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "card");
const SITE = "https://leidiqiudoc.github.io/opencode-intro/";
const TYPES = { ".html": "text/html; charset=utf-8", ".png": "image/png" };

let fail = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split("?")[0]);
  const rel = url === "/" ? "index.html" : url.replace(/^\/+/, "");
  const file = path.join(ROOT, rel);
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end("not found"); return;
  }
  res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
  res.end(fs.readFileSync(file));
});

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = "http://127.0.0.1:" + server.address().port + "/";
  console.log("serving ./card at " + base + "\n");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const ogImage = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
  const ogUrl = (html.match(/property="og:url" content="([^"]+)"/) || [])[1];
  const imgSrc = (html.match(/<img src="([^"]+)"/) || [])[1];
  const cta = (html.match(/class="cta" href="([^"]+)"/) || [])[1];

  check("og:image is absolute https", /^https:\/\//.test(ogImage || ""), ogImage);
  check("og:image points at the chosen site", (ogImage || "").startsWith(SITE), ogImage);
  check("og:url matches site root", ogUrl === SITE, ogUrl);
  check("og:image path == <img src>", ogImage === SITE + imgSrc, SITE + imgSrc);
  check("all asset paths are ASCII", /^[\x20-\x7e]+$/.test(imgSrc), imgSrc);
  check("CTA links to the juejin article", /^https:\/\/juejin\.cn\/post\//.test(cta || ""), cta);
  check("no unresolved placeholder", !html.includes("{{SITE_URL}}"));
  check(".nojekyll present (bypasses Jekyll)", fs.existsSync(path.join(ROOT, ".nojekyll")));

  // the file the meta points at must exist, byte for byte
  const onDisk = path.join(ROOT, imgSrc);
  check("og:image file exists on disk", fs.existsSync(onDisk), path.relative(ROOT, onDisk));
  const buf = fs.readFileSync(onDisk);
  check("PNG is 1200x630", buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630,
    buf.readUInt32BE(16) + "x" + buf.readUInt32BE(20));
  check("PNG has a valid signature", buf.slice(1, 4).toString() === "PNG");

  // fetch it the way a crawler would
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("requestfailed", (r) => errs.push("requestfailed " + r.url()));
  await page.goto(base, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const info = await page.evaluate(() => {
    const i = document.querySelector(".card img");
    return { w: i.naturalWidth, h: i.naturalHeight, ok: i.complete && i.naturalWidth > 0 };
  });
  check("page loads with hero image", info.ok && info.w === 1200, info.w + "x" + info.h);
  check("no page errors / failed requests", errs.length === 0, errs.join("; "));

  // the crawler-visible URL must 200
  const rel = ogImage.slice(SITE.length);
  const res = await new Promise((done) => {
    http.get(base + rel, (r) => { r.resume(); done(r); });
  });
  check("GET " + rel, res.statusCode === 200, "status " + res.statusCode);

  await page.screenshot({ path: ".render/_card-live.png", fullPage: true });
  await browser.close();
  server.close();

  console.log(fail ? "\n" + fail + " PROBLEM(S)" : "\ncard is deployment-ready");
  process.exit(fail ? 1 : 0);
})();
