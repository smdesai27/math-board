/**
 * MCP server tests (node:test): spawn `node mcp/server.mjs` and drive it with the MCP SDK's
 * Client over the stdio transport, the way Claude Code does. Every server gets a fresh
 * temporary MATH_BOARD_DATA_DIR and MATH_BOARD_NO_BROWSER=1, so nothing touches real saves
 * and no browser window opens. board_snapshot is skipped, with the reason, when no headless
 * browser is available. (That pi's loader reports no warnings is scripts/verify-import.mjs's job.)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { Type } from "typebox";
import { TOOLS, buildSchemas, viewerCount } from "../tools.mjs";
import { BoardServer } from "../server.mjs";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVER = path.join(ROOT, "mcp", "server.mjs");
const TOOL_NAMES = ["board_docs", "board_library", "board_open", "board_read", "board_save", "board_snapshot", "board_update"];
const DOC_TOPICS = ["overview", "workflow", "chapters", "equations", "marks", "plot", "svg", "mermaid", "molecule", "icon", "animation", "layout", "saves"];

const tempDirs = [];
const tempDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "math-board-mcp-test-"));
  tempDirs.push(dir);
  return dir;
};

/** Spawn the server over stdio with its own temporary data dir. */
async function connect() {
  const dataDir = tempDir();
  const env = { ...process.env, MATH_BOARD_DATA_DIR: dataDir, MATH_BOARD_NO_BROWSER: "1" };
  delete env.PI_MATH_BOARD_DATA_DIR;
  const transport = new StdioClientTransport({ command: process.execPath, args: [SERVER], cwd: ROOT, env, stderr: "pipe" });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => (stderr += chunk));
  const client = new Client({ name: "math-board-test", version: "0" });
  await client.connect(transport);
  return { client, transport, pid: transport.pid, dataDir, stderr: () => stderr };
}

const text = (result) => result.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function waitFor(predicate, ms = 5000) {
  const end = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > end) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}
