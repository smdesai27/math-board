/**
 * math-board server: the loopback-only HTTP server behind the board, shared by the pi extension
 * (index.ts) and the MCP server (mcp/server.mjs). It serves the locally bundled browser page (no
 * CDN), a JSON API used by the page and the model tools, and an SSE stream of revisions.
 *
 * Security model:
 *  - Listens on 127.0.0.1 only, never on 0.0.0.0.
 *  - Every API request carries `Authorization: Bearer <token>`, a per-session 32-byte random hex
 *    secret (the SSE stream takes it as a query parameter, since EventSource cannot set headers).
 *  - The Host header must be exactly 127.0.0.1:<port> (DNS-rebinding protection), and an Origin
 *    header, when present, must be that origin.
 *  - Request bodies are bounded (512 KiB). Every update is validated before it is applied, and
 *    input that does not fit is rejected with a reason instead of being dropped silently.
 *  - Static files come only from public/, chosen by file extension, with strict path checks.
 *  - Board data is plain JSON; the page draws it with SVG and DOM text nodes and shows SVG,
 *    Mermaid, molecules and icons through <image> only. No eval anywhere.
 *
 * Persistence (see defaultDataDir): <dataDir>/autosave.json, written after every change, with
 * three rotating backups (autosave.1.json is the newest); named saves in <dataDir>/saves/; a
 * board.lock naming the process that owns the data folder. An autosave that cannot be restored is
 * moved aside as autosave.corrupt-<time>.json, never overwritten.
 */

import http from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// Forward this module's cache-busting query (see index.ts) to sibling modules.
const VERSION_QUERY = new URL(import.meta.url).search;
const sibling = (file) => new URL(`./${file}${VERSION_QUERY}`, import.meta.url).href;
const { Snapshotter } = await import(sibling("snapshot.mjs"));
const { compileExpr, EXPR_FUNCTIONS } = await import(sibling("shared/expr.mjs"));
const { checkSvgSource, SVG_TAGS, SVG_ATTRS, MAX_SVG_BYTES } = await import(sibling("shared/svg.mjs"));
export { checkSvgSource, SVG_TAGS, SVG_ATTRS };

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/* ------------------------------------------------------------------ */
/* Stale-source detection                                              */
/* ------------------------------------------------------------------ */

/**
 * The board's code files. A running server warns when one changed on disk after it loaded
 * (public/ assets are read from disk per request, so they never go stale). index.ts stamps its
 * imports with the same list; keep the two in sync.
 */
export const SOURCE_FILES = Object.freeze(["server.mjs", "snapshot.mjs", "export.mjs", "tools.mjs", "shared/expr.mjs", "shared/svg.mjs", "index.ts"]);
function sourceStamp() {
  return Object.fromEntries(SOURCE_FILES.map((f) => {
    try { return [f, statSync(path.join(__dirname, f)).mtimeMs]; } catch { return [f, 0]; }
  }));
}
export const LOADED_SOURCE_STAMP = sourceStamp();
/** Files changed on disk since this module loaded (empty when current). */
export function staleSources() {
  const now = sourceStamp();
  return SOURCE_FILES.filter((f) => now[f] > LOADED_SOURCE_STAMP[f] + 1);
}

/* ------------------------------------------------------------------ */
/* Limits and layout constants                                         */
/* ------------------------------------------------------------------ */

/** Version of the save format (autosave.json, saves/*.json, an export's board.json). */
export const SCHEMA_VERSION = 1;
export const MAX_BODY_BYTES = 512 * 1024;
/** Shapes plus artifacts on the whole board. */
export const MAX_SCENE_ITEMS = 5000;
export const MAX_SHAPES = MAX_SCENE_ITEMS;
export const MAX_SHAPES_PER_UPDATE = 2000;
export const MAX_ARTIFACTS_PER_UPDATE = 100;
export const MAX_EQUATIONS = 1000;
export const MAX_CHAPTERS = 200;
// Whole-board size (long lessons with many SVGs). HTTP request bodies stay capped at MAX_BODY_BYTES.
export const MAX_BOARD_BYTES = 6 * 1024 * 1024;
export const CHAPTER = Object.freeze({ w: 1200, h: 800, gap: 240 });
/** Where an equation without x,y goes: x = 88, the first at y = 92, each next one 115 lower. */
export const EQUATION_LAYOUT = Object.freeze({ x: 88, y: 92, step: 115 });
export const MAX_POINTS_PER_STROKE = 4000;
export const MAX_ARTIFACT_BYTES = MAX_SVG_BYTES;
export const MAX_ID_LENGTH = 64;
export const DEFAULT_TITLE = "Blackboard";
export const AUTOSAVE_BACKUPS = 3;
const BACKUP_INTERVAL_MS = 10 * 60 * 1000;
const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".svg": "image/svg+xml",
};
const SHAPE_TYPES = new Set(["stroke", "rect", "ellipse", "line", "arrow", "text"]);
// No leading dot, so names like "." and ".." never become file names.
const SAVE_NAME_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/;

/* ------------------------------------------------------------------ */
/* Data directory                                                      */
/* ------------------------------------------------------------------ */

const PACKAGE_DIR = __dirname;

function isInside(dir, root) {
  if (!root) return false;
  const r = path.resolve(root);
  return dir === r || dir.startsWith(r + path.sep);
}

/**
 * True when the package is a plain checkout (a clone you run in place): its path has no
 * node_modules segment and is not inside pi's or npm's package folders. Installed copies get
 * replaced on update (npm), cleaned with `git clean -fdx` (pi's git installs) or live in a cache
 * (npx), so their data must live elsewhere.
 */
export function isPlainCheckout(dir = PACKAGE_DIR, env = process.env) {
  const resolved = path.resolve(dir);
  const parts = resolved.split(/[\\/]+/);
  if (parts.includes("node_modules")) return false;
  // pi's git, npm and temporary package folders: ~/.pi/agent/..., <project>/.pi/git/...
  if (parts.includes(".pi")) return false;
  if (isInside(resolved, env.PI_CODING_AGENT_DIR)) return false;
  if (isInside(resolved, env.npm_config_cache) || isInside(resolved, path.join(homedir(), ".npm"))) return false;
  if (env.LOCALAPPDATA && isInside(resolved, path.join(env.LOCALAPPDATA, "npm-cache"))) return false;
  return true;
}

/** The per-user state folder: macOS Application Support, $XDG_STATE_HOME on Linux, %LOCALAPPDATA% on Windows. */
export function userDataDir(env = process.env, plat = platform()) {
  const home = homedir();
  if (plat === "darwin") return path.join(home, "Library", "Application Support", "math-board");
  if (plat === "win32") return path.join(env.LOCALAPPDATA || path.join(home, "AppData", "Local"), "math-board");
  const state = env.XDG_STATE_HOME && path.isAbsolute(env.XDG_STATE_HOME) ? env.XDG_STATE_HOME : path.join(home, ".local", "state");
  return path.join(state, "math-board");
}

/** MATH_BOARD_DATA_DIR, or its older name PI_MATH_BOARD_DATA_DIR. */
export function dataDirOverride(env = process.env) {
  return env.MATH_BOARD_DATA_DIR || env.PI_MATH_BOARD_DATA_DIR || null;
}

/**
 * Where a board keeps autosave.json and saves/. The environment variable wins. Otherwise a
 * checkout keeps its data in <package>/.data (git-ignored) and an installed package in the
 * per-user folder. `kind` "mcp" (the MCP server's board) uses an mcp/ subfolder of the default,
 * so pi's board and the MCP server's never share an autosave.
 */
export function defaultDataDir(kind = "pi", { env = process.env, packageDir = PACKAGE_DIR, platform: plat = platform() } = {}) {
  const override = dataDirOverride(env);
  if (override) return path.resolve(override);
  const base = isPlainCheckout(packageDir, env) ? path.join(packageDir, ".data") : userDataDir(env, plat);
  return kind === "mcp" ? path.join(base, "mcp") : base;
}

/* ------------------------------------------------------------------ */
/* Validation helpers (shared by HTTP routes and in-process tools)    */
/* ------------------------------------------------------------------ */

function nowIso() {
  return new Date().toISOString();
}

/** Deep-clone plain JSON data. */
function clone(x) {
  return x === undefined ? undefined : JSON.parse(JSON.stringify(x));
}

export function emptyBoard(title = DEFAULT_TITLE) {
  return {
    title,
    equations: [],
    scene: { shapes: [], artifacts: [] },
    chapters: [],
    camera: null,
    lastStep: 0,
    updatedAt: nowIso(),
  };
}

export const REVEALS = ["draw", "write", "wipe", "fade", "none"];
export const ARTIFACT_TYPES = ["svg", "mermaid", "plot", "molecule", "icon"];

const fail = (message) => {
  throw new Error(message);
};
const show = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 40 ? `${s.slice(0, 40)}…` : s;
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
/** Board coordinates are clamped to ±1e6; anything that is not a finite number becomes 0 (lenient). */
const NUMBER = (v) => (typeof v === "number" && Number.isFinite(v) ? clamp(v, -1e6, 1e6) : 0);
const COLOR = (v) => (typeof v === "string" && v.length <= 32 && !/[;{}<>]|url\s*\(/i.test(v) ? v : undefined);
const DASH = (v) => (typeof v === "string" && /^[\d.\s,]{1,40}$/.test(v) ? v.trim() : undefined);
const LABEL = (v, n = 80) => (typeof v === "string" ? v.slice(0, n) : undefined);
const VALID_ID = (v) => typeof v === "string" && v.length > 0 && v.length <= MAX_ID_LENGTH;

/** Small edit distance, for "did you mean" hints on unknown fields. */
function closeTo(a, b) {
  if (Math.abs(a.length - b.length) > 2) return false;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length] <= 2;
}

