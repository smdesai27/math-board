/**
 * math-board for pi: a quiet, spatial SVG blackboard beside the pi terminal.
 *
 * `/board` opens a full-window page where diagrams and locally rendered KaTeX
 * equations share one coordinate system. The page is view-only (the learner
 * cannot draw; its Clear and Save buttons are the only writes); the model's
 * tools update the board and named snapshots preserve lesson stages.
 *
 * The page and the model share one board state with a monotonic `revision`.
 * Every mutation carries the revision it was based on; stale mutations are
 * rejected with a conflict (409 over HTTP, isError over tools), so a stale
 * write never overwrites a newer board. SSE updates the browser; the model
 * sees a Clear or a load through board_read (never as an unsolicited turn).
 *
 * The tools themselves (schemas, descriptions, handlers, board_docs text and
 * the board_teaching text) live in tools.mjs, shared with the MCP server
 * (mcp/server.mjs); this file is pi's adapter. It registers them with
 * defineTool and owns what only pi has: lazy activation, `/board`, the
 * board_teaching prompt section and `/board export`.
 *
 * Tools are loaded lazily so an idle board costs the model little per turn:
 * only `board_open` (a small loader) is active at first. The board tools are
 * registered with `deferred` exposure; `board_open` and `/board` activate them
 * with pi.setActiveTools. Long-form reference (artifact formats, SVG rules,
 * plot grammar, animation, chapters, layout, saves) lives in `board_docs`
 * instead of the tool schemas. A constant `board_teaching` system prompt
 * section tells the tutor when and how to use the board: by default inside
 * the learning folder (~/Learn, or $MATH_BOARD_LEARN_DIR) and not in
 * subagents; MATH_BOARD_TEACHING=always|never overrides that.
 *
 * Lifecycle & safety:
 *   - Nothing starts at extension load time. The server starts lazily on the
 *     first `/board` command or model tool call, and stops on `session_shutdown`.
 *   - The server binds to 127.0.0.1 only, requires a per-session bearer token,
 *     validates the Host header (loopback only) and any Origin header.
 *   - Request bodies and scenes are bounded and re-validated. Equations use
 *     KaTeX with trust:false and expansion limits; labels use textContent.
 *   - Saves persist as JSON in the data folder: $MATH_BOARD_DATA_DIR when set
 *     (tests always set it), else .data/ in a checkout, else a per-user folder
 *     (see defaultDataDir in server.mjs).
 *   - `/board export [name]` (export.mjs) writes the running board to
 *     <cwd>/viz/ only when the user types it: never on shutdown, autosave or
 *     from a model tool, and it never starts a board server.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeImport } from "./native-import.mjs";
// Types only: the runtime module is imported below through a version-stamped URL.
import type { BoardServer } from "./server.mjs";

/* ------------------------------------------------------------------ */
/* Learning folder: teaching guidance in the system prompt             */
/* ------------------------------------------------------------------ */

/** A path and, when it exists, its real path (pi resolves session folders through symlinks). */
function forms(dir: string): string[] {
  const resolved = path.resolve(dir);
  try {
    return [...new Set([resolved, realpathSync(resolved)])];
  } catch {
    return [resolved];
  }
}

// The learning folder: $MATH_BOARD_LEARN_DIR (or its older name $PI_LEARN_DIR), else ~/Learn.
const LEARN_DIRS = forms(process.env.MATH_BOARD_LEARN_DIR ?? process.env.PI_LEARN_DIR ?? path.join(homedir(), "Learn"));

function isLearningFolder(cwd: string): boolean {
  return forms(cwd).some((dir) => LEARN_DIRS.some((learn) => dir === learn || dir.startsWith(learn + path.sep)));
}

/**
 * Whether this run gets the board_teaching section. MATH_BOARD_TEACHING=always or never decides;
 * auto (the default) means inside the learning folder and not in a subagent (PI_SUBAGENT_NAME,
 * set by subagent extensions).
 */
function teachingWanted(cwd: string): boolean {
  const mode = (process.env.MATH_BOARD_TEACHING ?? "auto").trim().toLowerCase();
  if (mode === "always") return true;
  if (mode === "never") return false;
  return !process.env.PI_SUBAGENT_NAME && isLearningFolder(cwd);
}
// The section's text is BOARD_TEACHING in tools.mjs, which is also the MCP server's instructions.

