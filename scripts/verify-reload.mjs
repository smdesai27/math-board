/**
 * Regression: a second extension load in the same process (pi's /reload) must pick up an edited
 * server.mjs, and a board started after it reuses the port and token, so an open tab reconnects.
 * It edits server.mjs in place and restores it afterwards, also on Ctrl-C or a failure.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { ROOT as root, isolateDataDir, piHostRoot } from "./lib/pi-host.mjs";

// Isolated data dir: never read or overwrite the user's saves/autosave.
isolateDataDir();
const loader = await import(pathToFileURL(path.join(piHostRoot(), "dist/core/extensions/loader.js")));
const notices = [];
const ctx = { mode: "json", hasUI: false, cwd: root, ui: { notify: (text) => notices.push(text), setStatus() {} } };

/** Load the extension, read the board's probe field and its URL, stop the board. */
async function probe() {
  const result = await loader.loadExtensions([path.join(root, "index.ts")], root);
  assert.deepEqual(result.errors, []);
  const ext = result.extensions[0];
  result.runtime.getActiveTools = () => [];
  result.runtime.setActiveTools = () => {};
  try {
    const read = await ext.tools.get("board_read").definition.execute("x", {}, undefined, undefined, ctx);
    await ext.commands.get("board").handler("status", ctx);
    const url = notices.at(-1).match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/)?.[0];
    return { probe: read.details.board.probe, url };
  } finally {
    await ext.commands.get("board").handler("stop", ctx);
  }
}

const file = path.join(root, "server.mjs");
const original = readFileSync(file, "utf8");
const marker = "  getState() {\n    return clone(this.board);";
assert.ok(original.includes(marker), "server.mjs getState() changed: update this script's marker");
const restore = () => writeFileSync(file, original);
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.once(signal, () => {
    restore();
    process.exit(130);
  });

const first = await probe();
assert.equal(first.probe, undefined, "first load: unedited server");
assert.ok(first.url, "first load: /board status shows the URL");
writeFileSync(file, original.replace(marker, '  getState() {\n    return { ...clone(this.board), probe: "CHANGED" };'));
let second;
try {
  second = await probe();
} finally {
  restore();
}
assert.equal(readFileSync(file, "utf8"), original, "server.mjs restored");
assert.equal(second.probe, "CHANGED", "second load in the same process runs the edited server.mjs");
assert.equal(second.url, first.url, "the board after the reload has the same port and token");
console.log(`PASS: /reload picks up an edited server.mjs (probe=${second.probe}); the new board reuses ${new URL(first.url).host} and its token; server.mjs restored.`);