/** Strict mode: every key must be one the item kind knows. */
function onlyKeys(raw, allowed, where) {
  for (const key of Object.keys(raw)) {
    if (allowed.has(key)) continue;
    const near = [...allowed].find((k) => closeTo(key.toLowerCase(), k.toLowerCase()));
    fail(`${where}: unknown field "${key}"${near ? ` (did you mean "${near}"?)` : ""}; allowed: ${[...allowed].join(", ")}`);
  }
}

/**
 * Reads typed fields of one raw item. In strict mode (model and HTTP input) a field that is
 * present with the wrong type is an error that names it; in lenient mode (restoring saves
 * written by older versions) it falls back to the default.
 */
function reader(raw, where, strict) {
  const bad = (key, what) => {
    if (strict) fail(`${where}: ${key} must be ${what}, got ${show(raw[key])}`);
    return undefined;
  };
  return {
    has: (key) => raw[key] !== undefined,
    num(key, fallback) {
      const v = raw[key];
      if (v === undefined) return fallback;
      if (typeof v === "number" && Number.isFinite(v)) return clamp(v, -1e6, 1e6);
      return bad(key, "a number") ?? fallback;
    },
    int(key, lo, hi) {
      const v = raw[key];
      if (v === undefined) return undefined;
      if (Number.isInteger(v) && v >= lo) return Math.min(v, hi);
      return bad(key, `an integer of at least ${lo}`);
    },
    bool(key) {
      const v = raw[key];
      if (v === undefined) return undefined;
      return typeof v === "boolean" ? v : bad(key, "true or false");
    },
    str(key, max, { nonEmpty = false, cut = true } = {}) {
      const v = raw[key];
      if (v === undefined) return undefined;
      if (typeof v !== "string") return bad(key, "a string");
      if (nonEmpty && !v.trim()) return bad(key, "a non-empty string");
      if (v.length > max) return cut ? v.slice(0, max) : bad(key, `at most ${max} characters`);
      return v;
    },
    color(key) {
      const v = raw[key];
      if (v === undefined) return undefined;
      return COLOR(v) ?? bad(key, "a CSS color (at most 32 characters, no ; { } < > or url())");
    },
    dash(key) {
      const v = raw[key];
      if (v === undefined) return undefined;
      return DASH(v) ?? bad(key, 'a dash pattern like "6 4"');
    },
    oneOf(key, values) {
      const v = raw[key];
      if (v === undefined) return undefined;
      return values.includes(v) ? v : bad(key, `one of ${values.join(", ")}`);
    },
    id(key) {
      const v = raw[key];
      if (v === undefined) return undefined;
      return VALID_ID(v) ? v : bad(key, `a string of 1-${MAX_ID_LENGTH} characters`);
    },
  };
}

const ANIMATION_KEYS = ["step", "reveal", "duration", "order"];
/** Animation fields shared by every item kind (see browser playback). */
function readAnimation(r, out) {
  const step = r.int("step", 0, 1e6);
  if (step !== undefined) out.step = step;
  const reveal = r.oneOf("reveal", REVEALS);
  if (reveal) out.reveal = reveal;
  const duration = r.num("duration");
  if (duration !== undefined) out.duration = clamp(Math.round(duration), 0, 10000);
  const order = r.num("order");
  if (order !== undefined) out.order = order;
  return out;
}

const keys = (...lists) => new Set(lists.flat());
const CHAPTER_KEYS = keys("id", "title", "x", "y", "w", "h", "frame");

/** A chapter is a named board region; items with `chapter` use coordinates relative to its origin. */
export function sanitizeChapter(raw, { strict = false, where = "chapter" } = {}) {
  if (!raw || typeof raw !== "object") return null;
  const r = reader(raw, where, strict);
  const out = {
    id: r.id("id") ?? randomUUID(),
    title: r.str("title", 120) ?? "",
    x: r.num("x", 0),
    y: r.num("y", 0),
    w: clamp(r.num("w", 0) || CHAPTER.w, 200, 20000),
    h: clamp(r.num("h", 0) || CHAPTER.h, 150, 20000),
  };
  if (r.bool("frame") === false) out.frame = false;
  return out;
}

/** Camera = what following viewers see: a chapter, an explicit rect, or null (home). */
export function sanitizeCamera(raw, chapters = [], { strict = false } = {}) {
  if (raw === null || raw === undefined || raw === "home") return null;
  if (typeof raw !== "object" || Array.isArray(raw)) fail("camera must be {chapter}, {x,y,w,h} or null");
  if (raw.chapter !== undefined) {
    if (strict) onlyKeys(raw, keys("chapter"), "camera");
    if (!chapters.some((c) => c.id === raw.chapter)) fail(`camera: unknown chapter "${String(raw.chapter).slice(0, 64)}"`);
    return { chapter: raw.chapter };
  }
  if (strict) onlyKeys(raw, keys("x", "y", "w", "h"), "camera");
  const r = reader(raw, "camera", strict);
  const w = r.num("w", 0), h = r.num("h", 0);
  if (!(w > 0 && h > 0)) fail("camera rect needs positive w and h");
  return { x: r.num("x", 0), y: r.num("y", 0), w, h };
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

const EQUATION_KEYS = keys("id", "latex", "label", "color", "size", "x", "y", "z", "chapter", ANIMATION_KEYS);

function equationOf(eq, { strict = false, keys: checkKeys = strict, where = "equation" } = {}) {
  if (!eq || typeof eq !== "object" || Array.isArray(eq)) fail(`${where} must be an object`);
  if (checkKeys) onlyKeys(eq, EQUATION_KEYS, where);
  const r = reader(eq, where, strict);
  const latex = typeof eq.latex === "string" ? eq.latex : undefined;
  if (latex === undefined || !latex.trim()) fail(`${where}: latex must be a non-empty string`);
  if (latex.length > 4000) {
    if (strict) fail(`${where}: latex must be at most 4000 characters`);
  }
  const out = { id: r.id("id") ?? randomUUID(), latex: latex.slice(0, 4000) };
  const label = r.str("label", 200);
  if (label !== undefined) out.label = label;
  const color = r.color("color");
  if (color) out.color = color;
  // Optional font scale relative to the default display size (1 = default).
  const size = r.num("size");
  if (size !== undefined) out.size = clamp(size, 0.3, 4);
  // Board-space placement; applyUpdate places an equation without x,y below the last one.
  const x = r.num("x");
  if (x !== undefined) out.x = x;
  const y = r.num("y");
  if (y !== undefined) out.y = y;
  const z = r.num("z");
  if (z !== undefined) out.z = clamp(z, -1000, 1000);
  const chapter = r.id("chapter");
  if (chapter) out.chapter = chapter;
  readAnimation(r, out);
  out.createdAt = typeof eq.createdAt === "string" ? eq.createdAt.slice(0, 40) : nowIso();
  return out;
}

/** An equation, or null when it is unusable. With `strict`, problems throw with a reason instead. */
export function sanitizeEquation(eq, opts = {}) {
  try {
    return equationOf(eq, opts);
  } catch (err) {
    if (opts.strict) throw err;
    return null;
  }
}

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

/** [min, max] with min < max by more than rounding noise (a near-empty range would make no ticks). */
function range(v, name, fallback) {
  if (v === undefined) return fallback;
  const bad = () => fail(`plot ${name} must be [min, max] with min < max`);
  if (!Array.isArray(v) || v.length !== 2 || !v.every((n) => typeof n === "number" && Number.isFinite(n))) bad();
  const [lo, hi] = [NUMBER(v[0]), NUMBER(v[1])];
  if (!(hi - lo > 1e-9 * Math.max(1, Math.abs(lo), Math.abs(hi)))) bad();
  return [lo, hi];
}
function checkExpr(src, vars, where) {
  try { compileExpr(src, vars); return src; } catch (e) { fail(`plot ${where}: "${String(src).slice(0, 60)}": ${e.message}`); }
}
const STYLE_KEYS = ["color", "width", "dash", "label"];
const PLOT_KEYS = ["xRange", "yRange", "grid", "axes", "ticks", "equalAspect", "xLabel", "yLabel", "title", "params", "functions", "parametric", "areas", "points", "vlines", "hlines"];
const PLOT_PART_KEYS = {
  params: keys("name", "min", "max", "value", "step", "label", "period"),
  functions: keys("expr", "domain", STYLE_KEYS),
  parametric: keys("x", "y", "t", STYLE_KEYS),
  areas: keys("expr", "lower", "from", "to", STYLE_KEYS),
  points: keys("x", "y", "size", "drag", STYLE_KEYS),
  vlines: keys("x", STYLE_KEYS),
  hlines: keys("y", STYLE_KEYS),
};
// A slider's name is a variable in the plot's expressions, so it cannot be one of their own names.
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const RESERVED_PARAM_NAMES = new Set(["x", "t", "pi", "e", "tau", "inf", ...EXPR_FUNCTIONS]);
/** A slider: a named value in [min, max] the learner can drag (or play) and the plot redraws with. */
function sanitizeParam(p, pr, i, strict) {
  const at = `plot params[${i}]`;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  if (!PARAM_NAME.test(name) || RESERVED_PARAM_NAMES.has(name))
    fail(`${at}.name must be a short name such as "a" or "omega" (a letter, then letters, digits or _; not x, t, a constant or a function name), got ${show(p.name)}`);
  const min = p.min, max = p.max;
  if (!(typeof min === "number" && typeof max === "number" && Number.isFinite(min) && Number.isFinite(max) && max - min > 1e-9 * Math.max(1, Math.abs(min), Math.abs(max))))
    fail(`${at} "${name}": min and max must be numbers with min < max`);
  const out = { name, min: NUMBER(min), max: NUMBER(max) };
  out.value = clamp(pr.num("value", out.min), out.min, out.max);
  const step = pr.num("step");
  if (step !== undefined) {
    if (step > 0 && step <= out.max - out.min) out.step = step;
    else if (strict) fail(`${at} "${name}": step must be more than 0 and at most max - min`);
  }
  const label = pr.str("label", 40);
  if (label) out.label = label;
  const period = pr.num("period");
  if (period !== undefined) out.period = clamp(period, 0.5, 60);
  return out;
}
/** Declarative function plot. Expressions are parsed by shared/expr.mjs (no eval). */
function sanitizePlot(raw, strict, where) {
  const out = {};
  out.xRange = range(raw.xRange, "xRange", [-10, 10]);
  const yr = range(raw.yRange, "yRange", undefined);
  if (yr) out.yRange = yr;
  const r = reader(raw, where, strict);
  for (const k of ["grid", "axes", "ticks"]) if (r.bool(k) === false) out[k] = false;
  if (r.bool("equalAspect") === true) out.equalAspect = true;
  for (const k of ["xLabel", "yLabel", "title"]) { const v = r.str(k, 60); if (v) out[k] = v; }
  const list = (name, max) => {
    const v = raw[name];
    if (v === undefined) return [];
    if (!Array.isArray(v)) fail(`plot ${name} must be an array`);
    if (v.length > max) fail(`plot ${name}: at most ${max}`);
    return v.map((part, i) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) fail(`plot ${name}[${i}] must be an object`);
      if (strict) onlyKeys(part, PLOT_PART_KEYS[name], `${where} ${name}[${i}]`);
      return [part, reader(part, `${where} ${name}[${i}]`, strict), i];
    });
  };
  const style = (pr) => {
    const o = {};
    const c = pr.color("color"); if (c) o.color = c;
    const w = pr.num("width"); if (w !== undefined) o.width = clamp(w, 0.5, 12);
    const d = pr.dash("dash"); if (d) o.dash = d;
    const l = pr.str("label", 80); if (l) o.label = l;
    return o;
  };
  const params = list("params", 6).map(([p, pr, i]) => sanitizeParam(p, pr, i, strict));
  const names = params.map((p) => p.name);
  const twice = names.find((n, i) => names.indexOf(n) !== i);
  if (twice) fail(`plot params: "${twice}" is used twice`);
  if (params.length) out.params = params;
  // Every expression may use the sliders; a coordinate (point, line, area end) may be an
  // expression of them instead of a number when the plot has sliders.
  const vars = (v) => [v, ...names];
  const coord = (part, pr, key, fallback, at) => {
    const v = part[key];
    if (typeof v === "string" && names.length) return checkExpr(v, names, `${at}.${key}`).trim();
    if (typeof v === "string" && strict) fail(`plot ${at}.${key} must be a number (an expression such as "a" needs params on the plot), got ${show(v)}`);
    return pr.num(key, fallback);
  };
  out.functions = list("functions", 12).map(([f, pr, i]) => ({ expr: checkExpr(f.expr, vars("x"), `functions[${i}]`), ...style(pr), ...(f.domain !== undefined ? { domain: range(f.domain, `functions[${i}].domain`) } : {}) }));
  out.parametric = list("parametric", 8).map(([f, pr, i]) => ({ x: checkExpr(f.x, vars("t"), `parametric[${i}].x`), y: checkExpr(f.y, vars("t"), `parametric[${i}].y`), t: range(f.t, `parametric[${i}].t`, [0, 2 * Math.PI]), ...style(pr) }));
  out.areas = list("areas", 6).map(([a, pr, i]) => ({ expr: checkExpr(a.expr, vars("x"), `areas[${i}]`), ...(a.lower !== undefined ? { lower: checkExpr(a.lower, vars("x"), `areas[${i}].lower`) } : {}), from: coord(a, pr, "from", 0, `areas[${i}]`), to: coord(a, pr, "to", 0, `areas[${i}]`), ...style(pr) }));
  out.points = list("points", 200).map(([pt, pr, i]) => {
    const size = pr.num("size");
    const o = { x: coord(pt, pr, "x", 0, `points[${i}]`), y: coord(pt, pr, "y", 0, `points[${i}]`), ...style(pr), ...(size !== undefined ? { size: clamp(size, 1, 20) } : {}) };
    // A draggable point moves the slider(s) its x and/or y is bound to.
    if (pr.bool("drag") === true) {
      if ([o.x, o.y].some((v) => names.includes(v))) o.drag = true;
      else if (strict) fail(`plot points[${i}]: drag needs x or y to be a slider name, e.g. {x:"a", y:"sin(a)", drag:true}`);
    }
    return o;
  });
  out.vlines = list("vlines", 12).map(([v, pr, i]) => ({ x: coord(v, pr, "x", 0, `vlines[${i}]`), ...style(pr) }));
  out.hlines = list("hlines", 12).map(([h, pr, i]) => ({ y: coord(h, pr, "y", 0, `hlines[${i}]`), ...style(pr) }));
  if (!out.functions.length && !out.parametric.length && !out.points.length && !out.areas.length) fail("plot needs at least one of functions, parametric, points or areas");
  return out;
}

