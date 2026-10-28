/**
 * /board export (export.mjs) with a stubbed renderer: folder naming and collisions,
 * slugs, board.json loading back through the server's save/load path, lesson.md,
 * which images are written, and the no-browser path. No pi, no browser.
 * Run: node --test test/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, copyFile, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer, SCHEMA_VERSION, CHAPTER } from "../server.mjs";
import {
  EXPORT_WIDTH,
  HOME_REGION,
  OVERVIEW_WIDTH,
  SCHEMA_VERSION as EXPORT_SCHEMA_VERSION,
  exportLesson,
  exportNotice,
  overviewRegion,
  slugify,
} from "../export.mjs";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13]);
const SAVE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/; // server.mjs's rule for save names
const AT = new Date(2026, 9, 27, 14, 5, 42); // local time, so the folder stamp is 20261027-1405 in any zone
const now = () => AT;

const temps = [];
async function tempDir(prefix) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  temps.push(dir);
  return dir;
}
test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});

/** A renderer stub that records its calls; `fail(call)` decides which calls throw. */
function renderer(fail = () => false) {
  const calls = [];
  const snapshot = async (opts) => {
    calls.push(opts);
    if (fail(opts, calls.length)) throw new Error("no headless browser available (stub). Run: npx playwright install chromium\nsecond line");
    return PNG;
  };
  return { calls, snapshot };
}

/** A board built through the real update path (autosave off; the server never listens). */
async function lesson({ home = true, chapters = [["ch1", "First law"], ["ch2", "Second law"]], origin = 1440 } = {}) {
  const dataDir = await tempDir("board-export-data-");
  const s = new BoardServer({ dataDir, autosave: false });
  s.update({ title: "Newton's Laws: $F = ma$", ...(chapters.length ? {
    chapters: chapters.map(([id, title], i) => ({ op: "add", id, title, x: origin + i * 1440, y: 0 })),
  } : {}) });
  for (const [id] of chapters)
    s.update({
      equations: [{ op: "add", id: `eq-${id}`, latex: "F = m a", x: 80, y: 100, chapter: id }],
      scene: { mode: "append", shapes: [{ type: "arrow", id: `arrow-${id}`, points: [[100, 400], [400, 300]], chapter: id }] },
    });
  if (home) s.update({ scene: { mode: "append", shapes: [{ type: "text", id: "hello", text: "Home note", x: 80, y: 120 }] } });
  return s;
}

const read = (dir, file) => readFile(path.join(dir, file), "utf8");

test("slugs: lowercase a-z0-9 and hyphens, at most 48 characters, valid save names", () => {
  assert.equal(slugify("Newton's Second Law!"), "newton-s-second-law");
  assert.equal(slugify("  Énergie cinétique  "), "energie-cinetique");
  assert.equal(slugify("ATP -> ADP + P_i"), "atp-adp-p-i");
  assert.equal(slugify("δ ∆ !!!"), "");
  assert.equal(slugify(undefined), "");
  const long = slugify(`${"a".repeat(47)} bcd`);
  assert.equal(long, "a".repeat(47)); // cut at 48, trailing hyphen dropped
  for (const s of ["x", slugify("Blackboard"), slugify("z".repeat(200)), long]) {
    assert.ok(s.length <= 48, s);
    assert.match(s, /^[a-z0-9]+(-[a-z0-9]+)*$/);
    assert.match(s, SAVE_NAME_RE);
  }
});

test("folder: <cwd>/viz/board-<slug>-<YYYYMMDD-HHMM>, -2 and -3 instead of overwriting", async () => {
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const run = (name) => exportLesson({ board: s.getState(), revision: s.revision, name, cwd, snapshot: renderer().snapshot, now });
  const a = await run("Forces & Motion");
  assert.equal(a.dir, path.join(cwd, "viz", "board-forces-motion-20261027-1405"));
  assert.equal(a.folder, "board-forces-motion-20261027-1405");
  assert.equal((await run("forces motion")).folder, "board-forces-motion-20261027-1405-2");
  assert.equal((await run("FORCES-MOTION")).folder, "board-forces-motion-20261027-1405-3");
  // The first export is untouched by the later ones.
  assert.equal(JSON.parse(await read(a.dir, "board.json")).exportedAt, AT.toISOString());
  assert.deepEqual((await readdir(path.join(cwd, "viz"))).sort(), [
    "board-forces-motion-20261027-1405",
    "board-forces-motion-20261027-1405-2",
    "board-forces-motion-20261027-1405-3",
  ]);
  // The name falls back to the board title, then to "board".
  assert.equal((await run("")).folder, "board-newton-s-laws-f-ma-20261027-1405");
  assert.equal((await run("!!!")).folder, "board-newton-s-laws-f-ma-20261027-1405-2");
  const untitled = await exportLesson({ board: { ...s.getState(), title: "∑" }, revision: 1, cwd, snapshot: renderer().snapshot, now });
  assert.equal(untitled.folder, "board-board-20261027-1405");
});

