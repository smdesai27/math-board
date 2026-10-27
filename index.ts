/**
 * Pi Math Board — a quiet, spatial SVG blackboard beside the Pi terminal.
 *
 * `/board` opens a full-window surface where diagrams and locally rendered
 * KaTeX equations share one coordinate system. Browser rendering is view-only;
 * Pi model tools update the board and named snapshots preserve lesson stages.
 *
 * Both the browser and the model share one board state with a monotonic
 * `revision`. Every mutation carries the revision it was based on; stale
 * mutations are rejected with a conflict (409 over HTTP, isError over tools)
 * so stale writes cannot silently overwrite edits. SSE updates the browser;
 * the model observes browser edits through board_read (not unsolicited turns).
 *
 * Lifecycle & safety:
 *   - Nothing starts at extension load time. The server starts lazily on the
 *     first `/board` command or model tool call, and stops on `session_shutdown`.
 *   - The server binds to 127.0.0.1 only, requires a per-session bearer token,
 *     validates the Host header (loopback only) and any Origin header.
 *   - Request bodies and scenes are bounded and re-validated. Equations use
 *     KaTeX with trust:false and expansion limits; labels use textContent.
 *   - Saves persist as JSON under ~/.pi/agent/extensions/math-board/.data/.
 */

import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeImport } from "./native-import.mjs";