const childPids = (pid) =>
  (spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" }).stdout ?? "").split("\n").filter(Boolean).map(Number);

/** Every subschema of a JSON Schema, with its path. */
function* subschemas(schema, at = "#") {
  if (!schema || typeof schema !== "object") return;
  yield [at, schema];
  for (const key of ["properties", "patternProperties", "$defs"])
    for (const [k, v] of Object.entries(schema[key] ?? {})) yield* subschemas(v, `${at}/${key}/${k}`);
  for (const key of ["anyOf", "oneOf", "allOf", "prefixItems"]) for (const [i, v] of (schema[key] ?? []).entries()) yield* subschemas(v, `${at}/${key}/${i}`);
  for (const key of ["items", "additionalProperties", "not"]) if (schema[key] && typeof schema[key] === "object") yield* subschemas(schema[key], `${at}/${key}`);
}

let s; // the server most tests share
before(async () => {
  s = await connect();
});
after(async () => {
  await s?.client.close().catch(() => {});
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

test("lists the seven board tools with valid JSON Schema 2020-12 inputs", async () => {
  const { tools } = await s.client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), TOOL_NAMES);
  // A strict draft 2020-12 engine (the SDK's bundled Ajv2020): meta-schema valid, no unknown keywords.
  const Ajv2020 = new AjvJsonSchemaValidator().ajv.constructor;
  const ajv = new Ajv2020({ strict: true, allErrors: true });
  for (const tool of tools) {
    assert.ok(tool.description.length > 50, tool.name);
    assert.ok(tool.title, tool.name);
    assert.equal(typeof tool.annotations?.readOnlyHint, "boolean", tool.name);
    assert.equal(tool.inputSchema.type, "object", tool.name);
    assert.equal(ajv.validateSchema(tool.inputSchema), true, `${tool.name}: ${ajv.errorsText(ajv.errors)}`);
    assert.doesNotThrow(() => ajv.compile(tool.inputSchema), tool.name);
    for (const [at, sub] of subschemas(tool.inputSchema)) {
      assert.ok(!Array.isArray(sub.items), `${tool.name} ${at}: tuple-form items (draft-07) is invalid in 2020-12`);
      assert.ok(!Object.keys(sub).some((k) => k.startsWith("~")), `${tool.name} ${at}: TypeBox marker leaked`);
    }
  }
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
  // Exactly the shared definitions pi registers (verify-import checks pi's side against the same),
  // served from mcp/schemas.json, which `npm run build` generates: a stale file fails here.
  const schemas = buildSchemas(Type);
  const shipped = JSON.parse(readFileSync(path.join(ROOT, "mcp", "schemas.json"), "utf8"));
  assert.deepEqual(Object.keys(shipped), TOOLS.map((t) => t.name));
  for (const shared of TOOLS) {
    const published = byName[shared.name];
    assert.equal(published.description, shared.description, shared.name);
    assert.equal(published.title, shared.label, shared.name);
    assert.deepEqual(published.annotations, shared.annotations, shared.name);
    assert.deepEqual(published.inputSchema, JSON.parse(JSON.stringify(schemas[shared.name])), shared.name);
    assert.deepEqual(shipped[shared.name], JSON.parse(JSON.stringify(schemas[shared.name])), `${shared.name}: mcp/schemas.json is stale; run npm run build`);
  }
  assert.deepEqual(byName.board_docs.inputSchema.properties.topic.enum, DOC_TOPICS);
  assert.deepEqual(byName.board_update.inputSchema.required, ["baseRevision"]);
  assert.equal(byName.board_update.inputSchema.additionalProperties, false);
  assert.equal(byName.board_read.annotations.readOnlyHint, true);
  assert.equal(byName.board_update.annotations.destructiveHint, true);
  // The tutor workflow pi puts in its board_teaching section arrives as the server's instructions.
  assert.match(s.client.getInstructions() ?? "", /board_open[\s\S]*step 4, eq2/);
});

let url;
test("board_open starts the board on loopback, opens no browser and returns the URL", async () => {
  const first = await call(s.client, "board_open");
  assert.equal(first.isError, undefined, text(first));
  url = new URL(text(first).match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]{64}/)?.[0] ?? "http://missing");
  assert.match(text(first), /\(not opened automatically; give the learner this URL\)/);
  assert.match(text(first), /board_docs/);
  const second = await call(s.client, "board_open");
  assert.ok(text(second).includes(url.href), "same board on a second call");
  const response = await fetch(`${url.origin}/api/state`, { headers: { Authorization: `Bearer ${url.hash.slice("#token=".length)}` } });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).board.title, "Blackboard");
});

