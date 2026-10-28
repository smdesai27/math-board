/** Exercise the installed Pi loader and an in-process pi session, without credentials, network providers or configuration changes. */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { ROOT as root, isolateDataDir, piHostRoot } from "./lib/pi-host.mjs";
// Isolated data dir: never read or overwrite the user's saves/autosave.
isolateDataDir();
// Isolated learning folder for the board_teaching prompt section. index.ts reads
// MATH_BOARD_LEARN_DIR when it is loaded, so set it first. It is a symlink to the real folder:
// pi resolves session cwds through symlinks, and the rule must still match.
const learnDir = realpathSync(mkdtempSync(path.join(tmpdir(), "math-board-learn-")));
const learnLink = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "math-board-learn-link-"))), "Learn");
symlinkSync(learnDir, learnLink);
process.env.MATH_BOARD_LEARN_DIR = learnLink;
const subagentName = process.env.PI_SUBAGENT_NAME;
const teachingMode = process.env.MATH_BOARD_TEACHING;
delete process.env.PI_SUBAGENT_NAME;
delete process.env.MATH_BOARD_TEACHING;
const host = piHostRoot();
const { loadExtensions } = await import(
  pathToFileURL(path.join(host, "dist/core/extensions/loader.js"))
);
const result = await loadExtensions([path.join(root, "index.ts")], root);
assert.deepEqual(result.errors, []);
assert.deepEqual(result.warnings ?? [], []);
assert.equal(result.extensions.length, 1);
const ext = result.extensions[0];
const BOARD_TOOLS = ["board_docs", "board_library", "board_read", "board_save", "board_snapshot", "board_update"];
assert.deepEqual([...ext.tools.keys()].sort(), [...BOARD_TOOLS, "board_open"].sort());
assert.ok(ext.commands.has("board"));
// /board export is a command only (no model tool), and it completes like the other actions.
const completions = async (prefix) => ((await ext.commands.get("board").getArgumentCompletions(prefix)) ?? []).map((c) => c.value);
assert.ok((await completions("")).includes("export"));
assert.deepEqual(await completions("ex"), ["export"]);
assert.ok(![...ext.tools.keys()].some((name) => /export/.test(name)));
const def = (name) => ext.tools.get(name).definition;
// Per-turn cost budgets in characters (description + JSON schema); README quotes the measured numbers.
const BUDGET = { board_open: 1000, board_update: 9600, total: 12800 };
// index.ts stamps its imports with the same file list the server watches.
const serverModule = await import(pathToFileURL(path.join(root, "server.mjs")).href);
const indexFiles = JSON.parse(readFileSync(path.join(root, "index.ts"), "utf8").match(/const SERVER_FILES = (\[[^\]]*\])/)[1]);
assert.deepEqual(indexFiles, [...serverModule.SOURCE_FILES], "index.ts SERVER_FILES must equal server.mjs SOURCE_FILES");

// Lazy activation. The loader result has no active set (pi's AgentSession activates direct and
// model-only tools on registration), so check the exposure here; the session test below checks
// the real active set.
assert.equal(def("board_open").exposure ?? "direct", "direct");
assert.notEqual(def("board_open").defaultActive, false);
for (const name of BOARD_TOOLS) assert.equal(def(name).exposure, "deferred", `${name} must be deferred`);

// What each tool costs the model per turn: description + JSON schema, in characters.
const size = (name) => def(name).description.length + JSON.stringify(def(name).parameters).length;
const sizes = Object.fromEntries([...ext.tools.keys()].map((name) => [name, size(name)]));
const total = Object.values(sizes).reduce((a, b) => a + b, 0);
assert.ok(def("board_open").description.length <= 300, `board_open description: ${def("board_open").description.length}`);
assert.ok(sizes.board_open < BUDGET.board_open, `board_open: ${sizes.board_open}`);
assert.ok(def("board_update").description.length < 1000, `board_update description: ${def("board_update").description.length}`);
// The target was 6,000, but board_update's schema without any description is about 7,400
// characters and its types are unchanged on purpose (additionalProperties:false on every object
// adds about 500); everything above that floor is guarded here.
assert.ok(sizes.board_update < BUDGET.board_update, `board_update: ${sizes.board_update}`);
assert.ok(total < BUDGET.total, `all board tools: ${total}`);
console.log(`sizes (description + schema): ${JSON.stringify(sizes)}; total ${total}; active before board_open ${sizes.board_open}`);

