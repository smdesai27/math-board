/** Manual end-to-end check: real Pi loader → board_update (auto lint) → board_snapshot PNG → /board export. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
// Isolated data dir: never read or overwrite the user's saves/autosave.
process.env.PI_MATH_BOARD_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "math-board-test-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const host = process.env.PI_HOST_ROOT || path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const { loadExtensions } = await import(pathToFileURL(path.join(host, "dist/core/extensions/loader.js")));
const ext = (await loadExtensions([path.join(root, "index.ts")], root)).extensions[0];
const tool = (n) => ext.tools.get(n).definition;
const ctx = { mode: "json", hasUI: false, cwd: root, ui: { notify() {}, setStatus() {} } };
const out = process.argv[2] || "/tmp/board-e2e.png";
try {
  const t0 = Date.now();
  const r = await tool("board_update").execute("u", {
    baseRevision: 0,
    title: "E2E",
    equations: [
      { op: "add", id: "eq1", latex: "E = mc^2", x: 80, y: 80, label: "Energy" },
      { op: "add", id: "eq2", latex: "F = ma", x: 120, y: 110, color: "#f2c14e" }, // deliberate overlap
    ],
    scene: { mode: "append", shapes: [
      { type: "text", id: "t1", text: "Serif heading (LaTeX font)", x: 600, y: 100, size: 32 },
      { type: "text", id: "t2", text: "sans, centered, italic", x: 900, y: 160, font: "sans", anchor: "middle", italic: true, color: "#5fb3d9" },
      { type: "line", id: "l1", points: [[600, 200], [1100, 200]], dash: "8 6", color: "#8a8578" },
      { type: "text", id: "off", text: "off the edge", x: 1150, y: 300 },
    ] },
  }, undefined, undefined, ctx);
  console.log(`update (${Date.now() - t0}ms):\n` + r.content[0].text.split("\n").slice(0, 8).join("\n"));
  const r2 = await tool("board_update").execute("m", { baseRevision: 1, items: [{ op: "move", id: "eq2", dx: 0, dy: 120 }, { op: "update", id: "off", fields: { x: 900, anchor: "middle" } }] }, undefined, undefined, ctx);
  console.log("after fix:\n" + r2.content[0].text.split("\n").slice(0, 3).join("\n"));
  const t1 = Date.now();
  const snap = await tool("board_snapshot").execute("s", {}, undefined, undefined, ctx);
  writeFileSync(out, Buffer.from(snap.content[0].data, "base64"));
  console.log(`snapshot (${Date.now() - t1}ms) → ${out}\n` + snap.content[1].text);

  // /board export through the registered command, into a temporary cwd: two chapters beside
  // the home board, so it writes home.png, a PNG per chapter and the overview.
  await tool("board_update").execute("ch", {
    baseRevision: 2,
    chapters: [
      { op: "add", id: "ch1", title: "Mass-energy", x: 1440, y: 0 },
      { op: "add", id: "ch2", title: "Sine wave", x: 2880, y: 0 },
    ],
    equations: [{ op: "add", id: "eq3", latex: "E_0 = m_0 c^2", x: 80, y: 100, chapter: "ch1" }],
    scene: { mode: "append", artifacts: [{ type: "plot", id: "p1", x: 80, y: 120, width: 640, height: 400, xRange: [-6.3, 6.3], functions: [{ expr: "sin(x)" }], chapter: "ch2" }] },
  }, undefined, undefined, ctx);
  const exportCwd = mkdtempSync(path.join(tmpdir(), "math-board-export-"));
  const notices = [];
  const exportCtx = { ...ctx, cwd: exportCwd, ui: { notify: (text, type) => notices.push({ text, type }), setStatus() {} } };
  const t2 = Date.now();
  await ext.commands.get("board").handler("export E2E lesson", exportCtx);
  const notice = notices.at(-1);
  console.log(`export (${Date.now() - t2}ms):\n${notice.text}`);
  assert.equal(notice.type, "info", notice.text);
  const dir = notice.text.match(/^Lesson exported to (.+)$/m)?.[1];
  assert.ok(dir && existsSync(dir), notice.text);
  assert.equal(path.dirname(dir), path.join(exportCwd, "viz"));
  assert.match(path.basename(dir), /^board-e2e-lesson-\d{8}-\d{4}$/);
  const pngs = ["home.png", "chapter-ch1.png", "chapter-ch2.png", "overview.png"];
  assert.deepEqual(readdirSync(dir).sort(), ["board.json", "lesson.md", ...pngs].sort());
  for (const file of pngs) {
    const png = readFileSync(path.join(dir, file));
    assert.ok(png.length > 1000, `${file} is ${png.length} bytes`);
    assert.equal(png.subarray(1, 4).toString(), "PNG", file);
  }
  const saved = JSON.parse(readFileSync(path.join(dir, "board.json"), "utf8"));
  assert.equal(saved.name, "e2e-lesson");
  assert.equal(saved.revision, 3);
  assert.equal(saved.board.title, "E2E");
  assert.deepEqual(saved.board.chapters.map((c) => c.id), ["ch1", "ch2"]);
  const md = readFileSync(path.join(dir, "lesson.md"), "utf8");
  assert.match(md, /^# E2E\n\nExported \d{4}-\d\d-\d\d \d\d:\d\d · board revision 3 · 2 steps\n\n## Home\n\n!\[home\]\(home\.png\)\n\n## Mass-energy\n\n!\[chapter ch1\]\(chapter-ch1\.png\)\n\n## Sine wave\n\n!\[chapter ch2\]\(chapter-ch2\.png\)\n\n## Overview\n\n!\[overview\]\(overview\.png\)\n$/);
  console.log(`export folder ${dir}:\n${readdirSync(dir).sort().map((f) => `  ${f} (${statSync(path.join(dir, f)).size} bytes)`).join("\n")}\nlesson.md:\n${md}PASS: /board export wrote board.json, lesson.md and ${pngs.length} non-empty PNGs.`);
} finally {
  await ext.commands.get("board").handler("stop", ctx);
}
