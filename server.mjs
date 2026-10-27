/**
 * Math Board server — loopback-only HTTP server backing the Pi `math-board`
 * extension. Serves the locally bundled browser app (no runtime CDN), a
 * JSON sync API used by both the browser and the in-process model tools,
 * and an SSE stream for live updates.
 *
 * Security model:
 *  - Listens on 127.0.0.1 only (loopback). Never on 0.0.0.0.
 *  - Every API request must carry `Authorization: Bearer <token>` where
 *    <token> is a per-session random secret (32 bytes hex).
 *  - `Host` header must be a loopback host (DNS-rebinding protection).
 *  - When an `Origin` header is present it must match the loopback origin.
 *  - Request bodies are bounded (512 KiB) and validated before use.
 *  - Static file serving uses an explicit allow-list (no path traversal).
 *  - No `eval`, no `innerHTML` with untrusted content anywhere; scene data
 *    is plain JSON rendered with canvas / DOM text nodes only.
 */

import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  readdir,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
// Forward this module's cache-busting query (see index.ts) to sibling modules.
const VERSION_QUERY = new URL(import.meta.url).search;
const { sanitizeElements } = await import(new URL(`./scene.mjs${VERSION_QUERY}`, import.meta.url).href);
const { Snapshotter } = await import(new URL(`./snapshot.mjs${VERSION_QUERY}`, import.meta.url).href);
const { compileExpr } = await import(new URL(`./shared/expr.mjs${VERSION_QUERY}`, import.meta.url).href);
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, platform } from "node:os";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* Detect a running server whose source files were edited after it loaded. */
// public/ assets are read from disk per request, so only server code matters.
const WATCHED_SOURCES = ["server.mjs", "scene.mjs", "snapshot.mjs", "shared/expr.mjs", "index.ts"];
function sourceStamp() {
  return Object.fromEntries(WATCHED_SOURCES.map((f) => {
    try { return [f, statSync(path.join(__dirname, f)).mtimeMs]; } catch { return [f, 0]; }
  }));
}
export const LOADED_SOURCE_STAMP = sourceStamp();
/** Files changed on disk since this module loaded (empty when current). */
export function staleSources() {
  const now = sourceStamp();
  return WATCHED_SOURCES.filter((f) => now[f] > LOADED_SOURCE_STAMP[f] + 1);
}