test("board_update with baseRevision round-trips through board_read; stale revisions conflict", async () => {
  const read0 = text(await call(s.client, "board_read"));
  assert.match(read0, /The board is empty\./);
  assert.match(read0, /\nNo browser is showing the board; call board_open\.$/);
  assert.doesNotMatch(read0, /token/);
  const rev = Number(read0.match(/^revision: (\d+)$/m)[1]);
  const update = await call(s.client, "board_update", {
    baseRevision: rev,
    title: "MCP test",
    chapters: [{ op: "add", id: "ke", title: "Kinetic energy" }],
    equations: [{ op: "add", id: "eq1", latex: "E_k = \\tfrac12 mv^2", x: 80, y: 100, chapter: "ke" }],
    scene: { mode: "append", shapes: [{ type: "arrow", id: "v", points: [[200, 400], [420, 300]], chapter: "ke" }] },
    camera: { chapter: "ke" },
    check: false,
  });
  assert.equal(update.isError, undefined, text(update));
  assert.match(text(update), new RegExp(`^Board updated to revision ${rev + 1} \\(was ${rev}\\)\\.`, "m"));
  const read1 = text(await call(s.client, "board_read"));
  assert.match(read1, /^title: MCP test$/m);
  assert.match(read1, /\[ke\] "Kinetic energy" .* <- camera/);
  assert.match(read1, /\[eq1\] equation at \(80,100\) E_k = \\tfrac12 mv\^2 s1/);
  assert.match(read1, /\[v\] arrow bbox \(200,300\)-\(420,400\) s1/);
  assert.match(read1, new RegExp(`^revision: ${rev + 1}$`, "m"));

  const stale = await call(s.client, "board_update", { baseRevision: rev, title: "stale", check: false });
  assert.equal(stale.isError, true);
  assert.match(text(stale), new RegExp(`^Conflict: .*\\nCall board_read again, then re-apply your changes against revision ${rev + 1}\\.`));
  assert.match(text(await call(s.client, "board_read")), /^title: MCP test$/m);

  // Arguments are validated against the published schema before the handler runs.
  const invalid = await call(s.client, "board_update", { baseRevision: -1 });
  assert.equal(invalid.isError, true);
  assert.match(text(invalid), /baseRevision|>= 0/);
  // A misplaced field is an error, never "Board updated" with nothing drawn.
  const misplaced = await call(s.client, "board_update", { baseRevision: rev + 1, shapes: [{ type: "text", text: "x", x: 1, y: 2 }], check: false });
  assert.equal(misplaced.isError, true);
  assert.match(text(misplaced), /shapes|additional/i);
  // Values the schema cannot see are checked by the server, with the field named.
  const coords = await call(s.client, "board_update", { baseRevision: rev + 1, scene: { mode: "append", artifacts: [{ type: "plot", x: "500", functions: [{ expr: "x" }] }] }, check: false });
  assert.equal(coords.isError, true);
  assert.match(text(coords), /scene\.artifacts\[0\]: x must be a number, got "500"/);
  assert.match(text(await call(s.client, "board_read")), new RegExp(`^revision: ${rev + 1}$`, "m"));
});

test("board_docs returns a topic and rejects unknown ones", async () => {
  const plot = await call(s.client, "board_docs", { topic: "plot" });
  assert.equal(plot.isError, undefined);
  assert.ok(text(plot).startsWith("board_docs plot:\n"));
  assert.ok(text(plot).length > 200);
  assert.equal((await call(s.client, "board_docs", { topic: "nope" })).isError, true);
});

test("board_library answers from the offline index", async () => {
  const categories = text(await call(s.client, "board_library"));
  assert.match(categories, /^(Icon categories \(\d+ icons\):|The icon library is not built)/);
});

test("board_save saves to and lists from the temporary data dir, and loads with baseRevision", async () => {
  const name = `mcp-test-${randomBytes(4).toString("hex")}`;
  const saved = await call(s.client, "board_save", { action: "save", name });
  assert.equal(saved.isError, undefined, text(saved));
  const file = path.join(s.dataDir, "saves", `${name}.json`);
  assert.ok(text(saved).includes(`File: ${s.dataDir}/saves/${name}.json`), text(saved));
  assert.equal(JSON.parse(readFileSync(file, "utf8")).board.title, "MCP test");
  assert.equal(existsSync(path.join(ROOT, ".data", "mcp", "saves", `${name}.json`)), false, "not the default data dir");
  assert.equal(existsSync(path.join(ROOT, ".data", "saves", `${name}.json`)), false, "not pi's data dir");
  assert.match(text(await call(s.client, "board_save", { action: "list" })), new RegExp(`^Saved boards: .*\\b${name}\\b`));

  const noRevision = await call(s.client, "board_save", { action: "load", name });
  assert.equal(noRevision.isError, true);
  assert.match(text(noRevision), /supply baseRevision/);
  const rev = Number(text(await call(s.client, "board_read")).match(/^revision: (\d+)$/m)[1]);
  const loaded = await call(s.client, "board_save", { action: "load", name, baseRevision: rev });
  assert.equal(loaded.isError, undefined, text(loaded));
  assert.match(text(loaded), new RegExp(`^Loaded board "${name}" at revision ${rev + 1}\\.\\ntitle: MCP test`));
});

