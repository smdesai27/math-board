/**
 * html artifacts on the server: off unless MATH_BOARD_HTML=1, strict input, the frame document and
 * its own policy, frame addresses only for the current content, libraries for the opaque-origin
 * frames, and the headless check that decides which frames a learner's page may load.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer, HTML_LIBS, applyUpdate, emptyBoard, frameCsp, frameDocument, htmlEnabled, restoreOps, sanitizeArtifact, vendorManifest } from "../server.mjs";
import { BOARD_DOCS, handlers } from "../tools.mjs";

const temps = [];
test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
async function board(t, opts = {}) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "math-board-html-"));
  temps.push(dataDir);
  const s = new BoardServer({ dataDir, autosave: false, ...opts });
  await s.start();
  t.after(() => s.stop());
  const base = `http://127.0.0.1:${s.port}`;
  const get = (p, headers = {}) => fetch(base + p, { headers: { Authorization: `Bearer ${s.token}`, ...headers } });
  return { s, base, get };
}
const HTML = (fields = {}) => ({ type: "html", id: "h", x: 10, y: 20, width: 400, height: 300, source: "<p>hi</p>", ...fields });

test("html artifacts are off unless MATH_BOARD_HTML=1, and say how to turn them on", () => {
  assert.equal(htmlEnabled({}), false);
  assert.equal(htmlEnabled({ MATH_BOARD_HTML: "1" }), true);
  assert.equal(htmlEnabled({ MATH_BOARD_HTML: "true" }), false);
  assert.throws(() => sanitizeArtifact(HTML(), { strict: true }), /html artifacts are off on this board \(the learner turns them on with MATH_BOARD_HTML=1\)/);
  assert.throws(() => applyUpdate(emptyBoard(), { scene: { mode: "append", artifacts: [HTML()] } }), /MATH_BOARD_HTML=1/);
  // A save with html artifacts loads on a board without them: they are skipped and named.
  const saved = applyUpdate(emptyBoard(), { scene: { mode: "append", artifacts: [HTML(), { type: "plot", id: "p", functions: [{ expr: "x" }] }] } }, { html: true });
  const off = restoreOps(saved);
  assert.deepEqual(off.update.scene.artifacts.map((a) => a.id), ["p"]);
  assert.equal(off.dropped.artifacts, 1);
  assert.match(off.dropped.reasons.join(" "), /html artifacts are off/);
  assert.deepEqual(restoreOps(saved, { html: true }).update.scene.artifacts.map((a) => a.id), ["h", "p"]);
});

test("html input: a body of at most 64 KiB and known libraries", () => {
  const ok = (f) => sanitizeArtifact(HTML(f), { strict: true, html: true });
  assert.deepEqual(ok({ libs: ["three", "lil-gui"] }).libs, ["three", "lil-gui"]);
  assert.equal("libs" in ok({ libs: [] }), false);
  assert.equal(ok({ source: "x".repeat(64 * 1024) }).source.length, 64 * 1024);
  const bad = (f, re) => assert.throws(() => ok(f), re);
  bad({ source: " " }, /html needs source/);
  bad({ source: 5 }, /html needs source/);
  bad({ source: "é".repeat(33 * 1024) }, /html source is 66 KiB; at most 64 KiB/);
  bad({ libs: ["jquery"] }, /libs must be a list of distinct names from: three, d3, matter, lil-gui, fft, katex/);
  bad({ libs: ["d3", "d3"] }, /distinct/);
  bad({ libs: "three" }, /libs must be a list/);
  bad({ script: "x" }, /unknown field "script"/);
  // Lenient (old saves): unknown libraries are dropped.
  assert.deepEqual(sanitizeArtifact(HTML({ libs: ["d3", "nope", "d3"] }), { html: true }).libs, ["d3"]);
  assert.deepEqual(HTML_LIBS, ["three", "d3", "matter", "lil-gui", "fft", "katex"]);
});

test("the frame document: bridge first, then the libraries, then the source with its line numbers", () => {
  const manifest = vendorManifest();
  for (const lib of [...HTML_LIBS, "katex.css"]) assert.match(manifest[lib] ?? "", /^vendor\/[a-z0-9-]+-[A-Z0-9]+\.(js|css)$/, `${lib} is built`);
  const item = sanitizeArtifact(HTML({ libs: ["three", "katex"], source: "<p>a</p>\n<script>\nboom()\n</script>" }), { html: true });
  const doc = frameDocument(item, manifest);
  const lines = doc.split("\n");
  const offset = Number(/OFFSET=(\d+)/.exec(doc)[1]);
  assert.equal(lines[offset + 2], "boom()", "source line 3 is document line OFFSET + 3");
  assert.ok(doc.indexOf("window.board=") < doc.indexOf(manifest.three), "the bridge runs before the libraries");
  assert.ok(doc.indexOf(manifest.three) < doc.indexOf(manifest.katex) && doc.includes(`href="/${manifest["katex.css"]}"`));
  assert.match(doc, /width:400,height:300/);
  // A library missing from the build is reported by the frame, not silently skipped.
  assert.match(frameDocument({ ...item, libs: ["three"] }, {}), /board\.fail\("the three library is missing/);
  const csp = frameCsp(4321);
  for (const part of ["default-src 'none'", "connect-src 'none'", "form-action 'none'", "sandbox allow-scripts", "frame-ancestors http://127.0.0.1:4321", "script-src 'unsafe-inline' http://127.0.0.1:4321/vendor/"]) assert.ok(csp.includes(part), part);
  assert.ok(!/unsafe-eval|https?:\/\/(?!127\.0\.0\.1)/.test(csp));
});

test("the server serves a frame only at its current address, with the frame's own policy", async (t) => {
  const { s, base, get } = await board(t, { html: true });
  s.snapshots.lint = async () => ({ items: [], issues: [], frames: {} });
  s.update({ scene: { mode: "append", artifacts: [HTML({ libs: ["fft"] })] } });
  // The headless check page gets the address; a learner's page waits for the check.
  const snap = await (await get("/api/state", { "x-math-board-snapshot": "1" })).json();
  const url = snap.frames.h;
  assert.match(url, /^\/frame\/[a-f0-9]{32}$/);
  const learner = await (await get("/api/state")).json();
  assert.deepEqual([learner.frames, learner.frameStates], [{}, { h: { state: "checking" } }]);
  // The frame needs no token (it has none); its address is unguessable and tied to the content.
  const r = await fetch(base + url);
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("content-security-policy"), frameCsp(s.port));
  assert.match(r.headers.get("content-type"), /^text\/html/);
  assert.match(await r.text(), /<p>hi<\/p>/);
  assert.ok(!url.includes(s.token.slice(0, 16)));
  assert.equal((await fetch(`${base}/frame/${"0".repeat(32)}`)).status, 404);
  assert.equal((await fetch(`${base}/frame/nope`)).status, 404);
  s.update({ items: [{ op: "update", id: "h", fields: { source: "<p>changed</p>" } }] });
  assert.equal((await fetch(base + url)).status, 404, "the old address stops working when the content changes");
  // The board page may embed frames from itself only when html artifacts are on.
  assert.match((await fetch(base + "/")).headers.get("content-security-policy"), /frame-src 'self'/);
  // Frames have an opaque origin: they may load libraries and fonts (cacheable), nothing else.
  const lib = vendorManifest().fft;
  const v = await fetch(`${base}/${lib}`, { headers: { Origin: "null" } });
  assert.equal(v.status, 200);
  assert.equal(v.headers.get("access-control-allow-origin"), "*");
  assert.match(v.headers.get("cache-control"), /immutable/);
  assert.equal((await get("/api/state", { Origin: "null" })).status, 403);
  assert.equal((await fetch(`${base}/app.js`, { headers: { Origin: "null" } })).status, 403);
});

test("a board without html artifacts keeps its old policy and serves no frames", async (t) => {
  const { s, base, get } = await board(t, { html: false });
  assert.match((await fetch(base + "/")).headers.get("content-security-policy"), /frame-src 'none'/);
  assert.deepEqual(await (await get("/api/state")).json().then((d) => [d.frames, d.frameStates]), [{}, {}]);
  assert.equal(s.html, false);
});

test("the headless check: one frame at a time; a hang holds it back, no browser lets it through unchecked", async (t) => {
  const { s, get } = await board(t, { html: true });
  const events = [];
  s.broadcast = (e) => events.push(e.type);
  s.update({ scene: { mode: "append", artifacts: [HTML({ id: "a" }), HTML({ id: "b", x: 500 }), HTML({ id: "c", y: 400 })] } });
  const mac = (id) => s.frameMac(s.board.scene.artifacts.find((x) => x.id === id));
  assert.deepEqual(s.uncheckedFrames(), [{ id: "a", mac: mac("a") }]);
  const snapFrames = async () => Object.keys((await (await get("/api/state", { "x-math-board-snapshot": "1" })).json()).frames);
  assert.deepEqual(await snapFrames(), ["a"], "the check page loads only the frame being checked");
  s.frameChecked(s.uncheckedFrames(), { a: "ready" });
  assert.deepEqual(events.filter((e) => e === "frames"), ["frames"], "pages are told to fetch the frames again");
  s.frameChecked(s.uncheckedFrames(), null, Object.assign(new Error("Timeout 8000ms exceeded"), { name: "TimeoutError" }));
  s.frameChecked(s.uncheckedFrames(), null, new Error("no headless browser available (…)"));
  assert.deepEqual(s.uncheckedFrames(), []);
  const learner = await (await get("/api/state")).json();
  assert.deepEqual(Object.keys(learner.frames), ["a", "c"]);
  assert.equal(learner.frameStates.b.state, "failed");
  assert.match(learner.frameStates.b.reason, /not shown: in the headless check it was not ready within 8 s/);
  // A cancelled check decides nothing; an error state from the page still counts as loaded.
  s.update({ scene: { mode: "append", artifacts: [HTML({ id: "d", y: 700 })] } });
  s.frameChecked(s.uncheckedFrames(), null, new Error("cancelled"));
  assert.deepEqual(s.uncheckedFrames().map((f) => f.id), ["d"]);
  s.frameChecked(s.uncheckedFrames(), { d: "loading" });
  assert.deepEqual(s.uncheckedFrames().map((f) => f.id), ["d"], "still loading when the check ended: not decided");
  s.frameChecked(s.uncheckedFrames(), { d: "error" });
  assert.deepEqual(s.uncheckedFrames(), []);
  // The check of a frame is per content: changing it checks it again.
  s.update({ items: [{ op: "update", id: "a", fields: { source: "<p>new</p>" } }] });
  assert.deepEqual(s.uncheckedFrames().map((f) => f.id), ["a"]);
  assert.notEqual(mac("a"), s.frameChecks.keys().next().value);
});

test("a learner's page asking for the board starts the check in the background, at most twice per frame", async (t) => {
  const { s, get } = await board(t, { html: true });
  let calls = 0;
  s.snapshots.lint = async () => { calls++; return { items: [], issues: [], frames: {} }; };
  s.update({ scene: { mode: "append", artifacts: [HTML()] } });
  await get("/api/state", { "x-math-board-snapshot": "1" });
  assert.equal(calls, 0, "the check page itself does not start checks");
  await get("/api/state");
  await new Promise((r) => setTimeout(r, 50));
  // The stub never reports the frame, so the check is retried once and then left alone.
  assert.equal(calls, 2);
  await get("/api/state");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(calls, 2);
});

test("board_docs html says whether html artifacts are on; board_read lists their libraries", async (t) => {
  const prev = process.env.MATH_BOARD_HTML;
  t.after(() => { if (prev === undefined) delete process.env.MATH_BOARD_HTML; else process.env.MATH_BOARD_HTML = prev; });
  delete process.env.MATH_BOARD_HTML;
  const text = async (topic) => (await handlers.board_docs({}, { topic })).content[0].text;
  assert.match(await text("html"), /html artifacts on this board: OFF/);
  process.env.MATH_BOARD_HTML = "1";
  assert.match(await text("html"), /html artifacts on this board: on\.$/);
  assert.match(await text("overview"), /- html: your own HTML and JavaScript in a sandbox/);
  for (const lib of HTML_LIBS) assert.ok(BOARD_DOCS.html.includes(`${lib} (window.`), `docs name ${lib}`);
  // The example in the docs is valid input.
  const example = JSON.parse(BOARD_DOCS.html.split("\n").find((l) => l.startsWith("Example: ")).slice("Example: ".length));
  assert.equal(sanitizeArtifact(example, { strict: true, html: true }).libs[0], "three");
  const { s } = await board(t, { html: true });
  s.update({ scene: { mode: "append", artifacts: [HTML({ libs: ["three", "lil-gui"] })] } });
  const { summarizeBoard } = await import("../tools.mjs");
  assert.match(summarizeBoard(s.board), /\[h\] html at \(10,20\) 400x300 \(9 chars\) libs: three, lil-gui/);
});