test("board.json is a named save's payload and loads back through the server", async () => {
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const result = await exportLesson({ board: s.getState(), revision: s.revision, name: "Newton", cwd, snapshot: renderer().snapshot, now });
  const exported = JSON.parse(await read(result.dir, "board.json"));
  // Same shape and content as the file `/board save` writes, plus exportedAt.
  const saved = await s.save("reference");
  const onDisk = JSON.parse(await read(path.join(s.dataDir, "saves"), "reference.json"));
  assert.deepEqual(Object.keys(onDisk).sort(), Object.keys(saved).sort());
  for (const key of Object.keys(onDisk)) assert.ok(key in exported, `board.json lacks ${key}`);
  assert.equal(exported.name, "newton");
  assert.match(exported.name, SAVE_NAME_RE);
  assert.equal(exported.revision, onDisk.revision);
  assert.equal(exported.savedAt, AT.toISOString());
  assert.equal(exported.exportedAt, AT.toISOString());
  assert.deepEqual(exported.board, onDisk.board);
  // Copied into another server's saves/ it loads with `/board load newton`.
  const target = new BoardServer({ dataDir: await tempDir("board-export-load-"), autosave: false });
  await mkdir(path.join(target.dataDir, "saves"), { recursive: true });
  await copyFile(path.join(result.dir, "board.json"), path.join(target.dataDir, "saves", `${exported.name}.json`));
  assert.ok((await target.listSaves()).includes("newton"));
  await target.load("newton", 0);
  const before = s.getState(), after = target.getState();
  for (const key of ["title", "chapters", "equations", "camera", "lastStep"]) assert.deepEqual(after[key], before[key], key);
  assert.deepEqual(after.scene.shapes, before.scene.shapes);
  assert.deepEqual(after.scene.artifacts, before.scene.artifacts);
});

test("images: one per chapter at the board_snapshot region, home first, overview last", async () => {
  const s = await lesson();
  const board = s.getState();
  const cwd = await tempDir("board-export-cwd-");
  const { calls, snapshot } = renderer();
  const r = await exportLesson({ board, revision: s.revision, cwd, snapshot, now });
  assert.deepEqual(r.images, ["home.png", "chapter-ch1.png", "chapter-ch2.png", "overview.png"]);
  assert.deepEqual(r.files, ["board.json", ...r.images, "lesson.md"]);
  assert.deepEqual((await readdir(r.dir)).sort(), [...r.files].sort());
  for (const file of r.images) assert.deepEqual(await readFile(path.join(r.dir, file)), PNG);
  const [ch1, ch2] = board.chapters;
  assert.deepEqual(calls, [
    { region: { ...HOME_REGION }, width: EXPORT_WIDTH },
    { region: { x: ch1.x, y: ch1.y, w: ch1.w, h: ch1.h }, width: EXPORT_WIDTH },
    { region: { x: ch2.x, y: ch2.y, w: ch2.w, h: ch2.h }, width: EXPORT_WIDTH },
    { region: overviewRegion([HOME_REGION, ch1, ch2]), width: OVERVIEW_WIDTH },
  ]);
  assert.deepEqual(overviewRegion([HOME_REGION, ch1, ch2]), { x: -60, y: -80, w: ch2.x + ch2.w + 120, h: 800 + 140 });
  assert.deepEqual(r.skipped, []);
  assert.equal(r.imageError, null);
  assert.equal(exportNotice(r), `Lesson exported to ${r.dir}\n  4 images (home.png, chapter-ch1.png, chapter-ch2.png, overview.png), board.json, lesson.md`);
});