/*
 * Pi re-transpiles this file on /reload, but plain .mjs files are loaded by
 * Node's native ESM loader, whose cache cannot be cleared. Importing the server
 * through a URL that encodes the source files' mtimes gives every edited version
 * a fresh module instance (server.mjs forwards the same query to its siblings).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
// index.ts is included so the server's stale-source check is re-baselined on every reload.
const SERVER_FILES = ["server.mjs", "scene.mjs", "snapshot.mjs", "shared/expr.mjs", "index.ts"];
function loadServerModule(): Promise<any> {
  const stamp = Math.max(
    ...SERVER_FILES.map((f) => {
      try {
        return statSync(path.join(HERE, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  const url = `${pathToFileURL(path.join(HERE, "server.mjs")).href}?v=${Math.round(stamp)}`;
  return nativeImport(url);
}

export default async function mathBoardExtension(pi: ExtensionAPI) {
  const { BoardServer, defaultDataDir, openBrowser, sanitizeShape, staleSources, cameraRect, searchIcons, iconIndex } =
    await loadServerModule();

/** Warning line when board source files changed after this process loaded them. */
function staleWarning(): string {
  const stale = staleSources();
  return stale.length
    ? `WARNING: ${stale.join(", ")} changed on disk after the board server loaded. Ask the user to run /reload or restart pi; new features may be silently missing.`
    : "";
}

  /** Lazily-created, session-scoped board server. `null` until first use. */
  let server: BoardServer | null = null;

  async function ensureServer(title?: string): Promise<BoardServer> {
    if (!server) {
      server = new BoardServer({ dataDir: defaultDataDir(), title });
    }
    const s = server;
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
  /* Model tools                                                         */
  /* ------------------------------------------------------------------ */

  const EquationOpSchema = Type.Union([
    Type.Object({
      op: Type.Literal("add"),
      latex: Type.String({
        description: "KaTeX/LaTeX source, e.g. \\int_0^1 x^2\\,dx",
      }),
      label: Type.Optional(
        Type.String({
          description: "Short human label shown above the equation",
        }),
      ),
      x: Type.Optional(Type.Number({ description: "Board-space x of the equation box's top-left corner; default layout if omitted" })),
      y: Type.Optional(Type.Number({ description: "Board-space y of the equation box's top-left corner (label sits above the formula); default layout if omitted" })),
      color: Type.Optional(Type.String({ description: "CSS color for the formula, e.g. #f2c14e" })),
      size: Type.Optional(Type.Number({ description: "Font scale, 1 = default (~27px), range 0.3-4" })),
      z: Type.Optional(Type.Number({ description: "Layer order (default 0)" })),
      chapter: Type.Optional(Type.String({ description: "Chapter id: x/y become chapter-local" })),
      step: Type.Optional(Type.Integer({ minimum: 0, description: "Lesson step that reveals this item (default: the next step, one per board_update). Use lastStep+1, +2… to split one update into several click-steps" })),
      reveal: Type.Optional(Type.Union([Type.Literal("draw"), Type.Literal("write"), Type.Literal("wipe"), Type.Literal("fade"), Type.Literal("none")], { description: "How it appears: draw = traced like handwriting (default for lines/shapes), write = left-to-right (text/equations), wipe = sweep (diagrams), fade, none" })),
      duration: Type.Optional(Type.Number({ description: "Reveal duration in ms (default from size)" })),
      order: Type.Optional(Type.Number({ description: "Order within its step (default: diagrams, then marks, then text/equations, in given order)" })),

    }),
    Type.Object({
      op: Type.Literal("update"),
      id: Type.String({
        description: "Id of the equation to update (from board_read)",
      }),
      latex: Type.Optional(Type.String({ description: "New LaTeX source" })),
      label: Type.Optional(Type.String({ description: "New label" })),
      x: Type.Optional(Type.Number({ description: "Board-space x position; default layout if omitted" })),
      y: Type.Optional(Type.Number({ description: "Board-space y position; default layout if omitted" })),
      color: Type.Optional(Type.String({ description: "CSS color for the formula" })),
      size: Type.Optional(Type.Number({ description: "Font scale, 1 = default" })),
    }),
    Type.Object({
      op: Type.Literal("delete"),
      id: Type.String({ description: "Id of the equation to delete" }),
    }),
  ]);

  // [x, y] as a fixed-length array, not Type.Tuple: TypeBox emits the draft-07
  // tuple form (`items: [...]`), which Anthropic rejects as invalid 2020-12.
  const PointSchema = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });

  // Styling shared by every shape kind.
  const Style = {
    z: Type.Optional(Type.Number({ description: "Layer order across all items (default 0; higher draws on top)" })),
    opacity: Type.Optional(Type.Number({ description: "0-1" })),
    dash: Type.Optional(Type.String({ description: "Stroke dash pattern, e.g. '6 4' (not for text)" })),
    chapter: Type.Optional(Type.String({ description: "Chapter id: coordinates become relative to that chapter's top-left (its local 1200x800 space)" })),
    step: Type.Optional(Type.Integer({ minimum: 0, description: "Lesson step that reveals this item (default: the next step, one per board_update). Use lastStep+1, +2… to split one update into several click-steps" })),
    reveal: Type.Optional(Type.Union([Type.Literal("draw"), Type.Literal("write"), Type.Literal("wipe"), Type.Literal("fade"), Type.Literal("none")], { description: "How it appears: draw = traced like handwriting (default for lines/shapes), write = left-to-right (text/equations), wipe = sweep (diagrams), fade, none" })),
    duration: Type.Optional(Type.Number({ description: "Reveal duration in ms (default from size)" })),
    order: Type.Optional(Type.Number({ description: "Order within its step (default: diagrams, then marks, then text/equations, in given order)" })),
  };

  const ShapeSchema = Type.Union([
    Type.Object({
      type: Type.Literal("stroke"),
      ...Style,
      points: Type.Array(PointSchema, {
        minItems: 2,
        description:
          "Freehand polyline points in board pixel coordinates [x, y]",
      }),
      color: Type.Optional(
        Type.String({ description: "CSS color, e.g. #e8e3d9" }),
      ),
      width: Type.Optional(
        Type.Number({ description: "Stroke width in px (default 3)" }),
      ),
    }),
    Type.Object({
      type: Type.Literal("rect"),
      ...Style,
      x: Type.Number(),
      y: Type.Number(),
      w: Type.Number(),
      h: Type.Number(),
      color: Type.Optional(Type.String({ description: "Stroke color" })),
      fill: Type.Optional(Type.String({ description: "Fill color (default none)" })),
    }),
    Type.Object({
      type: Type.Literal("ellipse"),
      ...Style,
      x: Type.Number({ description: "Bounding box left" }),
      y: Type.Number({ description: "Bounding box top" }),
      w: Type.Number(),
      h: Type.Number(),
      color: Type.Optional(Type.String({ description: "Stroke color" })),
      fill: Type.Optional(Type.String({ description: "Fill color (default none)" })),
    }),
    Type.Object({
      type: Type.Literal("line"),
      ...Style,
      points: Type.Array(PointSchema, {
        minItems: 2,
      }),
      color: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
    }),
    Type.Object({
      type: Type.Literal("arrow"),
      ...Style,
      points: Type.Array(PointSchema, {
        minItems: 2,
        maxItems: 4,
        description: "Arrow points; the last segment gets the arrowhead",
      }),
      color: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
    }),
    Type.Object({
      type: Type.Literal("text"),
      ...Style,
      text: Type.String({
        description: "Plain text label (rendered as glyphs, never HTML)",
      }),
      x: Type.Number({ description: "Left edge of the text" }),
      y: Type.Number({ description: "Text baseline (not the top)" }),
      size: Type.Optional(
        Type.Number({ description: "Font size in px (default 24)" }),
      ),
      font: Type.Optional(Type.Union([Type.Literal("serif"), Type.Literal("sans"), Type.Literal("mono")], { description: "serif = LaTeX Computer Modern look (default)" })),
      anchor: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("middle"), Type.Literal("end")], { description: "Horizontal alignment at x" })),
      bold: Type.Optional(Type.Boolean()),
      italic: Type.Optional(Type.Boolean()),
      color: Type.Optional(Type.String()),
    }),
  ]);

  const ItemOpSchema = Type.Union([
    Type.Object({
      op: Type.Literal("update"),
      id: Type.String({ description: "Any item id (shape, artifact or equation) from board_read" }),
      fields: Type.Record(Type.String(), Type.Unknown(), { description: "Fields to change, e.g. {color:'#f2c14e'}, {x:10,y:20}, {z:5}, {source:'<svg…'}, {latex:'…'}. Type cannot change." }),
    }),
    Type.Object({
      op: Type.Literal("move"),
      id: Type.String(),
      dx: Type.Number(),
      dy: Type.Number(),
    }),
    Type.Object({ op: Type.Literal("delete"), id: Type.String() }),
  ]);

  const BoardUpdateSchema = Type.Object({
    baseRevision: Type.Integer({
      minimum: 0,
      description:
        "Required revision from board_read. Re-read on conflict; never blindly retry a stale replacement.",
    }),
    title: Type.Optional(
      Type.String({
        description: "New board title shown in the browser header",
      }),
    ),
    clear: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Literal("equations"),
          Type.Literal("scene"),
          Type.Literal("all"),
        ]),
        {
          description:
            "Clear these parts of the board before applying other operations",
        },
      ),
    ),
    equations: Type.Optional(
      Type.Array(EquationOpSchema, {
        description: "Ordered equation operations",
      }),
    ),
    chapters: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object({
            op: Type.Literal("add"),
            id: Type.String({ description: "Short stable id, e.g. 'forces'" }),
            title: Type.String(),
            x: Type.Optional(Type.Number({ description: "Board-space origin; omit to auto-place right of the last chapter" })),
            y: Type.Optional(Type.Number()),
            w: Type.Optional(Type.Number({ description: "Default 1200" })),
            h: Type.Optional(Type.Number({ description: "Default 800" })),
            frame: Type.Optional(Type.Boolean({ description: "Draw the faint frame + title (default true)" })),
          }),
          Type.Object({ op: Type.Literal("update"), id: Type.String(), title: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), w: Type.Optional(Type.Number()), h: Type.Optional(Type.Number()), frame: Type.Optional(Type.Boolean()) }),
          Type.Object({ op: Type.Literal("delete"), id: Type.String(), keepItems: Type.Optional(Type.Boolean({ description: "Keep the chapter's items (as free items) instead of erasing them" })) }),
        ]),
        { description: "Chapter (board region) ops, applied before equations/scene so new items can reference new chapters" },
      ),
    ),
    camera: Type.Optional(
      Type.Union([
        Type.Object({ chapter: Type.String() }),
        Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }),
        Type.Null(),
      ], { description: "Move the viewer's camera (smooth pan/zoom): {chapter} to show a chapter, a board-space rect to focus a detail, null for home" }),
    ),
    items: Type.Optional(
      Type.Array(ItemOpSchema, {
        description: "Edit any existing item by id (applied after equations and scene): update fields, move by dx/dy, or delete",
      }),
    ),
    check: Type.Optional(
      Type.Boolean({ description: "Measure the rendered layout afterwards and report overlaps/off-board items (default true)" }),
    ),
    scene: Type.Optional(
      Type.Object({
        mode: Type.Union([Type.Literal("append"), Type.Literal("replace")], {
          description:
            "append: add shapes to the scene; replace: swap the whole scene",
        }),
        shapes: Type.Optional(
          Type.Array(ShapeSchema, {
            maxItems: 2000,
            description:
              "Simple vector marks drawn directly on the board",
          }),
        ),
        elements: Type.Optional(
          Type.Array(Type.Record(Type.String(), Type.Unknown()), {
            maxItems: 2000,
            description:
              "Legacy Excalidraw elements (older saves only). Prefer shapes or SVG artifacts.",
          }),
        ),
        artifacts: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 100, description: "Positioned visuals {type,x,y,width,height,label?}. type 'svg' + source: a full <svg> document (viewBox recommended; markers, gradients, symbols/use, <style> CSS, SMIL animate/animateTransform allowed; no scripts, no external URLs, no foreignObject/image; url()/href must be #id). type 'mermaid' + source: Mermaid diagram text (flowchart, sequence, class, state, ER, gantt, mindmap, timeline, graphs/networks auto-laid out). type 'plot': function graphs drawn as traceable curves: xRange [a,b], yRange? (auto), functions [{expr:'sin(x)', label?, color?, dash?, width?, domain?}], parametric [{x:'cos(t)', y:'sin(t)', t:[0,6.28]}], areas [{expr, from, to, lower?}], points [{x,y,label?}], vlines/hlines [{x}|{y}], xLabel, yLabel, title, grid/axes/ticks (default true), equalAspect; expressions use + - * / ^, implicit multiplication, pi, e and functions sin cos tan exp ln log sqrt abs min max etc. type 'molecule' + smiles: 2D chemical structure (e.g. 'CC(=O)Oc1ccccc1C(=O)O'). type 'icon' + icon: id from board_library (anatomy, cells, microbes, lab equipment...), give width or height to keep its aspect; card:true puts it on a light panel (use for dark/detailed drawings). Optional on all: chapter, z, opacity, label, step, reveal (svg/mermaid/icon default wipe, plot default draw), duration, order." })),
      }),
    ),
  });

  /**
   * Text summary for the model. With chapters, prints a table of contents and
   * the detailed layout of one chapter only (focus; default = camera chapter),
   * so long lessons do not flood the context. focus "all" lists everything.
   */
  function summarizeBoard(board: any, focus?: string): string {
    const chapters = (board?.chapters ?? []) as any[];
    const all = [
      ...((board?.scene?.artifacts ?? []) as any[]).map((it) => ({ ...it, _kind: "artifact" })),
      ...((board?.equations ?? []) as any[]).map((it, i) => ({ ...it, _kind: "equation", _index: i })),
      ...((board?.scene?.shapes ?? []) as any[]).map((it) => ({ ...it, _kind: "shape" })),
    ];
    const camChapter = board?.camera?.chapter as string | undefined;
    const f = focus ?? (chapters.length ? camChapter ?? chapters[chapters.length - 1]?.id : "all");
    const lines: string[] = [`title: ${board?.title ?? ""}`];
    if (chapters.length) {
      lines.push(`chapters (${chapters.length}); items with a chapter use chapter-local coordinates:`);
      for (const c of chapters) {
        const n = all.filter((it) => it.chapter === c.id).length;
        lines.push(`  [${c.id}] "${c.title}" at (${Math.round(c.x)},${Math.round(c.y)}) ${Math.round(c.w)}x${Math.round(c.h)} · ${n} items${c.id === camChapter ? "  <- camera" : ""}`);
      }
      const free = all.filter((it) => !it.chapter).length;
      if (free) lines.push(`  (${free} free items outside chapters, board coordinates)`);
    }
    const cam = board?.camera;
    if (board?.lastStep) lines.push(`steps: ${board.lastStep} (the next board_update adds step ${board.lastStep + 1})`);
    lines.push(`camera: ${cam ? (cam.chapter ? `chapter ${cam.chapter}` : `rect ${Math.round(cam.x)},${Math.round(cam.y)} ${Math.round(cam.w)}x${Math.round(cam.h)}`) : "home (0,0 1200x800)"}`);
    const shown = f === "all" ? all : all.filter((it) => (it.chapter ?? null) === (f === "free" ? null : f));
    const r = (n: unknown) => (typeof n === "number" ? Math.round(n) : "?");
    const items: string[] = [];
    for (const it of shown) {
      const where = (it.chapter && f === "all" ? ` {${it.chapter}}` : "") + (it.step ? ` s${it.step}` : "");
      if (it._kind === "artifact")
        items.push(`  [${it.id}] ${it.type} at (${r(it.x)},${r(it.y)}) ${r(it.width)}x${r(it.height)}${it.label ? ` "${it.label}"` : ""}${it.source ? ` (${it.source.length} chars)` : ""}${where}`);
      else if (it._kind === "equation")
        items.push(`  [${it.id}] equation at (${r(it.x ?? 88)},${r(it.y ?? 92 + it._index * 115)}) ${it.label ? `${it.label}: ` : ""}${String(it.latex).slice(0, 80)}${where}`);
      else if (it.points?.length) {
        const xs = it.points.map((p: number[]) => p[0]), ys = it.points.map((p: number[]) => p[1]);
        items.push(`  [${it.id}] ${it.type} bbox (${r(Math.min(...xs))},${r(Math.min(...ys))})-(${r(Math.max(...xs))},${r(Math.max(...ys))})${where}`);
      } else if (it.type === "text") items.push(`  [${it.id}] text at (${r(it.x)},${r(it.y)}) "${String(it.text).slice(0, 40)}"${where}`);
      else items.push(`  [${it.id}] ${it.type} at (${r(it.x)},${r(it.y)}) ${r(it.w)}x${r(it.h)}${where}`);
    }
    const scope = f === "all" ? "whole board" : f === "free" ? "free items" : `chapter ${f}`;
    lines.push(`layout of ${scope} (${shown.length} items${chapters.length && f !== "all" ? "; pass chapter to board_read for another" : ""}):`);
    lines.push(...items.slice(0, 200));
    if (items.length > 200) lines.push(`  ... ${items.length - 200} more`);
    const summary = lines.join("\n");
    return summary.length <= 16000
      ? summary
      : summary.slice(0, 16000) + "\n[Summary truncated. Pass a chapter to board_read for detail.]";
  }

  const boardReadTool = defineTool({
    name: "board_read",
    label: "Read board",
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    description:
      "Read the current state of the shared blackboard (the Pi `/board` browser page; view-only for the human). Returns the revision, title, chapter table of contents, camera, and a layout list (id, type, position, size) for one chapter at a time. Use this before `board_update` to find free space, and pass the returned revision as `baseRevision`.",
    parameters: Type.Object({
      includeScene: Type.Optional(
        Type.Boolean({
          description:
            "Also include the full scene JSON (SVG/Mermaid sources omitted unless includeSources)",
        }),
      ),
      includeSources: Type.Optional(
        Type.Boolean({ description: "With includeScene, also include full artifact sources" }),
      ),
      chapter: Type.Optional(
        Type.String({ description: "Chapter id to list in detail ('all' = everything, 'free' = items outside chapters). Default: the camera's chapter" }),
      ),
    }),
    async execute(_toolCallId, params) {
      const s = await ensureServer();
      const board = s.getState();
      const sceneDetail = params.includeScene
        ? JSON.stringify(
            {
              ...board.scene,
              artifacts: (board.scene.artifacts ?? []).map((a: any) =>
                a.source && !params.includeSources
                  ? { ...a, source: `[${a.source.length} chars omitted; pass includeSources:true]` }
                  : a,
              ),
            },
            null,
            2,
          )
        : undefined;
      const text = [
        staleWarning(),
        `Pi blackboard running on 127.0.0.1:${s.port}. Use /board open for the authenticated browser URL.`,
        s.restoredFrom ? `(board restored from autosave of ${s.restoredFrom})` : "",
        summarizeBoard(board, params.chapter),
        `revision: ${s.revision}`,
        sceneDetail
          ? `scene detail:\n${sceneDetail.length > 24000 ? sceneDetail.slice(0, 24000) + "\n[Truncated. Use board_save then read the saved JSON for the complete scene.]" : sceneDetail}`
          : "",
        board.equations.length + board.scene.shapes.length + (board.scene.artifacts?.length ?? 0) === 0
          ? "The board is empty."
          : "",
      ]
        .filter(Boolean)
        .join("\n");
      return {
        content: [{ type: "text", text }],
        details: { revision: s.revision, board },
      };
    },
  });

  const boardUpdateTool = defineTool({
    name: "board_update",
    label: "Update board",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    description:
      "Teach progressively on the shared Pi blackboard: add or update marks/equations/artifacts at explicit board positions. SVG artifacts render safely as images; Mermaid is locally bundled and strict-security rendered. Add/edit/delete equations and draw marks on the same surface. Place shapes/equations with board-space x,y coordinates (upper-left origin); omitted equation positions use automatic layout. Board coordinates use a 1200x800 viewBox. Pass `baseRevision` from board_read; on conflict, re-read and reconcile rather than retrying blindly. Use `items` to move/restyle/delete anything by id. Long lessons: add `chapters` (named 1200x800 regions, auto-placed in a row), give items `chapter:id` so their coordinates are chapter-local, and set `camera:{chapter}` to glide the viewer to the chapter you are teaching; board_read then shows a table of contents plus one chapter's layout. Animation: viewers watch each update being drawn in order (diagrams, then strokes traced like handwriting, then labels/equations written left to right) and can step back/forward and replay, so build explanations in small updates, one idea per update. Emphasis: an ellipse (reveal draw) circles a term, a line underlines it, a rect with fill '#f2c14e33' and color 'none' (reveal wipe) highlights it; LaTeX \\color, \\boxed and \\cancel also work. Results include a measured layout check; call board_snapshot to actually look at the board after significant changes.\n\nStyle guide (black board, chalk-like colors; keep it consistent): chalk white #e8e3d9 for main lines/text, muted #8a8578 for axes/guides, accents yellow #f2c14e, blue #5fb3d9, red #ef6f6c, green #8de0be, purple #c39bd3. Text 18-28px, headings 30-36px; leave 40px margins and generous whitespace; label near (not on top of) what it names; use at most 3-4 accent colors per diagram. In SVG artifacts use font-family Georgia/serif and transparent backgrounds so they blend into the board.",
    parameters: BoardUpdateSchema,
    async execute(_toolCallId, params) {
      const s = await ensureServer();
      // Re-validate through the shared sanitizer so tool input follows the
      // same rules as browser input (ids assigned, bounds enforced).
      const update: Record<string, unknown> = {};
      if (params.title !== undefined)
        update.title = String(params.title).slice(0, 200);
      if (params.clear !== undefined) update.clear = params.clear;
      if (params.equations !== undefined) update.equations = params.equations;
      if (params.chapters !== undefined) update.chapters = params.chapters;
      if (params.camera !== undefined) update.camera = params.camera;
      if (params.items !== undefined)
        update.items = params.items.map((op: any) =>
          op.op === "update" ? { ...(op.fields ?? {}), op: "update", id: op.id } : op,
        );
      if (params.scene !== undefined) {
        update.scene = {
          mode: params.scene.mode === "replace" ? "replace" : "append",
          shapes: (params.scene.shapes ?? [])
            .map((sh) => sanitizeShape(sh))
            .filter(Boolean),
          elements: params.scene.elements ?? [],
          artifacts: params.scene.artifacts ?? [],
        };
      }
      try {
        const before = s.revision;
        const revision = s.update({
          baseRevision: params.baseRevision,
          ...update,
        });
        const board = s.getState();
        let check = "";
        if (params.check !== false) {
          try {
            const lint = await s.snapshots.lint({ timeout: 8000 });
            check = lint.issues.length
              ? `layout warnings (${lint.issues.length}):\n${lint.issues.slice(0, 25).map((i: string) => `  - ${i}`).join("\n")}`
              : "layout check: no overlaps or off-board items.";
          } catch (e) {
            check = `layout check unavailable: ${String((e as Error).message).split("\n")[0]}`;
          }
        }
        return {
          content: [
            {
              type: "text",
              text: [staleWarning(), `Board updated to revision ${revision} (was ${before}).`, check, summarizeBoard(board)].filter(Boolean).join("\n"),
            },
          ],
          details: { revision, board },
        };
      } catch (err) {
        const conflict = (err as { conflict?: unknown }).conflict as
          | { currentRevision: number }
          | undefined;
        if (conflict) {
          const board = s.getState();
          return {
            content: [
              {
                type: "text",
                text: `Conflict: ${String((err as Error).message)}\nCall board_read again, then re-apply your changes against revision ${conflict.currentRevision}. Current state:\n${summarizeBoard(board)}`,
              },
            ],
            isError: true,
            details: { revision: conflict.currentRevision, board },
          };
        }
        throw err;
      }
    },
  });

  const boardSnapshotTool = defineTool({
    name: "board_snapshot",
    label: "Look at board",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Render the shared blackboard in a headless browser and return it as an image, plus a measured layout report (each item's real bounding box, overlaps, off-board items). Use it to check your drawing the way the user sees it, then fix problems with board_update. Pass `region` (board coordinates) to zoom into detail.",
    parameters: Type.Object({
      region: Type.Optional(
        Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number({ minimum: 10 }), h: Type.Number({ minimum: 10 }) }, { description: "Board-space area to zoom into (default: whole 1200x800 board)" }),
      ),
      width: Type.Optional(Type.Number({ description: "Output image width in px (default 1200, max 2400)" })),
      chapter: Type.Optional(Type.String({ description: "Chapter id to capture (default: what the camera shows)" })),
      overview: Type.Optional(Type.Boolean({ description: "Capture the whole lesson (all chapters)" })),
    }),
    async execute(_toolCallId, params) {
      const s = await ensureServer();
      const board = s.getState();
      let region = params.region;
      if (!region && params.chapter) {
        const c = (board.chapters ?? []).find((ch: any) => ch.id === params.chapter);
        if (!c) throw new Error(`unknown chapter "${params.chapter}"`);
        region = { x: c.x, y: c.y, w: c.w, h: c.h };
      }
      if (!region && params.overview && board.chapters?.length) {
        const cs = board.chapters;
        const x0 = Math.min(...cs.map((c: any) => c.x)) - 60, y0 = Math.min(...cs.map((c: any) => c.y)) - 80;
        const x1 = Math.max(...cs.map((c: any) => c.x + c.w)) + 60, y1 = Math.max(...cs.map((c: any) => c.y + c.h)) + 60;
        region = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
      }
      region ??= cameraRect(board);
      const shot = await s.snapshots.capture({ region, width: params.width });
      const { items, issues } = shot.lint;
      const text = [
        staleWarning(),
        `Snapshot of revision ${s.revision} (board region ${Math.round(region.x)},${Math.round(region.y)} ${Math.round(region.w)}x${Math.round(region.h)}). Measured boxes are in board coordinates; a chapter item's local coords = board coords minus the chapter origin.`,
        issues.length ? `layout warnings (${issues.length}):\n${issues.slice(0, 40).map((i: string) => `  - ${i}`).join("\n")}` : "layout check: no overlaps or off-board items.",
        items.length ? `measured boxes:\n${items.slice(0, 120).map((i: any) => `  [${i.id}] ${i.kind} ${i.x},${i.y} ${i.w}x${i.h}`).join("\n")}` : "board is empty.",
      ].filter(Boolean).join("\n");
      return {
        content: [
          { type: "image", data: shot.png.toString("base64"), mimeType: "image/png" },
          { type: "text", text },
        ],
        details: { revision: s.revision, lint: shot.lint },
      };
    },
  });

  const boardLibraryTool = defineTool({
    name: "board_library",
    label: "Search illustrations",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    description:
      "Search the offline science illustration library (~2000 Bioicons: human physiology/anatomy, organs, cells and organelles, blood/immunology, microbiology, viruses, nucleic acids, genetics, plants, animals, chemistry, lab apparatus). Returns icon ids to place with a board_update artifact {type:'icon', icon:id, x, y, width}. Call with no query to list categories.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keywords, e.g. 'heart cross section', 'neuron', 'mitochondria', 'petri dish'" })),
      category: Type.Optional(Type.String({ description: "Restrict to a category (substring), e.g. 'Human physiology'" })),
      limit: Type.Optional(Type.Number({ description: "Max results (default 25)" })),
    }),
    async execute(_toolCallId, params) {
      if (!params.query && !params.category) {
        const counts = new Map<string, number>();
        for (const i of iconIndex().values()) counts.set(i.category, (counts.get(i.category) ?? 0) + 1);
        const text = counts.size
          ? `Icon categories (${iconIndex().size} icons):\n` + [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([c, n]) => `  ${c} (${n})`).join("\n")
          : "The icon library is not built. Run: node scripts/build-icons.mjs";
        return { content: [{ type: "text", text }], details: {} };
      }
      const hits = searchIcons(params.query ?? "", { category: params.category, limit: params.limit ?? 25 });
      const text = hits.length
        ? hits.map((i: any) => `  ${i.id} — ${i.name} · ${i.category} · ${i.license} · aspect ${(i.w / i.h).toFixed(2)}`).join("\n") + "\nPlace with {type:'icon', icon:'<id>', x, y, width} (credit: public/icons/CREDITS.md)."
        : `No icons match "${params.query}". Try fewer or broader words, or call with no query for categories.`;
      return { content: [{ type: "text", text }], details: { results: hits } };
    },
  });

  const boardSaveTool = defineTool({
    name: "board_save",
    label: "Save board",
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: false,
    },
    description:
      "Persist the current math board to disk as JSON (under ~/.pi/agent/extensions/math-board/.data/saves/) so it survives server restarts, or load a previously saved board. Saved boards can also be managed from the browser UI and the /board save command. Load replaces the board and requires baseRevision from board_read.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("save"), Type.Literal("load"), Type.Literal("list")],
        {
          description:
            "save: persist board under `name`; load: replace board from `name`; list: list saved names",
        },
      ),
      name: Type.Optional(
        Type.String({
          description: "Save slot name ([A-Za-z0-9._-], default 'default')",
        }),
      ),
      baseRevision: Type.Optional(
        Type.Integer({
          minimum: 0,
          description:
            "Required for load: revision from board_read, to avoid overwriting concurrent edits.",
        }),
      ),
    }),
    async execute(_toolCallId, params) {
      const s = await ensureServer();
      if (params.action === "list") {
        const saves = await s.listSaves();
        return {
          content: [
            {
              type: "text",
              text: saves.length
                ? `Saved boards: ${saves.join(", ")}`
                : "No saved boards yet.",
            },
          ],
          details: { saves },
        };
      }
      if (params.action === "save") {
        const saved = await s.save(params.name ?? "default");
        return {
          content: [
            {
              type: "text",
              text: `Saved board "${saved.name}" at ${saved.savedAt} (revision ${saved.revision}). File: ${defaultDataDir()}/saves/${saved.name}.json`,
            },
          ],
          details: { name: saved.name, savedAt: saved.savedAt },
        };
      }
      if (params.baseRevision === undefined)
        throw new Error(
          "Loading replaces the board. Read it first, then supply baseRevision.",
        );
      await s.load(params.name ?? "default", params.baseRevision);
      const revision = s.revision;
      return {
        content: [
          {
            type: "text",
            text: `Loaded board "${params.name ?? "default"}" at revision ${revision}.\n${summarizeBoard(s.getState())}`,
          },
        ],
        details: { revision, board: s.getState() },
      };
    },
  });

  /* ------------------------------------------------------------------ */
  /* Slash command                                                        */
  /* ------------------------------------------------------------------ */

  function usage(): string {
    return [
      "Usage: /board [action]",
      "  /board open       open the board in your browser (also /board)",
      "  /board clear      clear board (add: equations, scene)",
      "  /board save [n]   persist board to disk (name, default 'default')",
      "  /board load [n]   load a saved board",
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
        "status",
        "stop",
        "help",
      ];
      const hits = all.filter((a) => a.startsWith(prefix));
      return hits.length ? hits.map((a) => ({ value: a, label: a })) : null;
    },
    handler: async (args, ctx) => {
      const [verb, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      const nameArg = rest[0];

      try {
        switch (verb ?? "open") {
          case "open": {
            const s = await ensureServer();
            const opened =
              ctx.mode === "tui" ? await openBrowser(s.url) : false;
            ctx.ui.setStatus("math-board", `⬛ 127.0.0.1:${s.port}`);
            ctx.ui.notify(
              opened
                ? `Blackboard opened: ${s.url}`
                : `Open manually: ${s.url}`,
              "info",
            );
            return;
          }
          case "clear": {
            if (!server)
              return ctx.ui.notify(
                "No board running — nothing to clear.",
                "info",
              );
            server.clear(nameArg ? [nameArg] : ["all"]);
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
            await s.load(nameArg ?? "default", s.revision);
            ctx.ui.notify(
              `Loaded "${nameArg ?? "default"}" (rev ${s.revision}). Use /board open to view.`,
              "info",
            );
            return;
          }
          case "status": {
            if (!server) {
              ctx.ui.notify(
                "Board server: not running (starts on /board or model tool use).",
                "info",
              );
              return;
            }
            ctx.ui.notify(
              `Board server: running at 127.0.0.1:${server.port} (rev ${server.revision}, started ${server.startedAt}${server.restoredFrom ? `, restored autosave from ${server.restoredFrom}` : ""}, ${server.getState().chapters?.length ?? 0} chapters)\n${server.url}`,
              "info",
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

  pi.registerTool(boardReadTool);
  pi.registerTool(boardUpdateTool);
  pi.registerTool(boardSnapshotTool);
  pi.registerTool(boardLibraryTool);
  pi.registerTool(boardSaveTool);

  // Stop the server when the session goes away (quit, reload, switch, fork).
  // Cleanup is idempotent and cheap when nothing is running.
  pi.on("session_shutdown", async () => {
    await stopServer();
  });
}