export const MAX_BODY_BYTES = 512 * 1024;
export const MAX_SHAPES = 5000;
export const MAX_EQUATIONS = 1000;
export const MAX_CHAPTERS = 200;
// Whole-board size (long lessons with many SVGs). HTTP request bodies stay capped at MAX_BODY_BYTES.
export const MAX_BOARD_BYTES = 6 * 1024 * 1024;
export const CHAPTER = { w: 1200, h: 800, gap: 240 };
export const MAX_POINTS_PER_STROKE = 4000;
export const MAX_ARTIFACT_BYTES = 128 * 1024;
// SVG artifacts are displayed through an <image> data URI, where browsers never
// run scripts or fetch external resources. The allowlist is defense in depth and
// is broad enough for real teaching diagrams (markers, gradients, symbols, CSS).
export const SVG_TAGS = new Set([
  "svg", "g", "defs", "symbol", "use", "title", "desc", "style",
  "rect", "circle", "ellipse", "line", "polyline", "polygon", "path",
  "text", "tspan", "textPath",
  "marker", "linearGradient", "radialGradient", "stop", "pattern", "clipPath", "mask",
  // SMIL animation runs inside SVG images without scripts.
  "animate", "animateTransform", "animateMotion", "mpath", "set",
]);
export const SVG_ATTRS = new Set([
  "xmlns", "xmlns:xlink", "version", "id", "class", "style", "width", "height", "viewBox", "preserveAspectRatio",
  "x", "y", "x1", "y1", "x2", "y2", "cx", "cy", "r", "rx", "ry", "fx", "fy", "fr", "dx", "dy", "d", "points", "pathLength",
  "transform", "opacity", "visibility", "display",
  "fill", "fill-opacity", "fill-rule", "clip-rule", "clip-path", "mask",
  "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "stroke-dashoffset", "stroke-opacity", "stroke-miterlimit", "vector-effect",
  "font-family", "font-size", "font-weight", "font-style", "font-variant", "text-anchor", "dominant-baseline", "alignment-baseline", "baseline-shift", "letter-spacing", "word-spacing", "text-decoration", "textLength", "lengthAdjust", "rotate", "startOffset", "writing-mode",
  "marker-start", "marker-mid", "marker-end", "markerWidth", "markerHeight", "markerUnits", "refX", "refY", "orient",
  "offset", "stop-color", "stop-opacity", "gradientUnits", "gradientTransform", "spreadMethod",
  "patternUnits", "patternContentUnits", "patternTransform", "clipPathUnits", "maskUnits", "maskContentUnits",
  "href", "xlink:href", "color",
  "attributeName", "attributeType", "from", "to", "by", "values", "dur", "begin", "end", "repeatCount", "repeatDur", "restart",
  "keyTimes", "keySplines", "keyPoints", "calcMode", "additive", "accumulate", "type", "path", "min", "max",
]);
/** Throw a descriptive error if an SVG document is outside the safe subset. */
export function checkSvgSource(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_ARTIFACT_BYTES) throw new Error("SVG source must be a string of at most 128 KiB");
  if (!/^\s*(<\?xml[^>]*\?>\s*)?<svg\b/i.test(source) || !/<\/svg>\s*$/i.test(source)) throw new Error("malformed SVG document: must start with <svg and end with </svg>");
  const banned = /<!DOCTYPE|<!ENTITY|<script|<foreignObject|<image|<iframe|<object|<embed/i.exec(source);
  if (banned) throw new Error(`unsafe SVG content: ${banned[0]}`);
  // Content checks apply to markup (tags, attributes) and CSS, not to visible
  // text, so a label like "see url(x)" or "data: 5" is fine.
  const markup = source.replace(/>[^<]*</g, "><");
  const styles = [...source.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map((m) => m[1]).join("\n");
  const code = markup + "\n" + styles;
  const scheme = /javascript:|vbscript:|data:|@import|expression\s*\(/i.exec(code);
  if (scheme) throw new Error(`unsafe SVG content: ${scheme[0]}`);
  // url() may only reference fragments inside the same document: url(#id).
  for (const m of code.matchAll(/url\s*\(\s*(['"]?)([^)'"]*)\1\s*\)/gi))
    if (!/^#[A-Za-z_][\w.-]*$/.test(m[2])) throw new Error(`unsafe SVG url(): only url(#id) is allowed, got url(${m[2]})`);
  // Walk real tags only (not text content), so "x = 5" inside <text> is fine.
  const body = source.replace(/<\?xml[^>]*\?>/, "").replace(/<!--[\s\S]*?-->/g, "").replace(/(<style\b[^>]*>)[\s\S]*?(<\/style>)/gi, "$1$2");
  let tags = 0;
  for (const m of body.matchAll(/<(\/?)([A-Za-z][\w:.-]*)((?:[^>"']|"[^"]*"|'[^']*')*)>/g)) {
    tags++;
    const [, closing, tag, rest] = m;
    if (!SVG_TAGS.has(tag)) throw new Error(`unsupported SVG element <${tag}>. Allowed: ${[...SVG_TAGS].join(", ")}`);
    if (closing) continue;
    // Every attribute must be quoted; unquoted values would bypass the walk below.
    if (/=/.test(rest.replace(/([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g, "")))
      throw new Error(`unquoted or malformed attribute on <${tag}>: quote every attribute value`);
    for (const a of rest.matchAll(/([A-Za-z_:][\w:.-]*)\s*=\s*("[^"]*"|'[^']*')/g)) {
      const [, attr, quoted] = a;
      if (/^on/i.test(attr)) throw new Error(`unsafe SVG attribute ${attr} on <${tag}>`);
      if (!SVG_ATTRS.has(attr)) throw new Error(`unsupported SVG attribute "${attr}" on <${tag}>`);
      if ((attr === "href" || attr === "xlink:href") && !/^#[A-Za-z_][\w.-]*$/.test(quoted.slice(1, -1)))
        throw new Error(`unsafe SVG ${attr} on <${tag}>: only #id references are allowed`);
      if (attr === "attributeName" && /href/i.test(quoted))
        throw new Error(`unsafe SVG animation of ${quoted} on <${tag}>`);
    }
  }
  if (!tags) throw new Error("malformed SVG document");
  // An SVG shown via an image data URI renders nothing without its namespace.
  return /<svg\b[^>]*\sxmlns\s*=/.test(source)
    ? source
    : source.replace(/<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
}
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};
const SHAPE_TYPES = new Set([
  "stroke",
  "rect",
  "ellipse",
  "line",
  "arrow",
  "text",
]);
const SAVE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
const JSON_BODY_LIMIT_BYTES = MAX_BODY_BYTES;

function defaultDataDir() {
  // Tests and scripts point this elsewhere so they never touch real saves/autosave.
  if (process.env.PI_MATH_BOARD_DATA_DIR) return process.env.PI_MATH_BOARD_DATA_DIR;
  // Keep saves under the extension's own directory, not global config.
  return path.join(
    homedir(),
    ".pi",
    "agent",
    "extensions",
    "math-board",
    ".data",
  );
}

function nowIso() {
  return new Date().toISOString();
}

/** Deep-clone plain JSON data. */
function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

export function emptyBoard(title = "Pi Blackboard") {
  return {
    title,
    equations: [],
    scene: { shapes: [], elements: [], artifacts: [] },
    chapters: [],
    camera: null,
    lastStep: 0,
    updatedAt: nowIso(),
  };
}

const ID = (v) => (typeof v === "string" && v.length > 0 && v.length <= 64 ? v : undefined);
export const REVEALS = ["draw", "write", "wipe", "fade", "none"];

/** Animation fields shared by every item kind (see browser playback). */
function sanitizeAnimation(raw, out) {
  if (Number.isInteger(raw.step) && raw.step >= 0) out.step = Math.min(raw.step, 1e6);
  if (REVEALS.includes(raw.reveal)) out.reveal = raw.reveal;
  if (Number.isFinite(raw.duration)) out.duration = Math.max(0, Math.min(10000, Math.round(raw.duration)));
  if (Number.isFinite(raw.order)) out.order = Math.max(-1e6, Math.min(1e6, raw.order));
  return out;
}

/** A chapter is a named board region; items with `chapter` use coordinates relative to its origin. */
export function sanitizeChapter(raw) {
  if (!raw || typeof raw !== "object") return null;
  const out = {
    id: ID(raw.id) ?? randomUUID(),
    title: typeof raw.title === "string" ? raw.title.slice(0, 120) : "",
    x: NUMBER(raw.x),
    y: NUMBER(raw.y),
    w: Math.max(200, Math.min(20000, NUMBER(raw.w) || CHAPTER.w)),
    h: Math.max(150, Math.min(20000, NUMBER(raw.h) || CHAPTER.h)),
  };
  if (raw.frame === false) out.frame = false;
  return out;
}

/** Camera = what following viewers see: a chapter, an explicit rect, or null (home). */
export function sanitizeCamera(raw, chapters = []) {
  if (raw === null || raw === undefined || raw === "home") return null;
  if (typeof raw !== "object") throw new Error("camera must be {chapter}, {x,y,w,h} or null");
  if (raw.chapter !== undefined) {
    if (!chapters.some((c) => c.id === raw.chapter)) throw new Error(`camera: unknown chapter "${raw.chapter}"`);
    return { chapter: raw.chapter };
  }
  const w = NUMBER(raw.w), h = NUMBER(raw.h);
  if (!(w > 0 && h > 0)) throw new Error("camera rect needs positive w and h");
  return { x: NUMBER(raw.x), y: NUMBER(raw.y), w, h };
}

/** Board-space rect a camera resolves to (null = home 1200x800). */
export function cameraRect(board) {
  const cam = board.camera;
  if (!cam) return { x: 0, y: 0, w: CHAPTER.w, h: CHAPTER.h };
  if (cam.chapter) {
    const c = (board.chapters ?? []).find((ch) => ch.id === cam.chapter);
    if (c) return { x: c.x, y: c.y, w: c.w, h: c.h };
    return { x: 0, y: 0, w: CHAPTER.w, h: CHAPTER.h };
  }
  return { x: cam.x, y: cam.y, w: cam.w, h: cam.h };
}

/* ------------------------------------------------------------------ */
/* Validation helpers (shared by HTTP routes and in-process tools)    */
/* ------------------------------------------------------------------ */

export function sanitizeEquation(eq) {
  if (!eq || typeof eq !== "object") return null;
  const latex =
    typeof eq.latex === "string" ? eq.latex.slice(0, 4000) : undefined;
  if (latex === undefined || latex.trim() === "") return null;
  const out = {
    id: typeof eq.id === "string" && eq.id.length <= 64 ? eq.id : randomUUID(),
    latex,
  };
  if (typeof eq.label === "string") out.label = eq.label.slice(0, 200);
  if (typeof eq.color === "string") out.color = eq.color.slice(0, 32);
  // Optional font scale relative to the default display size (1 = default).
  if (Number.isFinite(eq.size)) out.size = Math.max(0.3, Math.min(4, eq.size));
  // Optional board-space placement; missing coordinates retain automatic layout.
  if (Number.isFinite(eq.x)) out.x = NUMBER(eq.x);
  if (Number.isFinite(eq.y)) out.y = NUMBER(eq.y);
  if (typeof eq.pinned === "boolean") out.pinned = eq.pinned;
  if (Number.isFinite(eq.z)) out.z = Math.max(-1000, Math.min(1000, eq.z));
  if (ID(eq.chapter)) out.chapter = eq.chapter;
  sanitizeAnimation(eq, out);
  out.createdAt = typeof eq.createdAt === "string" ? eq.createdAt : nowIso();
  return out;
}

const NUMBER = (v) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.max(-1e6, Math.min(1e6, v))
    : 0;

export const ARTIFACT_TYPES = ["svg", "mermaid", "plot", "molecule", "icon"];

/* Offline science icon library (built by scripts/build-icons.mjs from Bioicons). */
let ICONS = null;
export function iconIndex() {
  if (!ICONS) {
    try { ICONS = new Map(JSON.parse(readFileSync(path.join(__dirname, "public", "icons", "index.json"), "utf8")).map((i) => [i.id, i])); }
    catch { ICONS = new Map(); }
  }
  return ICONS;
}
/** Keyword search over icon names/categories (all words must match somewhere). */
export function searchIcons(query = "", { category, limit = 25 } = {}) {
  const words = String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const cat = category ? String(category).toLowerCase() : null;
  const scored = [];
  for (const icon of iconIndex().values()) {
    if (cat && !icon.category.toLowerCase().includes(cat)) continue;
    const name = icon.name.toLowerCase(), hay = `${icon.id} ${name} ${icon.category.toLowerCase()}`;
    if (!words.every((w) => hay.includes(w))) continue;
    let score = 0;
    for (const w of words) score += (icon.id === w ? 10 : 0) + (new RegExp(`\\b${w}`).test(name) ? 4 : 0) + (name.includes(w) ? 2 : 0) + (icon.category.toLowerCase().includes(w) ? 1 : 0);
    scored.push([score - name.length / 100, icon]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, Math.max(1, Math.min(100, limit))).map(([, i]) => i);
}
const COLOR = (v) => (typeof v === "string" && v.length <= 32 && !/[;{}<>]|url\s*\(/i.test(v) ? v : undefined);
const LABEL = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : undefined);
function range(v, name, fallback) {
  if (v === undefined) return fallback;
  if (!Array.isArray(v) || v.length !== 2 || !v.every(Number.isFinite) || !(v[1] > v[0])) throw new Error(`plot ${name} must be [min, max] with min < max`);
  return [NUMBER(v[0]), NUMBER(v[1])];
}
function checkExpr(src, vars, where) {
  try { compileExpr(src, vars); return src; } catch (e) { throw new Error(`plot ${where}: "${String(src).slice(0, 60)}": ${e.message}`); }
}
/** Declarative function plot. Expressions are parsed by shared/expr.mjs (no eval). */
function sanitizePlot(raw) {
  const out = {};
  out.xRange = range(raw.xRange, "xRange", [-10, 10]);
  const yr = range(raw.yRange, "yRange", undefined);
  if (yr) out.yRange = yr;
  for (const k of ["grid", "axes", "ticks"]) if (raw[k] === false) out[k] = false;
  if (raw.equalAspect === true) out.equalAspect = true;
  for (const k of ["xLabel", "yLabel", "title"]) { const v = LABEL(raw[k], 60); if (v) out[k] = v; }
  const list = (v, max, name) => { if (v === undefined) return []; if (!Array.isArray(v)) throw new Error(`plot ${name} must be an array`); if (v.length > max) throw new Error(`plot ${name}: at most ${max}`); return v; };
  const style = (f) => { const o = {}; const c = COLOR(f.color); if (c) o.color = c; if (Number.isFinite(f.width)) o.width = Math.max(0.5, Math.min(12, f.width)); if (typeof f.dash === "string" && /^[\d.\s,]{1,40}$/.test(f.dash)) o.dash = f.dash; const l = LABEL(f.label); if (l) o.label = l; return o; };
  out.functions = list(raw.functions, 12, "functions").map((f, i) => ({ expr: checkExpr(f?.expr, ["x"], `functions[${i}]`), ...style(f), ...(f.domain ? { domain: range(f.domain, `functions[${i}].domain`) } : {}) }));
  out.parametric = list(raw.parametric, 8, "parametric").map((f, i) => ({ x: checkExpr(f?.x, ["t"], `parametric[${i}].x`), y: checkExpr(f?.y, ["t"], `parametric[${i}].y`), t: range(f.t, `parametric[${i}].t`, [0, 2 * Math.PI]), ...style(f) }));
  out.areas = list(raw.areas, 6, "areas").map((a, i) => ({ expr: checkExpr(a?.expr, ["x"], `areas[${i}]`), ...(a.lower !== undefined ? { lower: checkExpr(a.lower, ["x"], `areas[${i}].lower`) } : {}), from: NUMBER(a.from), to: NUMBER(a.to), ...style(a) }));
  out.points = list(raw.points, 200, "points").map((pt) => ({ x: NUMBER(pt?.x), y: NUMBER(pt?.y), ...style(pt), ...(Number.isFinite(pt?.size) ? { size: Math.max(1, Math.min(20, pt.size)) } : {}) }));
  out.vlines = list(raw.vlines, 12, "vlines").map((v) => ({ x: NUMBER(v?.x), ...style(v) }));
  out.hlines = list(raw.hlines, 12, "hlines").map((v) => ({ y: NUMBER(v?.y), ...style(v) }));
  if (!out.functions.length && !out.parametric.length && !out.points.length && !out.areas.length) throw new Error("plot needs at least one of functions, parametric, points or areas");
  return out;
}

export function sanitizeArtifact(raw) {
  if (!raw || typeof raw !== "object" || !ARTIFACT_TYPES.includes(raw.type)) throw new Error(`invalid artifact type (one of: ${ARTIFACT_TYPES.join(", ")})`);
  const out = { type: raw.type, id: typeof raw.id === "string" && raw.id.length <= 64 ? raw.id : randomUUID(), x: NUMBER(raw.x), y: NUMBER(raw.y), width: Math.max(80, Math.min(1200, NUMBER(raw.width) || 360)), height: Math.max(60, Math.min(800, NUMBER(raw.height) || 280)) };
  if (raw.type === "plot") Object.assign(out, sanitizePlot(raw));
  else if (raw.type === "icon") {
    const icon = iconIndex().get(raw.icon);
    if (!icon) throw new Error(`unknown icon "${String(raw.icon).slice(0, 60)}": search with board_library first`);
    out.icon = icon.id;
    // Keep the drawing's aspect ratio when only one dimension is given.
    if (!Number.isFinite(raw.height) && Number.isFinite(raw.width)) out.height = Math.max(60, Math.min(800, (raw.width * icon.h) / icon.w));
    if (!Number.isFinite(raw.width) && Number.isFinite(raw.height)) out.width = Math.max(80, Math.min(1200, (raw.height * icon.w) / icon.h));
    if (raw.card === true) out.card = true;
  }
  else if (raw.type === "molecule") {
    // SMILES uses a small character set; anything else is rejected up front.
    if (typeof raw.smiles !== "string" || !raw.smiles.trim() || raw.smiles.length > 500 || !/^[A-Za-z0-9@+\-\[\]()=#$:./\\%*~>]+$/.test(raw.smiles.trim()))
      throw new Error("molecule needs a SMILES string (e.g. 'CCO' for ethanol, 'c1ccccc1' for benzene), at most 500 characters, no spaces");
    out.smiles = raw.smiles.trim();
  }
  else if (raw.type === "svg") {
    out.source = checkSvgSource(raw.source);
  } else if (raw.type === "mermaid") {
    if (typeof raw.source !== "string" || raw.source.length > 12000) throw new Error("invalid Mermaid source: must be a string of at most 12000 characters");
    // Rendered with securityLevel strict and shown as an image; additionally
    // refuse links, click callbacks and embedded markup (arrows like <|-- are fine).
    const bad = /https?:|javascript:|data:|\bclick\s|\bcall\s|\bhref\b|<\s*\/?\s*(script|iframe|img|image|a|object|embed|style|svg|foreignObject|link|meta)\b|\bon[a-z]+\s*=/i.exec(raw.source);
    if (bad) throw new Error(`invalid Mermaid source: ${bad[0]} is not allowed`);
    out.source = raw.source;
  }
  if (typeof raw.label === "string") out.label = raw.label.slice(0, 120);
  if (Number.isFinite(raw.z)) out.z = Math.max(-1000, Math.min(1000, raw.z));
  if (Number.isFinite(raw.opacity)) out.opacity = Math.max(0, Math.min(1, raw.opacity));
  if (ID(raw.chapter)) out.chapter = raw.chapter;
  sanitizeAnimation(raw, out);
  return out;
}

export function sanitizeShape(shape) {
  if (!shape || typeof shape !== "object") return null;
  const type = shape.type;
  if (typeof type !== "string" || !SHAPE_TYPES.has(type)) return null;
  const out = {
    type,
    id:
      typeof shape.id === "string" && shape.id.length <= 64
        ? shape.id
        : randomUUID(),
  };
  switch (type) {
    case "stroke": {
      const pts = Array.isArray(shape.points) ? shape.points : [];
      if (pts.length === 0) return null;
      const points = pts
        .slice(0, MAX_POINTS_PER_STROKE)
        .map((p) =>
          Array.isArray(p) && p.length >= 2
            ? [NUMBER(p[0]), NUMBER(p[1])]
            : null,
        )
        .filter(Boolean);
      if (points.length === 0) return null;
      out.points = points;
      out.color =
        typeof shape.color === "string" ? shape.color.slice(0, 32) : "#e8e3d9";
      out.width = Math.max(0.5, Math.min(100, NUMBER(shape.width) || 3));
      break;
    }
    case "rect":
    case "ellipse": {
      out.x = NUMBER(shape.x);
      out.y = NUMBER(shape.y);
      out.w = NUMBER(shape.w);
      out.h = NUMBER(shape.h);
      out.color =
        typeof shape.color === "string" ? shape.color.slice(0, 32) : "#e8e3d9";
      out.fill =
        typeof shape.fill === "string" ? shape.fill.slice(0, 32) : undefined;
      break;
    }
    case "line":
    case "arrow": {
      const pts = Array.isArray(shape.points) ? shape.points : [];
      const points = pts
        .slice(0, 16)
        .map((p) =>
          Array.isArray(p) && p.length >= 2
            ? [NUMBER(p[0]), NUMBER(p[1])]
            : null,
        )
        .filter(Boolean);
      if (points.length < 2) return null;
      out.points = points;
      out.color =
        typeof shape.color === "string" ? shape.color.slice(0, 32) : "#e8e3d9";
      out.width = Math.max(0.5, Math.min(100, NUMBER(shape.width) || 2));
      break;
    }
    case "text": {
      if (typeof shape.text !== "string" || shape.text.trim() === "")
        return null;
      out.text = shape.text.slice(0, 2000);
      out.x = NUMBER(shape.x);
      out.y = NUMBER(shape.y);
      out.size = Math.max(8, Math.min(200, NUMBER(shape.size) || 24));
      out.color =
        typeof shape.color === "string" ? shape.color.slice(0, 32) : "#e8e3d9";
      break;
    }
    default:
      return null;
  }
  if (typeof shape.label === "string") out.label = shape.label.slice(0, 200);
  if (Number.isFinite(shape.z)) out.z = Math.max(-1000, Math.min(1000, shape.z));
  if (ID(shape.chapter)) out.chapter = shape.chapter;
  sanitizeAnimation(shape, out);
  if (Number.isFinite(shape.opacity)) out.opacity = Math.max(0, Math.min(1, shape.opacity));
  if (type !== "text" && typeof shape.dash === "string" && /^[\d.\s,]{1,40}$/.test(shape.dash)) out.dash = shape.dash.trim();
  if (type === "text") {
    if (["serif", "sans", "mono"].includes(shape.font)) out.font = shape.font;
    if (["start", "middle", "end"].includes(shape.anchor)) out.anchor = shape.anchor;
    if (shape.bold === true) out.bold = true;
    if (shape.italic === true) out.italic = true;
  }
  return out;
}

/**
 * Apply an update bundle (equation ops + scene ops + clear scopes) to a board.
 * Pure function: returns a new state object. Throws on validation problems.
 */
export function applyUpdate(state, update) {
  if (!update || typeof update !== "object" || Array.isArray(update))
    throw new Error("update must be an object");
  for (const key of Object.keys(update))
    if (!["title", "clear", "chapters", "equations", "scene", "items", "camera"].includes(key))
      throw new Error(`unknown update field: ${key}`);
  if (update.equations !== undefined && !Array.isArray(update.equations))
    throw new Error("equations must be an array");
  let next = clone(state) ?? emptyBoard();
  if (update.title !== undefined) {
    if (typeof update.title !== "string" || update.title.length > 200)
      throw new Error("title must be a string of at most 200 characters");
    next.title = update.title;
  }

  const clear = update.clear;
  if (clear) {
    const scopes = Array.isArray(clear) ? clear : [clear];
    for (const scope of scopes) {
      if (scope === "equations") next.equations = [];
      else if (scope === "scene") next.scene = { shapes: [], elements: [], artifacts: [] };
      else if (scope === "all") next = emptyBoard(next.title);
      else throw new Error(`invalid clear scope: ${String(scope)}`);
    }
  }

  const idsBefore = new Set([...(next.scene?.shapes ?? []), ...(next.scene?.artifacts ?? []), ...(next.equations ?? [])].map((it) => it.id));
  next.chapters ??= [];
  next.scene ??= { shapes: [] };
  next.scene.shapes ??= [];
  next.scene.artifacts ??= [];
  next.scene.elements ??= [];
  if (next.camera === undefined) next.camera = null;
  if (update.chapters !== undefined) applyChapterOps(next, update.chapters);

  if (Array.isArray(update.equations)) {
    for (const op of update.equations) {
      if (!op || typeof op !== "object") throw new Error("invalid equation op");
      if (op.op === "add") {
        const eq = sanitizeEquation(op);
        if (!eq) throw new Error("equation add requires non-empty latex");
        if (next.equations.length >= MAX_EQUATIONS)
          throw new Error(`too many equations (max ${MAX_EQUATIONS})`);
        if (next.equations.some((e) => e.id === eq.id))
          throw new Error("duplicate equation id");
        next.equations.push(eq);
      } else if (op.op === "update") {
        const i = next.equations.findIndex((e) => e.id === op.id);
        if (i === -1) throw new Error(`unknown equation id: ${op.id}`);
        const merged = sanitizeEquation({
          ...next.equations[i],
          ...op,
          id: next.equations[i].id,
        });
        if (!merged)
          throw new Error("equation update requires non-empty latex");
        next.equations[i] = merged;
      } else if (op.op === "delete") {
        const i = next.equations.findIndex((e) => e.id === op.id);
        if (i === -1) throw new Error(`unknown equation id: ${op.id}`);
        next.equations.splice(i, 1);
      } else {
        throw new Error(`invalid equation op: ${op.op}`);
      }
    }
  }

  if (update.scene !== undefined) {
    if (!update.scene || !["append", "replace"].includes(update.scene.mode))
      throw new Error("invalid scene mode");
    const { mode, shapes: raw = [], elements: native = [], artifacts: rawArtifacts = [] } = update.scene;
    if (!Array.isArray(raw) || !Array.isArray(rawArtifacts)) throw new Error("shapes and artifacts must be arrays");
    const shapes = raw.map(sanitizeShape).filter(Boolean);
    const elements = sanitizeElements(native);
    const artifacts = rawArtifacts.map(sanitizeArtifact);
    if (mode === "replace") next.scene = { shapes, elements, artifacts };
    else
      next.scene = {
        shapes: [...next.scene.shapes, ...shapes],
        elements: [...(next.scene.elements ?? []), ...elements],
        artifacts: [...(next.scene.artifacts ?? []), ...artifacts],
      };
    if (next.scene.shapes.length + next.scene.elements.length + next.scene.artifacts.length > MAX_SHAPES)
      throw new Error(`too many scene elements (max ${MAX_SHAPES})`);
    const ids = [...next.scene.shapes, ...next.scene.elements, ...next.scene.artifacts].map((s) => s.id);
    if (new Set(ids).size !== ids.length) throw new Error("duplicate scene id");
  }
  if (update.items !== undefined) applyItemOps(next, update.items);
  if (update.camera !== undefined) next.camera = sanitizeCamera(update.camera, next.chapters);
  // Steps: items added by this update without an explicit step form the next
  // step, so every board_update is replayable as one stage of the lesson.
  const allItems = [...next.scene.shapes, ...next.scene.artifacts, ...next.equations];
  const nextStep = (Number.isInteger(next.lastStep) ? next.lastStep : 0) + 1;
  let added = false;
  for (const it of allItems)
    if (!idsBefore.has(it.id) && it.step === undefined) { it.step = nextStep; added = true; }
  next.lastStep = Math.max(added ? nextStep : 0, ...allItems.map((it) => it.step ?? 0), next.lastStep ?? 0);
  if (!allItems.length) next.lastStep = 0;
  // Every chapter reference must resolve; a deleted chapter's camera falls back home.
  const known = new Set(next.chapters.map((c) => c.id));
  for (const it of [...next.scene.shapes, ...next.scene.artifacts, ...next.equations])
    if (it.chapter !== undefined && !known.has(it.chapter)) throw new Error(`item ${it.id}: unknown chapter "${it.chapter}" (add it with chapters:[{op:"add",id,...}] first)`);
  if (next.camera?.chapter && !known.has(next.camera.chapter)) next.camera = null;
  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > MAX_BOARD_BYTES)
    throw new Error(`board would be ${Math.round(bytes / 1024)} KiB, over the ${Math.round(MAX_BOARD_BYTES / 1024)} KiB limit: delete or simplify items (large SVG sources count most)`);

  next.updatedAt = nowIso();
  return next;
}

/**
 * Chapter ops: {op:"add", id?, title, x?, y?, w?, h?, frame?} (auto-placed to the
 * right of the last chapter when x/y are omitted), {op:"update", id, ...fields},
 * {op:"delete", id, keepItems?} (deletes the chapter's items unless keepItems).
 */
function applyChapterOps(board, ops) {
  if (!Array.isArray(ops)) throw new Error("chapters must be an array");
  for (const op of ops) {
    if (!op || typeof op !== "object") throw new Error("invalid chapter op");
    if (op.op === "add") {
      if (board.chapters.length >= MAX_CHAPTERS) throw new Error(`too many chapters (max ${MAX_CHAPTERS})`);
      const raw = { ...op };
      if (!Number.isFinite(op.x) || !Number.isFinite(op.y)) {
        const last = board.chapters[board.chapters.length - 1];
        raw.x = last ? last.x + last.w + CHAPTER.gap : 0;
        raw.y = last ? last.y : 0;
      }
      const ch = sanitizeChapter(raw);
      if (board.chapters.some((c) => c.id === ch.id)) throw new Error(`duplicate chapter id: ${ch.id}`);
      board.chapters.push(ch);
    } else if (op.op === "update") {
      const i = board.chapters.findIndex((c) => c.id === op.id);
      if (i === -1) throw new Error(`unknown chapter id: ${op.id}`);
      const { op: _o, id: _i, ...fields } = op;
      board.chapters[i] = sanitizeChapter({ ...board.chapters[i], ...fields, id: board.chapters[i].id });
    } else if (op.op === "delete") {
      const i = board.chapters.findIndex((c) => c.id === op.id);
      if (i === -1) throw new Error(`unknown chapter id: ${op.id}`);
      board.chapters.splice(i, 1);
      const inChapter = (it) => it.chapter === op.id;
      if (op.keepItems) for (const it of [...board.scene.shapes, ...board.scene.artifacts, ...board.equations]) { if (inChapter(it)) delete it.chapter; }
      else {
        board.scene.shapes = board.scene.shapes.filter((it) => !inChapter(it));
        board.scene.artifacts = board.scene.artifacts.filter((it) => !inChapter(it));
        board.equations = board.equations.filter((it) => !inChapter(it));
      }
    } else throw new Error(`invalid chapter op: ${String(op.op)}`);
  }
}

/** Locate any board item (shape, artifact, equation) by id. */
function findItem(board, id) {
  for (const kind of ["shapes", "artifacts"]) {
    const list = board.scene[kind] ?? [];
    const i = list.findIndex((x) => x.id === id);
    if (i !== -1) return { list, i, kind };
  }
  const i = board.equations.findIndex((x) => x.id === id);
  if (i !== -1) return { list: board.equations, i, kind: "equations" };
  return null;
}

const RESANITIZE = { shapes: sanitizeShape, artifacts: sanitizeArtifact, equations: sanitizeEquation };

/**
 * Generic per-item edits that work for every kind of board item:
 *   {op:"update", id, ...fields}  merge fields and re-validate
 *   {op:"move", id, dx, dy}       translate (points, x/y, or equation box)
 *   {op:"delete", id}
 */
function applyItemOps(board, ops) {
  if (!Array.isArray(ops)) throw new Error("items must be an array");
  if (ops.length > 500) throw new Error("too many item ops (max 500)");
  for (const op of ops) {
    if (!op || typeof op !== "object" || typeof op.id !== "string") throw new Error("item op requires an id");
    const found = findItem(board, op.id);
    if (!found) throw new Error(`unknown item id: ${op.id}`);
    const { list, i, kind } = found;
    const cur = list[i];
    if (op.op === "delete") { list.splice(i, 1); continue; }
    let next;
    if (op.op === "move") {
      const dx = NUMBER(op.dx), dy = NUMBER(op.dy);
      next = clone(cur);
      if (Array.isArray(next.points)) next.points = next.points.map(([x, y]) => [x + dx, y + dy]);
      else {
        const index = kind === "equations" ? i : 0;
        next.x = (Number.isFinite(next.x) ? next.x : 88) + dx;
        next.y = (Number.isFinite(next.y) ? next.y : 92 + index * 115) + dy;
      }
    } else if (op.op === "update") {
      const { op: _op, id: _id, type: _type, ...fields } = op;
      next = { ...cur, ...fields, id: cur.id, type: cur.type };
    } else throw new Error(`invalid item op: ${String(op.op)}`);
    const clean = RESANITIZE[kind](next);
    if (!clean) throw new Error(`item ${op.id}: update produced an invalid ${kind.slice(0, -1)}`);
    list[i] = clean;
  }
}

/* ------------------------------------------------------------------ */
/* BoardServer                                                        */
/* ------------------------------------------------------------------ */

export class BoardServer {
  constructor({ dataDir, title, autosave = true } = {}) {
    this.dataDir = dataDir ?? defaultDataDir();
    this.autosave = autosave;
    this.autosaveTimer = null;
    this.autosavedRevision = -1;
    this.restoredFrom = null;
    this.token = randomBytes(32).toString("hex");
    this.board = emptyBoard(title);
    this.revision = 0;
    this.startedAt = null;
    this.server = null;
    this.port = null;
    this.url = null;
    this.clients = new Set(); // SSE responses
    this.starting = null;
    this.saveQueue = Promise.resolve();
    this.snapshots = new Snapshotter(this);
  }

  /* ---------------- in-process API (used by model tools) ----------- */

  getState() {
    return clone(this.board);
  }

  /** Apply an update; throws ConflictError on revision mismatch. */
  update({ baseRevision, ...update }) {
    if (baseRevision !== undefined) {
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0)
        throw new Error("invalid baseRevision");
      if (baseRevision !== this.revision) {
        const err = new Error(
          `conflict: board is at revision ${this.revision}, update was based on ${baseRevision}. Re-read the board and re-apply.`,
        );
        err.conflict = { currentRevision: this.revision };
        throw err;
      }
    }
    this.board = applyUpdate(this.board, update);
    this.revision += 1;
    this.broadcast({ type: "revision", revision: this.revision });
    this.scheduleAutosave();
    return this.revision;
  }

  clear(scopes = ["all"]) {
    this.board = applyUpdate(this.board, { clear: scopes });
    this.revision += 1;
    this.broadcast({ type: "revision", revision: this.revision });
    this.scheduleAutosave();
    return this.revision;
  }

  async savesDir() {
    const dir = path.join(this.dataDir, "saves");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  async save(name = "default") {
    if (!SAVE_NAME_RE.test(name))
      throw new Error(`invalid save name: ${JSON.stringify(name)}`);
    const payload = {
      name,
      revision: this.revision,
      savedAt: nowIso(),
      board: this.getState(),
    };
    const job = this.saveQueue.then(async () => {
      const dir = await this.savesDir();
      const temp = path.join(dir, `.${name}-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
        await rename(temp, path.join(dir, `${name}.json`));
      } finally {
        await rm(temp, { force: true });
      }
      return payload;
    });
    this.saveQueue = job.catch(() => {});
    return job;
  }

  async listSaves() {
    const dir = await this.savesDir();
    const files = await readdir(dir).catch(() => []);
    return files
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""));
  }

  /** Read and parse a board JSON file (save slot or autosave), bounded in size. */
  async readBoardFile(file) {
    if ((await stat(file)).size > MAX_BOARD_BYTES + 4096) throw new Error("save too large");
    const payload = JSON.parse(await readFile(file, "utf-8"));
    if (!payload || typeof payload !== "object" || !payload.board) throw new Error("save is corrupt");
    return payload;
  }

  /**
   * Turn an untrusted saved board into a full-replace update. Everything is
   * re-sanitized; unsupported artifacts and dangling chapter references are
   * dropped instead of failing the whole load.
   */
  restoreOps(saved) {
    const chapters = (Array.isArray(saved.chapters) ? saved.chapters : []).map(sanitizeChapter).filter(Boolean).slice(0, MAX_CHAPTERS);
    const known = new Set(chapters.map((c) => c.id));
    const fix = (it) => (it && it.chapter !== undefined && !known.has(it.chapter) ? { ...it, chapter: undefined } : it);
    const ok = (fn) => (x) => { try { return fn(x) ?? null; } catch { return null; } };
    const shapes = (saved.scene?.shapes ?? []).map(fix).map(ok(sanitizeShape)).filter(Boolean).slice(0, MAX_SHAPES);
    const artifacts = (saved.scene?.artifacts ?? []).map(fix).map(ok(sanitizeArtifact)).filter(Boolean);
    const equations = (saved.equations ?? []).map(fix).map(ok(sanitizeEquation)).filter(Boolean).slice(0, MAX_EQUATIONS);
    let camera = null;
    try { camera = sanitizeCamera(saved.camera, chapters); } catch {}
    return {
      clear: ["all"],
      title: typeof saved.title === "string" ? saved.title.slice(0, 200) : "Pi Blackboard",
      chapters: chapters.map((c) => ({ ...c, op: "add" })),
      equations: equations.map((e) => ({ ...e, op: "add" })),
      scene: { mode: "replace", shapes, artifacts, elements: saved.scene?.elements ?? [] },
      camera,
    };
  }

  async load(name = "default", baseRevision = this.revision) {
    if (!SAVE_NAME_RE.test(name))
      throw new Error(`invalid save name: ${JSON.stringify(name)}`);
    const dir = await this.savesDir();
    let payload;
    try {
      payload = await this.readBoardFile(path.join(dir, `${name}.json`));
    } catch (e) {
      throw new Error(/too large|corrupt/.test(e.message) ? `save ${name}: ${e.message}` : `no save named ${JSON.stringify(name)}`);
    }
    return this.update({ baseRevision, ...this.restoreOps(payload.board) });
  }

  /* ---------------- autosave ---------------------------------------- */
  // Every change is written (debounced) to <dataDir>/autosave.json; a fresh
  // server restores it on start, so /reload or a pi restart never loses work.

  get autosaveFile() {
    return path.join(this.dataDir, "autosave.json");
  }

  scheduleAutosave() {
    if (!this.autosave) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => { this.flushAutosave().catch(() => {}); }, 400);
    this.autosaveTimer.unref?.();
  }

  flushAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (!this.autosave || this.autosavedRevision === this.revision) return this.saveQueue;
    const payload = { name: "autosave", revision: this.revision, savedAt: nowIso(), board: this.getState() };
    const job = this.saveQueue.then(async () => {
      await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
      const temp = path.join(this.dataDir, `.autosave-${randomUUID()}.tmp`);
      try {
        await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
        await rename(temp, this.autosaveFile);
        this.autosavedRevision = payload.revision;
      } finally {
        await rm(temp, { force: true });
      }
    });
    this.saveQueue = job.catch(() => {});
    return job;
  }

  /** Restore the last autosaved board (once, on start). Returns true if restored. */
  async restoreAutosave() {
    if (!this.autosave || this.revision !== 0) return false;
    let payload;
    try {
      payload = await this.readBoardFile(this.autosaveFile);
    } catch {
      return false;
    }
    try {
      this.update(this.restoreOps(payload.board));
      this.autosavedRevision = this.revision;
      this.restoredFrom = payload.savedAt;
      return true;
    } catch {
      return false;
    }
  }

  /* ---------------- HTTP server ------------------------------------ */

  async start() {
    if (this.starting) return this.starting;
    if (this.server) return this;
    this.starting = this.listen().finally(() => {
      this.starting = null;
    });
    return this.starting;
  }

  async listen() {
    const server = http.createServer((req, res) => this.handle(req, res));
    // SSE keepalive + socket hygiene
    server.keepAliveTimeout = 5000;
    server.headersTimeout = 10000;
    server.requestTimeout = 15000;
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    this.port = addr.port;
    this.url = `http://127.0.0.1:${addr.port}/#token=${this.token}`;
    this.server = server;
    this.startedAt = nowIso();
    await this.restoreAutosave();
    return this;
  }

  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    await this.flushAutosave().catch(() => {});
    await this.saveQueue;
    await this.snapshots.close();
    const server = this.server;
    this.server = null;
    this.url = null;
    this.port = null;
    for (const res of this.clients) {
      try {
        res.end();
      } catch {}
    }
    this.clients.clear();
    if (!server) return;
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
  }

  /* ---------------- request plumbing ------------------------------ */

  broadcast(event) {
    const data = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of this.clients) {
      try {
        if (!res.write(data)) {
          res.destroy();
          this.clients.delete(res);
        }
      } catch {
        this.clients.delete(res);
      }
    }
  }

  checkAuth(req) {
    const host = req.headers.host ?? "";
    if (host !== `127.0.0.1:${this.port}`)
      return { code: 403, message: "forbidden host" };
    const auth = req.headers.authorization ?? "";
    if (auth !== `Bearer ${this.token}`)
      return { code: 401, message: "missing or invalid bearer token" };
    const origin = req.headers.origin;
    if (origin !== undefined) {
      const ok = this.allowedOrigin(origin);
      if (!ok) return { code: 403, message: "forbidden origin" };
    }
    return null;
  }

  async readBody(req, res) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      res.writeHead(413, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "payload too large" }));
      return null;
    }
    return await new Promise((resolve, reject) => {
      const chunks = [];
      let total = 0;
      let done = false;
      req.on("data", (c) => {
        if (done) return;
        total += c.length;
        if (total > MAX_BODY_BYTES) {
          done = true;
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "payload too large" }));
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (done) return;
        const raw = Buffer.concat(chunks).toString("utf-8");
        if (raw.length > JSON_BODY_LIMIT_BYTES) {
          res.writeHead(413, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "payload too large" }));
          resolve(null);
          return;
        }
        try {
          const body = JSON.parse(raw);
          if (!body || typeof body !== "object" || Array.isArray(body))
            throw new Error("object required");
          resolve(body);
        } catch {
          res.writeHead(400, { "content-type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
          resolve(null);
        }
      });
      req.on("error", () => {
        if (done) return;
        done = true;
        reject(new Error("request stream error"));
      });
      req.on("aborted", () => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
    });
  }

  json(res, code, obj) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "content-length": Buffer.byteLength(body),
    });
    res.end(body);
  }

  async handle(req, res) {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; frame-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    );
    try {
      if (req.headers.host !== `127.0.0.1:${this.port}`)
        return this.json(res, 403, { ok: false, error: "forbidden host" });
      if (
        req.headers.origin !== undefined &&
        !this.allowedOrigin(req.headers.origin)
      )
        return this.json(res, 403, { ok: false, error: "forbidden origin" });
      let pathname, url;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return this.json(res, 400, { ok: false, error: "malformed URL" });
      }
      // Static app routes (page load carries no auth yet; the app reads
      // the token from the URL fragment and sends it on every API call).
      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        const rel = pathname === "/" ? "index.html" : pathname.slice(1);
        if (
          !rel
            .split("/")
            .every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))
        )
          return this.notFound(res);
        const type = MIME[path.extname(rel)];
        if (!type) return this.notFound(res);
        return this.serveFile(res, rel, type);
      }

      // Everything else is API and requires auth + loopback origin.
      if (pathname === "/api/events" && req.method === "GET") {
        // EventSource cannot set an Authorization header; allow the
        // token as a query parameter for this route only.
        const host = req.headers.host ?? "";
        if (host !== `127.0.0.1:${this.port}`)
          return this.json(res, 403, { ok: false, error: "forbidden host" });
        const origin = req.headers.origin;
        if (origin !== undefined && !this.allowedOrigin(origin))
          return this.json(res, 403, { ok: false, error: "forbidden origin" });
        if (url.searchParams.get("token") !== this.token)
          return this.json(res, 401, {
            ok: false,
            error: "missing or invalid token",
          });
        if (this.clients.size >= 32)
          return this.json(res, 429, {
            ok: false,
            error: "too many browser connections",
          });
        res.writeHead(200, {
          "content-type": "text/event-stream",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        res.write(
          `data: ${JSON.stringify({ type: "hello", revision: this.revision })}\n\n`,
        );
        this.clients.add(res);
        const ping = setInterval(() => {
          try {
            res.write(": ping\n\n");
          } catch {}
        }, 25000);
        ping.unref?.();
        req.on("close", () => {
          clearInterval(ping);
          this.clients.delete(res);
        });
        return;
      }

      const authError = this.checkAuth(req);
      if (authError)
        return this.json(res, authError.code, {
          ok: false,
          error: authError.message,
        });

      if (req.method === "GET" && pathname === "/api/state") {
        return this.json(res, 200, {
          ok: true,
          revision: this.revision,
          board: this.board,
        });
      }
      if (req.method === "GET" && pathname === "/api/saves") {
        return this.json(res, 200, { ok: true, saves: await this.listSaves() });
      }

      if (req.method === "POST") {
        if (Number(req.headers["content-length"]) > MAX_BODY_BYTES)
          return this.json(res, 413, { ok: false, error: "payload too large" });
        if (
          req.headers["content-type"]?.split(";")[0].trim() !==
          "application/json"
        )
          return this.json(res, 415, {
            ok: false,
            error: "application/json required",
          });
        const body = await this.readBody(req, res);
        if (body === null) return; // already answered (413/400)
        if (!body || typeof body !== "object" || Array.isArray(body))
          return this.json(res, 400, {
            ok: false,
            error: "body must be an object",
          });
        if (
          ["/api/update", "/api/clear", "/api/load"].includes(
            pathname,
          ) &&
          !Number.isSafeInteger(body.baseRevision)
        )
          return this.json(res, 400, {
            ok: false,
            error: "baseRevision is required",
          });
        switch (pathname) {
          case "/api/update": {
            const { baseRevision, ...update } = body ?? {};
            try {
              const revision = this.update({ baseRevision, ...update });
              return this.json(res, 200, {
                ok: true,
                revision,
                board: this.board,
              });
            } catch (err) {
              if (err.conflict) {
                return this.json(res, 409, {
                  ok: false,
                  error: err.message,
                  revision: this.revision,
                  board: this.board,
                });
              }
              return this.json(res, 400, {
                ok: false,
                error: String(err.message ?? err),
              });
            }
          }
          case "/api/clear":
            this.update({
              baseRevision: body.baseRevision,
              clear: body.scopes ?? ["all"],
            });
            return this.json(res, 200, {
              ok: true,
              revision: this.revision,
              board: this.board,
            });
          case "/api/save": {
            try {
              const saved = await this.save(String(body?.name ?? "default"));
              return this.json(res, 200, { ok: true, saved });
            } catch (err) {
              return this.json(res, 400, {
                ok: false,
                error: String(err.message ?? err),
              });
            }
          }
          case "/api/load": {
            try {
              const revision = await this.load(
                String(body?.name ?? "default"),
                body.baseRevision ?? this.revision,
              );
              return this.json(res, 200, {
                ok: true,
                revision,
                board: this.board,
              });
            } catch (err) {
              return this.json(res, err.conflict ? 409 : 404, {
                ok: false,
                error: String(err.message ?? err),
                revision: this.revision,
                board: this.board,
              });
            }
          }
        }
      }

      return this.notFound(res);
    } catch (err) {
      if (!res.headersSent) {
        try {
          this.json(res, err.conflict ? 409 : 400, {
            ok: false,
            error: String(err?.message ?? err),
            revision: this.revision,
            board: this.board,
          });
        } catch {}
      } else {
        try {
          res.end();
        } catch {}
      }
    }
  }

  allowedOrigin(origin) {
    return origin === `http://127.0.0.1:${this.port}`;
  }

  notFound(res) {
    this.json(res, 404, { ok: false, error: "not found" });
  }

  async serveFile(res, relPath, type) {
    const abs = path.join(__dirname, "public", relPath);
    if (!abs.startsWith(path.join(__dirname, "public") + path.sep))
      return this.notFound(res);
    try {
      const data = await readFile(abs);
      res.writeHead(200, {
        "content-type": type,
        "cache-control": "no-store",
        "content-length": data.length,
      });
      res.end(data);
    } catch {
      this.notFound(res);
    }
  }
}

/** Convenience for tests and scripts. */
export async function listenBoard({ dataDir } = {}) {
  const server = new BoardServer({ dataDir });
  await server.start();
  return server;
}

/** Open a URL in the default browser (best effort). */
export async function openBrowser(url) {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  try {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) =>
      execFile(cmd, [url], { timeout: 10000 }, (err) =>
        err ? reject(err) : resolve(),
      ),
    );
    return true;
  } catch {
    return false;
  }
}

export { defaultDataDir };
