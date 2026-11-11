/**
 * The data formats the page draws itself: table, code, chart, vectors and segments on a plot,
 * and image files copied in from the learner's disk.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { deflateSync } from "node:zlib";
import { BoardServer, imageDirs, imageInfo, sanitizeArtifact } from "../server.mjs";
import { BOARD_DOCS, DOC_TOPICS, handlers } from "../tools.mjs";

const strict = (a) => sanitizeArtifact(a, { strict: true });
const bad = (a, re) => assert.throws(() => strict(a), re);

test("table: equal rows, text, numbers and math cells, highlights that exist, a size from its content", () => {
  const t = strict({ type: "table", id: "t", header: ["n", "$n^2$"], rows: [[1, 1], [2, "4"], ["3", 9]], highlight: [{ row: 0 }, { col: 1, color: "#5fb3d9" }, { row: 2, col: 0 }], align: "right" });
  assert.deepEqual(t.rows, [["1", "1"], ["2", "4"], ["3", "9"]]);
  assert.deepEqual(t.header, ["n", "$n^2$"]);
  assert.deepEqual([t.width, t.height], [260, 176], "about 130 px a column and 44 px a row");
  assert.deepEqual(t.highlight, [{ row: 0 }, { col: 1, color: "#5fb3d9" }, { row: 2, col: 0 }]);
  assert.equal(strict({ type: "table", rows: [["a"]], width: 500, height: 300 }).width, 500);
  bad({ type: "table" }, /table needs rows/);
  bad({ type: "table", rows: [["a", "b"], ["c"]] }, /rows\[1\] must have 2 cells like the first row, got 1/);
  bad({ type: "table", header: ["a"], rows: [["a", "b"]] }, /rows\[0\] must have 1 cells like the header/);
  bad({ type: "table", rows: [[{ html: "<b>" }]] }, /rows\[0\]\[0\] must be text of at most 120 characters or a number/);
  bad({ type: "table", rows: [["a"]], highlight: [{ row: 3 }] }, /the table has rows 0-0 and columns 0-0/);
  bad({ type: "table", rows: [["a"]], highlight: [{ color: "red" }] }, /needs row .*, col, or both/);
  bad({ type: "table", rows: [["a"]], colour: "red" }, /unknown field "colour"/);
  bad({ type: "table", rows: Array.from({ length: 41 }, () => ["a"]) }, /1 to 40 arrays/);
});

test("code: a bounded listing with highlighted lines; tabs become spaces and nothing is trimmed inside", () => {
  const c = strict({ type: "code", source: "def f(x):\r\n\treturn x  # keep\n\n", language: "python", highlight: [2, 2, 1] });
  assert.equal(c.source, "def f(x):\n  return x  # keep");
  assert.deepEqual(c.highlight, [1, 2]);
  assert.equal(c.language, "python");
  assert.ok(c.width >= 200 && c.height === 2 * 24 + 28);
  assert.equal(strict({ type: "code", source: "x", lineNumbers: false }).lineNumbers, false);
  bad({ type: "code", source: "  " }, /code needs source/);
  bad({ type: "code", source: "a\nb", highlight: [3] }, /highlight must be a list of line numbers from 1 to 2/);
  bad({ type: "code", source: Array.from({ length: 81 }, () => "x").join("\n") }, /at most 80 lines and 6000 characters \(it has 81 lines/);
});

test("chart: bars or histogram values, each with its own fields", () => {
  const b = strict({ type: "chart", kind: "bar", bars: [{ label: "A", value: 3 }, { label: "B", value: -1.5, color: "#ef6f6c" }], yLabel: "n", yRange: [-2, 4] });
  assert.deepEqual(b.bars, [{ label: "A", value: 3 }, { label: "B", value: -1.5, color: "#ef6f6c" }]);
  assert.deepEqual(b.yRange, [-2, 4]);
  const h = strict({ type: "chart", kind: "histogram", values: [1, 2, 2, 3], bins: 4, range: [0, 4] });
  assert.deepEqual([h.values.length, h.bins, h.range], [4, 4, [0, 4]]);
  bad({ type: "chart", kind: "pie" }, /chart kind must be "bar" or "histogram", got "pie"/);
  bad({ type: "chart", kind: "bar", bars: [{ label: "A", value: "3" }] }, /bars\[0\]: value must be a number, got "3"/);
  bad({ type: "chart", kind: "bar", bars: [{ label: "A", value: 1 }], values: [1, 2] }, /values, bins and range are for a histogram/);
  bad({ type: "chart", kind: "histogram", values: [1] }, /2 to 5000 numbers/);
  bad({ type: "chart", kind: "histogram", values: [1, 2], range: [3, 1] }, /range must be \[low, high\]/);
});

test("plot vectors and segments: ends are [x, y] in plot coordinates, numbers or slider expressions", () => {
  const p = strict({ type: "plot", xRange: [-1, 5], yRange: [-1, 5], vectors: [{ from: [0, 0], to: [3, 1], label: "a", color: "#5fb3d9" }], segments: [{ from: [3, 1], to: [4, 4], dash: "5 5" }] });
  assert.deepEqual(p.vectors, [{ from: [0, 0], to: [3, 1], color: "#5fb3d9", label: "a" }]);
  assert.deepEqual(p.segments, [{ from: [3, 1], to: [4, 4], dash: "5 5" }]);
  const s = strict({ type: "plot", params: [{ name: "a", min: 0, max: 6 }], vectors: [{ from: [0, 0], to: ["cos(a)", "sin(a)"] }] });
  assert.deepEqual(s.vectors[0].to, ["cos(a)", "sin(a)"]);
  bad({ type: "plot", vectors: [{ from: [0, 0], to: [1] }] }, /vectors\[0\]\.to must be \[x, y\]/);
  bad({ type: "plot", vectors: [{ from: [0, 0], to: ["b", 1] }] }, /vectors\[0\]\.to\.x must be a number \(an expression such as "a" needs params/);
  bad({ type: "plot", vectors: [{ from: [0, 0], to: [1, 1], head: true }] }, /unknown field "head"/);
  bad({ type: "plot" }, /at least one of functions, parametric, points, areas, vectors or segments/);
});

/** A valid 1-colour PNG of the given size. */
function png(w, h) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]), len = Buffer.alloc(4), crc = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    let c, n = 0xffffffff;
    for (const byte of body) { c = (n ^ byte) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; n = c ^ (n >>> 8); }
    crc.writeUInt32BE((n ^ 0xffffffff) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", deflateSync(Buffer.alloc((w * 3 + 1) * h, 0x80))), chunk("IEND", Buffer.alloc(0))]);
}

