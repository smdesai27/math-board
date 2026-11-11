/**
 * `pi-math-board watch`: the board in a terminal pane, for when a browser window is one too many.
 *
 * It joins the board a session hosts (never starts one), follows its revisions and redraws a
 * picture of what the tutor's camera shows, as sixel graphics: tmux 3.4+ (built with sixel),
 * WezTerm, iTerm2, foot, xterm -ti vt340 and others draw it; a terminal without sixel shows
 * nothing useful. It is a look at the board, not the board: no drawing animation, no sliders, no
 * hover references, no covers to lift. Each frame is a board_snapshot of the same region, so the
 * picture is exactly what the page would show at rest.
 *
 *   pi-math-board watch              follow the camera; o = whole lesson, r = redraw, q = quit
 *   pi-math-board watch --once       one frame to stdout, then exit (also when stdout is no terminal)
 *   pi-math-board watch --overview   start with the whole lesson
 *   pi-math-board watch --width 900  picture width in pixels (default: what fits the pane)
 *
 * The pane's size in pixels is asked of the terminal (CSI 14 t); when it does not answer,
 * $MATH_BOARD_CELL_PX (e.g. "9x18") or 8x17 per character cell is assumed.
 */

import { inflateSync } from "node:zlib";

/* ------------------------------------------------------------------ */
/* PNG -> pixels                                                       */
/* ------------------------------------------------------------------ */

/** Decode an 8-bit RGB or RGBA, non-interlaced PNG (what the headless browser writes): { width, height, channels, data }. */
export function decodePng(buf) {
  if (buf.length < 33 || buf.readUInt32BE(0) !== 0x89504e47 || buf.readUInt32BE(4) !== 0x0d0a1a0a) throw new Error("not a PNG");
  let width = 0, height = 0, channels = 0;
  const idat = [];
  for (let at = 8; at + 12 <= buf.length; ) {
    const length = buf.readUInt32BE(at), type = buf.toString("latin1", at + 4, at + 8), body = buf.subarray(at + 8, at + 8 + length);
    if (type === "IHDR") {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      const depth = body[8], color = body[9], interlace = body[12];
      if (depth !== 8 || (color !== 2 && color !== 6) || interlace !== 0) throw new Error(`unsupported PNG (depth ${depth}, colour type ${color}, interlace ${interlace})`);
      channels = color === 6 ? 4 : 3;
    } else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") break;
    at += 12 + length;
  }
  if (!width || !height || !idat.length) throw new Error("PNG without image data");
  const raw = inflateSync(Buffer.concat(idat), { maxOutputLength: 1 << 28 }), stride = width * channels;
  if (raw.length < (stride + 1) * height) throw new Error("PNG image data is cut short");
  const data = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)], line = y * (stride + 1) + 1, out = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? data[out + i - channels] : 0, b = y ? data[out + i - stride] : 0, c = y && i >= channels ? data[out + i - stride - channels] : 0;
      let predict = 0;
      if (filter === 1) predict = a;
      else if (filter === 2) predict = b;
      else if (filter === 3) predict = (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        predict = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      data[out + i] = (raw[line + i] + predict) & 0xff;
    }
  }
  return { width, height, channels, data };
}

/* ------------------------------------------------------------------ */
/* pixels -> sixel                                                     */
/* ------------------------------------------------------------------ */

// 240 colours: a 6x6x6 cube and 24 greys. The board is black with chalk colours and soft edges;
// the greys keep the edges of white text smooth, which a cube alone turns blotchy.
const CUBE = [0, 51, 102, 153, 204, 255];
const GREYS = 24;
export const PALETTE = [
  ...CUBE.flatMap((r) => CUBE.flatMap((g) => CUBE.map((b) => [r, g, b]))),
  ...Array.from({ length: GREYS }, (_, k) => { const v = Math.round((k * 255) / (GREYS - 1)); return [v, v, v]; }),
];
const nearCube = (v) => Math.round(v / 51);
/** The palette index of a colour: a grey when its channels are close together, else the nearest cube colour. */
export function paletteIndex(r, g, b) {
  if (Math.max(r, g, b) - Math.min(r, g, b) <= 14) return 216 + Math.round(((r + g + b) / 3 / 255) * (GREYS - 1));
  return nearCube(r) * 36 + nearCube(g) * 6 + nearCube(b);
}

