/** Manual end-to-end check: real Pi loader → board_update (auto lint) → board_snapshot PNG. */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
// Isolated data dir: never read or overwrite the user's saves/autosave.
process.env.PI_MATH_BOARD_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "math-board-test-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const host = path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
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
} finally {
  await ext.commands.get("board").handler("stop", ctx);
}
