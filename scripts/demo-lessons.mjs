/**
 * Visual QA: build three realistic lessons through the real tools (Pi's loader, board_update,
 * board_library, board_snapshot) and write every chapter, the camera view and the overview as
 * PNGs at the default width and at 1600 px, plus warnings.json with every layout warning the
 * tools returned.
 *
 *   node scripts/demo-lessons.mjs <out-dir> [physics|mri|chem ...]
 *
 * Needs pi (global install, this checkout's devDependency, or PI_HOST_ROOT) and a headless
 * Chromium, like scripts/e2e-snapshot.mjs. The board's data folder is a fresh temporary folder
 * unless MATH_BOARD_DATA_DIR is set.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { LESSONS } from "./demo-lessons-data.mjs";
import { ROOT as root, isolateDataDir, piHostRoot } from "./lib/pi-host.mjs";

const [outArg, ...only] = process.argv.slice(2);
if (!outArg) {
  console.error("usage: node scripts/demo-lessons.mjs <out-dir> [physics|mri|chem ...]");
  process.exit(2);
}
const out = path.resolve(outArg);
mkdirSync(out, { recursive: true });
// Isolated data dir: never read or overwrite the user's saves/autosave.
isolateDataDir("math-board-demo-");
const host = piHostRoot();
const { loadExtensions } = await import(pathToFileURL(path.join(host, "dist/core/extensions/loader.js")));
const ext = (await loadExtensions([path.join(root, "index.ts")], root)).extensions[0];
const tool = (n) => ext.tools.get(n).definition;
const ctx = { mode: "json", hasUI: false, cwd: root, ui: { notify() {}, setStatus() {} } };
const call = (name, params) => tool(name).execute(name, params, undefined, undefined, ctx);
/** The "layout warnings" lines of a tool result (empty when the check passed). */
const warningsOf = (text) => {
  const m = /layout warnings \(\d+\):\n((?:  - .*\n?)+)/.exec(text);
  return m ? m[1].trim().split("\n").map((l) => l.replace(/^\s*- /, "")) : [];
};

const report = {};
let revision = 0;
let failed = false;
try {
  // Start from an empty board (a reused data dir may hold an autosave).
  revision = (await call("board_read", {})).details.revision;
  for (const lesson of LESSONS) {
    if (only.length && !only.includes(lesson.slug)) continue;
    const r = (report[lesson.slug] = { updates: [], snapshots: {} });
    const cleared = await call("board_update", { baseRevision: revision, clear: ["all"], check: false });
    revision = cleared.details.revision;
    if (lesson.slug === "chem") {
      // The tutor searches the library before placing an icon.
      const hits = (await call("board_library", { query: "heart" })).content[0].text;
      if (!/\bheart-front\b/.test(hits)) throw new Error(`board_library "heart" did not list heart-front:\n${hits}`);
    }
    for (const [i, step] of lesson.steps.entries()) {
      const res = await call("board_update", { baseRevision: revision, ...step });
      const text = res.content[0].text;
      if (res.isError) throw new Error(`${lesson.slug} step ${i + 1}: ${text}`);
      revision = res.details.revision;
      const warnings = warningsOf(text);
      if (/layout check unavailable/.test(text)) warnings.push(text.match(/layout check unavailable.*/)[0]);
      r.updates.push({ step: i + 1, revision, warnings });
      console.log(`${lesson.slug} step ${i + 1} → revision ${revision}${warnings.length ? `\n${warnings.map((w) => `    ! ${w}`).join("\n")}` : " · no layout warnings"}`);
    }
    const board = (await call("board_read", { chapter: "all" })).details.board;
    const shots = [
      ...board.chapters.map((c) => ({ name: c.id, params: { chapter: c.id } })),
      { name: "camera", params: {} },
      { name: "overview", params: { overview: true } },
    ];
    for (const shot of shots) {
      for (const width of [undefined, 1600]) {
        const res = await call("board_snapshot", { ...shot.params, ...(width ? { width } : {}) });
        const file = path.join(out, `${lesson.slug}-${shot.name}-${width ?? 1200}.png`);
        writeFileSync(file, Buffer.from(res.content[0].data, "base64"));
        const warnings = warningsOf(res.content[1].text);
        r.snapshots[path.basename(file)] = warnings;
        console.log(`  ${file}${warnings.length ? ` (${warnings.length} warnings)` : ""}`);
      }
    }
  }
} catch (e) {
  failed = true;
  console.error(e);
} finally {
  writeFileSync(path.join(out, "warnings.json"), JSON.stringify(report, null, 2) + "\n");
  await ext.commands.get("board").handler("stop", ctx);
}
console.log(`${failed ? "FAILED" : "done"}: PNGs and warnings.json in ${out}`);
process.exit(failed ? 1 : 0);