// One implementation: the MCP server (mcp/server.mjs) serves the same tools from tools.mjs, with
// the schemas `npm run build` wrote to mcp/schemas.json. Names, labels, descriptions, annotations
// and JSON schemas must match what pi registered, so the sizes above are also what an MCP client sees.
const shared = await import(pathToFileURL(path.join(root, "tools.mjs")).href);
const mcpSchemas = JSON.parse(readFileSync(path.join(root, "mcp", "schemas.json"), "utf8"));
assert.deepEqual(shared.TOOLS.map((t) => t.name), [...ext.tools.keys()]);
for (const t of shared.TOOLS) {
  assert.equal(def(t.name).description, t.description, t.name);
  assert.equal(def(t.name).label, t.label, t.name);
  assert.deepEqual(def(t.name).annotations, t.annotations, t.name);
  assert.equal(JSON.stringify(mcpSchemas[t.name]), JSON.stringify(def(t.name).parameters), `${t.name}: mcp/schemas.json differs from pi's schema (run npm run build)`);
}

const notices = [];
const ctx = {
  mode: "json",
  hasUI: false,
  cwd: root,
  ui: { notify: (text, type) => notices.push({ text, type }), setStatus() {} },
};
const tool = (name) => def(name);

// board_docs: every topic returns reference text without starting the server.
const topics = def("board_docs").parameters.properties.topic.enum;
assert.deepEqual(topics, ["overview", "workflow", "chapters", "equations", "marks", "plot", "svg", "mermaid", "molecule", "icon", "animation", "layout", "saves"]);
for (const topic of topics) {
  const r = await tool("board_docs").execute(`docs-${topic}`, { topic }, undefined, undefined, ctx);
  assert.equal(r.content[0].type, "text");
  assert.ok(r.content[0].text.length > 200, `board_docs ${topic} is too short`);
  assert.ok(r.content[0].text.startsWith(`board_docs ${topic}:`));
}
await assert.rejects(tool("board_docs").execute("docs-bad", { topic: "nope" }, undefined, undefined, ctx), /unknown topic/);