/*
 * Pi re-transpiles this file on /reload, but plain .mjs files are loaded by
 * Node's native ESM loader, whose cache cannot be cleared. Importing the server
 * (and export.mjs, tools.mjs) through a URL that encodes the source files' mtimes gives every
 * edited version a fresh module instance (server.mjs and tools.mjs forward the same query to
 * their siblings, so they must all be imported with one stamp: see loadSourceModules).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
// The same list as SOURCE_FILES in server.mjs (index.ts included, so the server's stale-source
// check is re-baselined on every reload); scripts/verify-import.mjs checks that they match.
const SERVER_FILES = ["server.mjs", "snapshot.mjs", "export.mjs", "tools.mjs", "shared/expr.mjs", "shared/svg.mjs", "index.ts"];
/** Import these modules under one version stamp, so tools.mjs gets the same server.mjs instance as this file. */
function loadSourceModules(files: string[]): Promise<any[]> {
  const stamp = Math.max(
    ...SERVER_FILES.map((f) => {
      try {
        return statSync(path.join(HERE, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  return Promise.all(files.map((file) => nativeImport(`${pathToFileURL(path.join(HERE, file)).href}?v=${Math.round(stamp)}`)));
}

export default async function mathBoardExtension(pi: ExtensionAPI) {
  const [
    { BoardServer: BoardServerClass, defaultDataDir, openBrowser },
    { exportLesson, exportNotice },
    { TOOLS, buildSchemas, handlers, openText, viewerCount, staleFiles, BOARD_TEACHING },
  ] = await loadSourceModules(["server.mjs", "export.mjs", "tools.mjs"]);

  /** Warning line when board source files changed after this process loaded them. */
  function staleWarning(): string {
    const stale = staleFiles();
    return stale.length
      ? `WARNING: ${stale.join(", ")} changed on disk after the board server loaded. Ask the user to run /reload or restart pi; new features may be missing.`
      : "";
  }

  /** Lazily-created, session-scoped board server. `null` until first use. */
  let server: BoardServer | null = null;

  async function ensureServer(title?: string): Promise<BoardServer> {
    const s: BoardServer = (server ??= new BoardServerClass({ dataDir: defaultDataDir("pi"), title }));
    try {
      await s.start();
    } catch (error) {
      if (server === s) server = null;
      throw error;
    }
    return s;
  }

  async function stopServer(): Promise<void> {
    const s = server;
    server = null;
    if (s) {
      try {
        await s.stop();
      } catch {
        /* idempotent cleanup */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* Model tools (shared implementation: tools.mjs)                      */
  /* ------------------------------------------------------------------ */

  // Schemas are built with pi's TypeBox, so pi validates arguments against exactly what the model sees.
  const schemas = buildSchemas(Type);
  const meta = (name: string): any => TOOLS.find((t: any) => t.name === name);
  /** What the shared handlers need from pi: the lazy server, the stale-source warning, how to get the URL. */
  const toolContext = { server: () => ensureServer(), staleWarning, openHint: "board_open (or /board open)" };
  const noBrowser = () => process.env.MATH_BOARD_NO_BROWSER === "1";

  /** A board tool with the shared handler; `deferred`, so inactive until board_open or /board activates it. */
  const boardTool = (name: string) => {
    const { label, annotations, description } = meta(name);
    return defineTool({
      name,
      label,
      annotations,
      exposure: "deferred",
      description,
      parameters: schemas[name],
      // The abort signal lets pi cancel a running layout check or snapshot.
      execute: (_toolCallId, params, signal) => handlers[name]({ ...toolContext, signal }, params),
    });
  };

  /* ------------------------------------------------------------------ */
  /* Lazy activation: board_open (and /board) switch the board tools on  */
  /* ------------------------------------------------------------------ */

  /** Every board tool except the loader; registered `deferred`, so inactive until activated. */
  const BOARD_TOOL_NAMES: string[] = TOOLS.map((t: any) => t.name).filter((name: string) => name !== "board_open");

  /**
   * Add the board tools to the active set. Idempotent: does nothing when they are already
   * active (board_open called twice, or after /reload, which keeps the active set). Returns
   * pi's error message instead of throwing, so the board still opens if activation fails.
   */
  function activateBoardTools(): string | undefined {
    try {
      const active = pi.getActiveTools();
      const missing = BOARD_TOOL_NAMES.filter((name) => !active.includes(name));
      if (missing.length) pi.setActiveTools([...active, ...missing]);
      return undefined;
    } catch (err) {
      return String((err as Error)?.message ?? err);
    }
  }

  /**
   * The one code path behind `/board open` and board_open: start the server (shared, lazy),
   * activate the board tools, and open the browser in the TUI only (never with
   * MATH_BOARD_NO_BROWSER=1). With `unlessViewed`, a board that a browser already shows is not
   * opened again.
   */
  async function openBoard(ctx: ExtensionContext, { unlessViewed = false } = {}) {
    const s = await ensureServer();
    const activationError = activateBoardTools();
    const viewed = unlessViewed && viewerCount(s) > 0;
    const opened = ctx.mode === "tui" && !viewed && !noBrowser() ? await openBrowser(s.url) : false;
    ctx.ui.setStatus("math-board", `⬛ 127.0.0.1:${s.port}`);
    return { s, opened, viewed, activationError };
  }

  const openMeta = meta("board_open");
  const boardOpenTool = defineTool({
    name: openMeta.name,
    label: openMeta.label,
    annotations: openMeta.annotations,
    description: openMeta.description,
    parameters: schemas.board_open,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { s, opened, viewed, activationError } = await openBoard(ctx, { unlessViewed: true });
      // The URL (with its token) reaches the model only when no browser shows the board.
      const text = openText({ url: s.url, port: s.port, opened, viewed, activationError, staleWarning: staleWarning(), notices: s.notices() });
      return { content: [{ type: "text", text }], details: { port: s.port, opened, activated: !activationError } };
    },
  });

  /* ------------------------------------------------------------------ */
  /* Slash command                                                        */
  /* ------------------------------------------------------------------ */

  function usage(): string {
    return [
      "Usage: /board [action]",
      "  /board open       open the board in your browser and turn on the board tools (also /board)",
      "  /board clear      clear board (add: equations, scene)",
      "  /board save [n]   persist board to disk (name, default 'default'; words are joined with -)",
      "  /board load [n]   load a saved board",
      "  /board export [n] write the lesson to ./viz/board-<n>-<time>/: board.json, a PNG per chapter, lesson.md",
      "  /board status     show server status",
      "  /board stop       stop the board server",
    ].join("\n");
  }

  pi.registerCommand("board", {
    description:
      "Open the blackboard in your browser (live view of what the model draws)",
    getArgumentCompletions: (prefix) => {
      const all = [
        "open",
        "clear",
        "save",
        "load",
        "export",
        "status",
        "stop",
        "help",
      ];
      const hits = all.filter((a) => a.startsWith(prefix));
      return hits.length ? hits.map((a) => ({ value: a, label: a })) : null;
    },
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      // `/board save my lesson` saves "my-lesson": a save name is one word.
      const nameArg = rest.length ? rest.join("-") : undefined;
      // `/board export Newton's laws` names the export with every word after the verb.
      const exportName = rest.join(" ");

      try {
        switch (verb ?? "open") {
          case "open": {
            const { s, opened, activationError } = await openBoard(ctx);
            ctx.ui.notify(
              opened
                ? `Blackboard opened: ${s.url}`
                : `Open manually: ${s.url}`,
              "info",
            );
            if (activationError)
              ctx.ui.notify(`Board tools not activated: ${activationError}`, "warning");
            return;
          }
          case "clear": {
            if (!server)
              return ctx.ui.notify(
                "No board running — nothing to clear.",
                "info",
              );
            server.clear(rest[0] ? [rest[0]] : ["all"]);
            ctx.ui.notify(`Board cleared (rev ${server.revision}).`, "info");
            return;
          }
          case "save": {
            if (!server)
              return ctx.ui.notify(
                "No board running — use /board first.",
                "info",
              );
            const saved = await server.save(nameArg ?? "default");
            ctx.ui.notify(`Saved "${saved.name}" (${saved.savedAt}).`, "info");
            return;
          }
          case "load": {
            const s = await ensureServer();
            // Compare-and-swap against the revision seen now: an edit that lands
            // while the save file is read makes the load fail instead of clobbering it.
            const { skipped } = await s.load(nameArg ?? "default", s.revision);
            const activationError = activateBoardTools(); // the model can read and continue the loaded lesson
            if (activationError)
              ctx.ui.notify(`Board tools not activated: ${activationError}`, "warning");
            ctx.ui.notify(
              `Loaded "${nameArg ?? "default"}" (rev ${s.revision}). Use /board open to view.${skipped ? `\n  The save had things this board cannot use: ${skipped}.` : ""}`,
              skipped ? "warning" : "info",
            );
            return;
          }
          case "export": {
            // Manual only: this command is the sole caller of exportLesson. It reads the
            // running board and never starts one.
            const s = server;
            if (s?.starting) await s.starting.catch(() => {});
            if (!s?.url) {
              ctx.ui.notify(
                "Board not running, nothing to export (start it with /board or /board load <name>).",
                "info",
              );
              return;
            }
            const board = s.getState();
            const revision = s.revision;
            const result = await exportLesson({
              board,
              revision,
              name: exportName,
              cwd: ctx.cwd,
              // The capture board_snapshot uses: the server's headless page, a board region, a width.
              snapshot: async (opts: { region: { x: number; y: number; w: number; h: number }; width: number }) =>
                (await s.snapshots.capture(opts)).png,
            });
            const changed =
              s.revision !== revision
                ? `\n  The board changed during the export (revision ${revision} -> ${s.revision}); images may show the newer state.`
                : "";
            ctx.ui.notify(exportNotice(result) + changed, result.skipped.length || changed ? "warning" : "info");
            return;
          }
          case "status": {
            if (!server) {
              ctx.ui.notify(
                "Board server: not running (starts on /board, board_open or other board tool use).",
                "info",
              );
              return;
            }
            const notices = server.notices();
            ctx.ui.notify(
              [
                `Board server: running at 127.0.0.1:${server.port} (rev ${server.revision}, started ${server.startedAt}${server.restoredFrom ? `, restored autosave from ${server.restoredFrom}` : ""}, ${server.getState().chapters?.length ?? 0} chapters, ${viewerCount(server)} browser${viewerCount(server) === 1 ? "" : "s"} watching)`,
                `  data folder: ${server.dataDir}`,
                ...notices.map((n: string) => `  ${n}`),
                server.url,
              ].join("\n"),
              notices.length ? "warning" : "info",
            );
            return;
          }
          case "stop": {
            await stopServer();
            ctx.ui.setStatus("math-board", undefined);
            ctx.ui.notify("Board server stopped.", "info");
            return;
          }
          case "help":
            ctx.ui.notify(usage(), "info");
            return;
          default:
            ctx.ui.notify(`Unknown action "${verb}".\n${usage()}`, "warning");
            return;
        }
      } catch (err) {
        ctx.ui.notify(
          `Board error: ${String((err as Error)?.message ?? err)}`,
          "error",
        );
      }
    },
  });

  // board_open is direct, so registering it activates it; the others are `deferred` and stay
  // inactive (not declared to the model) until board_open or /board activates them.
  for (const { name } of TOOLS) pi.registerTool(name === "board_open" ? boardOpenTool : boardTool(name));

  // Inside the learning folder (and not in a subagent), or wherever MATH_BOARD_TEACHING=always,
  // tell the tutor when and how to use the board. Otherwise add nothing. The text is constant,
  // so the cached prompt holds.
  pi.on("before_agent_start", (event, ctx) => {
    if (!teachingWanted(ctx.cwd)) return;
    event.systemPromptOptions.sections.board_teaching = BOARD_TEACHING;
  });

  // Stop the server when the session goes away (quit, reload, switch, fork).
  // Cleanup is idempotent and cheap when nothing is running.
  pi.on("session_shutdown", async () => {
    await stopServer();
  });
}

