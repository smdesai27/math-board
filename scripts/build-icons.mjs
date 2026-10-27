/**
 * Build the offline science icon library from Bioicons (https://bioicons.com,
 * https://github.com/duerrsimon/bioicons). Icons are individually licensed;
 * we keep CC0, CC-BY 3.0/4.0, MIT and BSD (no share-alike) and record author +
 * license for every icon in public/icons/CREDITS.md.
 *
 * Each SVG is normalized to the board's safe subset: editor metadata, filters,
 * raster images, foreignObject, scripts and external references are removed,
 * unknown attributes are dropped, and the result must pass checkSvgSource()
 * (the same validator used for model-authored SVG). Icons that cannot be made
 * safe, or are larger than MAX_BYTES, are skipped.
 *
 *   node scripts/build-icons.mjs            # download + build (network)
 *   node scripts/build-icons.mjs --cached   # reuse .icon-cache/ downloads
 */
import { mkdir, readFile, writeFile, rm, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.PI_MATH_BOARD_DATA_DIR ??= "/tmp/math-board-icon-build";
const root = fileURLToPath(new URL("../", import.meta.url));
const { checkSvgSource, SVG_TAGS, SVG_ATTRS } = await import(path.join(root, "server.mjs"));

const REPO = "duerrsimon/bioicons";
const LICENSES = new Set(["cc-0", "cc-by-3.0", "cc-by-4.0", "mit", "bsd"]);
const SKIP_CATEGORIES = new Set(["Machine_Learning", "Computer_hardware", "Chemo-_and_Bioinformatics", "Safety_symbols"]);
const MAX_BYTES = 128 * 1024;
const OUT = path.join(root, "public", "icons");
const CACHE = path.join(root, ".icon-cache");
const cached = process.argv.includes("--cached");

// Elements dropped together with their whole subtree.
const DROP_SUBTREE = /^(metadata|title|desc|filter|foreignObject|image|script|switch|a|font|font-face|missing-glyph|glyph|style|cursor|view|animate|animateTransform|animateMotion|set|mpath)$|:/;
const KEEP = new Set([...SVG_TAGS].filter((t) => !["animate", "animateTransform", "animateMotion", "set", "mpath", "style", "title", "desc"].includes(t)));

function cleanStyle(value) {
  // Keep plain presentation declarations; drop anything referencing filters or external URLs.
  return value
    .split(";")
    .map((d) => d.trim())
    .filter((d) => d && /^[a-z-]+\s*:/.test(d) && !/^(filter|-inkscape|font-variation|mix-blend)/i.test(d))
    .filter((d) => !/url\s*\(/i.test(d) || /url\s*\(\s*['"]?#[A-Za-z_][\w.-]*['"]?\s*\)/i.test(d))
    .filter((d) => !/expression|javascript:|data:|@import/i.test(d))
    .join(";");
}

/**
 * Parse simple CSS rules from <style> blocks (".cls-1{fill:#f00}", "path{…}",
 * ".a,.b{…}") so they can be inlined: style elements and classes are dropped.
 */
function cssRules(src) {
  const byClass = new Map(), byTag = new Map();
  const css = [...src.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n")
    .replace(/<!\[CDATA\[|\]\]>/g, "").replace(/\/\*[\s\S]*?\*\//g, "");
  for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls = cleanStyle(m[2]);
    if (!decls) continue;
    for (const sel of m[1].split(",").map((x) => x.trim())) {
      if (/^\.[\w-]+$/.test(sel)) byClass.set(sel.slice(1), [byClass.get(sel.slice(1)), decls].filter(Boolean).join(";"));
      else if (/^[a-zA-Z]+$/.test(sel)) byTag.set(sel, [byTag.get(sel), decls].filter(Boolean).join(";"));
    }
  }
  return { byClass, byTag };
}

/** Normalize one SVG to the safe subset (or throw). */
export function normalizeIcon(src) {
  if (/<!ENTITY/i.test(src)) throw new Error("entities");
  const css = cssRules(src);
  let s = src.replace(/<\?xml[^>]*\?>/g, "").replace(/<!DOCTYPE[^>]*>/gi, "").replace(/<!--[\s\S]*?-->/g, "").replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, "");
  const out = [];
  let skipDepth = 0, rootSeen = false, viewBox = null;
  const re = /<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>|([^<]+)/g;
  for (const m of s.matchAll(re)) {
    const [, closing, tag, attrs = "", selfClose, text] = m;
    if (text !== undefined) { if (!skipDepth) out.push(text.replace(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-f]+);)/gi, "&amp;")); continue; }
    if (skipDepth) {
      if (!selfClose) skipDepth += closing ? -1 : 1;
      continue;
    }
    if (DROP_SUBTREE.test(tag) || !KEEP.has(tag)) { if (!closing && !selfClose) skipDepth = 1; continue; }
    if (closing) { out.push(`</${tag}>`); continue; }
    const kept = [];
    // Inline CSS: tag rules, then class rules, then the element's own style wins.
    const classes = (/\sclass\s*=\s*["']([^"']*)["']/.exec(attrs)?.[1] ?? "").split(/\s+/).filter(Boolean);
    const inherited = [css.byTag.get(tag), ...classes.map((c) => css.byClass.get(c))].filter(Boolean).join(";");
    let ownStyle = "";
    for (const a of attrs.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g)) {
      let [, name, quoted] = a;
      let value = quoted.slice(1, -1);
      if (name === "xlink:href") name = "href";
      if (!SVG_ATTRS.has(name) || /^on/i.test(name) || name === "class") continue;
      if (name === "href" && !/^#[A-Za-z_][\w.-]*$/.test(value)) continue;
      if (name === "style") { ownStyle = cleanStyle(value); continue; }
      if (/url\s*\(/i.test(value) && !/^url\s*\(\s*['"]?#[A-Za-z_][\w.-]*['"]?\s*\)$/i.test(value.trim())) continue;
      if (/javascript:|data:/i.test(value)) continue;
      if (tag === "svg" && !rootSeen) {
        if (name === "viewBox") viewBox = value;
        if (["width", "height", "x", "y", "version", "xmlns:xlink"].includes(name)) continue;
      }
      kept.push(`${name}="${value.replace(/"/g, "&quot;")}"`);
    }
    const style = [inherited, ownStyle].filter(Boolean).join(";");
    if (style) kept.push(`style="${style.replace(/"/g, "'")}"`);
    if (tag === "svg" && !rootSeen) {
      rootSeen = true;
      if (!viewBox) {
        const w = parseFloat(/\swidth\s*=\s*["']([\d.]+)/.exec(attrs)?.[1]), h = parseFloat(/\sheight\s*=\s*["']([\d.]+)/.exec(attrs)?.[1]);
        if (!(w > 0 && h > 0)) throw new Error("no viewBox");
        viewBox = `0 0 ${w} ${h}`;
        kept.push(`viewBox="${viewBox}"`);
      }
      if (!kept.some((k) => k.startsWith("xmlns="))) kept.unshift('xmlns="http://www.w3.org/2000/svg"');
    }
    out.push(`<${tag}${kept.length ? " " + kept.join(" ") : ""}${selfClose ? "/" : ""}>`);
  }
  const svg = out.join("").replace(/\s{2,}/g, " ").trim();
  checkSvgSource(svg);
  if (Buffer.byteLength(svg) > MAX_BYTES) throw new Error("too large after cleanup");
  const [, , w, h] = viewBox.trim().split(/[\s,]+/).map(Number);
  if (!(w > 0 && h > 0)) throw new Error("bad viewBox");
  return { svg, w, h };
}

async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}

async function main() {
  await mkdir(CACHE, { recursive: true });
  const treeFile = path.join(CACHE, "tree.json");
  if (!cached || !existsSync(treeFile)) {
    const res = await fetch(`https://api.github.com/repos/${REPO}/git/trees/main?recursive=1`, { headers: { "User-Agent": "pi-math-board" } });
    if (!res.ok) throw new Error(`GitHub tree: HTTP ${res.status}`);
    await writeFile(treeFile, await res.text());
  }
  const tree = JSON.parse(await readFile(treeFile, "utf8")).tree;
  const wanted = tree.filter((t) => {
    const parts = t.path.split("/");
    return t.type === "blob" && t.path.startsWith("static/icons/") && t.path.endsWith(".svg") && parts.length === 6 &&
      LICENSES.has(parts[2]) && !SKIP_CATEGORIES.has(parts[3]) && t.size <= MAX_BYTES;
  });
  console.log(`${wanted.length} candidate icons`);
  let downloaded = 0;
  await pool(wanted, 24, async (t) => {
    const file = path.join(CACHE, t.sha + ".svg");
    if (existsSync(file)) return;
    const url = `https://raw.githubusercontent.com/${REPO}/main/${t.path.split("/").map(encodeURIComponent).join("/")}`;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { headers: { "User-Agent": "pi-math-board" } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await writeFile(file, Buffer.from(await res.arrayBuffer()));
        if (++downloaded % 200 === 0) console.log(`  downloaded ${downloaded}`);
        return;
      } catch (e) { if (attempt === 2) console.warn(`  failed ${t.path}: ${e.message}`); }
    }
  });

  await rm(OUT, { recursive: true, force: true });
  await mkdir(OUT, { recursive: true });
  const index = [], credits = [], skipped = {}, used = new Set();
  for (const t of wanted) {
    const [, , license, category, authorDir, fileName] = t.path.split("/");
    const file = path.join(CACHE, t.sha + ".svg");
    if (!existsSync(file)) { skipped.missing = (skipped.missing ?? 0) + 1; continue; }
    let icon;
    try { icon = normalizeIcon(await readFile(file, "utf8")); }
    catch (e) { const k = e.message.split(":")[0].slice(0, 40); skipped[k] = (skipped[k] ?? 0) + 1; continue; }
    const name = fileName.replace(/\.drawio/i, "").replace(/\.svg$/i, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
    let id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "icon";
    if (used.has(id)) { let n = 2; while (used.has(`${id}-${n}`)) n++; id = `${id}-${n}`; }
    used.add(id);
    const author = authorDir.replace(/^[A-Z]--/, "").replace(/[_-]+/g, " ").trim();
    await writeFile(path.join(OUT, `${id}.svg`), icon.svg);
    index.push({ id, name, category: category.replace(/[_-]+/g, " ").trim(), author, license, w: Math.round(icon.w * 100) / 100, h: Math.round(icon.h * 100) / 100 });
    credits.push(`| ${id} | ${name} | ${author} | ${license} | ${t.path.replace("static/icons/", "")} |`);
  }
  index.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  await writeFile(path.join(OUT, "index.json"), JSON.stringify(index));
  await writeFile(path.join(OUT, "CREDITS.md"), [
    "# Icon credits",
    "",
    "Icons from [Bioicons](https://bioicons.com) (https://github.com/duerrsimon/bioicons), normalized for safe display.",
    "Each icon keeps its original license: CC0 (public domain), CC-BY 3.0/4.0 (attribution required: credit the author below),",
    "MIT or BSD. See https://creativecommons.org/licenses/by/4.0/ and https://creativecommons.org/licenses/by/3.0/.",
    "",
    "| id | name | author | license | source path |",
    "|---|---|---|---|---|",
    ...credits.sort(),
    "",
  ].join("\n"));
  const bytes = (await Promise.all((await readdir(OUT)).map(async (f) => (await readFile(path.join(OUT, f))).length))).reduce((a, b) => a + b, 0);
  console.log(`built ${index.length} icons (${(bytes / 1e6).toFixed(1)} MB) into public/icons; skipped:`, skipped);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
