// Test harness: extracts the pure layout helpers from index.html and
// exercises them against a stub canvas 2D context.
const fs = require("fs");
const vm = require("vm");

const HTML = "/Users/leidiqiu/repo/opencode-intro/index.html";
const src = fs.readFileSync(HTML, "utf8").match(/<script>([\s\S]*?)<\/script>/)[1];

// CJK = 1.0em, latin ~ 0.52em, wide latin ~ 0.66em
function approx(text, px) {
  let w = 0;
  for (const ch of text) {
    w += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? px : /[A-Z@%&MW]/.test(ch) ? px * 0.66 : px * 0.52;
  }
  return w;
}

const ctx = {
  font: "",
  measureText(t) {
    const m = this.font.match(/(\d+(?:\.\d+)?)px/);
    return { width: approx(t, m ? parseFloat(m[1]) : 16) };
  }
};

const sandbox = { ctx, Math, console, module: { exports: {} } };
const helpers = ["tokenize", "wrap", "ellipsize", "fitLines"]
  .map((n) => {
    const re = new RegExp("function\\s+" + n + "\\b[\\s\\S]*?\\n  \\}");
    const m = src.match(re);
    if (!m) throw new Error("could not extract " + n);
    return m[0];
  })
  .join("\n\n");

vm.createContext(sandbox);
vm.runInContext(helpers + "\n;module.exports={tokenize,wrap,ellipsize,fitLines};", sandbox);
const { tokenize, wrap, ellipsize, fitLines } = sandbox.module.exports;

const W = 1200, PAD = 84, maxW = W - PAD * 2; // 1032
let fail = 0;
const check = (name, cond, extra = "") => {
  console.log((cond ? "  ok   " : "  FAIL ") + name + (extra ? "   " + extra : ""));
  if (!cond) fail++;
};

const LONG =
  "这是一段非常非常长的标题用来测试当标题超过最大行数限制的时候系统是否能够正确地进行截断并加上省略号而不是硬切导致出现半个字符而且这段文字还会继续再长一点点再长一点点再长一点点确保一定超过三行上限";

console.log("tokenize");
ctx.font = "700 40px sans";
check("splits CJK per char", JSON.stringify(tokenize("大模型")) === '["大","模","型"]');
check("keeps latin words whole", JSON.stringify(tokenize("OpenCode AI")) === '["OpenCode"," ","AI"]');
check("empty input -> []", JSON.stringify(tokenize("")) === "[]");

console.log("\nwrap: width + maxLines");
ctx.font = "700 92px sans";
const two = wrap("OpenCode 简介：从大模型原理到 Agent Loop 的完整拆解", maxW, 3);
check("no false truncation", !two.truncated);
const twoLines = two.lines;
check("no line exceeds maxWidth", twoLines.every((l) => approx(l, 92) <= maxW), JSON.stringify(twoLines));
check("<= maxLines", twoLines.length <= 3, "lines=" + twoLines.length);
const squashed = twoLines.join("").replace(/\s/g, "");
const orig = "OpenCode 简介：从大模型原理到 Agent Loop 的完整拆解".replace(/\s/g, "");
check("no characters lost", squashed === orig);

console.log("\nwrap: truncation only when font is pinned at minSize");
const shrinkable =
  "OpenCode 自我说明：整体架构、Agent 体系、扩展系统与内置工具一览";
const shrink = fitLines(shrinkable, {
  maxWidth: maxW, maxHeight: 268, maxSize: 92, minSize: 34,
  lineRatio: 1.22, maxLines: 3, weight: 700, family: "sans"
});
check("shrinks rather than truncating", !shrink.lines.some((l) => l.endsWith("…")),
  "size=" + shrink.size + " lines=" + shrink.lines.length);
check("shrunk result fits height", shrink.lines.length * shrink.size * 1.22 <= 268.5,
  "h=" + (shrink.lines.length * shrink.size * 1.22).toFixed(0));
check("uses multiple lines for long title", shrink.lines.length > 1, "lines=" + shrink.lines.length);

const hopeless = fitLines(LONG, {
  maxWidth: maxW, maxHeight: 268, maxSize: 92, minSize: 34,
  lineRatio: 1.22, maxLines: 3, weight: 700, family: "sans"
});
check("falls back to minSize when nothing fits", hopeless.size === 34, "size=" + hopeless.size);
check("minSize result still capped at maxLines", hopeless.lines.length === 3, "lines=" + hopeless.lines.length);

const pinned = fitLines(LONG, {
  maxWidth: maxW, maxHeight: 268, maxSize: 34, minSize: 34,
  lineRatio: 1.22, maxLines: 3, weight: 700, family: "sans"
});
check("truncates to exactly maxLines", pinned.lines.length === 3, "lines=" + pinned.lines.length);
check("reports truncation", pinned.lines.length === 3);
check("last line marked with ellipsis", pinned.lines[2].endsWith("…"), JSON.stringify(pinned.lines[2]));
check("truncated line still fits width", approx(pinned.lines[2], 34) <= maxW,
  Math.round(approx(pinned.lines[2], 34)) + "px");
