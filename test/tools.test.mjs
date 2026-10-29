/**
 * The shared tool handlers (tools.mjs) on a real BoardServer with a stand-in layout check:
 * honest results (rejections, warnings in order, storage problems, nobody watching), board_read
 * on an unknown chapter, board_open's text without the token, and cancellation.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../server.mjs";
import { handlers, openText, updateWarnings } from "../tools.mjs";

const temps = [];
test.after(async () => {
  for (const dir of temps) {
    await chmod(dir, 0o700).catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
});

/** A started server whose layout check returns `issues` (or runs `lint`). */
async function setup(t, { issues = [], lint, dataDir } = {}) {
  dataDir ??= await mkdtemp(path.join(tmpdir(), "math-board-tools-"));
  temps.push(dataDir);
  const s = new BoardServer({ dataDir });
  s.snapshots.lint = lint ?? (async () => ({ items: [], issues }));
  await s.start();
  t.after(() => s.stop());
  const ctx = { server: async () => s, staleWarning: () => "", openHint: "board_open" };
  const text = (r) => r.content.map((c) => c.text).join("\n");
  return { s, ctx, text };
}

test("update warnings: this update's first, then a count of older ones", () => {
  const older = ["text t1 overlaps text t2 (50% of the smaller)", "artifact p1 extends off the board (bbox 1,2 3x4)"];
  const mine = 'equation eq3 extends outside chapter "c" (local bbox 1,2 3x4; chapter is 1200x800)';
  const out = updateWarnings(["chapters \"a\" and \"b\" overlap"], [...older, mine], ["eq3", "eq"]);
  assert.equal(out, ['layout warnings (2):', '  - chapters "a" and "b" overlap', `  - ${mine}`, "+2 older warnings on items this update did not touch (board_snapshot lists them all)."].join("\n"));
  assert.equal(updateWarnings([], older, ["eq3"]), "layout check: no problems with what this update changed.\n+2 older warnings on items this update did not touch (board_snapshot lists them all).");
  assert.equal(updateWarnings([], [], []), "layout check: no overlaps or off-board items.");
  // More than 25 from this update: the newest ones are listed, the rest counted.
  const many = Array.from({ length: 30 }, (_, i) => `text n${i} overlaps text n${i + 1} (9% of the smaller)`);
  assert.match(updateWarnings([], many, ["n0"]), /^layout warnings \(1\):\n {2}- text n0 overlaps text n1 .*\n\+29 older warnings/);
  assert.match(updateWarnings([], many, many.map((_, i) => `n${i}`)), /layout warnings \(30\):[\s\S]*\.\.\. 5 more from this update/);
});

test("board_update applies what it is given or rejects it with the reason", async (t) => {
  const { s, ctx, text } = await setup(t, { issues: ["text old overlaps text t (20% of the smaller)", "text x overlaps text y (20% of the smaller)"] });
  await assert.rejects(handlers.board_update(ctx, { baseRevision: 0, scene: { mode: "append", shapes: [{ type: "line", id: "l", points: [[1, 1]] }] } }), /scene\.shapes\[0\] "l": line needs at least 2 points/);
  await assert.rejects(handlers.board_update(ctx, { baseRevision: 0, colour: "red" }), /unknown update field: colour/);
  assert.equal(s.revision, 0, "nothing applied");
  const r = await handlers.board_update(ctx, { baseRevision: 0, scene: { mode: "append", shapes: [{ type: "text", id: "t", text: "hi", x: 10, y: 20 }] } });
  const out = text(r);
  assert.match(out, /^Board updated to revision 1 \(was 0\)\.\nlayout warnings \(1\):\n {2}- text old overlaps text t/m);
  assert.match(out, /\+1 older warning on items this update did not touch/);
  assert.match(out, /\nNo browser is showing the board; call board_open\.$/);
  // A learner's tab (any unmarked SSE client) removes the hint.
  s.clients.add({ snapshot: false, write() { return true; } });
  assert.doesNotMatch(text(await handlers.board_read(ctx, {})), /No browser is showing/);
});

