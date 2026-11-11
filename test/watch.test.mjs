/**
 * The terminal view (watch.mjs): decoding the snapshot PNG, the sixel picture (checked by decoding
 * it again), the size that fits a pane, and one frame from a running board.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";
import { PALETTE, decodePng, fitPicture, paletteIndex, toSixel } from "../watch.mjs";
import { BoardLink } from "../attach.mjs";

/** A PNG of `pixels` (rows of [r, g, b] or [r, g, b, a]), each row written with the given filter type. */
function png(pixels, filters = []) {
  const h = pixels.length, w = pixels[0].length, ch = pixels[0][0].length, stride = w * ch;
  const plain = Buffer.from(pixels.flat(2));
  const raw = Buffer.alloc((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const f = filters[y] ?? 0;
    raw[y * (stride + 1)] = f;
    for (let i = 0; i < stride; i++) {
      const at = y * stride + i, a = i >= ch ? plain[at - ch] : 0, b = y ? plain[at - stride] : 0, c = y && i >= ch ? plain[at - stride - ch] : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predict = [0, a, b, (a + b) >> 1, pa <= pb && pa <= pc ? a : pb <= pc ? b : c][f];
      raw[y * (stride + 1) + 1 + i] = (plain[at] - predict) & 0xff;
    }
  }
  const chunk = (type, data) => { const out = Buffer.alloc(12 + data.length); out.writeUInt32BE(data.length); out.write(type, 4, "latin1"); data.copy(out, 8); return out; }; // the decoder does not check CRCs
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = ch === 4 ? 6 : 2;
  const idat = deflateSync(raw);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", head), chunk("IDAT", idat.subarray(0, 20)), chunk("IDAT", idat.subarray(20)), chunk("IEND", Buffer.alloc(0))]);
}

/** Decode a sixel picture back to palette indices per pixel (what a terminal would paint). */
function unsixel(text) {
  assert.ok(text.startsWith("\x1bP0;0;0q") && text.endsWith("\x1b\\"));
  const body = text.slice(8, -2);
  const [, w, h] = /^"1;1;(\d+);(\d+)/.exec(body).map(Number);
  const pixels = new Int16Array(w * h).fill(-1);
  const colours = new Map();
  let colour = 0, x = 0, band = 0;
  const re = /"[\d;]+|#(\d+)(?:;2;(\d+);(\d+);(\d+))?|!(\d+)(.)|([$-])|([?-~])/g;
  for (let m; (m = re.exec(body)); ) {
    if (m[1] !== undefined) { colour = Number(m[1]); if (m[2] !== undefined) colours.set(colour, [m[2], m[3], m[4]].map(Number)); }
    else if (m[7] === "$") x = 0;
    else if (m[7] === "-") { x = 0; band++; }
    else if (m[5] !== undefined || m[8] !== undefined) {
      const n = m[5] !== undefined ? Number(m[5]) : 1, bits = (m[6] ?? m[8]).charCodeAt(0) - 63;
      for (let k = 0; k < n; k++, x++) for (let dy = 0; dy < 6; dy++) if (bits & (1 << dy) && band * 6 + dy < h) pixels[(band * 6 + dy) * w + x] = colour;
    }
  }
  return { w, h, pixels, colours };
}

test("a PNG decodes to its pixels with every row filter, RGB and RGBA, across IDAT chunks", () => {
  const rows = Array.from({ length: 9 }, (_, y) => Array.from({ length: 7 }, (_, x) => [(x * 37 + y * 11) & 255, (x * 5 + y * 91) & 255, (x * y * 13) & 255]));
  for (const filters of [[], [1, 1, 1, 1, 1, 1, 1, 1, 1], [0, 1, 2, 3, 4, 4, 3, 2, 1]]) {
    const got = decodePng(png(rows, filters));
    assert.deepEqual([got.width, got.height, got.channels], [7, 9, 3]);
    assert.deepEqual([...got.data], rows.flat(2));
  }
  const rgba = rows.map((row) => row.map((p) => [...p, 200]));
  assert.deepEqual([...decodePng(png(rgba, [4, 3, 2, 1, 0, 4, 3, 2, 1])).data], rgba.flat(2));
  assert.throws(() => decodePng(Buffer.from("GIF89a..........................................")), /not a PNG/);
});

test("the sixel picture paints every pixel with its palette colour", () => {
  // 13 rows (two full bands and one of a single row), 11 columns: chalk, black, accents, a grey ramp.
  const chalk = [232, 227, 217], yellow = [242, 193, 78], blue = [95, 179, 217];
  const rows = Array.from({ length: 13 }, (_, y) => Array.from({ length: 11 }, (_, x) => (y === 12 ? chalk : x === y ? yellow : x > 8 ? blue : (x + y) % 3 === 0 ? [x * 23, x * 23, x * 23] : [0, 0, 0])));
  const picture = unsixel(toSixel(decodePng(png(rows))));
  assert.deepEqual([picture.w, picture.h], [11, 13]);
  rows.flat().forEach((p, i) => assert.equal(picture.pixels[i], paletteIndex(...p), `pixel ${i}`));
  // Colours are declared in percent, once each, and only those in use.
  assert.deepEqual([...picture.colours.keys()].sort((a, b) => a - b), [...new Set(rows.flat().map((p) => paletteIndex(...p)))].sort((a, b) => a - b));
  for (const [c, rgb] of picture.colours) assert.deepEqual(rgb, PALETTE[c].map((v) => Math.round((v / 255) * 100)));
  // Greys keep their own ramp; a see-through pixel is drawn on black.
  assert.deepEqual(PALETTE[paletteIndex(128, 130, 126)], [133, 133, 133]);
  assert.deepEqual(PALETTE[paletteIndex(...yellow)], [255, 204, 102]);
  const faint = unsixel(toSixel(decodePng(png([[[255, 255, 255, 0], [255, 255, 255, 255]]]))));
  assert.deepEqual([...faint.pixels], [paletteIndex(0, 0, 0), paletteIndex(255, 255, 255)]);
  // Long runs are run-length coded: a 600 px black row is a few bytes, not 600.
  assert.ok(toSixel(decodePng(png([Array.from({ length: 600 }, () => [0, 0, 0])]))).length < 80);
});

test("the picture fits the pane: by width in a tall pane, by height in a wide one, two text rows spare", () => {
  const region = { x: 0, y: 0, w: 1200, h: 800 }, cell = { w: 8, h: 16 };
  assert.equal(fitPicture({ cols: 100, rows: 60, cell, region }), 800);
  assert.equal(fitPicture({ cols: 200, rows: 27, cell, region }), 600, "(27 - 2) rows of 16 px, at 3:2");
  assert.equal(fitPicture({ cols: 100, rows: 60, cell, region, pixels: { w: 1000, h: 1200 } }), 1000, "the terminal's own pixel size wins");
  assert.equal(fitPicture({ cols: 10, rows: 5, cell, region }), 200);
  assert.equal(fitPicture({ cols: 1000, rows: 400, cell, region }), 2400);
});

test("watch --once prints one sixel frame of a running board, and says so when there is none", async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), "math-board-watch-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = fileURLToPath(new URL("../mcp/server.mjs", import.meta.url));
  const run = (...args) => new Promise((resolve) => execFile(process.execPath, [cli, "watch", ...args], { env: { ...process.env, MATH_BOARD_DATA_DIR: dir }, encoding: "latin1", maxBuffer: 64 * 1024 * 1024, timeout: 60000 }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
  const none = await run("--once");
  assert.equal(none.code, 1);
  assert.match(none.stderr, /No board is running/);
  const link = new BoardLink({ dataDir: dir, context: { staleWarning: () => "", openHint: "board_open" } });
  t.after(() => link.stop());
  await link.ensure();
  link.local.update({ title: "Sixel", scene: { mode: "append", shapes: [{ type: "rect", id: "r", x: 100, y: 100, w: 1000, h: 600, color: "#f2c14e", fill: "#f2c14e" }] } });
  try {
    await link.local.snapshots.lint();
  } catch (err) {
    if (/no headless browser/.test(err.message)) return t.skip(err.message);
    throw err;
  }
  const out = await run("--once", "--width", "300");
  assert.equal(out.code, 0, out.stderr);
  const picture = unsixel(out.stdout.trimEnd());
  assert.deepEqual([picture.w, picture.h], [300, 200]);
  // The yellow rectangle fills the middle; the corner is the black board.
  assert.equal(picture.pixels[100 * 300 + 150], paletteIndex(242, 193, 78));
  assert.equal(picture.pixels[2 * 300 + 2], paletteIndex(0, 0, 0));
});
