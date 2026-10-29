import React from "react";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import katex from "katex";
import "katex/contrib/mhchem"; // \ce{...} chemical equations and \pu{...} units
import mermaid from "mermaid";
import "katex/dist/katex.min.css";
import { BoardSync, LiveEvents } from "../public/sync.js";
import { compileExpr } from "../shared/expr.mjs";
import SmilesDrawer from "smiles-drawer";

const $ = (id) => document.getElementById(id);
const hash = new URLSearchParams(location.hash.slice(1));
const sessionToken = hash.get("token");
const bar = $("bar");
let noteTimer = 0;
/**
 * The status line in the bar. Routine text ("Connected · revision 4") shows only in its open menu;
 * a note (the result of Save or Clear, an error) shows on the pill itself for a while.
 */
function status(text, note = false) {
  $("conn").textContent = text;
  clearTimeout(noteTimer);
  bar.classList.toggle("note", note);
  if (note) noteTimer = setTimeout(() => bar.classList.remove("note"), 6000);
}
async function request(path, body) {
  let response;
  try {
    response = await fetch(path, { headers: { Authorization: `Bearer ${sessionToken}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, method: body === undefined ? "GET" : "POST", body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new Error("Cannot reach the board server");
  }
  return { ...(await response.json().catch(() => ({ ok: false, error: `HTTP ${response.status}` }))), status: response.status };
}

/* ---------- render readiness (used by headless snapshots) ---------- */
// window.__board.revision is the last revision fully committed to the DOM;
// pending counts async work (diagram rendering, image decoding) still running.
window.__board = { revision: -1, pending: 0 };
function track(promise) {
  window.__board.pending++;
  return Promise.resolve(promise).catch(() => {}).finally(() => { window.__board.pending--; });
}

/* ---------- view (board-space window shown in the browser) ---------- */
const BOARD = { w: 1200, h: 800 };
function parseView(v) {
  const n = String(v || "").split(",").map(Number);
  return n.length === 4 && n.every(Number.isFinite) && n[2] > 0 && n[3] > 0 ? n : [0, 0, BOARD.w, BOARD.h];
}
const HOME = [0, 0, BOARD.w, BOARD.h];
let currentView = parseView(hash.get("view"));
// Headless snapshots pick their own regions, so they never follow the camera.
const NO_FOLLOW = hash.get("nofollow") === "1";
let follow = !NO_FOLLOW;
let anim = null;
// Apply the view straight to the DOM: panning must not re-render (and re-typeset) the board.
function setView(v) {
  currentView = v;
  const svg = $("blackboard");
  svg?.setAttribute("viewBox", v.join(" "));
  updateViewScale(svg);
  scheduleRef();
}
/** Board units per screen pixel as a CSS variable, for text that keeps a minimum on-screen size. */
function updateViewScale(svg = $("blackboard")) {
  const w = svg?.clientWidth, h = svg?.clientHeight;
  if (!w || !h) return;
  svg.style.setProperty("--view-scale", String(Math.max(currentView[2] / w, currentView[3] / h)));
}
window.__setView = (x, y, w, h) => { stopAnim(); setView(parseView([x, y, w, h].join(","))); };
function stopAnim() { if (anim) cancelAnimationFrame(anim); anim = null; }
/** Smooth camera move (ease in-out), zooming out a little mid-flight for long hops. */
function animateTo(target, ms = 750) {
  stopAnim();
  cameraBusyUntil = performance.now() + ms;
  const from = currentView.slice(), t0 = performance.now();
  const dist = Math.hypot(target[0] - from[0], target[1] - from[1]);
  const lift = Math.min(0.6, dist / Math.max(from[2], target[2]) * 0.25);
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms), k = ease(t), bump = 1 + lift * Math.sin(Math.PI * t);
    const v = from.map((f, i) => f + (target[i] - f) * k);
    const cx = v[0] + v[2] / 2, cy = v[1] + v[3] / 2, w = v[2] * bump, h = v[3] * bump;
    setView([cx - w / 2, cy - h / 2, w, h]);
    anim = t < 1 ? requestAnimationFrame(step) : null;
  };
  anim = requestAnimationFrame(step);
}

/* ---------- camera & chapters ---------- */
const chaptersOf = (board) => board?.chapters ?? [];
function cameraView(board) {
  const cam = board?.camera;
  if (cam?.chapter) { const c = chaptersOf(board).find((ch) => ch.id === cam.chapter); if (c) return [c.x, c.y, c.w, c.h]; }
  else if (cam) return [cam.x, cam.y, cam.w, cam.h];
  return HOME;
}
function overviewView(board) {
  const rects = chaptersOf(board).map((c) => [c.x, c.y, c.w, c.h]);
  if (!rects.length) { const bb = $("blackboard")?.getBBox(); if (bb && bb.width) rects.push([bb.x, bb.y, bb.width, bb.height]); else rects.push(HOME); }
  const x0 = Math.min(...rects.map((r) => r[0])), y0 = Math.min(...rects.map((r) => r[1]));
  const x1 = Math.max(...rects.map((r) => r[0] + r[2])), y1 = Math.max(...rects.map((r) => r[1] + r[3]));
  const m = Math.max(x1 - x0, y1 - y0) * 0.04;
  return [x0 - m, y0 - m, x1 - x0 + 2 * m, y1 - y0 + 2 * m];
}
function currentChapterIndex(board) {
  const cx = currentView[0] + currentView[2] / 2, cy = currentView[1] + currentView[3] / 2;
  const list = chaptersOf(board);
  let best = -1, bestD = Infinity;
  list.forEach((c, i) => { const d = Math.hypot(c.x + c.w / 2 - cx, c.y + c.h / 2 - cy); if (d < bestD) { bestD = d; best = i; } });
  return best;
}
function setFollow(on) {
  follow = on && !NO_FOLLOW;
  $("btn-follow")?.classList.toggle("active", follow);
  if (follow && lastData) animateTo(cameraView(lastData.board));
}
/** Manual navigation by the viewer pauses camera following. */
function manual() { stopAnim(); if (follow) setFollow(false); }
function goChapter(delta) {
  const list = chaptersOf(lastData?.board);
  if (!list.length) return;
  const i = currentChapterIndex(lastData.board);
  const c = list[Math.max(0, Math.min(list.length - 1, i + delta))];
  manual();
  animateTo([c.x, c.y, c.w, c.h]);
}
let lastCameraKey = null;
/** After each render: follow camera changes with a smooth move. */
function syncCamera(board, first) {
  const key = JSON.stringify(cameraView(board));
  if (NO_FOLLOW) { lastCameraKey = key; return; }
  if (first && !hash.get("view")) setView(cameraView(board));
  else if (follow && key !== lastCameraKey && lastCameraKey !== null) animateTo(cameraView(board));
  lastCameraKey = key;
  const ch = board.camera?.chapter && chaptersOf(board).find((c) => c.id === board.camera.chapter);
  $("board-title").textContent = [board.title, ch?.title].filter(Boolean).join("  ·  ");
}


/* ---------- step playback (reveal animations) ---------- */
// Every item has a step (one per board_update unless set explicitly). Live
// viewers watch new steps being drawn; ←/→ step back/forward, r replays the
// chapter, Space plays on, End returns to live. Snapshots (static) show all.
const STATIC = NO_FOLLOW || hash.get("static") === "1" || matchMedia("(prefers-reduced-motion: reduce)").matches;
let maxStep = 0;
// mode "live": new steps are drawn as they arrive (catching up in order);
// mode "manual": the viewer is stepping/replaying and new steps wait.
let mode = "live";
let shown = 0; // highest step currently visible (or being revealed)
let playToken = { cancelled: true };
let playing = false; // true only while playSteps is actually running
const running = new Set(); // finish() callbacks of in-flight reveals
const itemGroups = () => [...($("blackboard")?.querySelectorAll(":scope > g[data-id]") ?? [])];
const stepOf = (g) => Number(g.dataset.step || 0);
const RANK = { artifact: 0, mark: 1, text: 2, equation: 3 };
function stepItems(s) {
  return itemGroups().filter((g) => stepOf(g) === s)
    .map((g, i) => ({ g, i }))
    .sort((a, b) => (Number(a.g.dataset.order ?? 0) - Number(b.g.dataset.order ?? 0)) || (RANK[a.g.dataset.kind] - RANK[b.g.dataset.kind]) || a.i - b.i)
    .map((x) => x.g);
}
function applyVisibility() {
  // Caught up with the latest step while stepping manually = live again.
  if (mode === "manual" && shown >= maxStep && !playing) mode = "live";
  for (const g of itemGroups()) g.style.visibility = stepOf(g) > shown && !g.dataset.revealing ? "hidden" : "";
  updateStepUI();
  scheduleRef();
}
function updateStepUI() {
  const el = $("step-indicator");
  if (!el) return;
  el.textContent = maxStep ? `step ${Math.min(shown, maxStep)} / ${maxStep}${mode === "manual" && shown < maxStep ? " · End = live" : ""}` : "";
}
function finishAll() { for (const f of [...running]) f(); running.clear(); }
/** rAF tween: apply(t) for t in [0,1]; resolves when done (or finished early). */
function tween(ms, apply) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    let raf = 0, done = false;
    const finish = () => { if (done) return; done = true; cancelAnimationFrame(raf); apply(1); running.delete(finish); resolve(); };
    running.add(finish);
    if (ms <= 0) return finish();
    apply(0);
    const frame = (now) => { if (done) return; const t = Math.min(1, (now - t0) / ms); apply(1 - Math.pow(1 - t, 2)); if (t >= 1) finish(); else raf = requestAnimationFrame(frame); };
    raf = requestAnimationFrame(frame);
  });
}
const GEOM = "polyline,line,path,rect,ellipse,circle,polygon";
function defaultReveal(g) {
  if (g.dataset.reveal) return g.dataset.reveal;
  if (g.dataset.kind === "artifact") return g.querySelector(":scope > .plot") ? "draw" : "wipe";
  if (g.dataset.kind === "mark") return g.querySelector("[stroke-dasharray]") ? "wipe" : "draw";
  return "write";
}
function revealDuration(g, how) {
  if (g.dataset.duration) return Number(g.dataset.duration);
  const bb = g.getBBox();
  if (how === "draw") {
    const len = [...g.querySelectorAll(GEOM)].reduce((n, el) => n + (el.getTotalLength?.() || 0), 0);
    return Math.max(300, Math.min(1600, len * 0.9));
  }
  if (how === "write" || how === "wipe") return Math.max(300, Math.min(1400, bb.width * 1.3));
  if (how === "fade") return 450;
  return 0;
}
let clipSeq = 0;
/** Left-to-right sweep using an SVG clipPath rect in the group's own coordinates. */
function wipeIn(g, ms) {
  const eq = g.dataset.kind === "equation" && g.querySelector(".formula");
  if (eq) return tween(ms, (t) => { eq.style.clipPath = t >= 1 ? "" : `inset(-20% ${100 - t * 100}% -20% -5%)`; });
  const bb = g.getBBox(), pad = 12, ns = "http://www.w3.org/2000/svg";
  const clip = document.createElementNS(ns, "clipPath"), rect = document.createElementNS(ns, "rect");
  clip.id = `reveal-clip-${++clipSeq}`;
  clip.setAttribute("clipPathUnits", "userSpaceOnUse");
  rect.setAttribute("x", bb.x - pad); rect.setAttribute("y", bb.y - pad); rect.setAttribute("height", bb.height + 2 * pad);
  clip.appendChild(rect);
  g.prepend(clip);
  g.setAttribute("clip-path", `url(#${clip.id})`);
  return tween(ms, (t) => {
    rect.setAttribute("width", Math.max(0, (bb.width + 2 * pad) * t));
    if (t >= 1) { g.removeAttribute("clip-path"); clip.remove(); }
  });
}
/** Handwriting: trace each stroke with its dash offset; filled parts and text fade in at the end. */
function drawIn(g, ms) {
  const parts = [...g.querySelectorAll(GEOM)];
  const stroked = (el) => { for (let n = el; n && n !== g; n = n.parentNode) { const st = n.getAttribute?.("stroke"); if (st) return st !== "none"; } return false; };
  const strokes = parts.filter((el) => stroked(el) && el.getTotalLength);
  const fills = [...parts.filter((el) => !strokes.includes(el)), ...g.querySelectorAll("text")];
  const lens = strokes.map((el) => el.getTotalLength() || 1);
  strokes.forEach((el, i) => { el.style.strokeDasharray = `${lens[i]} ${lens[i]}`; });
  const fillOpacity = fills.map((el) => el.style.opacity);
  return tween(ms, (t) => {
    strokes.forEach((el, i) => { el.style.strokeDashoffset = String(lens[i] * (1 - t)); });
    fills.forEach((el) => { el.style.opacity = String(Math.max(0, (t - 0.75) / 0.25)); });
    if (t >= 1) {
      strokes.forEach((el) => { el.style.strokeDasharray = ""; el.style.strokeDashoffset = ""; });
      fills.forEach((el, i) => { el.style.opacity = fillOpacity[i] || ""; });
    }
  });
}
function fadeIn(g, ms) { return tween(ms, (t) => { g.style.opacity = t >= 1 ? "" : String(t); }); }
async function reveal(g, token, scale = 1) {
  if (token.cancelled) return;
  const how = defaultReveal(g);
  const ms = how === "none" ? 0 : revealDuration(g, how) * scale;
  g.dataset.revealing = "1";
  g.style.visibility = "";
  try {
    if (how === "draw") await drawIn(g, ms);
    else if (how === "write" || how === "wipe") await wipeIn(g, ms);
    else if (how === "fade") await fadeIn(g, ms);
  } finally { delete g.dataset.revealing; }
}
/** Chapter that most items of a step belong to (camera target while stepping). */
function stepChapter(items) {
  const counts = new Map();
  for (const g of items) if (g.dataset.chapter) counts.set(g.dataset.chapter, (counts.get(g.dataset.chapter) || 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
}
function cameraToStep(items) {
  const board = lastData?.board, ch = chaptersOf(board).find((c) => c.id === stepChapter(items));
  if (ch && currentChapterIndex(board) !== chaptersOf(board).indexOf(ch)) animateTo([ch.x, ch.y, ch.w, ch.h]);
}
let cameraBusyUntil = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function playStep(s, token, { moveCamera = false } = {}) {
  const items = stepItems(s);
  if (!items.length) return;
  if (moveCamera) cameraToStep(items);
  const wait = cameraBusyUntil - performance.now();
  if (wait > 0) await sleep(wait);
  // Diagrams decode asynchronously: let them finish so they sweep in instead of popping.
  for (let t = 0; window.__board.pending > 0 && t < 60 && !token.cancelled; t++) await sleep(50);
  // Keep long steps watchable: compress so a step takes at most ~7 s.
  const total = items.reduce((n, g) => n + revealDuration(g, defaultReveal(g)), 0);
  const scale = total > 7000 ? 7000 / total : 1;
  for (const g of items) {
    if (token.cancelled) return;
    await reveal(g, token, scale);
  }
}
/**
 * Reveal steps from `from` in order. With `until`, stop there; otherwise keep
 * going while newer steps exist (live catch-up when updates arrive quickly).
 */
async function playSteps(from, opts = {}) {
  playToken.cancelled = true;
  finishAll();
  const token = (playToken = { cancelled: false });
  playing = true;
  try {
    for (let s = from; s <= (opts.until ?? maxStep) && !token.cancelled; s++) {
      shown = Math.max(shown, s);
      updateStepUI();
      await playStep(s, token, opts);
      if (opts.gap && s < (opts.until ?? maxStep) && !token.cancelled) await sleep(opts.gap);
    }
  } finally {
    if (playToken === token) { playing = false; if (!token.cancelled) applyVisibility(); }
  }
}
function stopPlayback() { playToken.cancelled = true; playing = false; finishAll(); applyVisibility(); }
function stepForward() {
  if (shown >= maxStep) return;
  stopPlayback();
  mode = "manual";
  const s = shown + 1;
  for (const g of stepItems(s)) g.style.visibility = "hidden";
  playSteps(s, { until: s, moveCamera: true });
}
function stepBack() {
  stopPlayback();
  mode = "manual";
  shown = Math.max(0, shown - 1);
  applyVisibility();
  cameraToStep(stepItems(shown));
}
function goLive() { stopPlayback(); mode = "live"; shown = maxStep; applyVisibility(); if (follow && lastData) animateTo(cameraView(lastData.board)); }
/** Replay the chapter in view from its first step, with short pauses between steps. */
function replayChapter() {
  stopPlayback();
  const board = lastData?.board;
  const i = currentChapterIndex(board);
  const ch = i >= 0 ? chaptersOf(board)[i] : null;
  const steps = itemGroups().filter((g) => (ch ? g.dataset.chapter === ch.id : !g.dataset.chapter)).map(stepOf);
  if (!steps.length) return;
  const first = Math.min(...steps), last = Math.max(...steps);
  mode = "manual";
  shown = first - 1;
  applyVisibility();
  playSteps(first, { until: last, gap: 500 });
}
function togglePlay() {
  if (playing) { stopPlayback(); return; }
  if (shown >= maxStep) { replayChapter(); return; }
  mode = "manual";
  playSteps(shown + 1, { gap: 600, moveCamera: true });
}
/** Called after each committed render. */
function onRendered(board, first) {
  const prevMax = maxStep;
  maxStep = Math.max(0, ...itemGroups().map(stepOf), board.lastStep ?? 0);
  if (first || STATIC) { mode = "live"; shown = maxStep; applyVisibility(); return; }
  if (maxStep < prevMax) shown = Math.min(shown, maxStep); // board cleared/replaced
  // New steps start hidden; in live mode they are drawn in order (catching up
  // if several arrive while one is still drawing).
  for (const g of itemGroups()) if (stepOf(g) > shown && !g.dataset.revealing) g.style.visibility = "hidden";
  if (mode === "live" && maxStep > shown && !playing) playSteps(shown + 1);
  updateStepUI();
}

/* ---------- pan & zoom (viewer navigation only: panning and zooming never change the board) ---------- */
// Scroll/two-finger swipe pans, ctrl/cmd+scroll or pinch zooms at the cursor,
// drag pans; [ ] or PageUp/PageDown change chapter; o = overview; f or 0 = follow the lesson.
function viewScale() {
  // Board units per screen pixel (viewBox uses "meet", so the larger ratio wins).
  const el = $("surface");
  return Math.max(currentView[2] / el.clientWidth, currentView[3] / el.clientHeight);
}
function toBoard(clientX, clientY) {
  const svg = $("blackboard");
  const p = new DOMPoint(clientX, clientY).matrixTransform(svg.getScreenCTM().inverse());
  return [p.x, p.y];
}
function zoomAt(factor, clientX, clientY) {
  const [x, y, w, h] = currentView;
  const maxW = Math.max(BOARD.w * 12, overviewView(lastData?.board)[2] * 2);
  const nw = Math.min(maxW, Math.max(BOARD.w / 12, w * factor));
  const f = nw / w;
  const [bx, by] = clientX === undefined ? [x + w / 2, y + h / 2] : toBoard(clientX, clientY);
  setView([bx - (bx - x) * f, by - (by - y) * f, w * f, h * f]);
}
function panBy(dxPx, dyPx) {
  const k = viewScale(), [x, y, w, h] = currentView;
  setView([x + dxPx * k, y + dyPx * k, w, h]);
}
function installNavigation() {
  const surface = $("surface");
  surface.addEventListener("wheel", (e) => {
    e.preventDefault();
    manual();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? surface.clientHeight : 1;
    if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(e.deltaY * unit * 0.003), e.clientX, e.clientY);
    else panBy(e.deltaX * unit, e.deltaY * unit);
  }, { passive: false });
  let drag = null, pressMoved = false;
  surface.addEventListener("pointerdown", (e) => {
    // Sliders, ▶ and draggable points on a plot handle their own pointer.
    if (e.button !== 0 || e.target.closest("input,button,a,[data-control]")) return;
    drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
    surface.setPointerCapture(e.pointerId);
    surface.classList.add("dragging");
  });
  surface.addEventListener("pointermove", (e) => {
    if (e.pointerType !== "touch") refHover(e.clientX, e.clientY);
    if (!drag || e.pointerId !== drag.id) return;
    if (!drag.moved && Math.hypot(drag.x - e.clientX, drag.y - e.clientY) < 3) return;
    if (!drag.moved) { drag.moved = true; manual(); refDragging(true); }
    panBy(drag.x - e.clientX, drag.y - e.clientY);
    drag.x = e.clientX; drag.y = e.clientY;
  });
  const end = (e) => { if (drag && e.pointerId === drag.id) { pressMoved = drag.moved; drag = null; surface.classList.remove("dragging"); refDragging(false); } };
  surface.addEventListener("pointerup", end);
  surface.addEventListener("pointercancel", end);
  surface.addEventListener("pointerleave", () => refLeave());
  window.addEventListener("resize", () => { updateViewScale(); scheduleRef(); });
  // A click on an item copies its reference (after a short wait, so the first
  // click of a double-click does not copy); a drag that ends on an item does not.
  surface.addEventListener("click", (e) => { if (!pressMoved && !e.target.closest("[data-control]")) refClick(e); });
  surface.addEventListener("mousedown", (e) => { if (e.detail > 1) cancelCopy(); });
  surface.addEventListener("dblclick", (e) => { cancelCopy(); if (!e.target.closest("[data-control]")) setFollow(true); });
  // Safari trackpad pinch.
  let gestureStart = 1;
  surface.addEventListener("gesturestart", (e) => { e.preventDefault(); manual(); gestureStart = e.scale; });
  surface.addEventListener("gesturechange", (e) => { e.preventDefault(); zoomAt(gestureStart / e.scale, e.clientX, e.clientY); gestureStart = e.scale; });
  window.addEventListener("keydown", (e) => {
    if (e.target.closest?.("input,textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "0" || e.key === "Home" || e.key === "f") setFollow(true);
    else if (e.key === "o") { manual(); animateTo(overviewView(lastData?.board)); }
    else if (e.key === "]" || e.key === "PageDown") goChapter(1);
    else if (e.key === "[" || e.key === "PageUp") goChapter(-1);
    else if (e.key === "+" || e.key === "=") { manual(); zoomAt(1 / 1.25); }
    else if (e.key === "-" || e.key === "_") { manual(); zoomAt(1.25); }
    else if (e.key === "ArrowRight" && !e.shiftKey) stepForward();
    else if (e.key === "ArrowLeft" && !e.shiftKey) stepBack();
    else if (e.key === "End") goLive();
    else if (e.key === "r") replayChapter();
    else if (e.key === " ") togglePlay();
    else if (e.key === "?") { openBar(true); showMore(true); }
    else if (e.key === "Escape") openBar(false);
    else if (e.key.startsWith("Arrow")) {
      manual();
      const step = 80;
      panBy(e.key === "ArrowLeft" ? -step : e.key === "ArrowRight" ? step : 0, e.key === "ArrowUp" ? -step : e.key === "ArrowDown" ? step : 0);
    } else return;
    e.preventDefault();
  });
}

/* ---------- marks ---------- */
const FONTS = {
  serif: "KaTeX_Main, 'Latin Modern Roman', 'Computer Modern', Georgia, serif",
  sans: "system-ui, -apple-system, 'Helvetica Neue', Arial, sans-serif",
  mono: "ui-monospace, Menlo, Consolas, monospace",
};
// Serif for text drawn inside image artifacts (Mermaid, molecules): web fonts such as KaTeX_Main
// cannot load there, so this is a system font, with lining figures (Georgia's old-style
// figures make "A2", "CO2" or "COX-1" look like subscripts).
const IMAGE_SERIF = "Charter, 'Bitstream Charter', 'Charis SIL', Cambria, 'Times New Roman', serif";
function drawShape(s) {
  const color = s.color || "#e8e3d9", width = s.width || 2;
  const common = { opacity: s.opacity, strokeDasharray: s.dash };
  if (s.points?.length) {
    const points = s.points.map((p) => p.join(",")).join(" ");
    if (s.type === "arrow") {
      // Draw the head as a polygon so it always matches the arrow's color/width.
      const [x1, y1] = s.points[s.points.length - 2], [x2, y2] = s.points[s.points.length - 1];
      const ang = Math.atan2(y2 - y1, x2 - x1), len = 10 + width * 2.5, spread = 0.42;
      const head = [[x2, y2], [x2 - len * Math.cos(ang - spread), y2 - len * Math.sin(ang - spread)], [x2 - len * Math.cos(ang + spread), y2 - len * Math.sin(ang + spread)]];
      const shaft = [...s.points.slice(0, -1), [x2 - len * 0.7 * Math.cos(ang), y2 - len * 0.7 * Math.sin(ang)]].map((p) => p.join(",")).join(" ");
      return <g opacity={s.opacity}><polyline points={shaft} fill="none" stroke={color} strokeWidth={width} strokeDasharray={s.dash} strokeLinecap="round" strokeLinejoin="round" /><polygon points={head.map((p) => p.join(",")).join(" ")} fill={color} /></g>;
    }
    return <polyline points={points} fill="none" stroke={color} strokeWidth={width} strokeLinecap="round" strokeLinejoin="round" {...common} />;
  }
  if (s.type === "rect") return <rect x={Math.min(s.x, s.x + s.w)} y={Math.min(s.y, s.y + s.h)} width={Math.abs(s.w)} height={Math.abs(s.h)} fill={s.fill || "none"} stroke={color} strokeWidth={width} {...common} />;
  if (s.type === "ellipse") return <ellipse cx={s.x + s.w / 2} cy={s.y + s.h / 2} rx={Math.abs(s.w) / 2} ry={Math.abs(s.h) / 2} fill={s.fill || "none"} stroke={color} strokeWidth={width} {...common} />;
  if (s.type === "text") {
    const style = { fontFamily: FONTS[s.font || "serif"], fontWeight: s.bold ? 700 : undefined, fontStyle: s.italic ? "italic" : undefined };
    const lines = String(s.text).split("\n"), size = s.size || 24;
    return <text x={s.x} y={s.y} fill={color} fontSize={size} textAnchor={s.anchor} opacity={s.opacity} style={style}>
      {lines.length === 1 ? s.text : lines.map((line, i) => <tspan key={i} x={s.x} dy={i ? size * 1.25 : 0}>{line}</tspan>)}
    </text>;
  }
  return null;
}

/* ---------- equations ---------- */
// The server stores every equation's x,y. An equation that arrives without them (a save written
// before that) is stacked in its own chapter, so it never moves when another chapter changes.
const EQ_STACK = { x: 88, y: 92, gap: 115 };
// KaTeX runs with fixed options (colour and size are CSS on the wrapper, outside KaTeX), so the
// LaTeX source alone keys the cache. Typesetting is the expensive part of a render: each formula
// is typeset once per source and copied after that, and never on a re-render that keeps its source.
const KATEX_OPTIONS = { displayMode: true, throwOnError: false, trust: false, strict: "error", maxExpand: 200, maxSize: 20 };
const MATH_CACHE_MAX = 1500; // the board holds at most 1000 equations
const mathCache = new Map(); // latex -> typeset template element (least recently used first)
function typeset(el, latex) {
  let tpl = mathCache.get(latex);
  if (tpl) mathCache.delete(latex);
  else {
    tpl = document.createElement("div");
    try { katex.render(latex, tpl, { ...KATEX_OPTIONS, macros: Object.create(null) }); } catch { tpl.textContent = latex; }
    if (mathCache.size >= MATH_CACHE_MAX) mathCache.delete(mathCache.keys().next().value);
  }
  mathCache.set(latex, tpl);
  el.replaceChildren(...tpl.cloneNode(true).childNodes);
}
function MathBlock({ latex }) {
  const ref = React.useRef(null);
  // React renders no children here, so the typeset nodes stay in place across re-renders.
  React.useLayoutEffect(() => { if (ref.current) typeset(ref.current, latex); }, [latex]);
  return <div className="eq-math" ref={ref} />;
}
function Formula({ eq, x, y }) {
  // Generous box with visible overflow: long or tall formulas must not be clipped.
  const style = { color: eq.color || undefined, fontSize: eq.size ? `${eq.size}em` : undefined };
  return <foreignObject x={x} y={y} width={Math.max(400, BOARD.w - x)} height="400" style={{ overflow: "visible", pointerEvents: "none" }}>
    <div xmlns="http://www.w3.org/1999/xhtml" className="formula" style={style}>
      {eq.label ? <div className="eq-label">{eq.label}</div> : null}
      <MathBlock latex={eq.latex} />
    </div>
  </foreignObject>;
}
// Every revision brings a fresh copy of the board. An item whose content did not change is not
// re-rendered: no re-typesetting and no re-sampling of plots.
const MemoFormula = React.memo(Formula, (a, b) => a.sig === b.sig && a.x === b.x && a.y === b.y);

/* ---------- molecules (SMILES → 2D structure, offline) ---------- */
const CHALK_THEME = { FOREGROUND: "#e8e3d9", BACKGROUND: "transparent", C: "#e8e3d9", O: "#ef6f6c", N: "#5fb3d9", F: "#8de0be", CL: "#8de0be", BR: "#f2a65a", I: "#c39bd3", P: "#f2a65a", S: "#f2c14e", B: "#f2a65a", SI: "#f2a65a", H: "#b9b4a8" };
/**
 * SmilesDrawer frames every structure in a square viewBox, so a wide molecule in a wide box (or a
 * tall one in a tall box) uses half the space it was given and its atom labels come out small.
 * Frame the drawn structure tightly instead, without zooming a tiny molecule past about 2x
 * (60 px bonds).
 */
function fitMolecule(svg, width, height) {
  let bb;
  try { bb = svg.getBBox(); } catch { return; }
  if (!(bb.width > 0 && bb.height > 0)) return;
  const pad = 10, maxZoom = 2;
  const w = Math.max(bb.width + 2 * pad, width / maxZoom), h = Math.max(bb.height + 2 * pad, height / maxZoom);
  const cx = bb.x + bb.width / 2, cy = bb.y + bb.height / 2;
  svg.setAttribute("viewBox", [cx - w / 2, cy - h / 2, w, h].map((v) => v.toFixed(2)).join(" "));
}
function renderMolecule(smiles, width, height) {
  return new Promise((resolve, reject) => {
    const ns = "http://www.w3.org/2000/svg";
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-10000px;top:0;visibility:hidden";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("width", width); svg.setAttribute("height", height);
    host.appendChild(svg); document.body.appendChild(host);
    const done = (fn) => (v) => { host.remove(); fn(v); };
    try {
      const drawer = new SmilesDrawer.SvgDrawer({ width, height, padding: 24, bondThickness: 1.8, fontFamily: IMAGE_SERIF, fontSizeLarge: 13, fontSizeSmall: 7, themes: { chalk: CHALK_THEME } });
      SmilesDrawer.parse(smiles, (tree) => {
        try {
          drawer.draw(tree, svg, "chalk");
          fitMolecule(svg, width, height);
          svg.setAttribute("xmlns", ns);
          done(resolve)(new XMLSerializer().serializeToString(svg));
        } catch (e) { done(reject)(new Error(`could not draw molecule: ${e?.message || e}`)); }
      }, (err) => done(reject)(new Error(`invalid SMILES "${smiles}": ${err?.message || err}`)));
    } catch (e) { done(reject)(e); }
  });
}

/* ---------- plots (inline SVG so curves can be traced) ---------- */
const PLOT_COLORS = ["#5fb3d9", "#f2c14e", "#ef6f6c", "#8de0be", "#c39bd3", "#e8e3d9"];
// Plot chrome on black: axes stay quiet but clearly visible, tick and axis labels brighter
// than the axes (readable at 1200 px), grid barely there.
const PLOT_INK = { axis: "#9b968a", tick: "#b9b4a6", label: "#cfcab9", grid: "#ffffff16" };
// Black outline painted under label text: lines crossing a label stop short of the glyphs.
const HALO = { stroke: "#000", strokeWidth: 4, strokeLinejoin: "round", paintOrder: "stroke" };
function niceStep(span, target = 8) {
  const raw = span / target, mag = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / mag;
  return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * mag;
}
const MAX_TICKS = 200;
/**
 * Multiples of `step` from lo to hi. Each tick is computed from its index, never by adding the
 * step up, and the count is capped: a range far narrower than its endpoints (a step under half an
 * ULP) or a zero or non-finite step would otherwise loop forever.
 */
function tickValues(lo, hi, step) {
  if (!(Number.isFinite(lo) && Number.isFinite(hi) && Number.isFinite(step) && step > 0 && hi >= lo)) return [];
  const first = Math.ceil(lo / step) * step, n = Math.floor((hi + 1e-9 - first) / step);
  const out = [];
  for (let i = 0; i <= Math.min(n, MAX_TICKS); i++) {
    const v = first + i * step;
    if (v !== out[out.length - 1]) out.push(v);
  }
  return out;
}
function fmtTick(v, step) {
  const d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  const s = (Math.abs(v) < step / 1e6 ? 0 : v).toFixed(Math.min(6, d));
  return s.replace("-", "−");
}
function samplePath(at, a, b, n, sx, sy, ySpan) {
  // Polyline segments in screen coords, broken at NaN/∞ and asymptote-like jumps.
  const segs = [];
  let cur = [], prev = null;
  for (let i = 0; i <= n; i++) {
    const x = a + ((b - a) * i) / n;
    let y;
    try { y = at(x); } catch { y = NaN; }
    if (!Number.isFinite(y) || (prev !== null && Math.abs(y - prev) > ySpan * 3)) { if (cur.length > 1) segs.push(cur); cur = []; prev = Number.isFinite(y) ? y : null; if (!Number.isFinite(y)) continue; }
    cur.push([sx(x), sy(y)]);
    prev = y;
  }
  if (cur.length > 1) segs.push(cur);
  return segs;
}
const pts = (seg) => seg.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ");

/* ---------- sliders (a plot's params) ---------- */
// A plot's params are sliders the learner drags, or plays, and the plot redraws with them. The
// values live in this page only: the board, snapshots and other tabs keep each slider's `value`.
// A click on the plot copies its reference with the values the learner has set.
const SLIDER_ROW = 34;
const NO_PARAMS = [];
const initialValues = (params) => Object.fromEntries(params.map((p) => [p.name, p.value]));
function snapParam(p, v) {
  let out = Math.min(p.max, Math.max(p.min, Number.isFinite(v) ? v : p.value));
  if (p.step) out = Math.min(p.max, p.min + Math.round((out - p.min) / p.step) * p.step);
  return out;
}
function fmtParam(p, v) {
  const unit = p.step || (p.max - p.min) / 100;
  const d = Math.max(0, Math.min(6, -Math.floor(Math.log10(unit) + 1e-9)));
  return (Math.abs(v) < unit / 1e6 ? 0 : v).toFixed(d).replace("-", "−");
}
/**
 * Slider values for one plot. set(name, v) takes a value or a function of the current one (so two
 * key presses in one frame both count) and coalesces to one render per frame; ▶ sweeps min → max → min.
 */
function usePlotParams(params) {
  const [values, setValues] = React.useState(() => initialValues(params));
  const [playing, setPlaying] = React.useState(() => new Set());
  const current = React.useRef(values);
  current.current = values;
  const pending = React.useRef([]), frame = React.useRef(0);
  const set = React.useCallback((name, v) => {
    pending.current.push([name, v]);
    if (frame.current) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = 0;
      const changes = pending.current;
      pending.current = [];
      setValues((old) => {
        const out = { ...old };
        for (const [n, f] of changes) out[n] = typeof f === "function" ? f(out[n]) : f;
        return out;
      });
    });
  }, []);
  React.useEffect(() => () => cancelAnimationFrame(frame.current), []);
  const stop = React.useCallback((...names) => setPlaying((old) => (names.some((n) => old.has(n)) ? new Set([...old].filter((n) => !names.includes(n))) : old)), []);
  const togglePlay = React.useCallback((name) => setPlaying((old) => { const next = new Set(old); if (!next.delete(name)) next.add(name); return next; }), []);
  React.useEffect(() => {
    if (!playing.size || STATIC) return;
    const t0 = performance.now(), from = { ...current.current };
    let raf = 0;
    const tick = (now) => {
      const next = {};
      for (const p of params) {
        if (!playing.has(p.name)) continue;
        // Phase in [0, 2): up from min to max, then back down; `period` seconds each way.
        const span = p.max - p.min, phase = ((from[p.name] - p.min) / span + (now - t0) / ((p.period ?? 4) * 1000)) % 2;
        next[p.name] = snapParam(p, p.min + span * (phase <= 1 ? phase : 2 - phase));
      }
      setValues((old) => ({ ...old, ...next }));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, params]);
  return { values, set, playing, stop, togglePlay };
}
/** One slider row: ▶/❚❚, the label, the track and the value. Drag, click or use the arrow keys. */
const sliderLabel = (p) => p.label || p.name;
// Rough label width (serif italic, ~9 px per character): every row of a plot starts its track there.
const sliderLabelWidth = (params) => Math.min(150, Math.max(16, ...params.map((p) => sliderLabel(p).length * 9)));
function Slider({ p, value, y, left, right, labelWidth, playing, onValue, onPlay, onGrab }) {
  const track = React.useRef(null);
  const label = sliderLabel(p);
  const playX = left + 12, labelX = left + 32;
  const x0 = labelX + labelWidth + 14, x1 = right - 66;
  const kx = x0 + ((x1 - x0) * (value - p.min)) / (p.max - p.min);
  const fromClient = (clientX) => {
    const m = track.current?.getScreenCTM();
    if (!m) return value;
    const q = new DOMPoint(clientX, 0).matrixTransform(m.inverse());
    return snapParam(p, p.min + ((q.x - x0) / (x1 - x0)) * (p.max - p.min));
  };
  const down = (e) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    onGrab();
    onValue(fromClient(e.clientX));
  };
  const move = (e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) onValue(fromClient(e.clientX)); };
  const key = (e) => {
    const unit = p.step || (p.max - p.min) / 100;
    const by = { ArrowLeft: -unit, ArrowDown: -unit, ArrowRight: unit, ArrowUp: unit, PageDown: -10 * unit, PageUp: 10 * unit, Home: -Infinity, End: Infinity }[e.key];
    if (by === undefined) return;
    e.preventDefault();
    e.stopPropagation(); // the board's own arrow keys step through the lesson
    onGrab();
    onValue((v) => snapParam(p, Number.isFinite(by) ? v + by : by > 0 ? p.max : p.min));
  };
  const playKey = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); onPlay(); } };
  const font = { fontFamily: FONTS.serif };
  return <g className="plot-slider">
    <g className="slider-play" data-control="play" role="button" tabIndex={0} aria-label={`${playing ? "Pause" : "Play"} ${label}`} onClick={onPlay} onKeyDown={playKey}>
      <circle cx={playX} cy={y} r="11" fill="#ffffff12" stroke="#8a8578" strokeWidth="1.2" />
      {playing
        ? <path d={`M${playX - 3.5} ${y - 5}v10M${playX + 3.5} ${y - 5}v10`} stroke="#e8e3d9" strokeWidth="2.4" strokeLinecap="round" />
        : <path d={`M${playX - 3.2} ${y - 6}l9 6-9 6z`} fill="#e8e3d9" />}
    </g>
    <text x={labelX} y={y + 6} fill={PLOT_INK.label} fontSize="17" style={{ ...font, fontStyle: "italic" }}>{label}</text>
    <g ref={track} className="slider-track" data-control="slider" role="slider" tabIndex={0} aria-label={label} aria-valuemin={p.min} aria-valuemax={p.max} aria-valuenow={value} aria-valuetext={fmtParam(p, value)} onPointerDown={down} onPointerMove={move} onKeyDown={key}>
      <rect x={x0 - 12} y={y - 15} width={x1 - x0 + 24} height="30" fill="transparent" />
      <line x1={x0} y1={y} x2={x1} y2={y} stroke="#4f4c45" strokeWidth="3" strokeLinecap="round" />
      <line x1={x0} y1={y} x2={kx} y2={y} stroke="#f2c14e" strokeWidth="3" strokeLinecap="round" />
      <circle className="knob" cx={kx} cy={y} r="8" fill="#e8e3d9" stroke="#000" strokeWidth="1.5" />
    </g>
    <text x={right} y={y + 6} fill="#f2c14e" fontSize="16" textAnchor="end" style={{ ...font, fontVariantNumeric: "tabular-nums" }}>{fmtParam(p, value)}</text>
  </g>;
}

function Plot({ item }) {
  const params = item.params || NO_PARAMS;
  const { values, set, playing, stop, togglePlay } = usePlotParams(params);
  const root = React.useRef(null);
  const compiled = React.useMemo(() => {
    const names = params.map((p) => p.name);
    const c = (src, vars) => { try { return compileExpr(src, vars); } catch { return () => NaN; } };
    // A coordinate is a number, or (on a plot with sliders) an expression of them.
    const k = (v) => (typeof v === "string" ? c(v, names) : () => v);
    return {
      functions: (item.functions || []).map((f) => ({ ...f, fn: c(f.expr, ["x", ...names]) })),
      parametric: (item.parametric || []).map((f) => ({ ...f, fx: c(f.x, ["t", ...names]), fy: c(f.y, ["t", ...names]) })),
      areas: (item.areas || []).map((a) => ({ ...a, fn: c(a.expr, ["x", ...names]), lo: a.lower ? c(a.lower, ["x", ...names]) : () => 0, fromAt: k(a.from), toAt: k(a.to) })),
      points: (item.points || []).map((p) => ({ ...p, xAt: k(p.x), yAt: k(p.y) })),
      vlines: (item.vlines || []).map((v) => ({ ...v, at: k(v.x) })),
      hlines: (item.hlines || []).map((h) => ({ ...h, at: k(h.y) })),
    };
  }, [item, params]);
  const W = item.width, H = item.height;
  // The y-axis label sits above the plot area (a row of its own), so it never lands on the
  // curve's maximum or a point label at the top of the axis. Slider rows sit below the x axis.
  const padL = 46, padR = 18, padT = (item.title ? 34 : 14) + (item.yLabel ? 24 : 0), padB = 34 + params.length * SLIDER_ROW;
  let [x0, x1] = item.xRange || [-10, 10];
  if (!(x1 > x0)) { x0 -= 1; x1 += 1; } // a range whose ends were clamped to the same value
  const fitted = React.useMemo(() => {
    if (item.yRange) return null;
    // Auto y-range from samples (robust to asymptotes via percentiles). With sliders it covers
    // each slider's ends too, and is fitted once, so the axes stay put while a slider moves.
    const base = initialValues(params), sets = [base];
    for (const p of params) sets.push({ ...base, [p.name]: p.min }, { ...base, [p.name]: p.max });
    const ys = [], add = (v) => { if (Number.isFinite(v)) ys.push(v); };
    for (const s of sets) {
      for (const f of compiled.functions) for (let i = 0; i <= 200; i++) { s.x = x0 + ((x1 - x0) * i) / 200; add(f.fn(s)); }
      for (const f of compiled.parametric) for (let i = 0; i <= 200; i++) { s.t = f.t[0] + ((f.t[1] - f.t[0]) * i) / 200; add(f.fy(s)); }
      for (const p of compiled.points) add(p.yAt(s));
      for (const h of compiled.hlines) add(h.at(s));
    }
    ys.sort((a, b) => a - b);
    const lo = ys.length ? ys[Math.floor(ys.length * 0.02)] : -1, hi = ys.length ? ys[Math.ceil(ys.length * 0.98) - 1] : 1;
    const pad = (hi - lo || 2) * 0.12;
    return [lo - pad, hi + pad];
  }, [item, params, compiled, x0, x1]);
  let [y0, y1] = item.yRange || fitted;
  if (!(y1 > y0)) { y0 -= 1; y1 += 1; }
  const scope = { ...values };
  const ev = (fn) => { try { return fn(scope); } catch { return NaN; } };
  let iw = W - padL - padR, ih = H - padT - padB, ox = padL, oy = padT;
  if (item.equalAspect) {
    const k = Math.min(iw / (x1 - x0), ih / (y1 - y0));
    const nw = k * (x1 - x0), nh = k * (y1 - y0);
    ox += (iw - nw) / 2; oy += (ih - nh) / 2; iw = nw; ih = nh;
  }
  const sx = (x) => item.x + ox + ((x - x0) / (x1 - x0)) * iw;
  const sy = (y) => item.y + oy + ih - ((y - y0) / (y1 - y0)) * ih;
  const left = item.x + ox, top = item.y + oy, right = left + iw, bottom = top + ih;
  const clipId = `plotclip-${item.id.replace(/[^A-Za-z0-9_-]/g, "")}`;
  const xs = niceStep(x1 - x0, Math.max(3, Math.round(iw / 90))), ysStep = niceStep(y1 - y0, Math.max(3, Math.round(ih / 60)));
  const xticks = tickValues(x0, x1, xs), yticks = tickValues(y0, y1, ysStep);
  const axX = Math.min(Math.max(0, y0), y1), axY = Math.min(Math.max(0, x0), x1); // axes through 0 when visible
  const font = { fontFamily: FONTS.serif };
  const labels = [];
  const curves = compiled.functions.map((f, i) => {
    const color = f.color || PLOT_COLORS[i % PLOT_COLORS.length];
    const [a, b] = f.domain || [x0, x1];
    const segs = samplePath((x) => { scope.x = x; return f.fn(scope); }, Math.max(a, x0), Math.min(b, x1), Math.max(200, Math.round(iw * 1.5)), sx, sy, y1 - y0);
    if (f.label && segs.length) { const last = segs[segs.length - 1].filter(([, y]) => y >= top && y <= bottom).pop(); if (last) labels.push(<text key={`fl${i}`} x={Math.min(last[0] + 6, right - 4)} y={last[1] - 8} fill={color} fontSize="16" textAnchor={last[0] > right - 60 ? "end" : "start"} {...HALO} style={{ ...font, fontStyle: "italic" }}>{f.label}</text>); }
    return segs.map((seg, j) => <polyline key={`f${i}-${j}`} points={pts(seg)} fill="none" stroke={color} strokeWidth={f.width || 3} strokeDasharray={f.dash} strokeLinejoin="round" strokeLinecap="round" />);
  });
  const paramCurves = compiled.parametric.map((f, i) => {
    const color = f.color || PLOT_COLORS[(i + compiled.functions.length) % PLOT_COLORS.length];
    const seg = [];
    for (let k = 0; k <= 600; k++) { scope.t = f.t[0] + ((f.t[1] - f.t[0]) * k) / 600; const X = ev(f.fx), Y = ev(f.fy); if (Number.isFinite(X) && Number.isFinite(Y)) seg.push([sx(X), sy(Y)]); }
    if (f.label && seg.length) labels.push(<text key={`pl${i}`} x={seg[seg.length - 1][0] + 6} y={seg[seg.length - 1][1] - 8} fill={color} fontSize="16" {...HALO} style={{ ...font, fontStyle: "italic" }}>{f.label}</text>);
    return seg.length > 1 ? <polyline key={`p${i}`} points={pts(seg)} fill="none" stroke={color} strokeWidth={f.width || 3} strokeDasharray={f.dash} strokeLinejoin="round" /> : null;
  });
  const areas = compiled.areas.map((a, i) => {
    const A = ev(a.fromAt), B = ev(a.toAt);
    if (!Number.isFinite(A) || !Number.isFinite(B)) return null;
    const from = Math.max(Math.min(A, B), x0), to = Math.min(Math.max(A, B), x1), n = 160;
    const upper = [], lower = [];
    for (let k = 0; k <= n; k++) { scope.x = from + ((to - from) * k) / n; const u = ev(a.fn), l = ev(a.lo); if (Number.isFinite(u) && Number.isFinite(l)) { upper.push([sx(scope.x), sy(u)]); lower.push([sx(scope.x), sy(l)]); } }
    const color = a.color || "#f2c14e";
    return upper.length > 1 ? <polygon key={`a${i}`} points={pts([...upper, ...lower.reverse()])} fill={color} fillOpacity="0.26" stroke="none" /> : null;
  });
  const hlines = compiled.hlines.map((h) => ({ ...h, v: ev(h.at) })).filter((h) => Number.isFinite(h.v));
  const vlines = compiled.vlines.map((v) => ({ ...v, v: ev(v.at) })).filter((v) => Number.isFinite(v.v));
  // A draggable point moves the slider(s) its x and/or y is bound to.
  const byName = new Map(params.map((p) => [p.name, p]));
  const dragTo = (pt, e) => {
    const m = root.current?.getScreenCTM();
    if (!m) return;
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    const X = x0 + ((q.x - left) / iw) * (x1 - x0), Y = y0 + ((bottom - q.y) / ih) * (y1 - y0);
    if (byName.has(pt.x)) set(pt.x, snapParam(byName.get(pt.x), X));
    if (byName.has(pt.y)) set(pt.y, snapParam(byName.get(pt.y), Y));
  };
  const dragHandlers = (pt) => ({
    onPointerDown: (e) => { if (e.button !== 0) return; e.currentTarget.setPointerCapture(e.pointerId); stop(pt.x, pt.y); dragTo(pt, e); },
    onPointerMove: (e) => { if (e.currentTarget.hasPointerCapture(e.pointerId)) dragTo(pt, e); },
  });
  const yLabelX = item.yLabel ? Math.min(Math.max(sx(axY), item.x + item.yLabel.length * 4.4 + 4), item.x + W - item.yLabel.length * 4.4 - 4) : 0;
  const rowsTop = item.y + H - params.length * SLIDER_ROW;
  return <g className="plot" ref={root} data-params={params.length ? params.map((p) => `${p.name} = ${fmtParam(p, values[p.name])}`).join(", ") : undefined}>
    <defs><clipPath id={clipId}><rect x={left} y={top} width={iw} height={ih} /></clipPath></defs>
    {item.title ? <text x={item.x + W / 2} y={item.y + 22} fill="#e8e3d9" fontSize="20" textAnchor="middle" style={font}>{item.title}</text> : null}
    {item.grid !== false ? <g stroke={PLOT_INK.grid} strokeWidth="1">{xticks.map((v) => <line key={`gx${v}`} x1={sx(v)} y1={top} x2={sx(v)} y2={bottom} />)}{yticks.map((v) => <line key={`gy${v}`} x1={left} y1={sy(v)} x2={right} y2={sy(v)} />)}</g> : null}
    <g clipPath={`url(#${clipId})`}>{areas}</g>
    {item.axes !== false ? <g className="plot-axes" stroke={PLOT_INK.axis} strokeWidth="1.6"><line x1={left} y1={sy(axX)} x2={right} y2={sy(axX)} /><line x1={sx(axY)} y1={top} x2={sx(axY)} y2={bottom} /></g> : null}
    <g clipPath={`url(#${clipId})`}>
      {hlines.map((h, i) => <line key={`h${i}`} x1={left} y1={sy(h.v)} x2={right} y2={sy(h.v)} stroke={h.color || PLOT_INK.axis} strokeWidth={h.width || 1.5} strokeDasharray={h.dash || "6 5"} />)}
      {vlines.map((v, i) => <line key={`v${i}`} x1={sx(v.v)} y1={top} x2={sx(v.v)} y2={bottom} stroke={v.color || PLOT_INK.axis} strokeWidth={v.width || 1.5} strokeDasharray={v.dash || "6 5"} />)}
      {curves}{paramCurves}
    </g>
    {/* Labels go on top of the curves with a thin black halo, so a curve or a dashed marker
        crossing a tick label interrupts the line instead of striking through the text. */}
    {item.ticks !== false ? <g className="plot-ticks" fill={PLOT_INK.tick} fontSize="14" {...HALO} style={font}>
      {xticks.filter((v) => Math.abs(v - axY) > xs / 2 || item.axes === false).map((v) => <text key={`tx${v}`} x={sx(v)} y={Math.min(sy(axX) + 19, bottom + 19)} textAnchor="middle">{fmtTick(v, xs)}</text>)}
      {yticks.filter((v) => Math.abs(v - axX) > ysStep / 2 || item.axes === false).map((v) => <text key={`ty${v}`} x={Math.max(sx(axY) - 7, left - 7)} y={sy(v) + 5} textAnchor="end">{fmtTick(v, ysStep)}</text>)}
    </g> : null}
    {hlines.map((h, i) => h.label && h.v >= y0 && h.v <= y1 ? <text key={`hl${i}`} x={right - 4} y={sy(h.v) - 7} fill={h.color || PLOT_INK.label} fontSize="15" textAnchor="end" {...HALO} style={{ ...font, fontStyle: "italic" }}>{h.label}</text> : null)}
    {vlines.map((v, i) => v.label && v.v >= x0 && v.v <= x1 ? <text key={`vl${i}`} x={sx(v.v) + 5} y={top + 15} fill={v.color || PLOT_INK.label} fontSize="15" {...HALO} style={{ ...font, fontStyle: "italic" }}>{v.label}</text> : null)}
    {item.xLabel ? <text className="plot-xlabel" x={right} y={Math.min(sy(axX) + 34, bottom + 31)} fill={PLOT_INK.label} fontSize="17" textAnchor="end" {...HALO} style={{ ...font, fontStyle: "italic" }}>{item.xLabel}</text> : null}
    {item.yLabel ? <text className="plot-ylabel" x={yLabelX} y={top - 8} fill={PLOT_INK.label} fontSize="17" textAnchor="middle" {...HALO} style={{ ...font, fontStyle: "italic" }}>{item.yLabel}</text> : null}
    {compiled.points.map((p, i) => {
      const X = ev(p.xAt), Y = ev(p.yAt);
      if (!Number.isFinite(X) || !Number.isFinite(Y)) return null;
      const cx = sx(X), cy = sy(Y), r = p.size || 5, color = p.color || "#e8e3d9";
      return <g key={`pt${i}`}>
        {p.drag ? <circle className="plot-drag" data-control="point" cx={cx} cy={cy} r={r + 9} fill="#f2c14e1f" stroke="#f2c14e" strokeWidth="1.5" strokeDasharray="3 3" {...dragHandlers(p)} /> : null}
        <circle cx={cx} cy={cy} r={r} fill={color} pointerEvents={p.drag ? "none" : undefined} />
        {p.label ? <text x={cx + 9 + (p.drag ? 8 : 0)} y={cy - 9} fill={color} fontSize="16" {...HALO} style={font}>{p.label}</text> : null}
      </g>;
    })}
    {labels}
    {params.map((p, i) => <Slider key={p.name} p={p} value={values[p.name]} y={rowsTop + i * SLIDER_ROW + SLIDER_ROW / 2} left={item.x + 6} right={item.x + W - 8} labelWidth={sliderLabelWidth(params)}
      playing={playing.has(p.name)} onValue={(v) => set(p.name, v)} onPlay={() => togglePlay(p.name)} onGrab={() => stop(p.name)} />)}
  </g>;
}

/* ---------- artifacts ---------- */
// htmlLabels:false keeps labels as SVG <text>; HTML labels (foreignObject) can
// vanish when the diagram is displayed through an <image> data URI.
// Chalk theme: Mermaid's dark theme recoloured for the board. Serif text like the rest of the
// board (a system font, so the text measured here is the text drawn inside the image), near-black
// nodes with chalk outlines, chalk edges, and opaque black edge-label backgrounds so an edge never
// strikes through its label.
const MERMAID_FONT_PX = 18;
const MIN_TEXT_PX = 12; // board px; smaller diagram text is reported by the layout check
const MERMAID_THEME = {
  darkMode: true, background: "#000000", fontFamily: IMAGE_SERIF, fontSize: `${MERMAID_FONT_PX}px`,
  primaryColor: "#161616", primaryTextColor: "#e8e3d9", primaryBorderColor: "#bdb8a8",
  secondaryColor: "#1c1c1c", secondaryTextColor: "#e8e3d9", secondaryBorderColor: "#8a8578",
  tertiaryColor: "#121212", tertiaryTextColor: "#e8e3d9", tertiaryBorderColor: "#8a8578",
  mainBkg: "#161616", nodeBorder: "#bdb8a8", nodeTextColor: "#e8e3d9", textColor: "#e8e3d9", titleColor: "#e8e3d9",
  lineColor: "#c7c5ad", edgeLabelBackground: "#000000", clusterBkg: "#0d0d0d", clusterBorder: "#6f6b61",
  actorBkg: "#161616", actorBorder: "#bdb8a8", actorTextColor: "#e8e3d9", actorLineColor: "#8a8578", signalColor: "#c7c5ad", signalTextColor: "#e8e3d9",
  labelBoxBkgColor: "#161616", labelBoxBorderColor: "#bdb8a8", labelTextColor: "#e8e3d9", loopTextColor: "#e8e3d9",
  noteBkgColor: "#2a2618", noteBorderColor: "#f2c14e", noteTextColor: "#e8e3d9", activationBkgColor: "#2a2a2a", activationBorderColor: "#bdb8a8",
  // Section colours (pie slices, mindmap branches, timeline sections, journeys): the board's
  // chalk accents at mid tone, all carrying light labels. Mermaid's dark defaults include
  // near-black slices and black or grey-on-grey labels.
  ...Object.fromEntries(["#2c6178", "#7a6127", "#7a3836", "#3a6e5c", "#5e4a6a", "#5c584e", "#1f4a5c", "#5c4a1d", "#5c2a29", "#2b5245", "#47384f", "#45423b"]
    .flatMap((c, i) => [[`cScale${i}`, c], [`cScaleLabel${i}`, "#e8e3d9"]])),
  scaleLabelColor: "#e8e3d9",
  ...Object.fromEntries(["#4a4740", "#2c6178", "#7a6127", "#7a3836", "#3a6e5c", "#5e4a6a", "#1f4a5c", "#5c4a1d"]
    .flatMap((c, i) => [[`git${i}`, c], [`gitBranchLabel${i}`, "#e8e3d9"]])),
  pieOpacity: "0.9", pieStrokeColor: "#000000", pieOuterStrokeColor: "#8a8578", pieSectionTextColor: "#e8e3d9",
  pieTitleTextColor: "#e8e3d9", pieLegendTextColor: "#e8e3d9",
};
const MERMAID_CSS = [
  ".edgeLabel rect,.edgeLabel .background,.labelBkg{opacity:1!important;fill:#000!important;background-color:#000!important}",
  // Not .edge-thickness-normal: ER lines size their (stroke-width relative) markers by it.
  // Thick links (==>, which carry both thickness classes) keep their 3.5 px.
  ".flowchart-link:not(.edge-thickness-thick),.relation,.transition{stroke-width:1.8px!important}",
  ".node rect,.node circle,.node ellipse,.node polygon,.node path{stroke-width:1.6px!important}",
].join("\n");
mermaid.initialize({ startOnLoad: false, securityLevel: "strict", suppressErrorRendering: true, theme: "dark", themeVariables: MERMAID_THEME, themeCSS: MERMAID_CSS, htmlLabels: false, flowchart: { htmlLabels: false }, class: { htmlLabels: false }, state: { htmlLabels: false } });
/**
 * Finish a rendered Mermaid SVG for the board: arrowheads scaled to the thicker chalk edges
 * (Mermaid draws 8 px heads for 1 px lines), and the diagram's natural size, which the layout
 * check uses to warn when a diagram is shrunk until its text is too small to read.
 */
function tuneMermaid(svg) {
  const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
  const root = doc.documentElement;
  if (root.nodeName !== "svg" || doc.querySelector("parsererror")) return { svg, size: null };
  const k = 1.4;
  for (const m of root.querySelectorAll("marker")) {
    // Flowchart arrowheads only; other diagram types already size their markers for their lines.
    if (m.getAttribute("markerUnits") !== "userSpaceOnUse" || !/-point(End|Start)$/.test(m.id)) continue;
    const vb = (m.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    const mw = Number(m.getAttribute("markerWidth")), mh = Number(m.getAttribute("markerHeight")), refX = Number(m.getAttribute("refX"));
    if (!(vb.length === 4 && mw > 0 && mh > 0 && Number.isFinite(refX))) continue;
    m.setAttribute("markerWidth", String(mw * k));
    m.setAttribute("markerHeight", String(mh * k));
    // Keep the tip where Mermaid put it (at the node border): the head grows backwards along the edge.
    if (/End$/.test(m.id)) m.setAttribute("refX", String(vb[0] + vb[2] - (vb[0] + vb[2] - refX) / k));
    else m.setAttribute("refX", String(vb[0] + (refX - vb[0]) / k));
  }
  const vb = (root.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
  const size = vb.length === 4 && vb[2] > 0 && vb[3] > 0 ? { w: vb[2], h: vb[3] } : null;
  return { svg: new XMLSerializer().serializeToString(root), size };
}
const svgUrl = (svg) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
function decodeThen(url, live, set) {
  const img = new Image();
  img.src = url;
  // A malformed SVG (e.g. invalid XML) fails to decode: surface it instead of drawing nothing.
  return img.decode().then(() => { if (live()) set(url); }, () => { throw new Error("invalid SVG: not well-formed XML (unclosed tag, stray & or <?)"); });
}
function Artifact({ item, sig }) {
  const [src, setSrc] = React.useState("");
  const [error, setError] = React.useState("");
  const [natural, setNatural] = React.useState(null);
  React.useEffect(() => {
    let alive = true;
    const live = () => alive;
    // Keep showing the previous image until the replacement is ready (no flicker);
    // clear it only if the replacement fails.
    const fail = (e) => { if (alive) { setSrc(""); setError(String(e?.message || e).replace(/\s+/g, " ").trim().slice(0, 300)); } };
    const ok = (url, size = null) => { setError(""); setNatural(size); setSrc(url); };
    if (item.type === "svg") track(decodeThen(svgUrl(item.source), live, ok).catch(fail));
    if (item.type === "icon") track(decodeThen(`/icons/${encodeURIComponent(item.icon)}.svg`, live, ok).catch(() => fail(`icon "${item.icon}" could not be loaded`)));
    if (item.type === "molecule") track(renderMolecule(item.smiles, Math.round(item.width), Math.round(item.height)).then((svg) => decodeThen(svgUrl(svg), live, ok)).catch(fail));
    if (item.type === "mermaid") track(mermaid.render(`diagram-${item.id.replace(/[^a-zA-Z0-9_-]/g, "")}`, item.source).then(({ svg }) => { const t = tuneMermaid(svg); return decodeThen(svgUrl(t.svg), live, (url) => ok(url, t.size)); }).catch((e) => fail(`Mermaid: ${e?.message || e}`)));
    return () => { alive = false; };
  }, [item.id, item.type, item.source, item.smiles, item.icon, item.width, item.height]);
  // A changed plot starts again from its sliders' values.
  if (item.type === "plot") return <Plot key={sig} item={item} />;
  if (error) return <g data-render-error={error}>
    <rect x={item.x} y={item.y} width={item.width} height={Math.min(item.height, 70)} fill="#ef6f6c22" stroke="#ef6f6c" strokeDasharray="6 4" />
    <text x={item.x + 12} y={item.y + 28} fill="#ef6f6c" fontSize="16" style={{ fontFamily: FONTS.sans }}>{item.type} artifact failed to render</text>
    <text x={item.x + 12} y={item.y + 50} fill="#ef6f6c" fontSize="12" style={{ fontFamily: FONTS.mono }}>{error.length > (item.width - 24) / 7.3 ? error.slice(0, Math.max(10, Math.floor((item.width - 24) / 7.3) - 1)) + "…" : error}</text>
  </g>;
  if (!src) return null;
  const img = <image href={src} x={item.x} y={item.y} width={item.width} height={item.height} preserveAspectRatio="xMidYMid meet" opacity={item.opacity} aria-label={item.label || item.type} data-natural-w={natural?.w} data-natural-h={natural?.h} />;
  // card: a soft light panel behind illustrations drawn for white paper.
  return item.card ? <g><rect x={item.x - 8} y={item.y - 8} width={item.width + 16} height={item.height + 16} rx="14" fill="#efe9dc" opacity="0.94" />{img}</g> : img;
}

const MemoArtifact = React.memo(Artifact, (a, b) => a.sig === b.sig);

/* ---------- board ---------- */
// One draw list for every item kind, ordered by z (stable within equal z).
function drawList(board) {
  const list = [];
  for (const s of board.scene.shapes || []) list.push({ id: s.id, kind: s.type === "text" ? "text" : "mark", z: s.z ?? 0, chapter: s.chapter, anim: s, el: drawShape(s) });
  for (const a of board.scene.artifacts || []) list.push({ id: a.id, kind: "artifact", z: a.z ?? 0, chapter: a.chapter, anim: a, el: <MemoArtifact item={a} sig={JSON.stringify(a)} /> });
  const stacked = new Map(); // chapter -> equations placed by the fallback stack so far
  for (const eq of board.equations) {
    let { x, y } = eq;
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      const k = stacked.get(eq.chapter ?? "") ?? 0;
      stacked.set(eq.chapter ?? "", k + 1);
      if (!Number.isFinite(x)) x = EQ_STACK.x;
      if (!Number.isFinite(y)) y = EQ_STACK.y + k * EQ_STACK.gap;
    }
    list.push({ id: eq.id, kind: "equation", z: eq.z ?? 0, chapter: eq.chapter, anim: eq, el: <MemoFormula eq={eq} x={x} y={y} sig={JSON.stringify(eq)} /> });
  }
  return list.map((d, i) => ({ ...d, i })).sort((a, b) => a.z - b.z || a.i - b.i);
}
function ChapterFrame({ c }) {
  if (c.frame === false) return null;
  return <g className="chapter-frame" data-chapter-frame={c.id}>
    {/* The frame keeps a constant on-screen weight, and the title (style.css) a minimum on-screen
        size, so a zoomed-out overview still shows where each chapter is and what it is called. */}
    <rect x={c.x} y={c.y} width={c.w} height={c.h} rx="18" fill="none" stroke="#ffffff1c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    {c.title ? <text className="chapter-title" x={c.x + 6} y={c.y - 16} fill="#8a8578" fontSize="22" style={{ fontFamily: FONTS.serif, fontStyle: "italic" }}>{c.title}</text> : null}
  </g>;
}
function Board({ board, revision }) {
  React.useEffect(() => { window.__board.revision = revision; }, [revision, board]);
  const chapters = new Map(chaptersOf(board).map((c) => [c.id, c]));
  return <svg id="blackboard" viewBox={currentView.join(" ")} preserveAspectRatio="xMidYMid meet" role="img" aria-label="Mathematics blackboard">
    {chaptersOf(board).map((c) => <ChapterFrame key={`frame-${c.id}`} c={c} />)}
    {drawList(board).map((d) => {
      if (!d.el) return null;
      const c = d.chapter && chapters.get(d.chapter);
      const a = d.anim ?? {};
      return <g key={d.id} data-id={d.id} data-kind={d.kind} data-chapter={c ? c.id : undefined} data-step={a.step ?? 0} data-reveal={a.reveal} data-duration={a.duration} data-order={a.order} transform={c ? `translate(${c.x} ${c.y})` : undefined}>{d.el}</g>;
    })}
  </svg>;
}

/* ---------- layout lint (measured from the real DOM) ---------- */
function boardRect(svg, el) {
  const inv = svg.getScreenCTM().inverse();
  const r = el.getBoundingClientRect();
  if (!r.width && !r.height) return null;
  const p1 = new DOMPoint(r.left, r.top).matrixTransform(inv), p2 = new DOMPoint(r.right, r.bottom).matrixTransform(inv);
  return { x: p1.x, y: p1.y, w: p2.x - p1.x, h: p2.y - p1.y };
}
function overlapArea(a, b) { const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x), h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y); return w > 0 && h > 0 ? w * h : 0; }
window.__boardLint = (home = { x: 0, y: 0, w: BOARD.w, h: BOARD.h }) => {
  const chapters = new Map(chaptersOf(lastData?.board).map((c) => [c.id, c]));
  const svg = $("blackboard");
  if (!svg) return { items: [], issues: [] };
  const items = [];
  for (const g of svg.querySelectorAll(":scope > g[data-id]")) {
    let box;
    if (g.dataset.kind === "equation") { const f = g.querySelector(".formula"); box = f && boardRect(svg, f); }
    else box = boardRect(svg, g);
    if (box) items.push({ id: g.dataset.id, kind: g.dataset.kind, chapter: g.dataset.chapter, ...Object.fromEntries(Object.entries(box).map(([k, v]) => [k, Math.round(v)])) });
  }
  const issues = [];
  for (const el of svg.querySelectorAll("[data-render-error]"))
    issues.push(`artifact ${el.closest("g[data-id]")?.dataset.id} FAILED TO RENDER: ${el.dataset.renderError}`);
  // A Mermaid diagram is scaled to fit its box: a long chain in a small box shrinks its text
  // below reading size, which no overlap check can see.
  for (const im of svg.querySelectorAll(":scope > g[data-kind=artifact] image[data-natural-w]")) {
    const nw = Number(im.dataset.naturalW), nh = Number(im.dataset.naturalH);
    const w = im.width.baseVal.value, h = im.height.baseVal.value, k = Math.min(w / nw, h / nh);
    if (!(k > 0) || MERMAID_FONT_PX * k >= MIN_TEXT_PX) continue;
    // Smallest box (same aspect as the diagram) that keeps the text readable.
    const need = (v) => Math.ceil((v * MIN_TEXT_PX) / MERMAID_FONT_PX / 10) * 10;
    issues.push(`mermaid ${im.closest("g[data-id]")?.dataset.id}: text renders at about ${Math.round(MERMAID_FONT_PX * k)} px (diagram shrunk to ${Math.round(k * 100)}% to fit ${Math.round(w)}x${Math.round(h)}); ` +
      `it needs at least ${need(nw)}x${need(nh)}: enlarge it, use fewer nodes per row (e.g. graph TD instead of LR) or shorten the labels`);
  }
  for (const it of items) {
    // Items in a chapter must stay inside it; free items inside the home board.
    const c = it.chapter && chapters.get(it.chapter);
    const b = c ? { x: c.x, y: c.y, w: c.w, h: c.h } : home;
    const out = it.x < b.x - 2 || it.y < b.y - 2 || it.x + it.w > b.x + b.w + 2 || it.y + it.h > b.y + b.h + 2;
    if (out) issues.push(c
      ? `${it.kind} ${it.id} extends outside chapter "${c.id}" (local bbox ${it.x - c.x},${it.y - c.y} ${it.w}x${it.h}; chapter is ${c.w}x${c.h})`
      : `${it.kind} ${it.id} extends off the board (bbox ${it.x},${it.y} ${it.w}x${it.h})`);
  }
  const words = items.filter((i) => i.kind === "text" || i.kind === "equation");
  for (let a = 0; a < items.length; a++) for (let b = a + 1; b < items.length; b++) {
    const A = items[a], B = items[b], area = overlapArea(A, B);
    if (!area) continue;
    const small = Math.min(A.w * A.h, B.w * B.h) || 1, frac = area / small;
    const isWord = (x) => words.includes(x);
    if (isWord(A) && isWord(B) && frac > 0.08) issues.push(`${A.kind} ${A.id} overlaps ${B.kind} ${B.id} (${Math.round(frac * 100)}% of the smaller)`);
    else if ((A.kind === "equation" && B.kind === "artifact") || (A.kind === "artifact" && B.kind === "equation")) { if (frac > 0.15) issues.push(`equation and artifact overlap: ${A.id} / ${B.id} (${Math.round(frac * 100)}%)`); }
    else if (A.kind === "artifact" && B.kind === "artifact" && frac > 0.05) issues.push(`artifacts ${A.id} and ${B.id} overlap (${Math.round(frac * 100)}%)`);
  }
  return { items, issues };
};

/* ---------- item references (hover label, click to copy) ---------- */
// The learner cannot draw on the page and talks to the tutor in the terminal, so every item has a
// reference they can type: resting the pointer on an item shows a quiet
// "step 4 · eq2 · ch1" label next to it, and a click (not a drag) copies
// "step 4, eq2 (chapter ch1)". Nothing is sent to the server and the board is
// not changed. Snapshot pages (nofollow) never show it.
const REFS = !NO_FOLLOW;
const REF_SLACK = 5; // px around an item that still count as pointing at it
const COPY_DELAY = 250; // ms; a second click inside this is a double-click (Follow), not a copy
let refPoint = null; // last hover position in client px; null while the pointer is off the board
let refDrag = false; // a drag is panning the board: no label
let refShown = false, refFrame = 0, copyTimer = 0, toastTimer = 0;
function itemRef(g) {
  const step = Number(g.dataset.step);
  // A plot with sliders adds the values the learner has set: "step 3, p1 (chapter c) with a = 1.50".
  const params = g.querySelector(":scope > .plot")?.dataset.params || null;
  return { id: g.dataset.id, step: Number.isInteger(step) && step > 0 ? step : null, chapter: g.dataset.chapter || null, params };
}
const refText = (r) => `${r.step ? `step ${r.step}, ` : ""}${r.id}${r.chapter ? ` (chapter ${r.chapter})` : ""}${r.params ? ` with ${r.params}` : ""}`;
function segDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2)) : 0;
  return Math.hypot(px - ax - t * dx, py - ay - t * dy);
}
/** How near the pointer (client px) is to item group g: { on, d, area, rect }, or null when it is not near. */
function hitItem(g, x, y) {
  if (g.style.visibility === "hidden") return null; // a step not shown yet
  const box = g.dataset.kind === "equation" ? g.querySelector(".formula") : g;
  const rect = box?.getBoundingClientRect();
  if (!rect || (!rect.width && !rect.height)) return null;
  const out = Math.hypot(Math.max(rect.left - x, 0, x - rect.right), Math.max(rect.top - y, 0, y - rect.bottom));
  if (out > REF_SLACK) return null;
  // Lines, arrows and strokes: measure to the stroke itself, not to their mostly empty box.
  const strokes = g.dataset.kind === "mark" ? [...g.querySelectorAll("polyline,polygon")] : [];
  if (!strokes.length) return { on: out === 0, d: out, area: rect.width * rect.height, rect };
  let d = Infinity, len = 0, half = 1;
  for (const el of strokes) {
    const m = el.getScreenCTM(), list = el.points;
    if (!m || !list) continue;
    half = Math.max(half, ((Number(el.getAttribute("stroke-width")) || 2) * Math.hypot(m.a, m.b)) / 2);
    const p = [];
    for (let i = 0; i < list.numberOfItems; i++) { const q = list.getItem(i); p.push(new DOMPoint(q.x, q.y).matrixTransform(m)); }
    if (el.tagName === "polygon" && p.length > 2) p.push(p[0]);
    for (let i = 1; i < p.length; i++) {
      d = Math.min(d, segDist(x, y, p[i - 1].x, p[i - 1].y, p[i].x, p[i].y));
      len += Math.hypot(p[i].x - p[i - 1].x, p[i].y - p[i - 1].y);
    }
  }
  const reach = half + REF_SLACK;
  return d > reach ? null : { on: d <= half + 2, d, area: Math.max(1, len) * reach * 2, rect };
}
/** The item the pointer is on, preferring the most specific (smallest) one; ties go to the one drawn on top. */
function pickItem(x, y) {
  let best = null;
  for (const g of itemGroups()) {
    const h = hitItem(g, x, y);
    if (h && (!best || (h.on !== best.on ? h.on : h.on ? h.area <= best.area : h.d <= best.d))) best = { ...h, g };
  }
  return best;
}
function showRef(hit) {
  const label = $("item-ref"), outline = $("item-outline");
  if (!label || !outline) return;
  $("surface")?.classList.toggle("over-item", !!hit);
  refShown = !!hit;
  if (!hit) { label.classList.remove("show"); outline.classList.remove("show"); return; }
  const ref = itemRef(hit.g), key = refText(ref);
  if (label.dataset.ref !== key) {
    const parts = [];
    if (ref.step) { const s = document.createElement("span"); s.className = "ref-step"; s.textContent = `step ${ref.step}`; parts.push(s, " · "); }
    parts.push(ref.id);
    if (ref.chapter) parts.push(" · ", ref.chapter);
    label.replaceChildren(...parts); // ids are text, never HTML
    label.dataset.ref = key;
  }
  // Sit just above the item's top-left corner; if that is off screen, sit by the pointer.
  const r = hit.rect, w = label.offsetWidth, h = label.offsetHeight, W = innerWidth, H = innerHeight;
  let x = r.left, y = r.top - h - 6;
  if (y < 4 || r.left < 0 || r.left > W - 24) { x = (refPoint?.x ?? r.left) + 14; y = (refPoint?.y ?? r.top) + 18; }
  x = Math.max(4, Math.min(W - w - 4, x)); y = Math.max(4, Math.min(H - h - 4, y));
  label.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  outline.style.transform = `translate(${Math.round(r.left - 3)}px, ${Math.round(r.top - 3)}px)`;
  outline.style.width = `${Math.round(r.width + 6)}px`;
  outline.style.height = `${Math.round(r.height + 6)}px`;
  label.classList.add("show"); outline.classList.add("show");
}
/** Re-check what is under the pointer on the next frame (pointer moved, view moved, items changed). */
function scheduleRef() {
  if (!REFS || refFrame || (!refPoint && !refShown)) return;
  refFrame = requestAnimationFrame(() => { refFrame = 0; showRef(refPoint && !refDrag ? pickItem(refPoint.x, refPoint.y) : null); });
}
function refHover(x, y) { if (REFS) { refPoint = { x, y }; scheduleRef(); } }
function refLeave() { refPoint = null; scheduleRef(); }
function refDragging(on) { refDrag = on; if (on) showRef(null); else scheduleRef(); }
function cancelCopy() { clearTimeout(copyTimer); copyTimer = 0; }
function refClick(e) {
  cancelCopy();
  if (!REFS || e.detail > 1) return; // the second click of a double-click means Follow
  const hit = pickItem(e.clientX, e.clientY);
  if (!hit) return;
  // The reference is read when it is copied, so it has the slider values on screen by then.
  copyTimer = setTimeout(() => { copyTimer = 0; copyRef(refText(itemRef(hit.g))); }, COPY_DELAY);
}
async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* fall through */ }
  // No async clipboard (or it was refused): copy from a hidden, read-only textarea.
  const ta = document.createElement("textarea"), prev = document.activeElement;
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.setAttribute("aria-hidden", "true");
  ta.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0;pointer-events:none";
  document.body.appendChild(ta);
  let ok = false;
  try { ta.focus({ preventScroll: true }); ta.select(); ok = document.execCommand("copy"); } catch { /* ok stays false */ }
  ta.remove();
  if (prev && prev !== document.body) prev.focus?.({ preventScroll: true });
  return ok;
}
async function copyRef(text) {
  const ok = await copyText(text);
  toast(ok ? `Copied: ${text}` : `Could not copy. Type: ${text}`, ok ? 2000 : 5000);
}
function toast(text, ms) {
  const el = $("toast");
  if (!el) return;
  el.textContent = text;
  el.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove("show"), ms);
}

