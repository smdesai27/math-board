/**
 * Where boards are kept and how they survive: the data folder rule, autosave backups, an
 * unrestorable autosave, a data folder two boards share, an unwritable one, the save format
 * version, what a load skips, and a stopped server. Plus the update rules that decide what is
 * stored: strict validation, ids, equation positions, steps and chapters.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoardServer,
  SCHEMA_VERSION,
  applyUpdate,
  applyUpdateReport,
  defaultDataDir,
  emptyBoard,
  isPlainCheckout,
  restoreOps,
  userDataDir,
} from "../server.mjs";

const temps = [];
async function tempDir(prefix = "math-board-data-test-") {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of temps) {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});
const read = async (file) => JSON.parse(await readFile(file, "utf8"));

test("data folder: env override, else .data in a checkout, else a per-user folder; the MCP board uses mcp/", () => {
  const home = "/home/u";
  const env = (extra = {}) => ({ HOME: home, ...extra });
  assert.equal(defaultDataDir("pi", { env: { MATH_BOARD_DATA_DIR: "/x" } }), "/x");
  assert.equal(defaultDataDir("mcp", { env: { PI_MATH_BOARD_DATA_DIR: "/old" } }), "/old", "the older name still works");
  assert.equal(defaultDataDir("pi", { env: { MATH_BOARD_DATA_DIR: "/new", PI_MATH_BOARD_DATA_DIR: "/old" } }), "/new");
  // A clone run in place keeps its data next to the code (git-ignored).
  assert.equal(defaultDataDir("pi", { env: env(), packageDir: "/src/math-board" }), "/src/math-board/.data");
  assert.equal(defaultDataDir("mcp", { env: env(), packageDir: "/src/math-board" }), "/src/math-board/.data/mcp");
  // Installed copies are replaced on update, cleaned by pi's git updater or live in npx's cache.
  for (const installed of ["/u/.pi/agent/npm/node_modules/pi-math-board", "/u/.pi/agent/git/github.com/smdesai27/math-board", "/p/.pi/git/x/math-board", "/u/.npm/_npx/abc/node_modules/pi-math-board", "/usr/lib/node_modules/pi-math-board"])
    assert.equal(isPlainCheckout(installed, env()), false, installed);
  assert.equal(isPlainCheckout("/agent/pkgs/math-board", env({ PI_CODING_AGENT_DIR: "/agent" })), false);
  assert.equal(isPlainCheckout("/cache/x/math-board", env({ npm_config_cache: "/cache" })), false);
  assert.equal(isPlainCheckout("/Volumes/Dev/math-board", env()), true);
  const installed = "/u/.pi/agent/npm/node_modules/pi-math-board";
  assert.equal(defaultDataDir("pi", { env: env(), packageDir: installed, platform: "linux" }), path.join(userDataDir({}, "linux")));
  assert.equal(defaultDataDir("mcp", { env: env({ XDG_STATE_HOME: "/state" }), packageDir: installed, platform: "linux" }), "/state/math-board/mcp");
  assert.match(userDataDir({}, "darwin"), /\/Library\/Application Support\/math-board$/);
  assert.match(userDataDir({}, "linux"), /\/\.local\/state\/math-board$/);
  assert.equal(userDataDir({ XDG_STATE_HOME: "relative" }, "linux"), userDataDir({}, "linux"), "a relative XDG_STATE_HOME is ignored");
  assert.equal(userDataDir({ LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local" }, "win32"), path.join("C:\\Users\\u\\AppData\\Local", "math-board"));
});

test("autosave carries the format version and keeps three older copies", async () => {
  const dir = await tempDir();
  const a = new BoardServer({ dataDir: dir });
  await a.start();
  a.update({ title: "one" });
  await a.flushAutosave();
  assert.equal((await read(path.join(dir, "autosave.json"))).schemaVersion, SCHEMA_VERSION);
  a.update({ title: "two" });
  await a.flushAutosave();
  // Within one server and ten minutes, our own writes are not copied again.
  assert.deepEqual((await readdir(dir)).filter((f) => /^autosave\.\d\.json$/.test(f)), []);
  await a.stop();
  // Each new server copies what it found before it first overwrites it.
  for (const title of ["three", "four", "five", "six"]) {
    const s = new BoardServer({ dataDir: dir });
    await s.start();
    s.update({ title });
    await s.stop();
  }
  const backups = (await readdir(dir)).filter((f) => /^autosave\.\d\.json$/.test(f)).sort();
  assert.deepEqual(backups, ["autosave.1.json", "autosave.2.json", "autosave.3.json"]);
  assert.deepEqual(
    await Promise.all(backups.map(async (f) => (await read(path.join(dir, f))).board.title)),
    ["five", "four", "three"],
  );
  assert.equal((await read(path.join(dir, "autosave.json"))).board.title, "six");
});

test("an autosave another process wrote is copied before this board overwrites it", async () => {
  const dir = await tempDir();
  const a = new BoardServer({ dataDir: dir });
  await a.start();
  a.update({ title: "mine" });
  await a.flushAutosave();
  const foreign = JSON.parse(await readFile(path.join(dir, "autosave.json"), "utf8"));
  foreign.board.title = "theirs, longer";
  await writeFile(path.join(dir, "autosave.json"), JSON.stringify(foreign));
  a.update({ title: "mine again" });
  await a.flushAutosave();
  assert.equal((await read(path.join(dir, "autosave.1.json"))).board.title, "theirs, longer");
  await a.stop();
});

test("an unrestorable autosave is moved aside, reported, and never overwritten", async () => {
  for (const [content, why] of [
    ['{"board": {"title": "trunc', /not valid JSON/],
    [JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, board: { title: "future" } }), /newer math-board/],
  ]) {
    const dir = await tempDir();
    await writeFile(path.join(dir, "autosave.json"), content);
    const s = new BoardServer({ dataDir: dir });
    await s.start();
    assert.equal(s.getState().equations.length, 0);
    const [notice] = s.notices();
    assert.match(notice, why);
    assert.match(notice, /moved to autosave\.corrupt-[\dT-]+Z\.json/);
    s.update({ title: "new lesson" });
    await s.stop();
    const files = await readdir(dir);
    const aside = files.find((f) => f.startsWith("autosave.corrupt-"));
    assert.equal(await readFile(path.join(dir, aside), "utf8"), content, "the old file is intact");
    assert.equal((await read(path.join(dir, "autosave.json"))).board.title, "new lesson");
  }
});

test("a restore reports what it skipped; old Excalidraw elements become shapes and old equations keep their place", () => {
  const { update, dropped } = restoreOps({
    title: "old",
    chapters: [{ id: "c", title: "C", x: 0, y: 0 }, { id: "c", title: "again" }],
    equations: [
      { id: "e1", latex: "a" },
      { id: "e2", latex: "b", chapter: "c" },
      { id: "e3", latex: "c" },
      { id: "e4", latex: "d", x: 500, y: 600 },
      { id: "bad", latex: "" },
    ],
    scene: {
      shapes: [{ type: "text", id: "t", text: "hi", x: 1, y: 2, chapter: "gone" }, { type: "line", id: "one", points: [[0, 0]] }],
      artifacts: [{ type: "icon", id: "i", icon: "no-such-icon" }],
      elements: [
        { type: "text", id: "x1", x: 10, y: 20, fontSize: 30, text: "label", strokeColor: "#1e1e1e" },
        { type: "arrow", id: "x2", x: 5, y: 5, points: [[0, 0], [10, 10]], strokeWidth: 2 },
        { type: "rectangle", id: "x3", x: 1, y: 2, width: 3, height: 4 },
        { type: "ellipse", id: "x4", x: 1, y: 2, width: 3, height: 4, isDeleted: true },
        { type: "image", id: "x5", x: 0, y: 0, width: 1, height: 1 },
      ],
    },
  });
  assert.deepEqual(update.chapters.map((c) => c.id), ["c"]);
  // The page drew coordinate-less equations at x 88, y 92 + 115 * (index among the chapter's coordinate-less ones).
  assert.deepEqual(update.equations.map((e) => [e.id, e.x, e.y]), [["e1", 88, 92], ["e2", 88, 92], ["e3", 88, 207], ["e4", 500, 600]]);
  const shapes = Object.fromEntries(update.scene.shapes.map((s) => [s.id, s]));
  assert.deepEqual(Object.keys(shapes).sort(), ["t", "x1", "x2", "x3"]);
  assert.equal(shapes.t.chapter, undefined, "a missing chapter becomes board coordinates");
  assert.deepEqual([shapes.x1.type, shapes.x1.x, shapes.x1.y, shapes.x1.size, shapes.x1.color], ["text", 10, 50, 30, "#e8e3d9"]);
  assert.deepEqual([shapes.x2.type, shapes.x2.points, shapes.x2.width], ["arrow", [[5, 5], [15, 15]], 2]);
  assert.deepEqual([shapes.x3.type, shapes.x3.w, shapes.x3.h], ["rect", 3, 4]);
  assert.deepEqual(
    { chapters: dropped.chapters, shapes: dropped.shapes, artifacts: dropped.artifacts, equations: dropped.equations, duplicates: dropped.duplicates, elements: dropped.elements, references: dropped.references },
    { chapters: 0, shapes: 1, artifacts: 1, equations: 1, duplicates: 1, elements: 1, references: 1 },
  );
  // The full board loads through the lenient path and keeps those positions.
  const board = applyUpdate(emptyBoard(), update, { strict: false });
  assert.deepEqual(board.equations.map((e) => [e.x, e.y]), [[88, 92], [88, 92], [88, 207], [500, 600]]);
});

test("load says what it skipped, in the result and over HTTP", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, "saves"));
  await writeFile(path.join(dir, "saves", "old.json"), JSON.stringify({ board: { scene: { shapes: [{ type: "rect", id: "r" }, { type: "rect", id: "r" }] } } }));
  const s = new BoardServer({ dataDir: dir, autosave: false });
  const r = await s.load("old", 0);
  assert.equal(r.revision, 1);
  assert.match(r.skipped, /^skipped 1 item with a duplicate id \(duplicate id "r"\)$/);
  await assert.rejects(s.load("..", 1), /invalid save name/);
  await assert.rejects(s.save(".hidden"), /not starting with a dot/);
  await writeFile(path.join(dir, "saves", "future.json"), JSON.stringify({ schemaVersion: 99, board: {} }));
  await assert.rejects(s.load("future", 1), /newer math-board \(format 99/);
  assert.equal((await read(path.join(dir, "saves", (await s.save("now")).name + ".json"))).schemaVersion, SCHEMA_VERSION);
});

test("a second board on the same data folder is named in notices; the lock goes away on stop", async () => {
  const dir = await tempDir();
  const a = new BoardServer({ dataDir: dir });
  await a.start();
  assert.equal((await read(path.join(dir, "board.lock"))).pid, process.pid);
  assert.deepEqual(a.notices(), []);
  const b = new BoardServer({ dataDir: dir });
  await b.start();
  assert.match(b.notices().join("\n"), new RegExp(`another board \\(process ${process.pid}, port ${a.port}, .*uses the same data folder`));
  // The first board sees the newcomer at its next autosave.
  a.update({ title: "a" });
  await a.flushAutosave();
  assert.match(a.notices().join("\n"), new RegExp(`port ${b.port}`));
  await b.stop();
  assert.deepEqual(a.notices(), [], "the warning ends with the other board");
  await a.stop();
  await assert.rejects(readFile(path.join(dir, "board.lock")), /ENOENT/);
});

test("an unwritable data folder is reported instead of swallowed", { skip: process.getuid?.() === 0 && "root ignores permissions" }, async () => {
  const parent = await tempDir();
  const dir = path.join(parent, "locked");
  await mkdir(dir);
  await chmod(dir, 0o500);
  const s = new BoardServer({ dataDir: dir });
  await s.start();
  s.update({ title: "lost?" });
  await s.flushAutosave().catch(() => {});
  assert.match(s.notices().join("\n"), /WARNING: the last autosave failed \(EACCES.*changes since revision 0 are not on disk/);
  await chmod(dir, 0o700);
  s.update({ title: "saved" });
  await s.flushAutosave();
  assert.deepEqual(s.notices(), [], "a successful autosave clears the warning");
  await s.stop();
});

test("a stopped server rejects updates and writes nothing more", async () => {
  const dir = await tempDir();
  const s = new BoardServer({ dataDir: dir });
  await s.start();
  s.update({ title: "last" });
  await s.stop();
  assert.throws(() => s.update({ title: "late" }), /board server was stopped; call board_open/);
  assert.equal((await read(path.join(dir, "autosave.json"))).board.title, "last");
  // Starting it again works.
  await s.start();
  s.update({ title: "again" });
  await s.stop();
});

test("strict input: unknown fields, wrong types and bad ids are rejected with the field named", () => {
  const b = emptyBoard();
  const bad = (update, re) => assert.throws(() => applyUpdate(b, update), re);
  bad({ shapes: [{ type: "text", text: "x" }] }, /unknown update field: shapes/);
  bad({ elements: [] }, /unknown update field: elements/);
  bad({ scene: { mode: "append", shapes: [{ type: "text", text: "x", x: 1, y: 2, colour: "red" }] } }, /scene\.shapes\[0\] \(text\): unknown field "colour" \(did you mean "color"\?\)/);
  bad({ scene: { mode: "append", shapes: [{ type: "text", text: " ", x: 1, y: 2 }] } }, /text must be a non-empty string/);
  bad({ scene: { mode: "append", shapes: [{ type: "line", points: [[0, 0]] }] } }, /line needs at least 2 points/);
  bad({ scene: { mode: "append", shapes: [{ type: "line", points: [[0, 0], ["1", 2]] }] } }, /every point must be \[x, y\]/);
  bad({ scene: { mode: "append", shapes: [{ type: "rect", x: "500", y: 0, w: 1, h: 1 }] } }, /x must be a number, got "500"/);
  bad({ scene: { mode: "append", shapes: [{ type: "rect", id: "", x: 0, y: 0, w: 1, h: 1 }] } }, /id must be a string of 1-64 characters/);
  bad({ scene: { mode: "append", shapes: [{ type: "rect", id: "x".repeat(65), x: 0, y: 0, w: 1, h: 1 }] } }, /id must be a string of 1-64/);
  bad({ scene: { mode: "append", shapes: [{ type: "rect", x: 0, y: 0, w: 1, h: 1, color: "red;x" }] } }, /color must be a CSS color/);
  bad({ scene: { mode: "append", artifacts: [{ type: "plot", y: "1", functions: [{ expr: "x" }] }] } }, /artifacts\[0\]: y must be a number/);
  bad({ scene: { mode: "append", artifacts: [{ type: "plot", functions: [{ expr: "x", colour: "red" }] }] } }, /functions\[0\]: unknown field "colour"/);
  bad({ scene: { mode: "append", artifacts: [{ type: "plot", xRange: [2e6, 3e6], functions: [{ expr: "x" }] }] } }, /xRange must be \[min, max\] with min < max/);
  bad({ scene: { mode: "append", artifacts: [{ type: "plot", xRange: [1e6, 1e6 + 1e-6], functions: [{ expr: "x" }] }] } }, /xRange/);
  bad({ scene: { mode: "append", elements: [{ type: "rectangle" }] } }, /Excalidraw elements\) are no longer supported/);
  bad({ equations: [{ op: "add", latex: "x", pinned: true }] }, /equations\[0\]: unknown field "pinned"/);
  bad({ chapters: [{ op: "add", id: "c", title: "C", width: 10 }] }, /chapters\[0\]: unknown field "width"/);
  bad({ camera: { chapter: "nope", x: 1 } }, /camera: unknown field "x"/);
  bad({ items: [{ op: "move", id: "nope", dx: 1, dy: 1 }] }, /unknown item id/);
  // The lenient path (old saves) drops what it does not know instead.
  assert.equal(applyUpdate(b, { scene: { mode: "append", shapes: [{ type: "rect", x: "5", y: 0, w: 1, h: 1, extra: 1 }] } }, { strict: false }).scene.shapes[0].x, 0);
});

test("ids are unique across shapes, artifacts and equations", () => {
  const b = applyUpdate(emptyBoard(), { equations: [{ op: "add", id: "eq1", latex: "x" }] });
  assert.throws(() => applyUpdate(b, { scene: { mode: "append", shapes: [{ type: "rect", id: "eq1", x: 0, y: 0, w: 1, h: 1 }] } }), /duplicate id "eq1": used by a shape and an equation/);
  assert.throws(() => applyUpdate(b, { equations: [{ op: "add", id: "eq1", latex: "y" }] }), /duplicate equation id "eq1"/);
});

test("equations without x,y get a stored place in their own chapter's stack", () => {
  let b = applyUpdate(emptyBoard(), {
    chapters: [{ op: "add", id: "c1", title: "One" }, { op: "add", id: "c2", title: "Two" }],
    equations: [
      { op: "add", id: "a", latex: "a", chapter: "c1" },
      { op: "add", id: "b", latex: "b", chapter: "c1" },
      { op: "add", id: "z", latex: "z", chapter: "c2" },
      { op: "add", id: "y", latex: "y", chapter: "c2", y: 400 },
    ],
  });
  const at = (board) => Object.fromEntries(board.equations.map((e) => [e.id, [e.x, e.y]]));
  assert.deepEqual(at(b), { a: [88, 92], b: [88, 207], z: [88, 92], y: [88, 400] });
  // Deleting one moves nothing; the next one goes below the stack.
  b = applyUpdate(b, { equations: [{ op: "delete", id: "a" }, { op: "add", id: "c", latex: "c", chapter: "c1" }] });
  assert.deepEqual(at(b), { b: [88, 207], z: [88, 92], y: [88, 400], c: [88, 322] });
});

test("steps: kept across edits and replace, lastStep follows deletes", () => {
  let b = applyUpdate(emptyBoard(), { scene: { mode: "append", shapes: [{ type: "text", id: "t1", text: "a", x: 0, y: 0 }] } });
  b = applyUpdate(b, { scene: { mode: "append", shapes: [{ type: "text", id: "t2", text: "b", x: 0, y: 0 }] } });
  b = applyUpdate(b, { scene: { mode: "append", shapes: [{ type: "text", id: "t3", text: "c", x: 0, y: 0 }] } });
  assert.equal(b.lastStep, 3);
  b = applyUpdate(b, { items: [{ op: "delete", id: "t3" }] });
  assert.equal(b.lastStep, 2, "lastStep comes down after a delete");
  // A replace that reuses an id keeps that item's step; new items form the next step.
  b = applyUpdate(b, { scene: { mode: "replace", shapes: [{ type: "text", id: "t1", text: "a2", x: 0, y: 0 }, { type: "text", id: "t9", text: "n", x: 0, y: 0 }] } });
  assert.deepEqual(b.scene.shapes.map((s) => [s.id, s.step]), [["t1", 1], ["t9", 2]]);
  assert.throws(() => applyUpdate(b, { items: [{ op: "update", id: "t1", fields: { step: null } }] }), /step must be an integer/);
});

test("chapters: a given x or y is kept, overlaps are reported", () => {
  let r = applyUpdateReport(emptyBoard(), { chapters: [{ op: "add", id: "a", title: "A" }, { op: "add", id: "b", title: "B", y: 1000 }, { op: "add", id: "c", title: "C", x: 5000 }] });
  assert.deepEqual(r.board.chapters.map((c) => [c.id, c.x, c.y]), [["a", 0, 0], ["b", 1440, 1000], ["c", 5000, 1000]]);
  assert.deepEqual(r.warnings, []);
  r = applyUpdateReport(r.board, { chapters: [{ op: "add", id: "d", title: "D", x: 600, y: 200 }] });
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /chapters "d" \(600,200 1200x800\) and "a" \(0,0 1200x800\) overlap/);
  assert.ok(r.touched.includes("d"));
});

test("plot sliders: params are checked, usable in expressions and coordinates, and listed by board_read", async () => {
  const { summarizeBoard } = await import("../tools.mjs");
  const plot = (fields) => ({ scene: { mode: "append", artifacts: [{ type: "plot", id: "p", ...fields }] } });
  const ok = applyUpdate(emptyBoard(), plot({
    params: [{ name: "w", min: 0.5, max: 6, value: 9, step: 0.5, label: "ω" }, { name: "T2", min: 1, max: 8, period: 100 }],
    functions: [{ expr: "exp(-x/T2) cos(w x)" }],
    areas: [{ expr: "sin(w x)", from: 0, to: "T2" }],
    points: [{ x: "T2", y: "exp(-1)", drag: true }, { x: 1, y: 2 }],
    vlines: [{ x: "w" }],
    hlines: [{ y: "1/T2" }],
  })).scene.artifacts[0];
  assert.deepEqual(ok.params, [
    { name: "w", min: 0.5, max: 6, value: 6, step: 0.5, label: "ω" }, // value clamped into the range
    { name: "T2", min: 1, max: 8, value: 1, period: 60 }, // value defaults to min; period clamped
  ]);
  assert.deepEqual([ok.areas[0].to, ok.points[0].x, ok.points[0].drag, ok.points[1].x, ok.vlines[0].x, ok.hlines[0].y], ["T2", "T2", true, 1, "w", "1/T2"]);
  // A plot without sliders is stored as before (no params key).
  assert.equal("params" in applyUpdate(emptyBoard(), plot({ functions: [{ expr: "x" }] })).scene.artifacts[0], false);
  const bad = (fields, re) => assert.throws(() => applyUpdate(emptyBoard(), plot(fields)), re);
  const f = [{ expr: "a x" }];
  for (const name of ["x", "t", "e", "pi", "sin", "2a", "a b", "", 3]) bad({ params: [{ name, min: 0, max: 1 }], functions: f }, /params\[0\]\.name must be a short name/);
  bad({ params: [{ name: "a", min: 1, max: 1 }], functions: f }, /"a": min and max must be numbers with min < max/);
  bad({ params: [{ name: "a", min: 0 }], functions: f }, /min and max must be numbers/);
  bad({ params: [{ name: "a", min: 0, max: 1, step: 2 }], functions: f }, /step must be more than 0 and at most max - min/);
  bad({ params: [{ name: "a", min: 0, max: 1, speed: 2 }], functions: f }, /params\[0\]: unknown field "speed"/);
  bad({ params: [{ name: "a", min: 0, max: 1 }, { name: "a", min: 0, max: 2 }], functions: f }, /"a" is used twice/);
  bad({ params: Array.from({ length: 7 }, (_, i) => ({ name: `a${i}`, min: 0, max: 1 })), functions: [{ expr: "x" }] }, /params: at most 6/);
  bad({ functions: f }, /unknown name "a"/);
  bad({ params: [{ name: "a", min: 0, max: 1 }], functions: [{ expr: "b x" }] }, /unknown name "b"/);
  bad({ points: [{ x: "1", y: 2 }] }, /points\[0\]\.x must be a number \(an expression such as "a" needs params on the plot\)/);
  bad({ params: [{ name: "a", min: 0, max: 1 }], points: [{ x: "x", y: 2 }] }, /points\[0\]\.x: "x": unknown name "x"/);
  bad({ params: [{ name: "a", min: 0, max: 1 }], points: [{ x: "a+1", y: 2, drag: true }] }, /drag needs x or y to be a slider name/);
  // Old saves load leniently: a bad step is dropped, not fatal.
  const lenient = applyUpdate(emptyBoard(), plot({ params: [{ name: "a", min: 0, max: 1, step: -1 }], functions: f }), { strict: false });
  assert.deepEqual(lenient.scene.artifacts[0].params, [{ name: "a", min: 0, max: 1, value: 0 }]);
  assert.match(summarizeBoard(applyUpdate(emptyBoard(), plot({ params: [{ name: "w", min: 0, max: 6, value: 3 }], functions: [{ expr: "sin(w x)" }] }))), /\[p\] plot at \(0,0\) 360x280 sliders: w=3 in \[0, 6\]/);
});