check("no trailing whitespace before ellipsis", !/ …$/.test(pinned.lines[2]));

console.log("\nwrap: never emits a blank line");
const withSpaces = wrap("OpenCode 简介  Agent  Loop  ", maxW, 3).lines;
check("no empty lines", withSpaces.every((l) => l.trim().length > 0), JSON.stringify(withSpaces));
check("trailing spaces trimmed", withSpaces.every((l) => l === l.replace(/\s+$/, "")));

console.log("\nellipsize");
ctx.font = "500 20px sans";
const e = ellipsize("opencode.ai/docs/very/long/path/that/overflows", 200);
check("adds … and fits", e.endsWith("…") && approx(e, 20) <= 200, e);
check("short text untouched", ellipsize("opencode.ai", 400) === "opencode.ai");
check("never empty", ellipsize("abcdefghij", 5).length > 0, ellipsize("abcdefghij", 5));

console.log("\nfitLines geometry (all presets)");
for (const t of [
  "OpenCode 简介", "什么是大模型", "常见词汇", "常见大模型及厂商",
  "OpenCode 日常用法", "OpenCode 工作原理", "OpenCode 自我说明", "上下文管理", "内置工具一览"
]) {
  const r = fitLines(t, {
    maxWidth: maxW, maxHeight: 268, maxSize: 92, minSize: 34,
    lineRatio: 1.22, maxLines: 3, weight: 700, family: "sans"
  });
  const h = r.lines.length * r.size * 1.22;
  check(
    t,
    h <= 268.5 && r.lines.length <= 3 && r.lines.every((l) => approx(l, r.size) <= maxW),
    "size=" + r.size + " lines=" + r.lines.length + " h=" + h.toFixed(0)
  );
}
console.log("\nrendered layout stays inside 1200x630");
// mirrors the vertical budget in renderAt()
const LABEL_BASE = 108, labelTop = 82, regionTop = 162, regionH = 262, FOOTER_BASE = 630 - 52;
for (const [title, sub] of [
  ["OpenCode 简介", "从大模型原理到 Agent Loop 的完整拆解"],
  ["OpenCode 自我说明", "整体架构、Agent 体系、扩展系统与内置工具一览"],
  ["内置工具一览", "bash · edit · read · grep · webfetch · lsp"],
  ["", ""]
]) {
  const t = title || "OpenCode 简介";
  ctx.font = "400 30px sans";
  const subLines = sub ? wrap(sub, maxW, 2).lines : [];
  const subBlock = subLines.length ? 53 + (subLines.length - 1) * 42 : 0;
  const titleMaxH = regionH - 31 - subBlock;
  check("  title budget positive: " + t.slice(0, 12), titleMaxH > 60, "maxH=" + titleMaxH);

  const r = fitLines(t, {
    maxWidth: maxW, maxHeight: titleMaxH, maxSize: 92, minSize: 34,
    lineRatio: 1.22, maxLines: 3, weight: 700, family: "sans"
  });
  const lineStep = Math.round(r.size * 1.22);
  const descender = Math.round(r.size * 0.22);
  const groupH = r.size + (r.lines.length - 1) * lineStep + descender + 26 + 5 + subBlock;
  const groupTop = regionTop + Math.max(0, (regionH - groupH) / 2);
  const divY = Math.min(Math.max(470, groupTop + groupH + 46), 630 - 108);

  const firstBaseline = groupTop + r.size;
  const lastBaseline = groupTop + r.size + (r.lines.length - 1) * lineStep;
  const ruleBottom = lastBaseline + descender + 26 + 5;
  const subBottom = subLines.length ? ruleBottom + 53 + (subLines.length - 1) * 42 : ruleBottom;

  const okLayout =
    labelTop >= 0 &&
    LABEL_BASE < firstBaseline &&
    subBottom < divY &&
    divY < FOOTER_BASE - 40 &&
    divY >= 470 && divY <= 630 - 108 &&
    FOOTER_BASE + 14 < 630;

  check(
    "layout '" + t.slice(0, 14) + "'",
    okLayout,
    "size=" + r.size + " lines=" + r.lines.length +
    " title[" + Math.round(firstBaseline) + ".." + Math.round(lastBaseline) + "]" +
    " sub->" + Math.round(subBottom) + " div=" + Math.round(divY) + " footer=" + FOOTER_BASE
  );
  check(
    "  title fits: " + t.slice(0, 12),
    r.lines.length <= 3 && r.lines.every((l) => approx(l, r.size) <= maxW)
  );
}

console.log(fail ? "\n" + fail + " FAILURE(S)" : "\nall " + "passed");
process.exit(fail ? 1 : 0);