/* ---------- wiring ---------- */
let root, lastData;
function render(data) {
  const first = !lastData;
  lastData = data;
  if (!root) root = createRoot($("surface"));
  // Commit synchronously so new steps can be hidden before the browser paints.
  flushSync(() => root.render(<Board board={data.board} revision={data.revision} />));
  syncCamera(data.board, first);
  updateViewScale();
  onRendered(data.board, first);
  scheduleRef();
}
const sync = new BoardSync({ request, status: (text) => status(text), render: (data) => render(data) });
const guarded = (fn) => (...args) => Promise.resolve().then(() => fn(...args)).catch((e) => status(e.message, true));

/* ---------- the bar: a quiet pill at rest, the controls below it on hover, focus or tap ---------- */
// Its width follows its content (the pill's line when closed, the wider of that and the controls
// when open), set in px so the change can animate.
function sizeBar() {
  const top = $("bar-top").offsetWidth, inner = $("bar-inner").offsetWidth;
  bar.style.width = `${Math.ceil((bar.classList.contains("open") ? Math.max(top, inner) : top) + 1)}px`;
}
let barTimer = 0, barPointer = "mouse";
function openBar(open) {
  clearTimeout(barTimer);
  if (!open) showMore(false);
  if (bar.classList.contains("open") === open) return;
  bar.classList.toggle("open", open);
  sizeBar();
}
function showMore(on) {
  bar.classList.toggle("more", on);
  $("btn-more").setAttribute("aria-expanded", String(on));
}
function installBar() {
  const ro = new ResizeObserver(sizeBar);
  ro.observe($("bar-top"));
  ro.observe($("bar-inner"));
  sizeBar();
  requestAnimationFrame(() => bar.classList.add("sized")); // no width animation on page load
  // A mouse or pen opens it by hovering; a finger taps the pill (and anywhere else to close it).
  bar.addEventListener("pointerdown", (e) => { barPointer = e.pointerType; });
  bar.addEventListener("pointerenter", (e) => { if (e.pointerType !== "touch") openBar(true); });
  bar.addEventListener("pointerleave", (e) => {
    if (e.pointerType === "touch" || bar.contains(document.activeElement)) return;
    clearTimeout(barTimer);
    barTimer = setTimeout(() => openBar(false), 400);
  });
  $("bar-top").addEventListener("click", () => { if (barPointer === "touch") openBar(!bar.classList.contains("open")); });
  document.addEventListener("pointerdown", (e) => { if (!bar.contains(e.target)) openBar(false); }, true);
  bar.addEventListener("focusin", () => openBar(true));
  bar.addEventListener("focusout", (e) => { if (!bar.contains(e.relatedTarget) && !bar.matches(":hover")) openBar(false); });
  $("btn-more").onclick = () => showMore(!bar.classList.contains("more"));
}
/** One quiet banner for what the learner must act on (today: the board server stopped). */
function notice(text) {
  $("notice-message").textContent = text || "";
  $("notice").hidden = !text;
}
const nextPaint = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
/**
 * The page's only writes (Clear, Save) carry the revision on screen. If the board changed before
 * the write arrived (409), the current board is shown and the learner is asked again.
 */