test("lesson.md: title, export line, one section per region with relative markdown image links", async () => {
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const r = await exportLesson({ board: s.getState(), revision: s.revision, cwd, snapshot: renderer().snapshot, now });
  const md = await read(r.dir, "lesson.md");
  assert.equal(
    md,
    [
      "# Newton's Laws: \\$F = ma\\$",
      "",
      `Exported 2026-10-27 14:05 · board revision ${s.revision} · 3 steps`,
      "",
      "## Home",
      "",
      "![home](home.png)",
      "",
      "## First law",
      "",
      "![chapter ch1](chapter-ch1.png)",
      "",
      "## Second law",
      "",
      "![chapter ch2](chapter-ch2.png)",
      "",
      "## Overview",
      "",
      "![overview](overview.png)",
      "",
    ].join("\n"),
  );
  assert.doesNotMatch(md, /\[\[|!\[\[/); // standard links, not wiki-links
  for (const [, target] of md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)) {
    assert.ok(!target.includes("/") && !path.isAbsolute(target), target);
    assert.ok(r.files.includes(target), `${target} was not written`);
  }
});

test("home.png only when home has items; overview only with more than one region", async () => {
  const cwd = await tempDir("board-export-cwd-");
  const files = async (opts) => {
    const s = await lesson(opts);
    return (await exportLesson({ board: s.getState(), revision: s.revision, cwd, snapshot: renderer().snapshot, now })).images;
  };
  assert.deepEqual(await files({ home: false }), ["chapter-ch1.png", "chapter-ch2.png", "overview.png"]);
  assert.deepEqual(await files({ home: false, chapters: [["ch1", "Only"]] }), ["chapter-ch1.png"]);
  assert.deepEqual(await files({ home: true, chapters: [] }), ["home.png"]);
  assert.deepEqual(await files({ home: true, chapters: [["ch1", "Only"]] }), ["home.png", "chapter-ch1.png", "overview.png"]);
  // A chapter at (0,0), where the first auto-placed chapter goes, covers home: its image shows the home items.
  assert.deepEqual(await files({ home: true, chapters: [["ch1", "Only"]], origin: 0 }), ["chapter-ch1.png"]);
  assert.deepEqual(await files({ home: true, chapters: [["ch1", "A"], ["ch2", "B"]], origin: 0 }), ["chapter-ch1.png", "chapter-ch2.png", "overview.png"]);
  // An empty board: no images, and the note says why.
  const empty = await exportLesson({ board: new BoardServer({ dataDir: cwd, autosave: false }).getState(), revision: 0, cwd, snapshot: renderer().snapshot, now });
  assert.deepEqual(empty.images, []);
  assert.equal(empty.empty, true);
  assert.match(await read(empty.dir, "lesson.md"), /# Blackboard\n\nExported 2026-10-27 14:05 · board revision 0 · 0 steps\n\nThe board is empty/);
  assert.match(exportNotice(empty), /0 images, board\.json, lesson\.md\n {2}The board is empty/);
});

test("chapter ids become safe, distinct file names inside the export folder", async () => {
  const cwd = await tempDir("board-export-cwd-");
  const board = {
    title: "Ids",
    lastStep: 1,
    equations: [],
    scene: { shapes: [], elements: [], artifacts: [] },
    camera: null,
    chapters: [
      { id: "../../evil", title: "", x: 0, y: 0, w: 1200, h: 800 },
      { id: "a b", title: "  ", x: 1440, y: 0, w: 1200, h: 800 },
      { id: "a-b", title: "[link](x) #tag", x: 2880, y: 0, w: 1200, h: 800 },
      { id: "Ch1", title: "upper", x: 4320, y: 0, w: 1200, h: 800 },
      { id: "ch1", title: "lower", x: 5760, y: 0, w: 1200, h: 800 },
    ],
  };
  const r = await exportLesson({ board, revision: 3, cwd, snapshot: renderer().snapshot, now });
  assert.deepEqual(r.images, ["chapter-evil.png", "chapter-a-b.png", "chapter-a-b-2.png", "chapter-Ch1.png", "chapter-ch1-2.png", "overview.png"]);
  assert.deepEqual((await readdir(r.dir)).sort(), [...r.files].sort()); // nothing escaped the folder
  assert.deepEqual(await readdir(cwd), ["viz"]);
  const md = await read(r.dir, "lesson.md");
  assert.match(md, /## \.\.\/\.\.\/evil\n\n!\[chapter \.\.\/\.\.\/evil\]\(chapter-evil\.png\)/); // empty title: the id
  assert.match(md, /## a b\n\n!\[chapter a b\]\(chapter-a-b\.png\)/);
  assert.match(md, /## \\\[link\\\]\(x\) \\#tag\n\n!\[chapter a-b\]\(chapter-a-b-2\.png\)/);
});

test("no headless browser: board.json and lesson.md are still written, with the reason", async () => {
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const { calls, snapshot } = renderer(() => true);
  const r = await exportLesson({ board: s.getState(), revision: s.revision, cwd, snapshot, now });
  assert.equal(calls.length, 1); // the renderer is not retried for every image
  assert.deepEqual(r.images, []);
  assert.deepEqual((await readdir(r.dir)).sort(), ["board.json", "lesson.md"]);
  assert.equal(r.imageError, "no headless browser available (stub). Run: npx playwright install chromium");
  assert.deepEqual(r.skipped.map((x) => x.file), ["home.png", "chapter-ch1.png", "chapter-ch2.png", "overview.png"]);
  assert.equal(JSON.parse(await read(r.dir, "board.json")).board.title, "Newton's Laws: $F = ma$");
  const md = await read(r.dir, "lesson.md");
  assert.match(md, /\n\nImages were not rendered: no headless browser available \(stub\)\. Run: npx playwright install chromium\n/);
  assert.match(md, /## First law\n\n_Image not rendered\._/);
  assert.doesNotMatch(md, /!\[/);
  const notice = exportNotice(r);
  assert.match(notice, /^Lesson exported to .*\n {2}0 images, board\.json, lesson\.md\n {2}Images not rendered: no headless browser available/);
  // No renderer at all behaves the same way.
  const none = await exportLesson({ board: s.getState(), revision: s.revision, cwd, now });
  assert.equal(none.imageError, "no renderer available");
  assert.deepEqual((await readdir(none.dir)).sort(), ["board.json", "lesson.md"]);
});

test("one image failing after others rendered is skipped and named; the rest are written", async () => {
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const { snapshot } = renderer((_opts, n) => n === 3);
  const r = await exportLesson({ board: s.getState(), revision: s.revision, cwd, snapshot, now });
  assert.deepEqual(r.images, ["home.png", "chapter-ch1.png", "overview.png"]);
  assert.equal(r.imageError, null);
  assert.deepEqual(r.skipped, [{ file: "chapter-ch2.png", reason: "no headless browser available (stub). Run: npx playwright install chromium" }]);
  assert.match(await read(r.dir, "lesson.md"), /## Second law\n\n_Image not rendered: no headless browser available \(stub\)\. Run: npx playwright install chromium_\n/);
  assert.match(exportNotice(r), /3 images \(home\.png, chapter-ch1\.png, overview\.png\), board\.json, lesson\.md\n {2}Skipped chapter-ch2\.png: no headless/);
});

test("files are private, the format version matches saves, and a symlinked viz/ is refused", async () => {
  assert.equal(EXPORT_SCHEMA_VERSION, SCHEMA_VERSION);
  assert.deepEqual(HOME_REGION, { x: 0, y: 0, w: CHAPTER.w, h: CHAPTER.h });
  const s = await lesson();
  const cwd = await tempDir("board-export-cwd-");
  const r = await exportLesson({ board: s.getState(), revision: s.revision, cwd, snapshot: renderer().snapshot, now });
  assert.equal(JSON.parse(await read(r.dir, "board.json")).schemaVersion, SCHEMA_VERSION);
  assert.equal((await stat(path.join(cwd, "viz"))).mode & 0o777, 0o700);
  assert.equal((await stat(r.dir)).mode & 0o777, 0o700);
  for (const file of r.files) assert.equal((await stat(path.join(r.dir, file))).mode & 0o777, 0o600, file);
  // viz/ pointing somewhere else (planted in an untrusted folder) is not followed.
  const elsewhere = await tempDir("board-export-target-");
  const linked = await tempDir("board-export-linked-");
  await symlink(elsewhere, path.join(linked, "viz"));
  await assert.rejects(
    exportLesson({ board: s.getState(), revision: s.revision, cwd: linked, snapshot: renderer().snapshot, now }),
    /viz is a symbolic link .*writes only into a real folder/,
  );
  assert.deepEqual(await readdir(elsewhere), []);
  // A file named viz is not a folder either.
  const fileCwd = await tempDir("board-export-file-");
  await (await import("node:fs/promises")).writeFile(path.join(fileCwd, "viz"), "x");
  await assert.rejects(exportLesson({ board: s.getState(), revision: s.revision, cwd: fileCwd, now }), /exists and is not a folder/);
});
