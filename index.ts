/**
 * math-board for pi: a quiet, spatial SVG blackboard beside the pi terminal.
 *
 * `/board` opens a full-window page where diagrams and locally rendered KaTeX
 * equations share one coordinate system. The page is view-only (the learner
 * cannot draw; its New board, Clear and Save buttons are the only writes); the model's
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
 *   - Nothing starts at extension load time. On the first `/board` command or model
 *     tool call this session joins the board another session hosts on the same data
 *     folder, or hosts it (attach.mjs); a board hosted here stops on `session_shutdown`.
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
import type { BoardLink } from "./attach.mjs";

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
const SERVER_FILES = ["server.mjs", "snapshot.mjs", "export.mjs", "tools.mjs", "attach.mjs", "shared/expr.mjs", "shared/svg.mjs", "index.ts"];
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
    { defaultDataDir, openBrowser },
    { exportLesson, exportNotice },
    { TOOLS, buildSchemas, openText, staleFiles, BOARD_TEACHING },
    { BoardLink: BoardLinkClass },
  ] = await loadSourceModules(["server.mjs", "export.mjs", "tools.mjs", "attach.mjs"]);

  /** Warning line when board source files changed after this process loaded them. */
  function staleWarning(): string {
    const stale = staleFiles();
    return stale.length
      ? `WARNING: ${stale.join(", ")} changed on disk after the board server loaded. Ask the user to run /reload or restart pi; new features may be missing.`
      : "";
  }

  /**
   * This session's link to the board: nothing runs until first use; then it hosts the board or
   * joins the session that does (attach.mjs).
   */
  const link: BoardLink = new BoardLinkClass({
    dataDir: defaultDataDir(),
    context: { staleWarning, openHint: "board_open (or /board open)" },
  });

  /** Stop the board if this session hosts it. False when another session does. */
  async function stopServer(): Promise<boolean> {
    try {
      return await link.stop();
    } catch {
      return true; /* idempotent cleanup */
    }
  }

  /* ------------------------------------------------------------------ */
  /* Model tools (shared implementation: tools.mjs)                      */
  /* ------------------------------------------------------------------ */

  // Schemas are built with pi's TypeBox, so pi validates arguments against exactly what the model sees.
  const schemas = buildSchemas(Type);
  const meta = (name: string): any => TOOLS.find((t: any) => t.name === name);
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
      execute: (_toolCallId, params, signal) => link.call(name, params, signal),
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
   * The one code path behind `/board open` and board_open: host or join the board (lazy),
   * activate the board tools, and open the browser in the TUI only (never with
   * MATH_BOARD_NO_BROWSER=1). With `unlessViewed`, a board that a browser already shows is not
   * opened again.
   */
  async function openBoard(ctx: ExtensionContext, { unlessViewed = false } = {}) {
    const status = await link.status({ warm: true });
    const activationError = activateBoardTools();
    const viewed = unlessViewed && status.viewers > 0;
    const opened = ctx.mode === "tui" && !viewed && !noBrowser() ? await openBrowser(link.url) : false;
    ctx.ui.setStatus("math-board", `⬛ 127.0.0.1:${link.port}`);
    return { status, opened, viewed, activationError };
  }

  const openMeta = meta("board_open");
  const boardOpenTool = defineTool({
    name: openMeta.name,
    label: openMeta.label,
    annotations: openMeta.annotations,
    description: openMeta.description,
    parameters: schemas.board_open,
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { status, opened, viewed, activationError } = await openBoard(ctx, { unlessViewed: true });
      // The URL (with its token) reaches the model only when no browser shows the board.
      const text = openText({ url: link.url, port: link.port, opened, viewed, activationError, staleWarning: staleWarning(), notices: status.notices });
      return { content: [{ type: "text", text }], details: { port: link.port, opened, activated: !activationError } };
    },
  });

  /* ------------------------------------------------------------------ */
  /* Slash command                                                        */
  /* ------------------------------------------------------------------ */

  function usage(): string {
    return [
      "Usage: /board [action]",
      "  /board open       open the board in your browser and turn on the board tools (also /board)",
      "  /board new        save this board under its title and date, then start an empty one",
      "  /board clear      clear board (add: equations, scene)",
      "  /board save [n]   persist board to disk (name, default 'default'; words are joined with -)",
      "  /board load [n]   load a saved board",
      "  /board export [n] write the lesson to ./viz/board-<n>-<time>/: board.json, a PNG per chapter, lesson.md",
      "  /board status     show server status",
      "  /board stop       stop the board server (when this session hosts it)",
    ].join("\n");
  }

  pi.registerCommand("board", {
    description:
      "Open the blackboard in your browser (live view of what the model draws)",
    getArgumentCompletions: (prefix) => {
      const all = [
        "open",
        "new",
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
            const { opened, activationError } = await openBoard(ctx);
            ctx.ui.notify(
              opened
                ? `Blackboard opened: ${link.url}`
                : `Open manually: ${link.url}`,
              "info",
            );
            if (activationError)
              ctx.ui.notify(`Board tools not activated: ${activationError}`, "warning");
            return;
          }
          case "new": {
            if (!(await link.find()))
              return ctx.ui.notify("No board running — /board opens an empty one.", "info");
            const { saved, revision } = await link.fresh();
            ctx.ui.notify(saved ? `Saved the board as "${saved}" (/board load ${saved} brings it back). New board (rev ${revision}).` : "The board is already empty.", "info");
            return;
          }
          case "clear": {
            // A board another session hosts counts as running: find() joins it, and never starts one.
            if (!(await link.find()))
              return ctx.ui.notify(
                "No board running — nothing to clear.",
                "info",
              );
            const revision = await link.clear(rest[0] ? [rest[0]] : ["all"]);
            ctx.ui.notify(`Board cleared (rev ${revision}).`, "info");
            return;
          }
          case "save": {
            if (!(await link.find()))
              return ctx.ui.notify(
                "No board running — use /board first.",
                "info",
              );
            const saved = await link.save(nameArg ?? "default");
            ctx.ui.notify(`Saved "${saved.name}" (${saved.savedAt}).`, "info");
            return;
          }
          case "load": {
            // Compare-and-swap against the revision seen now: an edit that lands
            // while the save file is read makes the load fail instead of clobbering it.
            const { skipped, revision } = await link.load(nameArg ?? "default");
            const activationError = activateBoardTools(); // the model can read and continue the loaded lesson
            if (activationError)
              ctx.ui.notify(`Board tools not activated: ${activationError}`, "warning");
            ctx.ui.notify(
              `Loaded "${nameArg ?? "default"}" (rev ${revision}). Use /board open to view.${skipped ? `\n  The save had things this board cannot use: ${skipped}.` : ""}`,
              skipped ? "warning" : "info",
            );
            return;
          }
          case "export": {
            // Manual only: this command is the sole caller of exportLesson. It reads the
            // running board and never starts one.
            if (!(await link.find())) {
              ctx.ui.notify(
                "Board not running, nothing to export (start it with /board or /board load <name>).",
                "info",
              );
              return;
            }
            const { board, revision } = await link.state();
            const result = await exportLesson({
              board,
              revision,
              name: exportName,
              cwd: ctx.cwd,
              // The capture board_snapshot uses: the board's headless page, a board region, a width.
              snapshot: (opts: { region: { x: number; y: number; w: number; h: number }; width: number }) => link.capture(opts),
            });
            const now = (await link.status()).revision;
            const changed =
              now !== revision
                ? `\n  The board changed during the export (revision ${revision} -> ${now}); images may show the newer state.`
                : "";
            ctx.ui.notify(exportNotice(result) + changed, result.skipped.length || changed ? "warning" : "info");
            return;
          }
          case "status": {
            if (!(await link.find())) {
              ctx.ui.notify(
                "Board server: not running (starts on /board, board_open or other board tool use).",
                "info",
              );
              return;
            }
            const st = await link.status();
            ctx.ui.notify(
              [
                `Board server: running at 127.0.0.1:${st.port} (rev ${st.revision}, started ${st.startedAt}${st.restoredFrom ? `, restored autosave from ${st.restoredFrom}` : ""}, ${st.chapters} chapters, ${st.viewers} browser${st.viewers === 1 ? "" : "s"} watching)`,
                ...(link.hosting ? [] : [`  hosted by another session (process ${st.pid}); this one joined it`]),
                `  data folder: ${st.dataDir}`,
                `  html artifacts: ${st.html ? "on (MATH_BOARD_HTML=1)" : `off (start ${link.hosting ? "pi" : "the hosting session"} with MATH_BOARD_HTML=1 to allow them)`}`,
                ...st.notices.map((n: string) => `  ${n}`),
                link.url,
              ].join("\n"),
              st.notices.length ? "warning" : "info",
            );
            return;
          }
          case "stop": {
            const pid = link.hosting ? null : (link as any).remote?.pid;
            const mine = await stopServer();
            ctx.ui.setStatus("math-board", undefined);
            ctx.ui.notify(mine ? "Board server stopped." : `Left the board. Another session (process ${pid}) hosts it, so it keeps running.`, "info");
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

  // Stop a board hosted here when the session goes away (quit, reload, switch, fork).
  // Cleanup is idempotent and cheap when nothing is running.
  pi.on("session_shutdown", async () => {
    await stopServer();
  });
}

