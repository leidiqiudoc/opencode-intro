// Serves ./docs over HTTP and asserts the deployed page is self-consistent:
// every asset the HTML references resolves, and og:image points at a real file.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright-core");

const ROOT = path.join(__dirname, "docs");
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
  console.log("serving ./docs at " + base + "\n");

  const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
  const ogImage = (html.match(/property="og:image" content="([^"]+)"/) || [])[1];
  const ogUrl = (html.match(/property="og:url" content="([^"]+)"/) || [])[1];
  const imgSrc = (html.match(/<img src="([^"]+)"/) || [])[1];
  const cta = (html.match(/class="cta" href="([^"]+)"/) || [])[1];
  // path the crawler fetches, relative to the site root
  const ogRel = ogImage && ogImage.startsWith(SITE) ? ogImage.slice(SITE.length) : null;

  check("og:image is absolute https", /^https:\/\//.test(ogImage || ""), ogImage);
  check("og:image points at the chosen site", (ogImage || "").startsWith(SITE), ogImage);
  check("og:url matches site root", ogUrl === SITE, ogUrl);
  // absolute, so scrapers that do not resolve relative URLs still find it
  check("og:image == <img src>", ogImage === imgSrc, imgSrc);
  check("<img src> is absolute", /^https:\/\//.test(imgSrc || ""), imgSrc);
  check("all asset paths are ASCII", /^[\x20-\x7e]+$/.test(ogRel || ""), ogRel);
  check("CTA links to the juejin article", /^https:\/\/juejin\.cn\/post\//.test(cta || ""), cta);
  check("no unresolved placeholder", !html.includes("{{SITE_URL}}"));
  check(".nojekyll present (bypasses Jekyll)", fs.existsSync(path.join(ROOT, ".nojekyll")));

  // og:image is the first tag a sequential scraper meets
  const headOrder = (html.match(/<meta property="og:image" content=/) || []).index;
  const firstProperty = html.search(/<meta property=/);
  check("og:image is the first property tag", headOrder >= 0 && headOrder === firstProperty, "offset " + headOrder);
  check("itemprop image present (schema.org)", /<meta itemprop="image"/.test(html));
  check("link rel=image_src present", /<link rel="image_src"/.test(html));

  // the file the meta points at must exist, byte for byte
  const onDisk = path.join(ROOT, ogRel || "");
  check("og:image file exists on disk", fs.existsSync(onDisk), path.relative(ROOT, onDisk));
  const buf = fs.readFileSync(onDisk);
  check("PNG is 1200x630", buf.readUInt32BE(16) === 1200 && buf.readUInt32BE(20) === 630,
    buf.readUInt32BE(16) + "x" + buf.readUInt32BE(20));
  check("PNG has a valid signature", buf.slice(1, 4).toString() === "PNG");

  // fetch it the way a crawler would
  const browser = await chromium.launch({ channel: "chromium" });
  const page = await browser.newPage();
  const errs = [];
  const missing = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("requestfailed", (r) => errs.push("requestfailed " + r.url()));
  // the page references its image absolutely, so serve the site origin from
  // ./docs: keeps the check hermetic and proves the absolute path exists
  await page.route(/^https:\/\/leidiqiudoc\.github\.io\//, (route) => {
    const p = decodeURIComponent(new URL(route.request().url()).pathname).replace(/^\/opencode-intro\//, "");
    const f = path.join(ROOT, p);
    if (fs.existsSync(f) && fs.statSync(f).isFile()) {
      route.fulfill({
        status: 200,
        contentType: p.endsWith(".png") ? "image/png" : "text/html; charset=utf-8",
        body: fs.readFileSync(f)
      });
    } else {
      missing.push(p);
      route.fulfill({ status: 404, body: "not found" });
    }
  });
  await page.goto(base, { waitUntil: "load" });
  await page.evaluate(() => document.fonts.ready);
  const info = await page.evaluate(() => {
    const i = document.querySelector(".card img");
    return { w: i.naturalWidth, h: i.naturalHeight, ok: i.complete && i.naturalWidth > 0, src: i.getAttribute("src") };
  });
  check("page loads with hero image", info.ok && info.w === 1200, info.w + "x" + info.h);
  check("img src is absolute", /^https:\/\//.test(info.src), info.src);
  check("absolute image URL resolves in ./docs", missing.length === 0, missing.join(", "));
  check("no page errors / failed requests", errs.length === 0, errs.join("; "));

  const rel = ogRel || "";
  const res = await new Promise((done) => {
    http.get(base + rel, (r) => { r.resume(); done(r); });
  });
  check("GET " + rel, res.statusCode === 200, "status " + res.statusCode);

  await page.screenshot({ path: ".render/_card-live.png", fullPage: true });
  await browser.close();
  server.close();

  console.log(fail ? "\n" + fail + " PROBLEM(S)" : "\ndocs/ is deployment-ready (Pages source: main + /docs)");
  process.exit(fail ? 1 : 0);
})();
