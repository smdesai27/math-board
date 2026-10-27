/** Regression: a second extension load in the same process must pick up edited server.mjs (Pi /reload). */
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
// Isolated data dir: never read or overwrite the user's saves/autosave.
process.env.PI_MATH_BOARD_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "math-board-test-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const host = path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), "@earendil-works/pi-coding-agent");
const loader = await import(pathToFileURL(path.join(host, "dist/core/extensions/loader.js")));
const probe = async () => { const r = await loader.loadExtensions([path.join(root, "index.ts")], root); const ext = r.extensions[0]; const ctx = { mode: "json", hasUI: false, cwd: root, ui: { notify(){}, setStatus(){} } }; const out = await ext.tools.get("board_read").definition.execute("x", {}, undefined, undefined, ctx).then(r => "probe=" + r.details.board.probe, e => "ERR " + e.message); await ext.commands.get("board").handler("stop", ctx); return out; };
console.log("1st load:", await probe());
const p = path.join(root, "server.mjs"), orig = readFileSync(p, "utf8");
writeFileSync(p, orig.replace("  getState() {\n    return clone(this.board);", "  getState() {\n    return { ...clone(this.board), probe: \"CHANGED\" };"));
try { console.log("2nd load:", await probe()); } finally { writeFileSync(p, orig); }