async function confirmedWrite(path, body, { ask, again }) {
  if (ask && !confirm(ask)) return null;
  for (;;) {
    const r = await sync.mutate(path, body);
    if (r.ok) return r.data;
    await nextPaint(); // let the changed board show before the question blocks the page
    if (!confirm(`The board changed in the meantime (it is now at revision ${r.revision}). ${again}`)) {
      status(`Not done: the board changed · revision ${r.revision}`, true);
      return null;
    }
  }
}
installNavigation();
installBar();
$("btn-prev").onclick = () => goChapter(-1);
$("btn-next").onclick = () => goChapter(1);
$("btn-overview").onclick = () => { manual(); animateTo(overviewView(lastData?.board)); };
$("btn-follow").onclick = () => setFollow(true);
// Nav buttons must not keep keyboard focus: Space/Enter would re-click them
// instead of driving playback.
for (const b of document.querySelectorAll("nav button")) b.addEventListener("mousedown", (e) => e.preventDefault());
$("btn-step-back").onclick = () => stepBack();
$("btn-step-fwd").onclick = () => stepForward();
$("btn-replay").onclick = () => replayChapter();
setFollow(follow);
$("btn-clear").onclick = guarded(() => confirmedWrite("/api/update", { clear: ["all"] }, {
  ask: "Clear the whole board? (Save first if you want to keep it.)",
  again: "Clear the whole board as it is now?",
}));
$("btn-save").onclick = guarded(async () => {
  const r = await confirmedWrite("/api/save", { name: "default" }, { again: "Save the board as it is now?" });
  if (r) status(`Saved · revision ${r.saved.revision}`, true);
});