/** A sixel picture of decoded pixels (see decodePng): the string to write to the terminal. */
export function toSixel({ width, height, channels, data }) {
  const index = new Uint8Array(width * height), seen = new Uint8Array(PALETTE.length);
  for (let i = 0, p = 0; i < index.length; i++, p += channels) {
    // Drawn on black: a see-through pixel is as dark as it is clear.
    const alpha = channels === 4 ? data[p + 3] / 255 : 1;
    const c = paletteIndex(data[p] * alpha, data[p + 1] * alpha, data[p + 2] * alpha);
    index[i] = c;
    seen[c] = 1;
  }
  const out = ["\x1bP0;0;0q", `"1;1;${width};${height}`];
  for (let c = 0; c < PALETTE.length; c++)
    if (seen[c]) out.push(`#${c};2;${PALETTE[c].map((v) => Math.round((v / 255) * 100)).join(";")}`);
  const run = (bits, n) => { const ch = String.fromCharCode(63 + bits); return n > 3 ? `!${n}${ch}` : ch.repeat(n); };
  for (let top = 0; top < height; top += 6) {
    // One row of bits per colour in this band of six pixel rows.
    const rows = new Map();
    for (let dy = 0; dy < 6 && top + dy < height; dy++)
      for (let x = 0, at = (top + dy) * width; x < width; x++, at++) {
        let row = rows.get(index[at]);
        if (!row) rows.set(index[at], (row = new Uint8Array(width)));
        row[x] |= 1 << dy;
      }
    let first = true;
    for (const [c, row] of rows) {
      let line = "", bits = row[0], n = 0, end = width;
      while (end > 0 && row[end - 1] === 0) end--; // nothing to draw after the colour's last pixel
      for (let x = 0; x < end; x++) {
        if (row[x] === bits) n++;
        else { line += run(bits, n); bits = row[x]; n = 1; }
      }
      if (end) line += run(bits, n);
      out.push(`${first ? "" : "$"}#${c}${line}`);
      first = false;
    }
    out.push("-");
  }
  out.push("\x1b\\");
  return out.join("");
}

/* ------------------------------------------------------------------ */
/* The watcher                                                         */
/* ------------------------------------------------------------------ */

/** The picture size (px) that fits a pane of cols x rows cells of cell px, for a board region, leaving `spare` text rows. */
export function fitPicture({ cols, rows, cell, region, spare = 2, pixels = null }) {
  const w = pixels?.w ?? cols * cell.w, h = (pixels?.h ?? rows * cell.h) - spare * (pixels ? pixels.h / rows : cell.h);
  const width = Math.floor(Math.min(w, (h * region.w) / region.h));
  return Math.max(200, Math.min(2400, width));
}