test("board_read: unknown chapter is an error; storage problems are reported", async (t) => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "math-board-tools-"));
  await writeFile(path.join(dataDir, "autosave.json"), "{broken");
  const { s, ctx, text } = await setup(t, { dataDir });
  // The restore problem shows in board_update once, and in every board_read.
  const u1 = text(await handlers.board_update(ctx, { baseRevision: 0, chapters: [{ op: "add", id: "c1", title: "One" }], check: false }));
  assert.match(u1, /^WARNING: the autosave could not be restored \(save is corrupt \(not valid JSON\)\)\. It was moved to autosave\.corrupt-/);
  await assert.rejects(handlers.board_read(ctx, { chapter: "nope" }), /unknown chapter "nope"; chapters: c1 \(or "all", "free"\)/);
  assert.match(text(await handlers.board_read(ctx, { chapter: "c1" })), /layout of chapter c1/);
  assert.match(text(await handlers.board_read(ctx, {})), /^WARNING: the autosave could not be restored/);
  await handlers.board_update(ctx, { baseRevision: 1, title: "x", check: false });
  const u2 = text(await handlers.board_update(ctx, { baseRevision: 2, title: "y", check: false }));
  assert.doesNotMatch(u2, /could not be restored/);
  assert.match(text(await handlers.board_read(ctx, {})), /could not be restored/);
  // An autosave that fails is in the very update that caused it.
  await chmod(dataDir, 0o500);
  const u3 = text(await handlers.board_update(ctx, { baseRevision: 3, title: "z", check: false }));
  assert.match(u3, /WARNING: the last autosave failed \(EACCES/);
  await chmod(dataDir, 0o700);
  s.restoreNotice = null;
  assert.doesNotMatch(text(await handlers.board_update(ctx, { baseRevision: 4, title: "w", check: false })), /WARNING/);
});

test("board_save load says what the save had that the board cannot use", async (t) => {
  const { s, ctx, text } = await setup(t);
  await mkdir(path.join(s.dataDir, "saves"), { recursive: true });
  await writeFile(path.join(s.dataDir, "saves", "old.json"), JSON.stringify({ board: { scene: { artifacts: [{ type: "icon", icon: "nope" }] } } }));
  const r = await handlers.board_save(ctx, { action: "load", name: "old", baseRevision: 0 });
  assert.match(text(r), /^Loaded board "old" at revision 1\.\nThe save had things this board cannot use: skipped 1 artifact \(unknown icon "nope"/);
});

test("a cancelled layout check is reported; the update itself stands", async (t) => {
  const { ctx, text } = await setup(t, { lint: async ({ signal }) => { throw Object.assign(new Error("cancelled"), { name: "AbortError", signal }); } });
  const r = await handlers.board_update({ ...ctx, signal: AbortSignal.abort() }, { baseRevision: 0, title: "t" });
  assert.match(text(r), /Board updated to revision 1[\s\S]*layout check cancelled\./);
});

test("board_open gives the URL with its token only when no browser shows the board", () => {
  const url = "http://127.0.0.1:5/#token=" + "a".repeat(64);
  assert.equal(openText({ url, port: 5, opened: true }), "The board is open in the learner's browser (127.0.0.1:5).\nBoard tools are active. Call board_docs (topic) for formats before using an artifact type the first time.");
  assert.doesNotMatch(openText({ url, port: 5, viewed: true }), /token/);
  assert.match(openText({ url, port: 5 }), new RegExp(`^Board: ${url.replace(/[.#/]/g, "\\$&")} \\(not opened automatically; give the learner this URL\\)\\.`));
  assert.match(openText({ url, port: 5, notices: ["WARNING: x"], activationError: "nope" }), /^WARNING: x\n[\s\S]*Could not activate the board tools: nope$/);
});

test("board_snapshot lists the measured boxes of the region it shows, not the whole board", async (t) => {
  const { s, ctx, text } = await setup(t);
  s.update({ chapters: [{ op: "add", id: "a", title: "A", x: 0, y: 0 }, { op: "add", id: "b", title: "B", x: 1400, y: 0 }] });
  const items = [
    { id: "in1", kind: "text", chapter: "a", x: 100, y: 100, w: 50, h: 20 },
    { id: "edge", kind: "text", chapter: "a", x: 1180, y: 100, w: 60, h: 20 },
    { id: "out1", kind: "text", chapter: "b", x: 1500, y: 100, w: 50, h: 20 },
    { id: "out2", kind: "artifact", chapter: "b", x: 1600, y: 300, w: 300, h: 200 },
  ];
  s.snapshots.capture = async ({ region }) => ({ png: Buffer.from("png"), lint: { items, issues: [] }, region });
  const a = text(await handlers.board_snapshot(ctx, { chapter: "a" }));
  assert.match(a, /measured boxes in this region:\n {2}\[in1\] text 100,100 50x20\n {2}\[edge\] text 1180,100 60x20\n\(2 more outside this region; snapshot their chapter for theirs\)/);
  assert.doesNotMatch(a, /out1|out2/);
  const empty = text(await handlers.board_snapshot(ctx, { region: { x: 5000, y: 5000, w: 600, h: 400 } }));
  assert.match(empty, /nothing in this region \(4 items elsewhere on the board\)\./);
});