/* ---------- connection ---------- */
const STOPPED_NOTICE = "The board server stopped; reopen it with /board (or board_open).";
function onConnection(state) {
  bar.dataset.conn = state;
  if (state === "connected") {
    notice("");
    status(sync.revision >= 0 ? `Connected · revision ${sync.revision}` : "Connected");
  } else if (state === "reconnecting") status("Connection lost · reconnecting…");
  else if (state === "stopped") {
    status("Board server stopped");
    notice(STOPPED_NOTICE);
  }
}
let live = null;
function connect() {
  live?.close();
  live = new LiveEvents({
    open: () => new EventSource(`/api/events?token=${encodeURIComponent(sessionToken)}`),
    onState: onConnection,
    // The first event after an outage may come from a restarted server: show its board as it is.
    onEvent: (d, { resync }) => {
      if (Number.isSafeInteger(d.revision)) (resync ? sync.resync(d.revision) : sync.remote(d.revision)).catch((e) => status(e.message, true));
    },
  }).start();
}
async function start() {
  if (!/^[a-f0-9]{64}$/.test(sessionToken || "")) throw Error("Missing session token: open the board with /board (or board_open).");
  // If the server is not reachable, the event stream retries and reports it.
  await sync.refresh().catch((e) => status(e.message, true));
  connect();
  window.addEventListener("pagehide", () => { live?.close(); live = null; });
  window.addEventListener("pageshow", (e) => { if (e.persisted) { connect(); sync.refresh().catch((err) => status(err.message, true)); } });
}
start().catch((e) => status(e.message, true));