const ARTIFACT_COMMON_KEYS = ["type", "id", "x", "y", "width", "height", "label", "z", "opacity", "chapter", ...ANIMATION_KEYS];
const ARTIFACT_KEYS = {
  plot: keys(ARTIFACT_COMMON_KEYS, PLOT_KEYS),
  icon: keys(ARTIFACT_COMMON_KEYS, "icon", "card"),
  molecule: keys(ARTIFACT_COMMON_KEYS, "smiles"),
  svg: keys(ARTIFACT_COMMON_KEYS, "source"),
  mermaid: keys(ARTIFACT_COMMON_KEYS, "source"),
};

/** Mermaid text: rendered with securityLevel strict and shown as an image; links, callbacks, markup and directives are refused. */
export function checkMermaidSource(source) {
  if (typeof source !== "string" || !source.trim() || source.length > 12000) fail("invalid Mermaid source: must be a non-empty string of at most 12000 characters");
  // %%{init: ...}%% directives can change configuration Mermaid does not protect (label rendering, theme CSS).
  if (/%%\s*\{/.test(source)) fail("invalid Mermaid source: %%{...}%% directives are not allowed (the board sets the theme)");
  // Arrows like <|-- are fine; links, click callbacks and embedded markup are not.
  const bad = /https?:|javascript:|data:|\bclick\s|\bcall\s|\bhref\b|<\s*\/?\s*(script|iframe|img|image|a|object|embed|style|svg|foreignObject|link|meta)\b|\bon[a-z]+\s*=/i.exec(source);
  if (bad) fail(`invalid Mermaid source: ${bad[0]} is not allowed`);
  return source;
}

/** An artifact (plot, svg, mermaid, molecule, icon). Throws with a reason when it is invalid. */
export function sanitizeArtifact(raw, { strict = false, keys: checkKeys = strict, where = "artifact" } = {}) {
  if (!raw || typeof raw !== "object" || !ARTIFACT_TYPES.includes(raw.type)) fail(`${where}: invalid artifact type (one of: ${ARTIFACT_TYPES.join(", ")})`);
  if (checkKeys) onlyKeys(raw, ARTIFACT_KEYS[raw.type], `${where} (${raw.type})`);
  const r = reader(raw, where, strict);
  const out = {
    type: raw.type,
    id: r.id("id") ?? randomUUID(),
    x: r.num("x", 0),
    y: r.num("y", 0),
    width: clamp(r.num("width", 0) || 360, 80, 1200),
    height: clamp(r.num("height", 0) || 280, 60, 800),
  };
  if (raw.type === "plot") Object.assign(out, sanitizePlot(raw, strict, where));
  else if (raw.type === "icon") {
    const icon = iconIndex().get(raw.icon);
    if (!icon) fail(`unknown icon "${String(raw.icon).slice(0, 60)}": search with board_library first`);
    out.icon = icon.id;
    // Keep the drawing's aspect ratio when only one dimension is given.
    if (!r.has("height") && r.has("width")) out.height = clamp((out.width * icon.h) / icon.w, 60, 800);
    if (!r.has("width") && r.has("height")) out.width = clamp((out.height * icon.w) / icon.h, 80, 1200);
    if (r.bool("card") === true) out.card = true;
  } else if (raw.type === "molecule") {
    // SMILES uses a small character set; anything else is rejected up front.
    if (typeof raw.smiles !== "string" || !raw.smiles.trim() || raw.smiles.length > 500 || !/^[A-Za-z0-9@+\-[\]()=#$:./\\%*~>]+$/.test(raw.smiles.trim()))
      fail("molecule needs a SMILES string (e.g. 'CCO' for ethanol, 'c1ccccc1' for benzene), at most 500 characters, no spaces");
    out.smiles = raw.smiles.trim();
  } else if (raw.type === "svg") {
    out.source = checkSvgSource(raw.source);
  } else if (raw.type === "mermaid") {
    out.source = checkMermaidSource(raw.source);
  }
  const label = r.str("label", 120);
  if (label !== undefined) out.label = label;
  const z = r.num("z");
  if (z !== undefined) out.z = clamp(z, -1000, 1000);
  const opacity = r.num("opacity");
  if (opacity !== undefined) out.opacity = clamp(opacity, 0, 1);
  const chapter = r.id("chapter");
  if (chapter) out.chapter = chapter;
  readAnimation(r, out);
  return out;
}

const SHAPE_COMMON_KEYS = ["type", "id", "label", "z", "opacity", "chapter", ...ANIMATION_KEYS];
const SHAPE_KEYS = {
  stroke: keys(SHAPE_COMMON_KEYS, "dash", "points", "color", "width"),
  line: keys(SHAPE_COMMON_KEYS, "dash", "points", "color", "width"),
  arrow: keys(SHAPE_COMMON_KEYS, "dash", "points", "color", "width"),
  rect: keys(SHAPE_COMMON_KEYS, "dash", "x", "y", "w", "h", "color", "fill"),
  ellipse: keys(SHAPE_COMMON_KEYS, "dash", "x", "y", "w", "h", "color", "fill"),
  text: keys(SHAPE_COMMON_KEYS, "text", "x", "y", "size", "color", "font", "anchor", "bold", "italic"),
};
const CHALK = "#e8e3d9";

function shapeOf(shape, { strict = false, keys: checkKeys = strict, where = "shape" } = {}) {
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) fail(`${where} must be an object`);
  const type = shape.type;
  if (typeof type !== "string" || !SHAPE_TYPES.has(type)) fail(`${where}: type must be one of ${[...SHAPE_TYPES].join(", ")}, got ${show(type)}`);
  if (checkKeys) onlyKeys(shape, SHAPE_KEYS[type], `${where} (${type})`);
  const r = reader(shape, where, strict);
  const out = { type, id: r.id("id") ?? randomUUID() };
  const points = (min, max) => {
    const pts = shape.points;
    if (!Array.isArray(pts)) fail(`${where}: ${type} needs points [[x, y], ...]`);
    if (strict && pts.length > max) fail(`${where}: ${type} takes at most ${max} points, got ${pts.length}${type !== "stroke" ? " (use a stroke for curves)" : ""}`);
    const ok = pts.slice(0, max).filter((p) => Array.isArray(p) && p.length >= 2 && p.slice(0, 2).every((n) => typeof n === "number" && Number.isFinite(n)));
    if (strict && ok.length !== Math.min(pts.length, max)) fail(`${where}: every point must be [x, y] with two numbers`);
    if (ok.length < min) fail(`${where}: ${type} needs at least ${min} points`);
    return ok.map((p) => [NUMBER(p[0]), NUMBER(p[1])]);
  };
  switch (type) {
    case "stroke":
      out.points = points(strict ? 2 : 1, MAX_POINTS_PER_STROKE);
      out.color = r.color("color") ?? CHALK;
      out.width = clamp(r.num("width", 0) || 3, 0.5, 100);
      break;
    case "line":
    case "arrow":
      out.points = points(2, type === "arrow" && strict ? 4 : 16);
      out.color = r.color("color") ?? CHALK;
      out.width = clamp(r.num("width", 0) || 2, 0.5, 100);
      break;
    case "rect":
    case "ellipse": {
      out.x = r.num("x", 0);
      out.y = r.num("y", 0);
      out.w = r.num("w", 0);
      out.h = r.num("h", 0);
      out.color = r.color("color") ?? CHALK;
      const fill = r.color("fill");
      if (fill) out.fill = fill;
      break;
    }
    case "text": {
      const text = r.str("text", 2000, { nonEmpty: true, cut: !strict });
      if (!text?.trim()) fail(`${where}: text needs a non-empty "text"`);
      out.text = text;
      out.x = r.num("x", 0);
      out.y = r.num("y", 0);
      out.size = clamp(r.num("size", 0) || 24, 8, 200);
      out.color = r.color("color") ?? CHALK;
      const font = r.oneOf("font", ["serif", "sans", "mono"]);
      if (font) out.font = font;
      const anchor = r.oneOf("anchor", ["start", "middle", "end"]);
      if (anchor) out.anchor = anchor;
      if (r.bool("bold") === true) out.bold = true;
      if (r.bool("italic") === true) out.italic = true;
      break;
    }
  }
  const label = r.str("label", 200);
  if (label !== undefined) out.label = label;
  const z = r.num("z");
  if (z !== undefined) out.z = clamp(z, -1000, 1000);
  const chapter = r.id("chapter");
  if (chapter) out.chapter = chapter;
  readAnimation(r, out);
  const opacity = r.num("opacity");
  if (opacity !== undefined) out.opacity = clamp(opacity, 0, 1);
  if (type !== "text") {
    const dash = r.dash("dash");
    if (dash) out.dash = dash;
  }
  return out;
}

/** A shape, or null when it is unusable. With `strict`, problems throw with a reason instead. */
export function sanitizeShape(shape, opts = {}) {
  try {
    return shapeOf(shape, opts);
  } catch (err) {
    if (opts.strict) throw err;
    return null;
  }
}

/* ------------------------------------------------------------------ */
/* applyUpdate                                                         */
/* ------------------------------------------------------------------ */

const UPDATE_KEYS = keys("title", "clear", "chapters", "equations", "scene", "items", "camera");
const SCENE_KEYS = keys("mode", "shapes", "artifacts");
const sceneItems = (board) => [...board.scene.shapes, ...board.scene.artifacts, ...board.equations];

const isSlot = (y) => Number.isFinite(y) && y >= EQUATION_LAYOUT.y && Number.isInteger((y - EQUATION_LAYOUT.y) / EQUATION_LAYOUT.step);

/**
 * Store a position for an equation that came without x or y: x 88, y 92 + k * 115, where k is the
 * next slot of that stack in the equation's own chapter (one below the lowest stacked equation
 * there, so a deleted equation leaves a gap instead of moving the others). The position is
 * stored, so nothing moves when other equations or chapters change.
 */
function placeEquation(board, eq) {
  if (eq.x !== undefined && eq.y !== undefined) return;
  if (eq.x === undefined) eq.x = EQUATION_LAYOUT.x;
  if (eq.y === undefined) {
    const used = board.equations
      .filter((e) => (e.chapter ?? null) === (eq.chapter ?? null) && e.x === eq.x && isSlot(e.y))
      .map((e) => (e.y - EQUATION_LAYOUT.y) / EQUATION_LAYOUT.step);
    eq.y = EQUATION_LAYOUT.y + (used.length ? Math.max(...used) + 1 : 0) * EQUATION_LAYOUT.step;
  }
}

/**
 * Where the page draws equations saved without x or y (boards from before positions were
 * stored): x 88, y 92 + k * 115, k = the index among the coordinate-less equations of the same
 * chapter, in board order. Returns a Map from equation to [x, y].
 */
export function legacyEquationPositions(equations) {
  const counts = new Map();
  const out = new Map();
  for (const eq of equations ?? []) {
    if (!eq || typeof eq !== "object" || (Number.isFinite(eq.x) && Number.isFinite(eq.y))) continue;
    const key = eq.chapter ?? "";
    const k = counts.get(key) ?? 0;
    counts.set(key, k + 1);
    out.set(eq, [Number.isFinite(eq.x) ? eq.x : EQUATION_LAYOUT.x, Number.isFinite(eq.y) ? eq.y : EQUATION_LAYOUT.y + k * EQUATION_LAYOUT.step]);
  }
  return out;
}

/**
 * Apply an update bundle to a board and say what it did. Pure: returns a new board.
 * Throws with a reason on any invalid input, so an update applies completely or not at all.
 * `strict` (default) is for model and HTTP input: unknown fields, wrong types and bad ids are
 * errors. Restoring a save passes strict:false, where older fields are dropped instead.
 * Returns { board, warnings, touched }: warnings found without a browser (overlapping chapters)
 * and the ids of the items and chapters the update added or changed.
 */
export function applyUpdateReport(state, update, { strict = true } = {}) {
  if (!update || typeof update !== "object" || Array.isArray(update)) fail("update must be an object");
  for (const key of Object.keys(update)) if (!UPDATE_KEYS.has(key)) fail(`unknown update field: ${key}`);
  if (update.equations !== undefined && !Array.isArray(update.equations)) fail("equations must be an array");
  let next = clone(state) ?? emptyBoard();
  const touched = new Set();
  const warnings = [];
  if (update.title !== undefined) {
    if (typeof update.title !== "string" || update.title.length > 200) fail("title must be a string of at most 200 characters");
    next.title = update.title;
  }

  const clear = update.clear;
  if (clear) {
    const scopes = Array.isArray(clear) ? clear : [clear];
    for (const scope of scopes) {
      if (scope === "equations") next.equations = [];
      else if (scope === "scene") next.scene = { shapes: [], artifacts: [] };
      else if (scope === "all") next = emptyBoard(next.title);
      else fail(`invalid clear scope: ${String(scope)} (one of equations, scene, all)`);
    }
  }

  next.chapters ??= [];
  next.scene ??= { shapes: [], artifacts: [] };
  next.scene.shapes ??= [];
  next.scene.artifacts ??= [];
  delete next.scene.elements; // Excalidraw elements from 0.2 saves; restoreOps reports them as dropped
  next.equations ??= [];
  if (next.camera === undefined) next.camera = null;
  const stepsBefore = new Map(sceneItems(next).map((it) => [it.id, it.step]));
  const chaptersBefore = new Map(next.chapters.map((c) => [c.id, JSON.stringify(c)]));

  if (update.chapters !== undefined) applyChapterOps(next, update.chapters, strict, touched);

  if (Array.isArray(update.equations)) {
    update.equations.forEach((op, i) => {
      const where = `equations[${i}]`;
      if (!op || typeof op !== "object") fail(`${where}: invalid equation op`);
      const { op: kind, ...fields } = op;
      if (kind === "add") {
        const eq = equationOf(fields, { strict, where });
        if (next.equations.length >= MAX_EQUATIONS) fail(`too many equations (max ${MAX_EQUATIONS})`);
        if (next.equations.some((e) => e.id === eq.id)) fail(`${where}: duplicate equation id "${eq.id}"`);
        placeEquation(next, eq);
        next.equations.push(eq);
        touched.add(eq.id);
      } else if (kind === "update") {
        const i = next.equations.findIndex((e) => e.id === op.id);
        if (i === -1) fail(`${where}: unknown equation id: ${op.id}`);
        const { id: _id, ...changes } = fields;
        if (strict) onlyKeys(changes, EQUATION_KEYS, where);
        next.equations[i] = equationOf({ ...next.equations[i], ...changes, id: next.equations[i].id }, { strict, keys: false, where });
        touched.add(op.id);
      } else if (kind === "delete") {
        const i = next.equations.findIndex((e) => e.id === op.id);
        if (i === -1) fail(`${where}: unknown equation id: ${op.id}`);
        next.equations.splice(i, 1);
      } else {
        fail(`${where}: invalid equation op: ${show(kind)} (add, update or delete)`);
      }
    });
  }

  if (update.scene !== undefined) {
    const scene = update.scene;
    if (!scene || typeof scene !== "object" || !["append", "replace"].includes(scene.mode)) fail('scene.mode must be "append" or "replace"');
    if (scene.elements !== undefined && (!Array.isArray(scene.elements) || scene.elements.length)) fail("scene.elements (Excalidraw elements) are no longer supported: draw with shapes and artifacts");
    if (strict) onlyKeys(Object.fromEntries(Object.entries(scene).filter(([k]) => k !== "elements")), SCENE_KEYS, "scene");
    const { mode, shapes: rawShapes = [], artifacts: rawArtifacts = [] } = scene;
    if (!Array.isArray(rawShapes) || !Array.isArray(rawArtifacts)) fail("scene.shapes and scene.artifacts must be arrays");
    if (strict && rawShapes.length > MAX_SHAPES_PER_UPDATE) fail(`too many shapes in one update (max ${MAX_SHAPES_PER_UPDATE})`);
    if (strict && rawArtifacts.length > MAX_ARTIFACTS_PER_UPDATE) fail(`too many artifacts in one update (max ${MAX_ARTIFACTS_PER_UPDATE})`);
    const shapes = rawShapes.map((s, i) => shapeOf(s, { strict, where: `scene.shapes[${i}]${s?.id ? ` "${String(s.id).slice(0, 64)}"` : ""}` }));
    const artifacts = rawArtifacts.map((a, i) => sanitizeArtifact(a, { strict, where: `scene.artifacts[${i}]${a?.id ? ` "${String(a.id).slice(0, 64)}"` : ""}` }));
    for (const it of [...shapes, ...artifacts]) touched.add(it.id);
    if (mode === "replace") next.scene = { shapes, artifacts };
    else next.scene = { shapes: [...next.scene.shapes, ...shapes], artifacts: [...next.scene.artifacts, ...artifacts] };
    if (next.scene.shapes.length + next.scene.artifacts.length > MAX_SCENE_ITEMS) fail(`too many scene items (max ${MAX_SCENE_ITEMS} shapes and artifacts in total)`);
  }
  if (update.items !== undefined) applyItemOps(next, update.items, strict, touched);
  if (update.camera !== undefined) next.camera = sanitizeCamera(update.camera, next.chapters, { strict });

  // Ids are unique across shapes, artifacts and equations, so items ops and the learner's
  // references ("step 4, eq2") always mean one item.
  const seen = new Map();
  for (const [kind, list] of [["shape", next.scene.shapes], ["artifact", next.scene.artifacts], ["equation", next.equations]])
    for (const it of list) {
      const other = seen.get(it.id);
      if (other) fail(`duplicate id "${it.id}": ${other === kind ? `two ${kind}s use it` : `used by a ${other} and an ${kind}`.replace(/\ba (?=[ae])/g, "an ").replace(/\ban (?=s)/g, "a ")} (ids are unique across shapes, artifacts and equations)`);
      seen.set(it.id, kind);
    }

  // Steps: an item keeps the step it had; new items without a step form the next step, so every
  // board_update is replayable as one stage of the lesson. lastStep is the highest step in use.
  const allItems = sceneItems(next);
  // The next step follows the highest step among items that were there before and still are.
  const stepsInUse = allItems.filter((it) => stepsBefore.has(it.id)).map((it) => stepsBefore.get(it.id)).filter(Number.isInteger);
  const nextStep = (stepsInUse.length ? Math.max(...stepsInUse) : 0) + 1;
  for (const it of allItems) {
    if (it.step !== undefined) continue;
    const before = stepsBefore.get(it.id);
    it.step = Number.isInteger(before) ? before : nextStep;
  }
  next.lastStep = allItems.length ? Math.max(0, ...allItems.map((it) => it.step ?? 0)) : 0;

  // Every chapter reference must resolve; a deleted chapter's camera falls back home.
  const known = new Set(next.chapters.map((c) => c.id));
  for (const it of allItems)
    if (it.chapter !== undefined && !known.has(it.chapter)) fail(`item ${it.id}: unknown chapter "${it.chapter}" (add it with chapters:[{op:"add",id,...}] first)`);
  if (next.camera?.chapter && !known.has(next.camera.chapter)) next.camera = null;

  // Chapters this update added or moved that overlap another chapter.
  const changed = next.chapters.filter((c) => chaptersBefore.get(c.id) !== JSON.stringify(c));
  for (const c of changed) touched.add(c.id);
  const reported = new Set();
  for (const a of changed)
    for (const b of next.chapters) {
      if (a === b || reported.has([a.id, b.id].sort().join("\0"))) continue;
      const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (w > 0 && h > 0) {
        reported.add([a.id, b.id].sort().join("\0"));
        warnings.push(`chapters "${a.id}" (${Math.round(a.x)},${Math.round(a.y)} ${Math.round(a.w)}x${Math.round(a.h)}) and "${b.id}" (${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}x${Math.round(b.h)}) overlap: move one with chapters:[{op:"update", id, x, y}]`);
      }
    }

  const bytes = Buffer.byteLength(JSON.stringify(next));
  if (bytes > MAX_BOARD_BYTES)
    fail(`board would be ${Math.round(bytes / 1024)} KiB, over the ${Math.round(MAX_BOARD_BYTES / 1024)} KiB limit: delete or simplify items (large SVG sources count most)`);

  next.updatedAt = nowIso();
  return { board: next, warnings, touched: [...touched] };
}

/** applyUpdateReport's board only. */
export function applyUpdate(state, update, opts) {
  return applyUpdateReport(state, update, opts).board;
}

/**
 * Chapter ops: {op:"add", id?, title, x?, y?, w?, h?, frame?} (a missing x goes to the right
 * of the rightmost chapter, a missing y to the last chapter's row), {op:"update", id, ...fields},
 * {op:"delete", id, keepItems?} (deletes the chapter's items unless keepItems).
 */
function applyChapterOps(board, ops, strict, touched) {
  if (!Array.isArray(ops)) fail("chapters must be an array");
  ops.forEach((op, i) => {
    const where = `chapters[${i}]`;
    if (!op || typeof op !== "object") fail(`${where}: invalid chapter op`);
    const { op: kind, ...fields } = op;
    if (kind === "add") {
      if (board.chapters.length >= MAX_CHAPTERS) fail(`too many chapters (max ${MAX_CHAPTERS})`);
      if (strict) onlyKeys(fields, CHAPTER_KEYS, where);
      const raw = { ...fields };
      const last = board.chapters[board.chapters.length - 1];
      if (raw.x === undefined) raw.x = board.chapters.length ? Math.max(...board.chapters.map((c) => c.x + c.w)) + CHAPTER.gap : 0;
      if (raw.y === undefined) raw.y = last ? last.y : 0;
      const ch = sanitizeChapter(raw, { strict, where });
      if (board.chapters.some((c) => c.id === ch.id)) fail(`${where}: duplicate chapter id: ${ch.id}`);
      board.chapters.push(ch);
    } else if (kind === "update") {
      const i = board.chapters.findIndex((c) => c.id === op.id);
      if (i === -1) fail(`${where}: unknown chapter id: ${op.id}`);
      const { id: _id, ...changes } = fields;
      if (strict) onlyKeys(changes, CHAPTER_KEYS, where);
      board.chapters[i] = sanitizeChapter({ ...board.chapters[i], ...changes, id: board.chapters[i].id }, { strict, where });
      // Moving a chapter moves its items: their layout warnings belong to this update.
      for (const it of sceneItems(board)) if (it.chapter === op.id) touched.add(it.id);
    } else if (kind === "delete") {
      if (strict) onlyKeys(fields, keys("id", "keepItems"), where);
      const i = board.chapters.findIndex((c) => c.id === op.id);
      if (i === -1) fail(`${where}: unknown chapter id: ${op.id}`);
      board.chapters.splice(i, 1);
      const inChapter = (it) => it.chapter === op.id;
      if (op.keepItems) for (const it of sceneItems(board)) { if (inChapter(it)) { delete it.chapter; touched.add(it.id); } }
      else {
        board.scene.shapes = board.scene.shapes.filter((it) => !inChapter(it));
        board.scene.artifacts = board.scene.artifacts.filter((it) => !inChapter(it));
        board.equations = board.equations.filter((it) => !inChapter(it));
      }
    } else fail(`${where}: invalid chapter op: ${show(kind)} (add, update or delete)`);
  });
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

/**
 * Generic per-item edits that work for every kind of board item:
 *   {op:"update", id, fields:{...}} (or the fields inline)  merge fields and re-validate
 *   {op:"move", id, dx, dy}       translate (points, x/y, or equation box)
 *   {op:"delete", id}
 */
function applyItemOps(board, ops, strict, touched) {
  if (!Array.isArray(ops)) fail("items must be an array");
  if (ops.length > 500) fail("too many item ops (max 500)");
  ops.forEach((op, n) => {
    if (!op || typeof op !== "object" || typeof op.id !== "string") fail(`items[${n}]: item op requires an id`);
    const where = `items[${n}] (${show(op.op)} "${op.id.slice(0, 64)}")`;
    const found = findItem(board, op.id);
    if (!found) fail(`${where}: unknown item id: ${op.id}`);
    const { list, i, kind } = found;
    const cur = list[i];
    if (op.op === "delete") {
      if (strict) onlyKeys(op, keys("op", "id"), where);
      list.splice(i, 1);
      return;
    }
    let next;
    if (op.op === "move") {
      if (strict) onlyKeys(op, keys("op", "id", "dx", "dy"), where);
      const r = reader(op, where, strict);
      const dx = r.num("dx", 0), dy = r.num("dy", 0);
      next = clone(cur);
      if (Array.isArray(next.points)) next.points = next.points.map(([x, y]) => [x + dx, y + dy]);
      else {
        // Stored boards always have x,y; an equation from an older state moves from where the page drew it.
        const [x0, y0] = kind === "equations" ? legacyEquationPositions(list).get(cur) ?? [cur.x, cur.y] : [cur.x, cur.y];
        next.x = NUMBER(x0) + dx;
        next.y = NUMBER(y0) + dy;
      }
    } else if (op.op === "update") {
      const { op: _op, id: _id, fields: wrapped, ...inline } = op;
      if (wrapped !== undefined && (typeof wrapped !== "object" || wrapped === null || Array.isArray(wrapped))) fail(`${where}: fields must be an object`);
      const fields = { ...inline, ...(wrapped ?? {}) };
      if ("id" in fields && fields.id !== cur.id) fail(`${where}: an item's id cannot change (delete it and add a new one)`);
      if ("type" in fields && fields.type !== cur.type) fail(`${where}: an item's type cannot change (delete it and add a new one)`);
      const allowed = kind === "equations" ? EQUATION_KEYS : kind === "shapes" ? SHAPE_KEYS[cur.type] : ARTIFACT_KEYS[cur.type];
      if (strict) onlyKeys(fields, allowed, where);
      next = { ...cur, ...fields, id: cur.id, type: cur.type };
      if (kind === "equations") delete next.type;
    } else fail(`${where}: invalid item op: ${show(op.op)} (update, move or delete)`);
    const opts = { strict, keys: false, where };
    list[i] = kind === "shapes" ? shapeOf(next, opts) : kind === "artifacts" ? sanitizeArtifact(next, opts) : equationOf(next, opts);
    touched.add(cur.id);
  });
}

/* ------------------------------------------------------------------ */
/* Restoring saved boards                                              */
/* ------------------------------------------------------------------ */

/** "2 shapes, 1 artifact (unknown icon "x"), ..." for a restore or load report; "" when nothing was dropped. */
export function describeDropped(dropped) {
  if (!dropped) return "";
  const parts = [];
  const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
  for (const [key, one, many] of [["chapters", "chapter"], ["shapes", "shape"], ["artifacts", "artifact"], ["equations", "equation"], ["duplicates", "item with a duplicate id", "items with duplicate ids"], ["elements", "unsupported Excalidraw element"]])
    if (dropped[key]) parts.push(plural(dropped[key], one, many));
  let text = parts.length ? `skipped ${parts.join(", ")}` : "";
  if (dropped.reasons?.length) text += ` (${dropped.reasons.join("; ")})`;
  const notes = [];
  if (dropped.references) notes.push(`${plural(dropped.references, "item")} lost a missing chapter and now use board coordinates`);
  if (dropped.camera) notes.push("the camera went home (its chapter was missing)");
  return [text, ...notes].filter(Boolean).join("; ");
}

/**
 * Turn an untrusted saved board into a full-replace update and report what could not be used.
 * Everything is re-validated (leniently: fields that older versions wrote are tolerated);
 * unusable items and duplicate ids are skipped instead of failing the whole load, and counted.
 * Excalidraw elements from 0.2 saves become shapes, and equations saved without x,y keep the
 * place the page drew them at, so old lessons look the same.
 */
export function restoreOps(saved) {
  const dropped = { chapters: 0, shapes: 0, artifacts: 0, equations: 0, duplicates: 0, elements: 0, references: 0, camera: false, reasons: [] };
  const reason = (message) => {
    if (dropped.reasons.length < 3 && !dropped.reasons.includes(message)) dropped.reasons.push(message.slice(0, 160));
  };
  const board = saved && typeof saved === "object" ? saved : {};
  const take = (list, max, key, fn) => {
    const out = [];
    for (const raw of Array.isArray(list) ? list : []) {
      if (out.length >= max) { dropped[key]++; reason(`more than ${max} ${key}`); continue; }
      try {
        const item = fn(raw);
        if (item) out.push(item);
        else { dropped[key]++; reason(`invalid ${key.slice(0, -1)}`); }
      } catch (err) {
        dropped[err.duplicate ? "duplicates" : key]++;
        reason(String(err.message));
      }
    }
    return out;
  };
  const chapterIds = new Set();
  const duplicate = (message) => Object.assign(new Error(message), { duplicate: true });
  const chapters = take(board.chapters, MAX_CHAPTERS, "chapters", (c) => {
    const ch = sanitizeChapter(c);
    if (ch && chapterIds.has(ch.id)) throw duplicate(`duplicate chapter id "${ch.id}"`);
    if (ch) chapterIds.add(ch.id);
    return ch;
  });
  const fix = (it) => {
    if (it && typeof it === "object" && it.chapter !== undefined && !chapterIds.has(it.chapter)) {
      dropped.references++;
      const { chapter: _c, ...rest } = it;
      return rest;
    }
    return it;
  };
  const ids = new Set();
  const unique = (item) => {
    if (ids.has(item.id)) throw duplicate(`duplicate id "${item.id}"`);
    ids.add(item.id);
    return item;
  };
  // Excalidraw elements (saves from 0.2 and earlier) become shapes, as the 0.2 page drew them.
  const legacy = [];
  for (const e of Array.isArray(board.scene?.elements) ? board.scene.elements : []) {
    const shape = shapeFromElement(e);
    if (shape) legacy.push(shape);
    else if (!e?.isDeleted) { dropped.elements++; reason(`unsupported Excalidraw element ${show(e?.type)}`); }
  }
  const shapes = take([...(Array.isArray(board.scene?.shapes) ? board.scene.shapes : []), ...legacy], MAX_SCENE_ITEMS, "shapes", (s) => unique(shapeOf(fix(s), { where: "a shape" })));
  const artifacts = take(board.scene?.artifacts, MAX_SCENE_ITEMS - shapes.length, "artifacts", (a) => unique(sanitizeArtifact(fix(a), { where: "an artifact" })));
  // Equations saved without x,y get the place the page drew them at, then keep it.
  const rawEquations = (Array.isArray(board.equations) ? board.equations : []).map(fix);
  const legacyPositions = legacyEquationPositions(rawEquations);
  const equations = take(rawEquations, MAX_EQUATIONS, "equations", (e) => {
    const eq = unique(equationOf(e, { where: "an equation" }));
    const at = legacyPositions.get(e);
    if (eq && at) [eq.x, eq.y] = at;
    return eq;
  });
  let camera = null;
  try {
    camera = sanitizeCamera(board.camera, chapters);
  } catch {
    dropped.camera = true;
  }
  const update = {
    clear: ["all"],
    title: typeof board.title === "string" ? board.title.slice(0, 200) : DEFAULT_TITLE,
    chapters: chapters.map((c) => ({ ...c, op: "add" })),
    equations: equations.map((e) => ({ ...e, op: "add" })),
    scene: { mode: "replace", shapes, artifacts },
    camera,
  };
  const any = dropped.chapters + dropped.shapes + dropped.artifacts + dropped.equations + dropped.duplicates + dropped.elements + dropped.references > 0 || dropped.camera;
  return { update, dropped: any ? dropped : null };
}

/**
 * One Excalidraw element from a 0.2 save as a shape, with the mapping the 0.2 page used to draw
 * it (text baseline below its top, points relative to the element, the default dark stroke as
 * chalk). Deleted and unsupported elements give null.
 */
function shapeFromElement(e) {
  if (!e || typeof e !== "object" || e.isDeleted) return null;
  const n = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const color = e.strokeColor === "#1e1e1e" ? CHALK : COLOR(e.strokeColor) ?? CHALK;
  const id = VALID_ID(e.id) ? e.id : undefined;
  if (e.type === "text" && typeof e.text === "string")
    return { type: "text", id, x: n(e.x), y: n(e.y) + (n(e.fontSize) || 20), text: e.text, ...(n(e.fontSize) ? { size: e.fontSize } : {}), color };
  if (["line", "arrow", "freedraw"].includes(e.type) && Array.isArray(e.points))
    return { type: e.type === "arrow" ? "arrow" : "line", id, points: e.points.filter(Array.isArray).map(([x, y]) => [n(e.x) + n(x), n(e.y) + n(y)]), color, ...(n(e.strokeWidth) ? { width: e.strokeWidth } : {}) };
  if (e.type === "rectangle" || e.type === "ellipse")
    return { type: e.type === "rectangle" ? "rect" : "ellipse", id, x: n(e.x), y: n(e.y), w: n(e.width), h: n(e.height), color };
  return null;
}

/* ------------------------------------------------------------------ */
/* Process-wide state                                                  */
/* ------------------------------------------------------------------ */

// Kept on globalThis, not in this module, because pi's /reload imports a fresh copy of this
// module: a board started after a reload reuses the previous token and port, so an open tab
// reconnects to it.
const SESSIONS = (globalThis[Symbol.for("math-board.sessions")] ??= new Map()); // dataDir -> { token, port }
const LIVE = (globalThis[Symbol.for("math-board.live")] ??= new Set()); // instance ids of running servers

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

const SNAPSHOT_HEADER = "x-math-board-snapshot";
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

/* ------------------------------------------------------------------ */
/* BoardServer                                                        */
/* ------------------------------------------------------------------ */

export class BoardServer {
  constructor({ dataDir, title, autosave = true, kind = "pi" } = {}) {
    this.dataDir = path.resolve(dataDir ?? defaultDataDir(kind));
    this.autosave = autosave;
    this.autosaveTimer = null;
    this.autosavedRevision = 0; // revision 0 is the empty board: nothing to write until a change
    this.restoredFrom = null;
    this.restoreNotice = null; // what restoring the autosave skipped or moved aside
    this.restoreNoticeReported = false;
    this.lastAutosaveError = null; // { message, at } of the last failed autosave, null after a success
    this.autosaveBlocked = null; // why autosave is off (an autosave that could not be read or moved aside)
    this.lastBackupAt = Date.now(); // a backup is due on the first write anyway (see rotateBackups)
    this.lastWritten = null; // { mtimeMs, size } of our last autosave.json write
    this.sharedWith = null; // another live board server on this data folder: { pid, port, started }
    this.instance = randomUUID();
    this.token = randomBytes(32).toString("hex");
    this.board = emptyBoard(title);
    this.revision = 0;
    this.startedAt = null;
    this.server = null;
    this.port = null;
    this.url = null;
    this.clients = new Set(); // SSE responses; the headless snapshot page's are marked .snapshot
    this.starting = null;
    this.stopping = false;
    this.stopped = false;
    this.saveQueue = Promise.resolve();
    this.snapshots = new Snapshotter(this);
  }

  /* ---------------- in-process API (used by model tools) ----------- */

  getState() {
    return clone(this.board);
  }

  /** Browsers showing the board: SSE connections other than the headless snapshot page's. */
  viewerCount() {
    let n = 0;
    for (const res of this.clients) if (!res.snapshot) n++;
    return n;
  }

  /**
   * Apply an update with compare-and-swap on baseRevision. Throws an Error with `conflict` on a
   * revision mismatch and a plain Error with the reason when the update is invalid (nothing is
   * applied then). Returns { revision, warnings, touched } (see applyUpdateReport).
   */
  apply({ baseRevision, ...update }, { strict = true } = {}) {
    if (this.stopping || this.stopped) fail("this board server was stopped; call board_open to start the board again");
    if (baseRevision !== undefined) this.checkRevision(baseRevision);
    const { board, warnings, touched } = applyUpdateReport(this.board, update, { strict });
    this.board = board;
    this.revision += 1;
    this.broadcast({ type: "revision", revision: this.revision });
    this.scheduleAutosave();
    return { revision: this.revision, warnings, touched };
  }

  /** Throw a conflict error (err.conflict = { currentRevision }) unless baseRevision is the current revision. */
  checkRevision(baseRevision) {
    if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) fail("invalid baseRevision");
    if (baseRevision !== this.revision) {
      const err = new Error(`conflict: board is at revision ${this.revision}, update was based on ${baseRevision}. Re-read the board and re-apply.`);
      err.conflict = { currentRevision: this.revision };
      throw err;
    }
  }

  /** apply() returning the new revision only. */
  update(update) {
    return this.apply(update).revision;
  }

  clear(scopes = ["all"]) {
    return this.update({ clear: scopes });
  }

  /**
   * What the model and the learner should know about this board's storage, as warning lines:
   * the last failed autosave, autosave switched off, what restoring the autosave skipped or moved
   * aside, and another live board on the same data folder. `once` marks the restore notice as
   * reported (board_update shows it once; board_read and /board status always).
   */
  notices({ once = false } = {}) {
    const out = [];
    if (this.autosaveBlocked) out.push(`WARNING: autosave is off for this board: ${this.autosaveBlocked}`);
    else if (this.lastAutosaveError)
      out.push(`WARNING: the last autosave failed (${this.lastAutosaveError.message}); changes since ${this.lastAutosaveError.since} are not on disk. Set MATH_BOARD_DATA_DIR to a writable folder and restart, or save the lesson somewhere that works.`);
    if (this.restoreNotice && !(once && this.restoreNoticeReported)) out.push(this.restoreNotice);
    if (once) this.restoreNoticeReported = true;
    const other = this.sharedWith && (this.sharedWith.pid === process.pid ? LIVE.has(this.sharedWith.instance) : pidAlive(this.sharedWith.pid)) ? this.sharedWith : null;
    if (other)
      out.push(`WARNING: another board (process ${other.pid}, port ${other.port}, started ${other.started}) uses the same data folder ${this.dataDir}. Both write autosave.json, so the last change wins (older copies: autosave.1.json to autosave.${AUTOSAVE_BACKUPS}.json). Give each its own folder with MATH_BOARD_DATA_DIR.`);
    return out;
  }

  async savesDir() {
    const dir = path.join(this.dataDir, "saves");
    await mkdir(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  payload(name) {
    return { schemaVersion: SCHEMA_VERSION, name, revision: this.revision, savedAt: nowIso(), board: this.getState() };
  }

  async save(name = "default") {
    if (!SAVE_NAME_RE.test(name)) fail(`invalid save name: ${JSON.stringify(name)} (letters, digits, . _ -; at most 64; not starting with a dot)`);
    const payload = this.payload(name);
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
    let files;
    try {
      files = await readdir(path.join(this.dataDir, "saves"));
    } catch (err) {
      if (err?.code === "ENOENT") return [];
      throw err;
    }
    return files.filter((f) => f.endsWith(".json") && !f.startsWith(".")).map((f) => f.replace(/\.json$/, "")).sort();
  }

  /** Read and parse a board JSON file (save slot or autosave), bounded in size. */
  async readBoardFile(file) {
    if ((await stat(file)).size > MAX_BOARD_BYTES + 4096) fail("save too large");
    let payload;
    try {
      payload = JSON.parse(await readFile(file, "utf-8"));
    } catch (err) {
      if (err instanceof SyntaxError) fail("save is corrupt (not valid JSON)");
      throw err;
    }
    if (!payload || typeof payload !== "object" || !payload.board || typeof payload.board !== "object") fail("save is corrupt (no board)");
    if (Number.isInteger(payload.schemaVersion) && payload.schemaVersion > SCHEMA_VERSION)
      fail(`save was written by a newer math-board (format ${payload.schemaVersion}; this version reads ${SCHEMA_VERSION}): update the package`);
    return payload;
  }

  /** See restoreOps. */
  restoreOps(saved) {
    return restoreOps(saved);
  }

  /**
   * Load a named save over the whole board (compare-and-swap on baseRevision). Returns
   * { revision, dropped, skipped }: skipped describes what the save had that could not be used.
   */
  async load(name = "default", baseRevision = this.revision) {
    if (!SAVE_NAME_RE.test(name)) fail(`invalid save name: ${JSON.stringify(name)}`);
    let payload;
    try {
      payload = await this.readBoardFile(path.join(this.dataDir, "saves", `${name}.json`));
    } catch (err) {
      if (err?.code === "ENOENT") fail(`no save named ${JSON.stringify(name)}`);
      fail(`save ${name}: ${firstLine(err).replace(/^save /, "")}`);
    }
    const { update, dropped } = restoreOps(payload.board);
    const { revision } = this.apply({ baseRevision, ...update }, { strict: false });
    return { revision, dropped, skipped: describeDropped(dropped) };
  }

  /* ---------------- autosave ---------------------------------------- */
  // Every change is written (debounced) to <dataDir>/autosave.json; a fresh server restores it on
  // start, so /reload or a restart keeps the board.

  get autosaveFile() {
    return path.join(this.dataDir, "autosave.json");
  }

  scheduleAutosave() {
    if (!this.autosave || this.stopped) return;
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = setTimeout(() => { this.flushAutosave().catch(() => {}); }, 400);
    this.autosaveTimer.unref?.();
  }

  /**
   * Copy autosave.json to autosave.1.json (shifting older copies up to AUTOSAVE_BACKUPS) before
   * this server first overwrites it, when another process wrote it since our last write, and at
   * most every 10 minutes otherwise.
   */
  async rotateBackups() {
    let current;
    try {
      current = await stat(this.autosaveFile);
    } catch {
      return;
    }
    const foreign = !this.lastWritten || current.mtimeMs !== this.lastWritten.mtimeMs || current.size !== this.lastWritten.size;
    if (!foreign && Date.now() - this.lastBackupAt < BACKUP_INTERVAL_MS) return;
    const backup = (n) => path.join(this.dataDir, `autosave.${n}.json`);
    for (let n = AUTOSAVE_BACKUPS - 1; n >= 1; n--) await rename(backup(n), backup(n + 1)).catch(() => {});
    await copyFile(this.autosaveFile, backup(1));
    this.lastBackupAt = Date.now();
  }

  flushAutosave() {
    clearTimeout(this.autosaveTimer);
    this.autosaveTimer = null;
    if (!this.autosave || this.autosaveBlocked || this.stopped || this.autosavedRevision === this.revision) return this.saveQueue;
    const payload = this.payload("autosave");
    const job = this.saveQueue.then(async () => {
      try {
        await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
        this.checkLock();
        await this.rotateBackups();
        const temp = path.join(this.dataDir, `.autosave-${randomUUID()}.tmp`);
        try {
          await writeFile(temp, JSON.stringify(payload), { mode: 0o600 });
          await rename(temp, this.autosaveFile);
        } finally {
          await rm(temp, { force: true });
        }
        const written = await stat(this.autosaveFile);
        this.lastWritten = { mtimeMs: written.mtimeMs, size: written.size };
        this.autosavedRevision = payload.revision;
        this.lastAutosaveError = null;
      } catch (err) {
        this.lastAutosaveError = { message: firstLine(err), at: nowIso(), since: this.lastAutosaveError?.since ?? `revision ${this.autosavedRevision}` };
        throw err;
      }
    });
    this.saveQueue = job.catch(() => {});
    return job;
  }

  /** Move an unusable autosave aside (never overwrite it). Returns the new file name, or null. */
  async moveAside(file) {
    const aside = path.join(this.dataDir, `autosave.corrupt-${nowIso().replace(/[:.]/g, "-")}.json`);
    try {
      await rename(file, aside);
      return path.basename(aside);
    } catch {
      return null;
    }
  }

  /** Restore the last autosaved board (once, on start). Returns true if restored. */
  async restoreAutosave() {
    if (!this.autosave || this.revision !== 0) return false;
    let payload;
    const unusable = async (why) => {
      const aside = await this.moveAside(this.autosaveFile);
      if (aside) this.restoreNotice = `WARNING: the autosave could not be restored (${why}). It was moved to ${aside} in ${this.dataDir}, and this board started empty.`;
      else {
        this.autosaveBlocked = `autosave.json in ${this.dataDir} could not be restored (${why}) or moved aside, so it is left untouched. Fix or remove it and restart the board.`;
        this.restoreNotice = `WARNING: the autosave could not be restored (${why}); this board started empty.`;
      }
      return false;
    };
    try {
      payload = await this.readBoardFile(this.autosaveFile);
    } catch (err) {
      if (err?.code === "ENOENT") return false;
      return unusable(firstLine(err));
    }
    try {
      const { update, dropped } = restoreOps(payload.board);
      this.apply(update, { strict: false });
      this.autosavedRevision = this.revision;
      this.restoredFrom = payload.savedAt;
      if (dropped) this.restoreNotice = `Restoring the autosave of ${payload.savedAt}: ${describeDropped(dropped)}.`;
      return true;
    } catch (err) {
      return unusable(firstLine(err));
    }
  }

  /* ---------------- lock file ---------------------------------------- */

  get lockFile() {
    return path.join(this.dataDir, "board.lock");
  }

  /** Note another live board server on this data folder (it stays allowed; see notices()). */
  checkLock() {
    let lock;
    try {
      lock = JSON.parse(readFileSync(this.lockFile, "utf8"));
    } catch {
      return;
    }
    if (!lock || lock.instance === this.instance) return;
    const alive = lock.pid === process.pid ? LIVE.has(lock.instance) : pidAlive(lock.pid);
    if (alive) this.sharedWith = { pid: lock.pid, port: lock.port, started: lock.started, instance: lock.instance };
  }

  writeLock() {
    try {
      writeFileSync(this.lockFile, JSON.stringify({ pid: process.pid, port: this.port, started: this.startedAt, instance: this.instance }), { mode: 0o600 });
    } catch {
      // An unwritable data folder shows up as a failed autosave.
    }
  }

  releaseLock() {
    try {
      if (JSON.parse(readFileSync(this.lockFile, "utf8")).instance === this.instance) unlinkSync(this.lockFile);
    } catch {}
  }

  /* ---------------- HTTP server ------------------------------------ */

  async start() {
    if (this.starting) return this.starting;
    if (this.server) return this;
    this.stopped = false;
    this.stopping = false;
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
    const bind = (port) =>
      new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", reject);
          resolve();
        });
      });
    // Within one process, a board on the same data folder reuses the last token and port, so a
    // tab left open across /reload or /board stop reconnects by itself.
    const previous = SESSIONS.get(this.dataDir);
    const reuse = previous && ![...LIVE].some((id) => previous.owner === id);
    if (reuse) this.token = previous.token;
    try {
      await bind(reuse ? previous.port : 0);
    } catch (err) {
      if (!reuse || err?.code !== "EADDRINUSE") throw err;
      await bind(0);
    }
    const addr = server.address();
    this.port = addr.port;
    this.url = `http://127.0.0.1:${addr.port}/#token=${this.token}`;
    this.server = server;
    this.startedAt = nowIso();
    LIVE.add(this.instance);
    SESSIONS.set(this.dataDir, { token: this.token, port: this.port, owner: this.instance });
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 }).catch(() => {});
    this.checkLock();
    this.writeLock();
    await this.restoreAutosave();
    return this;
  }

  async stop() {
    if (this.starting) await this.starting.catch(() => {});
    this.stopping = true; // updates from now on are rejected; the autosave below has the final state
    await this.flushAutosave().catch(() => {});
    await this.saveQueue;
    this.stopped = true;
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
    LIVE.delete(this.instance);
    this.releaseLock();
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

  async readBody(req, res) {
    const declared = Number(req.headers["content-length"] ?? 0);
    if (declared > MAX_BODY_BYTES) {
      this.json(res, 413, { ok: false, error: "payload too large" });
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
          this.json(res, 413, { ok: false, error: "payload too large" });
          req.destroy();
          resolve(null);
          return;
        }
        chunks.push(c);
      });
      req.on("end", () => {
        if (done) return;
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("object required");
          resolve(body);
        } catch {
          this.json(res, 400, { ok: false, error: "invalid JSON body" });
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
      // Every route: exact loopback Host (DNS rebinding) and, when sent, the board's own Origin.
      if (req.headers.host !== `127.0.0.1:${this.port}`) return this.json(res, 403, { ok: false, error: "forbidden host" });
      if (req.headers.origin !== undefined && !this.allowedOrigin(req.headers.origin)) return this.json(res, 403, { ok: false, error: "forbidden origin" });
      let pathname, url;
      try {
        url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
        pathname = decodeURIComponent(url.pathname);
      } catch {
        return this.json(res, 400, { ok: false, error: "malformed URL" });
      }
      // Static app routes (page load carries no auth yet; the app reads the token from the URL
      // fragment and sends it on every API call).
      if (req.method === "GET" && !pathname.startsWith("/api/")) {
        const rel = pathname === "/" ? "index.html" : pathname.slice(1);
        if (!rel.split("/").every((part) => /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(part))) return this.notFound(res);
        const type = MIME[path.extname(rel)];
        if (!type) return this.notFound(res);
        return this.serveFile(res, rel, type);
      }

      if (pathname === "/api/events" && req.method === "GET") {
        // EventSource cannot set an Authorization header; this route takes the token as a query parameter.
        if (url.searchParams.get("token") !== this.token) return this.json(res, 401, { ok: false, error: "missing or invalid token" });
        if (this.clients.size >= 32) return this.json(res, 429, { ok: false, error: "too many browser connections" });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        res.write(`data: ${JSON.stringify({ type: "hello", revision: this.revision })}\n\n`);
        // The headless snapshot page marks its requests, so it is not counted as a viewer.
        res.snapshot = req.headers[SNAPSHOT_HEADER] === "1";
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

      if (req.headers.authorization !== `Bearer ${this.token}`) return this.json(res, 401, { ok: false, error: "missing or invalid bearer token" });

      if (req.method === "GET" && pathname === "/api/state") return this.json(res, 200, { ok: true, revision: this.revision, board: this.board });
      if (req.method === "GET" && pathname === "/api/saves") return this.json(res, 200, { ok: true, saves: await this.listSaves() });

      if (req.method === "POST") {
        if (Number(req.headers["content-length"]) > MAX_BODY_BYTES) return this.json(res, 413, { ok: false, error: "payload too large" });
        if (req.headers["content-type"]?.split(";")[0].trim() !== "application/json") return this.json(res, 415, { ok: false, error: "application/json required" });
        const body = await this.readBody(req, res);
        if (body === null) return; // already answered (413/400)
        if (["/api/update", "/api/clear", "/api/load"].includes(pathname) && !Number.isSafeInteger(body.baseRevision))
          return this.json(res, 400, { ok: false, error: "baseRevision is required" });
        const failed = (err, code = 400) => this.json(res, err.conflict ? 409 : code, { ok: false, error: String(err.message ?? err), revision: this.revision, board: this.board });
        const BODY_KEYS = { "/api/clear": keys("baseRevision", "scopes"), "/api/save": keys("baseRevision", "name"), "/api/load": keys("baseRevision", "name") };
        try {
          // A stale page gets the 409 first (with the current board, to re-read and ask again);
          // a save from the page's view must not save a board the learner has not seen.
          if (BODY_KEYS[pathname] && body.baseRevision !== undefined) this.checkRevision(body.baseRevision);
          if (BODY_KEYS[pathname]) onlyKeys(body, BODY_KEYS[pathname], pathname);
        } catch (err) {
          return failed(err);
        }
        switch (pathname) {
          case "/api/update": {
            try {
              const { revision, warnings } = this.apply(body);
              return this.json(res, 200, { ok: true, revision, warnings, board: this.board });
            } catch (err) {
              return failed(err);
            }
          }
          case "/api/clear":
            try {
              this.update({ baseRevision: body.baseRevision, clear: body.scopes ?? ["all"] });
              return this.json(res, 200, { ok: true, revision: this.revision, board: this.board });
            } catch (err) {
              return failed(err);
            }
          case "/api/save": {
            try {
              const saved = await this.save(String(body?.name ?? "default"));
              return this.json(res, 200, { ok: true, saved });
            } catch (err) {
              return this.json(res, 400, { ok: false, error: String(err.message ?? err) });
            }
          }
          case "/api/load": {
            try {
              const { revision, skipped } = await this.load(String(body?.name ?? "default"), body.baseRevision);
              return this.json(res, 200, { ok: true, revision, skipped, board: this.board });
            } catch (err) {
              return failed(err, /^no save named/.test(err.message) ? 404 : 400);
            }
          }
        }
      }

      return this.notFound(res);
    } catch (err) {
      if (!res.headersSent) {
        try {
          this.json(res, err.conflict ? 409 : 400, { ok: false, error: String(err?.message ?? err), revision: this.revision, board: this.board });
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
    if (!abs.startsWith(path.join(__dirname, "public") + path.sep)) return this.notFound(res);
    try {
      const data = await readFile(abs);
      res.writeHead(200, { "content-type": type, "cache-control": "no-store", "content-length": data.length });
      res.end(data);
    } catch {
      this.notFound(res);
    }
  }
}

/** Open a URL in the default browser (best effort; macOS and Linux). */
export async function openBrowser(url) {
  const cmd = platform() === "darwin" ? "open" : "xdg-open";
  try {
    const { execFile } = await import("node:child_process");
    await new Promise((resolve, reject) => execFile(cmd, [url], { timeout: 10000 }, (err) => (err ? reject(err) : resolve())));
    return true;
  } catch {
    return false;
  }
}
