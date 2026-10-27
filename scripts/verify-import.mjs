/** Exercise the installed Pi loader, without credentials, providers or configuration changes. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { pathToFileURL, fileURLToPath } from "node:url";
import path from "node:path";
// Isolated data dir: never read or overwrite the user's saves/autosave.
process.env.PI_MATH_BOARD_DATA_DIR ??= (await import("node:fs")).mkdtempSync((await import("node:path")).join((await import("node:os")).tmpdir(), "math-board-test-"));
const root = fileURLToPath(new URL("../", import.meta.url));
const host =
  process.env.PI_HOST_ROOT ||
  path.join(
    execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(),
    "@earendil-works/pi-coding-agent",
  );
const { loadExtensions } = await import(
  pathToFileURL(path.join(host, "dist/core/extensions/loader.js"))
);
const result = await loadExtensions([path.join(root, "index.ts")], root);
assert.deepEqual(result.errors, []);
assert.deepEqual(result.warnings ?? [], []);
assert.equal(result.extensions.length, 1);
const ext = result.extensions[0];
assert.deepEqual([...ext.tools.keys()].sort(), [
  "board_library",
  "board_read",
  "board_save",
  "board_snapshot",
  "board_update",
]);
assert.ok(ext.commands.has("board"));
const notices = [];
const ctx = {
  mode: "json",
  hasUI: false,
  cwd: root,
  ui: { notify: (text, type) => notices.push({ text, type }), setStatus() {} },
};
try {
  await ext.commands.get("board").handler("status", ctx);
  assert.match(notices.at(-1).text, /not running/);
  // Two parallel first calls share one lazy server.
  const tool = (name) => ext.tools.get(name).definition;
  const [a, b] = await Promise.all([
    tool("board_read").execute("a", {}, undefined, undefined, ctx),
    tool("board_read").execute("b", {}, undefined, undefined, ctx),
  ]);
  assert.equal(a.details.revision, 0);
  assert.equal(b.details.revision, 0);
  await tool("board_update").execute(
    "c",
    {
      baseRevision: 0,
      title: "Loader smoke test",
      equations: [{ op: "add", latex: "x^2" }],
    },
    undefined,
    undefined,
    ctx,
  );
  const state = await tool("board_read").execute(
    "d",
    {},
    undefined,
    undefined,
    ctx,
  );
  assert.equal(state.details.board.title, "Loader smoke test");
  assert.equal(state.details.revision, 1);
  const conflict = await tool("board_update").execute(
    "e",
    { baseRevision: 0, title: "stale" },
    undefined,
    undefined,
    ctx,
  );
  assert.equal(conflict.isError, true);
  await ext.commands.get("board").handler("open", ctx); // non-TUI must not launch a browser
  const url = new URL(
    notices.at(-1).text.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)[0],
  );
  const response = await fetch(`${url.origin}/api/state`, {
    headers: { Authorization: `Bearer ${url.hash.slice(7)}` },
  });
  assert.equal((await response.json()).board.title, "Loader smoke test");
  await ext.commands.get("board").handler("stop", ctx);
  await assert.rejects(fetch(`${url.origin}/api/state`));
  console.log(
    "PASS: actual Pi loader; command/tool registration; concurrent lazy start; read/update/conflict; authenticated HTTP; stop.",
  );
} finally {
  for (const handler of ext.handlers.get("session_shutdown") ?? []) {
    await handler({}, ctx);
    await handler({}, ctx);
  }
}
console.log(
  "PASS: idempotent session_shutdown. No model requests, browser launch, symlinks or configuration writes.",
);