// board_teaching: added in the learning folder only (also when it is reached through a symlink),
// never in subagents, and constant; MATH_BOARD_TEACHING=always|never overrides the rule.
const { normalizeBuildSystemPromptOptions, buildSystemPrompt } = await import(
  pathToFileURL(path.join(host, "dist/core/system-prompt.js"))
);
const startRun = async (cwd) => {
  const event = { type: "before_agent_start", messageType: "user", prompt: "explain", systemPromptOptions: normalizeBuildSystemPromptOptions({ cwd }) };
  for (const handler of ext.handlers.get("before_agent_start") ?? []) await handler(event, { ...ctx, cwd });
  return event.systemPromptOptions;
};
const teaching = (await startRun(path.join(learnDir, "linear-algebra"))).sections.board_teaching;
assert.equal(typeof teaching, "string");
const words = teaching.split(/\s+/).filter(Boolean).length;
assert.ok(words >= 150 && words <= 220, `board_teaching has ${words} words`);
for (const name of ["board_open", "board_read", "board_update", "board_docs"]) assert.ok(teaching.includes(name), name);
assert.doesNotMatch(teaching, /\d{1,2}:\d{2}|\/Users\/|\/Volumes\/|~\//); // no clock times or paths
assert.equal((await startRun(learnDir)).sections.board_teaching, teaching); // the folder itself; same text again
assert.match(buildSystemPrompt(await startRun(learnDir)), /<board_teaching>\n[\s\S]*step 4, eq2[\s\S]*\n<\/board_teaching>/);
assert.equal((await startRun(path.join(learnLink, "physics"))).sections.board_teaching, teaching); // through the link
assert.equal((await startRun(root)).sections.board_teaching, undefined);
assert.equal((await startRun(`${learnDir}-other`)).sections.board_teaching, undefined);
process.env.PI_SUBAGENT_NAME = "worker";
assert.equal((await startRun(path.join(learnDir, "linear-algebra"))).sections.board_teaching, undefined);
process.env.MATH_BOARD_TEACHING = "always";
assert.equal((await startRun(root)).sections.board_teaching, teaching, "always: everywhere, subagents too");
delete process.env.PI_SUBAGENT_NAME;
process.env.MATH_BOARD_TEACHING = "never";
assert.equal((await startRun(learnDir)).sections.board_teaching, undefined, "never: not even in the learning folder");
delete process.env.MATH_BOARD_TEACHING;

// The loader alone leaves pi's action methods unbound (they throw), so stand in for the
// session's active tool set.
let active = ["read", "bash", "edit", "write", "board_open"];
let setCalls = 0;
result.runtime.getActiveTools = () => [...active];
result.runtime.setActiveTools = (names) => {
  setCalls++;
  active = [...names];
};
try {
  await ext.commands.get("board").handler("status", ctx);
  assert.match(notices.at(-1).text, /not running/);
  // /board export reads the running board only: with none it says so, starts nothing, writes nothing.
  const exportCwd = mkdtempSync(path.join(tmpdir(), "math-board-export-"));
  await ext.commands.get("board").handler("export Newton", { ...ctx, cwd: exportCwd });
  assert.match(notices.at(-1).text, /^Board not running, nothing to export/);
  assert.equal(existsSync(path.join(exportCwd, "viz")), false);
  await ext.commands.get("board").handler("status", ctx);
  assert.match(notices.at(-1).text, /Board server: not running/);
  await ext.commands.get("board").handler("help", ctx);
  assert.match(notices.at(-1).text, /\/board export \[n\]/);
  // A multi-word save name is one name: `/board save my lesson` saves my-lesson.
  await ext.commands.get("board").handler("open", ctx);
  await ext.commands.get("board").handler("save my lesson", ctx);
  assert.match(notices.at(-1).text, /^Saved "my-lesson"/);
  await ext.commands.get("board").handler("status", ctx);
  assert.match(notices.at(-1).text, /^Board server: running at 127\.0\.0\.1:\d+ .*0 browsers watching\)\n {2}data folder: /);
  await ext.commands.get("board").handler("stop", ctx);
  active = ["read", "bash", "edit", "write", "board_open"];
  setCalls = 0;
  // Two parallel first calls share one lazy server.
  const [a, b] = await Promise.all([
    tool("board_read").execute("a", {}, undefined, undefined, ctx),
    tool("board_read").execute("b", {}, undefined, undefined, ctx),
  ]);
  assert.equal(a.details.revision, 0);
  assert.equal(b.details.revision, 0);
  assert.equal(setCalls, 0); // using a tool does not change the active set
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
  // A misplaced field never reaches the board: pi's argument validation refuses it against the
  // closed schema, and the handler refuses it too when called directly.
  const validationEntry = [path.join(host, "node_modules/@earendil-works/pi-ai/dist/utils/validation.js"), path.join(host, "../pi-ai/dist/utils/validation.js")].find(existsSync);
  if (validationEntry) {
    const { validateToolArguments } = await import(pathToFileURL(validationEntry));
    const piTool = { name: "board_update", description: "", parameters: def("board_update").parameters };
    const args = (a) => ({ type: "toolCall", id: "v", name: "board_update", arguments: a });
    assert.throws(() => validateToolArguments(piTool, args({ baseRevision: 1, shapes: [] })), /shapes|additional/i);
    assert.throws(() => validateToolArguments(piTool, args({ baseRevision: 1, scene: { mode: "append", shapes: [{ type: "text", text: "x", x: 1, y: 2, colour: "red" }] } })), /colour|additional|must match/i);
    validateToolArguments(piTool, args({ baseRevision: 1, equations: [{ op: "add", id: "e", latex: "x" }], scene: { mode: "append", shapes: [{ type: "text", id: "t", text: "x", x: 1, y: 2 }] } }));
  }
  await assert.rejects(tool("board_update").execute("bad", { baseRevision: 1, shapes: [] }, undefined, undefined, ctx), /unknown update field: shapes/);
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
  // /board open activates every board tool, keeping the tools that were active.
  assert.deepEqual(active.slice(0, 5), ["read", "bash", "edit", "write", "board_open"]);
  assert.deepEqual(active.slice(5).sort(), BOARD_TOOLS);
  const response = await fetch(`${url.origin}/api/state`, {
    headers: { Authorization: `Bearer ${url.hash.slice(7)}` },
  });
  assert.equal((await response.json()).board.title, "Loader smoke test");
  await ext.commands.get("board").handler("stop", ctx);
  await assert.rejects(fetch(`${url.origin}/api/state`));

  // board_open: same code path as /board open; idempotent when called again.
  active = ["read", "bash", "edit", "write", "board_open"];
  setCalls = 0;
  const first = await tool("board_open").execute("o1", {}, undefined, undefined, ctx);
  const firstUrl = first.content[0].text.match(/http:\/\/127\.0\.0\.1:\d+\/#token=[a-f0-9]+/)?.[0];
  assert.ok(firstUrl, first.content[0].text);
  assert.match(first.content[0].text, /not opened automatically/); // json mode: no browser
  assert.match(first.content[0].text, /board_docs/);
  assert.deepEqual(active.slice(5).sort(), BOARD_TOOLS);
  assert.equal(setCalls, 1);
  const second = await tool("board_open").execute("o2", {}, undefined, undefined, ctx);
  assert.ok(second.content[0].text.includes(firstUrl)); // same server
  assert.equal(setCalls, 1); // nothing left to activate
  assert.equal(active.length, 11);
  const after = await tool("board_read").execute("o3", {}, undefined, undefined, ctx);
  assert.equal(after.details.board.title, "Loader smoke test"); // restored from autosave
  // If pi refuses the activation, the board still opens and the model is told.
  result.runtime.getActiveTools = () => {
    throw new Error("runtime not ready");
  };
  const refused = await tool("board_open").execute("o4", {}, undefined, undefined, ctx);
  assert.match(refused.content[0].text, /Could not activate the board tools: runtime not ready/);
  assert.ok(refused.content[0].text.includes(firstUrl));
  console.log(
    "PASS: actual Pi loader; command/tool registration; deferred board tools; size budgets; MCP schemas identical to pi's; board_docs topics; board_teaching only in the learning folder; /board export completion and its not-running path; concurrent lazy start; read/update/conflict; authenticated HTTP; stop; board_open and /board open activate the tools idempotently.",
  );
} finally {
  for (const handler of ext.handlers.get("session_shutdown") ?? []) {
    await handler({}, ctx);
    await handler({}, ctx);
  }
}
console.log(
  "PASS: idempotent session_shutdown. No model requests, browser launch or configuration writes (the learning-folder symlink is in a temporary folder).",
);

/*
 * A real pi session (in-process faux model, temporary agent dir, in-memory settings and
 * session, no credentials or network): the first request declares board_open but none of
 * the other board tools and carries <board_teaching>; after the model calls board_open the
 * next request declares them all; /reload keeps them active and they still work.
 */
const sdk = await import(pathToFileURL(path.join(host, "dist/index.js")));
const aiEntry = [path.join(host, "node_modules/@earendil-works/pi-ai/dist/index.js"), path.join(host, "../pi-ai/dist/index.js")].find(existsSync);
const ai = aiEntry ? await import(pathToFileURL(aiEntry)) : {};
if (!sdk.createAgentSession || !sdk.DefaultResourceLoader || !ai.fauxProvider) {
  console.log("SKIP: this pi build has no SDK session or faux provider; session-level activation not checked.");
} else {
  const faux = ai.fauxProvider({ provider: "math-board-faux", models: [{ id: "faux" }] });
  const requests = [];
  const record = (context) => {
    const system = context.messages.filter((m) => m.role === "system");
    const tools = new Map();
    for (const m of system) {
      for (const t of m.toolsAdded ?? []) tools.set(t.name, t);
      for (const t of m.toolsRemoved ?? []) tools.delete(t.name);
    }
    const board = [...tools.values()].filter((t) => t.name.startsWith("board_"));
    requests.push({
      tools: [...tools.keys()],
      boardChars: board.reduce((n, t) => n + t.description.length + JSON.stringify(t.parameters).length, 0),
      teaching: system.some((m) => m.sections && typeof m.sections.board_teaching === "string"),
    });
  };
  faux.setResponses([
    (context) => {
      record(context);
      return ai.fauxAssistantMessage(ai.fauxToolCall("board_open", {}), { stopReason: "toolUse" });
    },
    (context) => {
      record(context);
      return ai.fauxAssistantMessage("Drawn.");
    },
  ]);
  const agentDir = mkdtempSync(path.join(tmpdir(), "math-board-agent-"));
  const cwd = path.join(learnDir, "physics");
  mkdirSync(cwd);
  const settingsManager = sdk.SettingsManager.inMemory();
  const resourceLoader = new sdk.DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    additionalExtensionPaths: [path.join(root, "index.ts")],
    extensionFactories: [(pi) => pi.registerProvider(faux.provider)],
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
  });
  await resourceLoader.reload();
  assert.deepEqual(resourceLoader.getExtensions().errors, []);
  const { session } = await sdk.createAgentSession({
    cwd,
    agentDir,
    resourceLoader,
    settingsManager,
    sessionManager: sdk.SessionManager.inMemory(cwd),
    model: faux.getModel(),
  });
  try {
    const boardActive = () => session.getActiveToolNames().filter((n) => n.startsWith("board_")).sort();
    assert.deepEqual(boardActive(), ["board_open"]);
    await session.prompt("Explain vectors on the board.");
    assert.equal(requests.length, 2);
    assert.deepEqual(requests[0].tools.filter((n) => n.startsWith("board_")), ["board_open"]);
    assert.ok(requests[0].boardChars < BUDGET.board_open, `board tools declared before board_open: ${requests[0].boardChars}`);
    assert.equal(requests[0].teaching, true);
    assert.deepEqual(requests[1].tools.filter((n) => n.startsWith("board_")).sort(), [...BOARD_TOOLS, "board_open"].sort());
    assert.ok(requests[1].boardChars < BUDGET.total, `board tools declared after board_open: ${requests[1].boardChars}`);
    assert.equal(requests[1].boardChars, total, "pi declares exactly the measured tools");
    assert.deepEqual(boardActive(), [...BOARD_TOOLS, "board_open"].sort());
    // /reload re-registers the tools; the active set survives and the tools still work.
    await session.reload();
    assert.deepEqual(boardActive(), [...BOARD_TOOLS, "board_open"].sort());
    const read = session.agent.state.tools.find((t) => t.name === "board_read");
    assert.match((await read.execute("r1", {})).content[0].text, /revision: \d+/);
    const reopen = session.agent.state.tools.find((t) => t.name === "board_open");
    assert.match((await reopen.execute("r2", {})).content[0].text, /Board tools are active/);
    assert.deepEqual(boardActive(), [...BOARD_TOOLS, "board_open"].sort());
    console.log(
      `PASS: real pi session: declared board tools ${requests[0].boardChars} chars before board_open, ${requests[1].boardChars} after; board_teaching sent; activation survives /reload.`,
    );
  } finally {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
}
/*
 * Installed as a package (`pi install <folder>` adds it to the settings' packages), pi also checks
 * package.json: host-provided packages (typebox, pi-ai, ...) listed in `dependencies` give an
 * extension warning (this package has none: the MCP server's schemas are prebuilt JSON). Load this
 * folder the way an install does and expect no warnings; a stand-in package with typebox in
 * `dependencies` shows that the check is live.
 */