/** Ask the terminal for its text area in pixels (CSI 14 t). null when it does not answer in time. */
function askPixels(ms = 300) {
  const { stdin, stdout } = process;
  if (!stdin.isTTY || !stdout.isTTY) return Promise.resolve(null);
  return new Promise((resolve) => {
    let got = "";
    const done = (value) => { clearTimeout(timer); stdin.off("data", onData); resolve(value); };
    const onData = (chunk) => {
      got += chunk.toString("latin1");
      const m = /\x1b\[4;(\d+);(\d+)t/.exec(got);
      if (m) done({ w: Number(m[2]), h: Number(m[1]) });
    };
    const timer = setTimeout(() => done(null), ms);
    stdin.on("data", onData);
    stdout.write("\x1b[14t");
  });
}

export async function watch(argv = process.argv.slice(3)) {
  const { defaultDataDir, cameraRect } = await import("./server.mjs");
  const { overviewRegion } = await import("./export.mjs");
  const { BoardLink } = await import("./attach.mjs");
  const flag = (name) => argv.includes(name);
  const widthArg = Number(argv[argv.indexOf("--width") + 1]);
  const { stdin, stdout } = process;
  const once = flag("--once") || !stdout.isTTY;
  let overview = flag("--overview");
  const cellEnv = /^(\d+)x(\d+)$/.exec(process.env.MATH_BOARD_CELL_PX ?? "");
  const cell = cellEnv ? { w: Number(cellEnv[1]), h: Number(cellEnv[2]) } : { w: 8, h: 17 };
  const link = new BoardLink({ dataDir: defaultDataDir(), context: {} });
  // Text from the board (titles, error messages) is printed without control characters: it must not steer the terminal.
  const plain = (text) => String(text).replace(/[\u0000-\u0009\u000b-\u000c\u000e-\u001f\u007f-\u009f]/g, "");
  const note = (text) => { if (!once) stdout.write(`\x1b[H\x1b[2J\x1b[2m${plain(text)}\x1b[0m\r\n`); };

  let pixels = null, drawing = false, again = false, shown = "";
  async function frame() {
    const { board, revision } = await link.request("/api/state");
    const region = overview && board.chapters?.length ? overviewRegion(board.chapters) : cameraRect(board);
    const width = Number.isFinite(widthArg) && argv.includes("--width") ? Math.max(200, Math.min(2400, widthArg))
      : fitPicture({ cols: stdout.columns ?? 100, rows: stdout.rows ?? 30, cell, region, pixels });
    const { png } = await link.request("/api/snapshot", { region, width });
    const chapter = board.camera?.chapter && (board.chapters ?? []).find((c) => c.id === board.camera.chapter);
    const status = [board.title, overview ? "whole lesson" : chapter?.title, board.lastStep ? `step ${board.lastStep}` : "", `revision ${revision}`].filter(Boolean).map((part) => plain(part).replace(/[\r\n]/g, " ")).join(" · ");
    return { sixel: toSixel(decodePng(Buffer.from(png, "base64"))), status };
  }
  async function draw() {
    if (drawing) { again = true; return; }
    drawing = true;
    try {
      do {
        again = false;
        const { sixel, status } = await frame();
        shown = status;
        if (once) stdout.write(`${sixel}\n`);
        else stdout.write(`\x1b[H\x1b[2J${sixel}\r\n\x1b[2m${status}   (o whole lesson, r redraw, q quit)\x1b[0m`);
      } while (again && !once);
    } finally {
      drawing = false;
    }
  }

  if (once) {
    if (!(await link.find())) {
      console.error("No board is running: open one with board_open, /board or `pi-math-board serve`.");
      process.exit(1);
    }
    await draw();
    process.exit(0);
  }

  // Interactive: follow the board until q.
  const leave = (code = 0) => {
    stdout.write("\x1b[?25h\r\n");
    if (stdin.isTTY) stdin.setRawMode(false);
    process.exit(code);
  };
  if (stdin.isTTY) stdin.setRawMode(true);
  stdin.resume();
  stdout.write("\x1b[?25l");
  pixels = await askPixels();
  stdin.on("data", (chunk) => {
    const key = chunk.toString("latin1");
    if (key === "q" || key === "\x03") leave();
    else if (key === "o") { overview = !overview; draw().catch(() => {}); }
    else if (key === "r") draw().catch(() => {});
  });
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => leave());
  stdout.on("resize", async () => { pixels = await askPixels(); draw().catch(() => {}); });

  for (;;) {
    link.remote = null;
    if (!(await link.find().catch(() => false))) {
      note("No board is running. Waiting for one (board_open, /board or `pi-math-board serve`); q quits.");
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    try {
      // The board's event stream: a line of data per revision.
      const res = await fetch(`http://127.0.0.1:${link.remote.port}/api/events?token=${link.remote.token}`);
      if (!res.ok) throw new Error(`the board answered ${res.status}`);
      let timer = null, buffer = "";
      const soon = () => { clearTimeout(timer); timer = setTimeout(() => draw().catch((err) => note(`Could not draw the board: ${err.message}`)), 150); };
      const text = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += text.decode(chunk, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop();
        if (events.some((e) => /"type":"(hello|revision|frames)"/.test(e))) soon();
      }
    } catch {
      // The host went away: wait for the next one below.
    }
    note(`${shown ? `${shown}\r\n` : ""}The board stopped. Waiting for it to come back; q quits.`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}
