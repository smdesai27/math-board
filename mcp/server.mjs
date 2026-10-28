#!/usr/bin/env node
/**
 * math-board MCP server: the blackboard's model tools over stdio, for Claude Code and any
 * other MCP client.
 *
 *   npx -y pi-math-board                       (the package's bin)
 *   claude mcp add math-board -- npx -y pi-math-board
 *   claude mcp add math-board -- node /path/to/math-board/mcp/server.mjs   (from a checkout)
 *
 * The tools are the pi extension's tools: tools.mjs is the one implementation (schemas,
 * descriptions, handlers, board_docs text); this file is the MCP adapter, as index.ts is pi's.
 * It is a separate board: this process hosts its own BoardServer (server.mjs), started on
 * the first tool call that needs it, listening on 127.0.0.1 only, with its own data directory.
 *
 * Environment:
 *   MATH_BOARD_DATA_DIR      data folder (also read as PI_MATH_BOARD_DATA_DIR). Default: the mcp/
 *                            subfolder of the board's default data folder (.data/ in a checkout,
 *                            else ~/Library/Application Support/math-board, $XDG_STATE_HOME/math-board
 *                            or %LOCALAPPDATA%\math-board), apart from pi's, so the two never
 *                            overwrite each other's autosave
 *   MATH_BOARD_NO_BROWSER=1  board_open returns the URL without opening a browser
 *
 * stdout carries JSON-RPC only; diagnostics go to stderr. No network beyond 127.0.0.1, no
 * telemetry. When the client disconnects (stdin closes) or on SIGINT, SIGTERM or SIGHUP the
 * board server stops: autosave flushed, headless browser closed, port released.
 *
 * Dependencies: @modelcontextprotocol/server (v2, the SDK's current stable line). The input
 * schemas are mcp/schemas.json, generated from tools.mjs by `npm run build`, so no TypeBox is
 * needed at runtime.
 */

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { BoardServer, defaultDataDir, openBrowser } from "../server.mjs";
import { TOOLS, BOARD_TEACHING, handlers, openText, staleFiles, viewerCount } from "../tools.mjs";

// Anything printed to stdout would corrupt the JSON-RPC stream.
for (const level of ["log", "info", "debug"]) console[level] = (...args) => console.error(...args);

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSION = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;

/** Import a dependency, or exit with what to run when `npm ci` has not installed it. */
async function need(specifier, why) {
  try {
    return await import(specifier);
  } catch (err) {
    if (err?.code !== "ERR_MODULE_NOT_FOUND") throw err;
    console.error(`math-board MCP: cannot load ${specifier} (${why}). Run \`npm ci\` in ${ROOT}.`);
    process.exit(1);
  }
}
const { McpServer, fromJsonSchema } = await need("@modelcontextprotocol/server", "the MCP SDK");
const { serveStdio } = await need("@modelcontextprotocol/server/stdio", "the MCP SDK");

/* ------------------------------------------------------------------ */
/* The board server: one per process, started lazily                   */
/* ------------------------------------------------------------------ */

let board = null;

async function ensureServer() {
  if (!board) board = new BoardServer({ dataDir: defaultDataDir("mcp") });
  const s = board;
  try {
    await s.start();
  } catch (error) {
    if (board === s) board = null;
    throw error;
  }
  return s;
}

const SELF = fileURLToPath(import.meta.url);
const mtime = (file) => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};
const LOADED_STAMP = mtime(SELF);

/** Warning line when board source files changed after this process loaded them (index.ts is pi's, not ours). */
function staleWarning() {
  const stale = [...staleFiles().filter((f) => f !== "index.ts"), ...(mtime(SELF) > LOADED_STAMP + 1 ? ["mcp/server.mjs"] : [])];
  return stale.length
    ? `WARNING: ${stale.join(", ")} changed on disk after this MCP server started. Ask the user to restart it (in Claude Code: /mcp, then reconnect math-board); new features may be silently missing.`
    : "";
}

/** What the shared handlers need: the lazy server, the stale-source warning, how to get the URL. */
const toolContext = { server: ensureServer, staleWarning, openHint: "board_open" };

/**
 * board_open: start the board and show it in the default browser, unless one already shows it.
 * The URL (with its token) goes into the result only when no browser shows the board.
 */
async function boardOpen() {
  const s = await ensureServer();
  const viewed = viewerCount(s) > 0;
  const opened = process.env.MATH_BOARD_NO_BROWSER === "1" || viewed ? false : await openBrowser(s.url);
  return {
    content: [{ type: "text", text: openText({ url: s.url, port: s.port, opened, viewed, staleWarning: staleWarning(), notices: s.notices() }) }],
    details: { port: s.port, opened },
  };
}

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

// The same schemas pi builds with its TypeBox, as plain JSON Schema generated by `npm run build`
// (scripts/build-schemas.mjs). The SDK validates arguments against them (Ajv, draft 2020-12).
let schemas;
try {
  schemas = JSON.parse(readFileSync(path.join(ROOT, "mcp", "schemas.json"), "utf8"));
} catch (err) {
  console.error(`math-board MCP: cannot read mcp/schemas.json (${err?.message ?? err}). Run \`npm run build\` in ${ROOT}.`);
  process.exit(1);
}
const inputSchema = (name) => schemas[name];

/** Run a tool; MCP results carry content and isError (pi's `details` stay local). */
async function callTool(name, params, extra) {
  try {
    // The client's cancellation reaches a running layout check or snapshot.
    const result = name === "board_open" ? await boardOpen() : await handlers[name]({ ...toolContext, signal: extra?.mcpReq?.signal ?? extra?.signal }, params ?? {});
    return result.isError ? { content: result.content, isError: true } : { content: result.content };
  } catch (err) {
    return { content: [{ type: "text", text: String(err?.message ?? err) }], isError: true };
  }
}

/** One McpServer per connection (stdio has one); every instance shares this process's board. */
function createMcpServer() {
  const mcp = new McpServer({ name: "math-board", title: "Math board", version: VERSION }, { instructions: BOARD_TEACHING });
  for (const { name, label, description, annotations } of TOOLS) {
    mcp.registerTool(name, { title: label, description, annotations, inputSchema: fromJsonSchema(inputSchema(name)) }, (params, extra) =>
      callTool(name, params, extra),
    );
  }
  return mcp;
}

/* ------------------------------------------------------------------ */
/* Lifecycle                                                           */
/* ------------------------------------------------------------------ */

let stopping = null;

/** Stop the board server (flushes autosave, closes the headless browser) and exit. Idempotent. */
function shutdown(reason) {
  stopping ??= (async () => {
    setTimeout(() => process.exit(1), 5000).unref(); // never hang on a stuck browser
    try {
      await connection?.close();
    } catch {}
    const s = board;
    board = null;
    try {
      await s?.stop();
    } catch (err) {
      console.error(`math-board MCP: stopping the board server after ${reason}: ${err?.message ?? err}`);
    }
    process.exit(0);
  })();
  return stopping;
}

process.on("unhandledRejection", (err) => console.error("math-board MCP: unhandled rejection:", err));
const connection = serveStdio(createMcpServer, { onerror: (err) => console.error(`math-board MCP: ${err?.message ?? err}`) });
// The client closing our stdin ends the session (the MCP stdio binding): stop the board too.
process.stdin.once("end", () => shutdown("stdin closed"));
process.stdin.once("close", () => shutdown("stdin closed"));
process.stdout.once("error", () => shutdown("stdout error"));
for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) process.once(signal, () => shutdown(signal));