test("board_snapshot returns the PNG as an MCP image block plus the text summary", async (t) => {
  const shot = await call(s.client, "board_snapshot", { chapter: "ke", width: 600 });
  if (shot.isError && /no headless browser available/.test(text(shot))) {
    t.skip(`no headless browser: ${text(shot)}`);
    return;
  }
  assert.equal(shot.isError, undefined, text(shot));
  const [image, summary] = shot.content;
  assert.equal(image.type, "image");
  assert.equal(image.mimeType, "image/png");
  const png = Buffer.from(image.data, "base64");
  assert.ok(png.length > 1000, `${png.length} bytes`);
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(png.readUInt32BE(16), 600, "width");
  assert.equal(summary.type, "text");
  assert.match(summary.text, /^Snapshot of revision \d+ \(board region 0,0 1200x800\)/);
  assert.match(summary.text, /\[eq1\] equation /);
  // The headless page that took the snapshot is no viewer: board_open still offers the URL.
  assert.match(text(await call(s.client, "board_open")), /\(not opened automatically; give the learner this URL\)/);
});

test("board_open counts browsers, not the headless snapshot page, as viewers", async () => {
  // The headless page marks its requests; only its live SSE connection is discounted.
  const dataDir = tempDir();
  const board = new BoardServer({ dataDir, autosave: false });
  await board.start();
  try {
    const sse = (headers = {}) => fetch(`http://127.0.0.1:${board.port}/api/events?token=${board.token}`, { headers });
    assert.equal(viewerCount(board), 0);
    const headless = await sse({ "x-math-board-snapshot": "1" });
    await headless.body.getReader().read();
    assert.equal(board.clients.size, 1);
    assert.equal(viewerCount(board), 0);
    const learner = await sse();
    const reader = learner.body.getReader();
    await reader.read();
    assert.equal(viewerCount(board), 1);
    await reader.cancel();
    assert.ok(await waitFor(() => viewerCount(board) === 0), "a closed tab stops counting");
  } finally {
    await board.stop();
  }
  // Plain objects (as the adapters see them) count unmarked clients.
  assert.equal(viewerCount({ clients: new Set([{ snapshot: true }, {}]) }), 1);
});

test("closing the client stops the board server and flushes autosave into the temporary data dir", async () => {
  const { client, pid, dataDir } = s;
  const children = childPids(pid); // the headless browser, if a snapshot or layout check ran
  await client.close();
  s = null;
  assert.ok(await waitFor(() => !alive(pid)), "server process exits after stdin closes");
  const autosave = JSON.parse(readFileSync(path.join(dataDir, "autosave.json"), "utf8"));
  assert.equal(autosave.board.title, "MCP test");
  await assert.rejects(fetch(`${url.origin}/api/state`), "board server port is closed");
  assert.ok(await waitFor(() => children.every((child) => !alive(child))), `children left: ${children.filter(alive)}`);
});

test("SIGTERM stops the board server cleanly and keeps the last update", async () => {
  const other = await connect();
  try {
    const update = await call(other.client, "board_update", { baseRevision: 0, title: "before SIGTERM", check: false });
    assert.equal(update.isError, undefined, text(update));
    process.kill(other.pid, "SIGTERM"); // within autosave's 400 ms debounce: only stop() writes it
    assert.ok(await waitFor(() => !alive(other.pid)), "server process exits on SIGTERM");
    const autosave = JSON.parse(readFileSync(path.join(other.dataDir, "autosave.json"), "utf8"));
    assert.equal(autosave.board.title, "before SIGTERM");
    assert.doesNotMatch(other.stderr(), /stopping the board server/);
  } finally {
    await other.client.close().catch(() => {});
  }
});