test("image sizes are read from the file's own bytes", () => {
  assert.deepEqual(imageInfo(png(40, 30)), { ext: "png", w: 40, h: 30 });
  assert.deepEqual(imageInfo(Buffer.concat([Buffer.from("GIF89a"), Buffer.from([0x20, 0x00, 0x10, 0x00, 0, 0, 0])])), { ext: "gif", w: 32, h: 16 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x64, 0x00, 0xc8, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpeg), { ext: "jpg", w: 200, h: 100 });
  assert.equal(imageInfo(Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>".padEnd(40))), null);
  assert.equal(imageInfo(Buffer.from("not an image at all, just text....")), null);
});

test("an image artifact is copied into the data folder from an allowed folder only, and served by its hash", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "math-board-images-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const learn = path.join(root, "Learn"), outside = path.join(root, "outside"), dataDir = path.join(root, "data");
  await mkdir(learn); await mkdir(outside);
  await writeFile(path.join(learn, "fig.png"), png(400, 200));
  await writeFile(path.join(learn, "notes.png"), "this is not a picture, whatever its name says");
  await writeFile(path.join(outside, "secret.png"), png(10, 10));
  await symlink(path.join(outside, "secret.png"), path.join(learn, "link.png"));
  const saved = process.env.MATH_BOARD_IMAGE_DIRS;
  process.env.MATH_BOARD_IMAGE_DIRS = learn;
  t.after(() => { if (saved === undefined) delete process.env.MATH_BOARD_IMAGE_DIRS; else process.env.MATH_BOARD_IMAGE_DIRS = saved; });
  assert.deepEqual(imageDirs(), [learn]);
  assert.deepEqual(imageDirs({ MATH_BOARD_LEARN_DIR: "/l" }), ["/l"]);
  assert.deepEqual(imageDirs({ MATH_BOARD_IMAGE_DIRS: `/a${path.delimiter}relative${path.delimiter}/b` }), ["/a", "/b"]);
  const s = new BoardServer({ dataDir });
  s.snapshots.lint = async () => ({ items: [], issues: [] });
  await s.start();
  t.after(() => s.stop());
  const ctx = { server: async () => s, staleWarning: () => "", openHint: "board_open" };
  const add = (artifact) => handlers.board_update(ctx, { baseRevision: s.revision, scene: { mode: "append", artifacts: [artifact] } });
  const out = (await add({ type: "image", id: "fig", path: path.join(learn, "fig.png"), x: 60, y: 100, width: 300 })).content[0].text;
  assert.match(out, /\[fig\] image at \(60,100\) 300x150/, "the height follows the picture's 2:1 shape");
  const item = s.getState().scene.artifacts[0];
  assert.match(item.file, /^[a-f0-9]{64}\.png$/);
  assert.deepEqual(item.natural, [400, 200]);
  assert.equal(item.path, undefined, "the board keeps its copy, not the path");
  assert.deepEqual(await readdir(path.join(dataDir, "images")), [item.file]);
  // Served by its content hash; nothing else under /images/ is.
  const got = await fetch(`http://127.0.0.1:${s.port}/images/${item.file}`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await got.arrayBuffer()), png(400, 200));
  for (const name of ["..%2Fautosave.json", "autosave.json", `${"0".repeat(64)}.png`, `${item.file}.bak`]) assert.equal((await fetch(`http://127.0.0.1:${s.port}/images/${name}`)).status, 404, name);
  // The same picture again is one file; the original can go and the board still has it.
  await add({ type: "image", id: "again", path: path.join(learn, "fig.png") });
  assert.equal((await readdir(path.join(dataDir, "images"))).length, 1);
  await rm(path.join(learn, "fig.png"));
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/images/${item.file}`)).status, 200);
  // Refused, with the reason and nothing applied.
  const rev = s.revision;
  await assert.rejects(add({ type: "image", path: path.join(outside, "secret.png") }), /is outside the folders this board may show images from .*MATH_BOARD_IMAGE_DIRS/);
  await assert.rejects(add({ type: "image", path: path.join(learn, "link.png") }), /is outside the folders/, "a link out of the folder is followed before the check");
  await assert.rejects(add({ type: "image", path: path.join(learn, "notes.png") }), /is not a PNG, JPEG, GIF or WebP image/);
  await assert.rejects(add({ type: "image", path: path.join(learn, "missing.png") }), /no file at/);
  await assert.rejects(add({ type: "image", path: "fig.png" }), /path must be absolute/);
  await assert.rejects(add({ type: "image", path: path.join(learn, "notes.png"), file: item.file }), /give path only/);
  await assert.rejects(add({ type: "image" }), /image needs path/);
  assert.equal(s.revision, rev);
  // Over HTTP (the page's route) a path is never read.
  assert.throws(() => s.apply({ baseRevision: rev, scene: { mode: "append", artifacts: [{ type: "image", path: path.join(learn, "notes.png") }] } }), /cannot read image files from a path here/);
  // A save keeps the reference, and loading it brings the picture back.
  await s.save("with-image");
  s.clear();
  await s.load("with-image");
  assert.equal(s.getState().scene.artifacts[0].file, item.file);
});

test("every new format has a board_docs topic with an example", () => {
  for (const topic of ["table", "code", "chart", "image"]) {
    assert.ok(DOC_TOPICS.includes(topic));
    assert.match(BOARD_DOCS[topic], new RegExp(`Example: \\{"type":"${topic}"`));
  }
  assert.match(BOARD_DOCS.plot, /vectors: up to 24/);
});