if (!sdk.DefaultResourceLoader || !sdk.SettingsManager?.inMemory) {
  console.log("SKIP: this pi build has no DefaultResourceLoader; package manifest warnings not checked.");
} else {
  const loadPackage = async (dir) => {
    const loader = new sdk.DefaultResourceLoader({
      cwd: dir,
      agentDir: mkdtempSync(path.join(tmpdir(), "math-board-agent-")),
      settingsManager: sdk.SettingsManager.inMemory({ packages: [dir] }),
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
    });
    await loader.reload();
    return loader.getExtensions();
  };
  const installed = await loadPackage(root);
  assert.deepEqual(installed.errors, []);
  assert.deepEqual(installed.warnings ?? [], []);
  assert.deepEqual(installed.extensions.map((e) => e.path), [path.join(root, "index.ts")]);
  const control = mkdtempSync(path.join(tmpdir(), "math-board-control-"));
  writeFileSync(path.join(control, "package.json"), JSON.stringify({ name: "control", type: "module", pi: { extensions: ["./ext.mjs"] }, dependencies: { typebox: "*" } }));
  writeFileSync(path.join(control, "ext.mjs"), "export default function () {}\n");
  const warned = await loadPackage(control);
  assert.equal(warned.warnings?.length, 1);
  assert.match(warned.warnings[0].warning, /not dependencies: typebox/);
  console.log("PASS: installed as a package, pi reports no manifest warnings (a control package with typebox in dependencies does warn).");
}
if (subagentName !== undefined) process.env.PI_SUBAGENT_NAME = subagentName;
if (teachingMode !== undefined) process.env.MATH_BOARD_TEACHING = teachingMode;
