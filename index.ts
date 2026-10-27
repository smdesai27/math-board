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
 * Tools are loaded lazily so an idle board costs the model little per turn:
 * only `board_open` (a small loader) is active at first. The board tools are
 * registered with `deferred` exposure; `board_open` and `/board` activate them
 * with pi.setActiveTools. Long-form reference (artifact formats, SVG rules,
 * plot grammar, animation, chapters, layout, saves) lives in `board_docs`
 * instead of the tool schemas. In the learning folder (~/Learn or
 * $PI_LEARN_DIR, outside subagents) a constant `board_teaching` system prompt
 * section tells the tutor when and how to use the board.
 *
 * Lifecycle & safety:
 *   - Nothing starts at extension load time. The server starts lazily on the
 *     first `/board` command or model tool call, and stops on `session_shutdown`.
 *   - The server binds to 127.0.0.1 only, requires a per-session bearer token,
 *     validates the Host header (loopback only) and any Origin header.
 *   - Request bodies and scenes are bounded and re-validated. Equations use
 *     KaTeX with trust:false and expansion limits; labels use textContent.
 *   - Saves persist as JSON under the package's own .data/ directory, or under
 *     $PI_MATH_BOARD_DATA_DIR when set (tests always set it).
 *   - `/board export [name]` (export.mjs) writes the running board to
 *     <cwd>/viz/ only when the user types it: never on shutdown, autosave or
 *     from a model tool, and it never starts a board server.
 */

import { StringEnum, Type } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { nativeImport } from "./native-import.mjs";

/* ------------------------------------------------------------------ */
/* Learning folder: teaching guidance in the system prompt             */
/* ------------------------------------------------------------------ */

// The learning folder is ~/Learn, or $PI_LEARN_DIR.
const LEARN_DIR = path.resolve(process.env.PI_LEARN_DIR ?? path.join(homedir(), "Learn"));

function isLearningFolder(cwd: string): boolean {
  const dir = path.resolve(cwd);
  return dir === LEARN_DIR || dir.startsWith(LEARN_DIR + path.sep);
}

/**
 * The `board_teaching` system prompt section, added in the learning folder only.
 * Keep it constant (no clock times, paths or board state) so the prompt cache holds.
 */
const BOARD_TEACHING = [
  "A shared blackboard is available: a browser page the learner watches while you talk in the terminal. " +
    "Call board_open to start it; that activates the other board tools.",
  "",
  "Draw when a visual helps: derivations, geometry and vectors, diagrams of processes, plots, molecules, anatomy. " +
    "Do not draw trivial or purely verbal points; answer those in the terminal.",
  "",
  "Rhythm: read the board (board_read), draw one step (board_update), ask one check question in the terminal " +
    "and wait for the answer, then continue.",
  "",
  "Keep one concept per chapter: start a new chapter for a new concept and use the camera to move the learner there. " +
    "Keep board text short (labels, key equations, a few words) and put the explanation in the terminal.",
  "",
  "Before you use an artifact type (plot, svg, mermaid, molecule, icon) for the first time, call board_docs for its format.",
  "",
  'The learner may refer to the board as "step 4, eq2": that is a step number and an item id. ' +
    "Read the board to find what they mean before you answer. Give items short ids (eq1, f2) so such references stay easy.",
].join("\n");

/* ------------------------------------------------------------------ */
/* board_docs: long-form reference, fetched on demand                  */
/* ------------------------------------------------------------------ */

const DOC_TOPICS = [
  "overview",
  "workflow",
  "chapters",
  "equations",
  "marks",
  "plot",
  "svg",
  "mermaid",
  "molecule",
  "icon",
  "animation",
  "layout",
  "saves",
] as const;
type DocTopic = (typeof DOC_TOPICS)[number];

const ARTIFACT_COMMON =
  "Artifacts go in scene:{mode:\"append\", artifacts:[...]}. Every artifact takes x, y (top-left), width (80-1200, default 360), " +
  "height (60-800, default 280), label?, id?, chapter?, z?, opacity?, step?, reveal?, duration?, order?.";

const BOARD_DOCS: Record<DocTopic, string> = {
  overview: [
    "The blackboard is a view-only browser page the learner watches; you change it only through tools.",
    "Tools: board_read (revision, chapters, camera, layout of one chapter), board_update (draw and edit; one call = one lesson step), " +
      "board_snapshot (PNG of what the learner sees plus measured boxes), board_library (search ~2000 offline science illustrations), " +
      "board_save (named snapshots), board_docs (this reference).",
    "What you can draw, by topic:",
    "- equations: KaTeX math, \\color, \\boxed, \\cancel, chemistry with \\ce{...}",
    "- marks: lines, arrows, freehand curves, rectangles, ellipses, text",
    "- plot: function graphs, parametric curves, shaded areas, points, asymptotes",
    "- svg: hand-written SVG diagrams (markers, gradients, symbols, CSS, SMIL animation)",
    "- mermaid: flowcharts, sequence, state, class and ER diagrams, mind maps, timelines (automatic layout)",
    "- molecule: 2D structures from SMILES",
    "- icon: anatomy, organs, cells, microbes, viruses, DNA, plants, animals, lab equipment",
    "Style (black board, chalk colors; keep it consistent): chalk white #e8e3d9 for main lines and text, muted #8a8578 for axes and guides; " +
      "accents yellow #f2c14e, blue #5fb3d9, red #ef6f6c, green #8de0be, purple #c39bd3; at most 3-4 accents per diagram.",
    "Other topics: workflow, chapters, animation, layout, saves.",
  ].join("\n"),

  workflow: [
    "1. board_read: note the revision, the chapter list and the free space in the chapter you are teaching.",
    "2. board_update with baseRevision = that revision. Build the explanation in small updates, one idea per update: " +
      "each update that adds items is one lesson step, drawn live for the learner and replayable step by step.",
    "3. The result gives the new revision (your next baseRevision) and a measured layout check. Fix every warning " +
      "(overlap, outside its chapter, failed to render) with items ops: {op:\"move\", id, dx, dy}, " +
      "{op:\"update\", id, fields:{...}} (type cannot change), {op:\"delete\", id}.",
    "4. After significant changes call board_snapshot to see the board as the learner does (chapter or region to zoom in).",
    "Conflicts: a conflict means the board changed since your read (the learner loaded a save or cleared it, or another call landed). " +
      "Call board_read and re-apply your intended change against the current revision; never resend a stale replace or delete blindly.",
    "Ids: items get random ids unless you pass a short unique id (max 64 characters) when adding them, e.g. \"eq1\", \"force\". " +
      "Short ids make later edits and the learner's references (\"step 4, eq2\") easy.",
    "Order inside one update: title, clear ([\"equations\"|\"scene\"|\"all\"]; all also removes chapters), chapters, equations, scene, items, camera.",
    "check:false skips the layout check (faster for a burst of small edits; check again at the end).",
  ].join("\n"),

  chapters: [
    "Chapters are named regions on an unbounded canvas, 1200x800 by default, placed left to right (240 px apart) when you omit x/y. " +
      "Use one chapter per concept.",
    "Add: chapters:[{op:\"add\", id:\"forces\", title:\"Newton's second law\"}] (optional x, y, w, h; frame:false hides the faint frame and title). " +
      "Update: {op:\"update\", id, title?, x?, y?, w?, h?, frame?}. Delete: {op:\"delete\", id} also erases the chapter's items unless keepItems:true " +
      "(they become free items).",
    "Items with chapter:\"forces\" use chapter-local coordinates (0,0 = the chapter's top-left), so moving a chapter moves its content. " +
      "Items without a chapter use board coordinates; the home board is (0,0)-(1200,800).",
    "Chapter ops run before equations and scene in the same update, so one call can add a chapter and fill it.",
    "Camera: camera:{chapter:\"forces\"} glides every following viewer to that chapter; camera:{x,y,w,h} (board coordinates) focuses a detail; " +
      "camera:null goes home. Move the camera whenever you start teaching in another chapter. A learner who pans stops following until they press Follow.",
    "board_read shows a table of contents plus the layout of one chapter (the camera's; pass chapter:\"id\", \"all\" or \"free\" for others).",
    'Example: {"baseRevision":3,"chapters":[{"op":"add","id":"energy","title":"Kinetic energy"}],' +
      '"equations":[{"op":"add","id":"ke","latex":"E_k=\\\\tfrac12 mv^2","x":80,"y":100,"chapter":"energy"}],"camera":{"chapter":"energy"}}',
  ].join("\n"),

  equations: [
    "equations:[{op:\"add\", latex, id?, label?, x?, y?, color?, size?, chapter?, z?, step?, reveal?, duration?, order?}]",
    "- latex is KaTeX: \\frac, \\sum, \\int, \\begin{pmatrix}...\\end{pmatrix}, \\begin{aligned}...\\end{aligned}, \\underbrace, " +
      "\\color{#f2c14e}{...}, \\boxed{...}, \\cancel{...}; chemistry with \\ce{2H2 + O2 -> 2H2O} (mhchem).",
    "- x,y = top-left of the equation box; the label sits above the formula. Omit both for automatic stacking down the left side.",
    "- size = font scale (1 = about 27 px, range 0.3-4); color = CSS color of the formula.",
    "- {op:\"update\", id, latex?, label?, x?, y?, color?, size?} changes an equation, {op:\"delete\", id} removes it; " +
      "items ops (move, update any field) work on equations too.",
    "- A derivation reads best as one equation per line, each its own step; mark the term that changed with \\color or circle it with an ellipse (see marks).",
    'Example: {"op":"add","id":"eq1","latex":"F = m\\\\,a","label":"Newton II","x":80,"y":120,"color":"#f2c14e"}',
  ].join("\n"),

  marks: [
    "scene:{mode:\"append\", shapes:[...]} draws vector marks. mode \"replace\" swaps the whole scene (all shapes and artifacts): use append unless you mean that.",
    "- line: {type:\"line\", points:[[x1,y1],[x2,y2],...], color?, width? (default 2)}",
    "- arrow: {type:\"arrow\", points: 2-4 points; the last segment gets the arrowhead, color?, width?}",
    "- stroke: {type:\"stroke\", points:[[x,y],...], color?, width? (default 3)}: freehand polyline; give many points for a smooth curve",
    "- rect: {type:\"rect\", x, y, w, h, color? (stroke), fill? (default none)}; x,y = top-left",
    "- ellipse: {type:\"ellipse\", x, y, w, h, color?, fill?}; x,y = top-left of its bounding box",
    "- text: {type:\"text\", text, x, y, size? (px, default 24), font? serif|sans|mono (serif = LaTeX look, default), anchor? start|middle|end, " +
      "bold?, italic?, color?}. y is the baseline, not the top; \"\\n\" starts a new line. Plain text only: use equations for math.",
    "All marks take id?, z, opacity (0-1), dash (\"6 4\"; not for text), chapter, step, reveal, duration, order. Default color is chalk white #e8e3d9.",
    "Emphasis: circle a term with an ellipse (reveal \"draw\"), underline it with a line, highlight it with a rect " +
      "{fill:\"#f2c14e33\", color:\"none\", reveal:\"wipe\"}.",
    'Example: {"mode":"append","shapes":[{"type":"arrow","id":"v","points":[[200,400],[420,300]],"color":"#5fb3d9","width":3},' +
      '{"type":"text","id":"vlabel","text":"v","x":430,"y":295,"italic":true,"color":"#5fb3d9"}]}',
  ].join("\n"),

  plot: [
    "{type:\"plot\", x, y, width, height, xRange:[a,b] (default [-10,10]), yRange?:[c,d] (default: fitted), functions?, parametric?, areas?, points?, " +
      "vlines?, hlines?, xLabel?, yLabel?, title?, grid?, axes?, ticks? (all true by default; false hides), equalAspect? (true = same scale on both axes, for circles and geometry)}",
    "- functions: up to 12 of {expr:\"sin(x)\", label?, color?, dash?, width?, domain?:[a,b]}",
    "- parametric: up to 8 of {x:\"cos(t)\", y:\"sin(t)\", t:[0,6.283] (default [0, 2pi]), label?, color?, dash?, width?}",
    "- areas: up to 6 of {expr, from, to, lower?:\"expr\"}: shades between expr and lower (default the x axis)",
    "- points: up to 200 of {x, y, label?, color?, size?}; vlines / hlines: up to 12 of {x} / {y} with label?, color?, dash? (asymptotes, markers)",
    "At least one of functions, parametric, points or areas is required. Curves are traced (default reveal \"draw\").",
    "Expressions: numbers, the variable x (t in parametric), + - * / ^ (or **), unary minus, parentheses, implicit multiplication (2x, 3(x+1), 2pi), " +
      "constants pi, e, tau, and the functions sin cos tan asin acos atan sinh cosh tanh asinh acosh atanh sec csc cot exp ln log (base 10) log2 log10 " +
      "sqrt cbrt abs sign floor ceil round min max pow atan2 hypot mod step (Heaviside) sinc gauss(x, mu, sigma). Unknown names are errors; at most 500 characters.",
    ARTIFACT_COMMON,
    'Example: {"type":"plot","id":"p1","x":60,"y":120,"width":560,"height":360,"xRange":[-6.3,6.3],' +
      '"functions":[{"expr":"sin(x)","label":"sin x"},{"expr":"x^2/8 - 1","dash":"7 5","color":"#f2c14e"}],' +
      '"areas":[{"expr":"sin(x)","from":0,"to":3.14159}],"points":[{"x":0,"y":0,"label":"O"}],"xLabel":"x","yLabel":"y"}',
  ].join("\n"),

  svg: [
    "{type:\"svg\", x, y, width, height, source:\"<svg viewBox=...>...</svg>\"}: a complete SVG document (at most 128 KiB), shown as an image scaled into " +
      "width x height; keep the viewBox aspect equal to width/height.",
    "Allowed elements: svg g defs symbol use title desc style rect circle ellipse line polyline polygon path text tspan textPath marker " +
      "linearGradient radialGradient stop pattern clipPath mask animate animateTransform animateMotion mpath set. So markers (arrowheads), gradients, " +
      "patterns, clip paths, masks, a <style> block with CSS classes and SMIL animation all work.",
    "Rejected: script, foreignObject, image, iframe, object, embed, DOCTYPE/ENTITY, on* event attributes, javascript: and data: URLs, @import, and every " +
      "external reference: url(...) and href must point to an #id inside the same SVG. Quote every attribute value. Attributes outside the usual " +
      "presentation and animation set are rejected; the error names the element or attribute. A missing xmlns is added.",
    "An SVG that is not well-formed XML shows a red \"failed to render\" box and is reported in the layout check.",
    "Style: transparent background (no full-size white rect), font-family Georgia, serif, chalk colors (see overview), stroke widths 2-3. Default reveal \"wipe\".",
    ARTIFACT_COMMON,
    'Example source: <svg viewBox="0 0 400 200"><defs><marker id="h" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">' +
      '<path d="M0,0 L10,5 L0,10 z" fill="#e8e3d9"/></marker></defs><line x1="20" y1="100" x2="360" y2="100" stroke="#e8e3d9" stroke-width="3" ' +
      'marker-end="url(#h)"/><text x="190" y="85" fill="#f2c14e" font-family="Georgia, serif" font-size="22" text-anchor="middle">force</text></svg>',
  ].join("\n"),

  mermaid: [
    "{type:\"mermaid\", x, y, width, height, source}: Mermaid diagram text (at most 12,000 characters), laid out automatically and shown as an image " +
      "scaled into width x height. Flowcharts (graph/flowchart), sequenceDiagram, classDiagram, stateDiagram-v2, erDiagram, gantt, mindmap, timeline, pie.",
    "Rendered with securityLevel strict: links, click/call callbacks, URLs and embedded HTML tags are rejected.",
    "Use it for processes and graphs where automatic layout beats placing boxes by hand; size the artifact generously. Default reveal \"wipe\".",
    ARTIFACT_COMMON,
    'Example: {"type":"mermaid","id":"resp","x":620,"y":120,"width":460,"height":260,' +
      '"source":"graph LR\\n  G[Glucose] -->|glycolysis| P[Pyruvate]\\n  P --> A[Acetyl-CoA] --> K((Krebs cycle))"}',
  ].join("\n"),

  molecule: [
    "{type:\"molecule\", x, y, width, height, smiles}: a 2D structure drawn from a SMILES string (at most 500 characters, SMILES characters only, no spaces). " +
      "Put the name in label. Default reveal \"wipe\".",
    "SMILES examples: ethanol CCO, benzene c1ccccc1, acetic acid CC(=O)O, aspirin CC(=O)Oc1ccccc1C(=O)O, caffeine Cn1cnc2c1c(=O)n(C)c(=O)n2C, " +
      "glucose OC[C@H]1OC(O)[C@H](O)[C@@H](O)[C@@H]1O.",
    ARTIFACT_COMMON,
    'Example: {"type":"molecule","id":"asp","smiles":"CC(=O)Oc1ccccc1C(=O)O","x":640,"y":40,"width":260,"height":200,"label":"aspirin"}',
  ].join("\n"),

  icon: [
    "{type:\"icon\", icon:\"<id>\", x, y, width}: an illustration from the offline library (~2000 Bioicons: anatomy and organs, cells and organelles, " +
      "blood and immunology, microbes and viruses, DNA and genetics, plants, animals, chemistry, lab equipment).",
    "Find ids with board_library first (keywords; no query lists the categories); unknown ids are rejected.",
    "Give width or height, not both, to keep the drawing's aspect ratio. card:true puts it on a soft light panel: use it for dark or detailed drawings " +
      "made for white paper. Add arrows and text marks to point at its parts. Default reveal \"wipe\".",
    ARTIFACT_COMMON,
    'Example: {"type":"icon","id":"heart","icon":"heart-cross-section-2","x":700,"y":100,"width":260,"card":true,"label":"Heart"}',
    "CC-BY icons need attribution if the material is published (public/icons/CREDITS.md).",
  ].join("\n"),

  animation: [
    "Every board_update that adds items is one lesson step. The learner watches new steps being drawn live and can step back and forward, " +
      "replay a chapter and play on.",
    "Within a step, items appear one after another: diagrams first, then marks, then text and equations, each group in the order given. " +
      "order (a number) overrides the order within its step.",
    "reveal = how an item appears:",
    "- draw: traced like handwriting (default for lines, arrows, strokes, rects, ellipses and plots)",
    "- write: left to right (default for text and equations)",
    "- wipe: a sweep (default for svg, mermaid, molecule and icon artifacts and for dashed marks)",
    "- fade, none",
    "duration: reveal time in ms (0-10000; default from the item's size). Long steps are compressed to about 7 s.",
    "step: board_read shows \"steps: N\". Give items of one update step N+1, N+2, ... to build one call up in several steps; items without step " +
      "form the next step.",
    "Emphasis uses the same machinery: an ellipse with reveal \"draw\" circles a term; a translucent rect (fill \"#f2c14e33\", color \"none\") with reveal " +
      "\"wipe\" highlights it; \\color and \\boxed work in LaTeX.",
    "SVG artifacts may also contain SMIL animation (animate, animateTransform, animateMotion), which loops inside the drawing.",
  ].join("\n"),

  layout: [
    "Coordinates: the home board and every chapter are 1200x800 spaces, origin top-left, x right, y down. Items with chapter:\"id\" use " +
      "chapter-local coordinates; the others use board coordinates.",
    "Anchors: text x,y = start of the baseline (anchor middle/end puts x at the center/end); equation x,y = top-left of its box; rect, ellipse and " +
      "artifact x,y = top-left corner; line, arrow and stroke use their points [[x,y],...].",
    "Sizes: text 18-28 px, headings 30-36 px; equation size 1 is about 27 px; artifacts default to 360x280 (width 80-1200, height 60-800).",
    "Spacing: leave 40 px margins inside a chapter and generous whitespace; put labels next to (not on top of) what they name. " +
      "A derivation column on the left and the diagram on the right works well.",
    "Layering: z orders items of every kind (default 0; higher draws on top); opacity 0-1.",
    "Checks: every board_update result reports measured overlaps (text and equations, artifacts), items spilling out of their chapter and " +
      "artifacts that failed to render. board_snapshot returns each item's measured box in board coordinates (subtract the chapter origin for local ones).",
    "Edits: items:[{op:\"update\", id, fields:{x:100, y:200}}, {op:\"move\", id, dx, dy}, {op:\"delete\", id}] work on shapes, artifacts and equations alike.",
  ].join("\n"),

  saves: [
    "Autosave: every change is written to autosave.json in the board's data directory (the extension's .data/ folder, or $PI_MATH_BOARD_DATA_DIR); " +
      "a fresh board server restores it, so /reload or restarting pi keeps the board.",
    "Named snapshots with board_save: {action:\"save\", name} writes saves/<name>.json (letters, digits, . _ -; default \"default\"); " +
      "{action:\"list\"} lists the names; {action:\"load\", name, baseRevision} replaces the whole board, so board_read first and pass its revision. " +
      "The learner can also use /board save <name> and /board load <name>.",
    "Loading re-validates everything; unsupported items are skipped instead of failing the load.",
    "Save before clearing the board or switching topics, so the lesson can be reopened later.",
    "Limits: 200 chapters, 1000 equations, 5000 scene items, 100 artifacts per update, 128 KiB per SVG, 6 MiB per board.",
  ].join("\n"),
};

/*
 * Pi re-transpiles this file on /reload, but plain .mjs files are loaded by
 * Node's native ESM loader, whose cache cannot be cleared. Importing the server
 * (and export.mjs) through a URL that encodes the source files' mtimes gives every
 * edited version a fresh module instance (server.mjs forwards the same query to its siblings).
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
// index.ts is included so the server's stale-source check is re-baselined on every reload.
const SERVER_FILES = ["server.mjs", "scene.mjs", "snapshot.mjs", "shared/expr.mjs", "export.mjs", "index.ts"];
function loadSourceModule(file: string): Promise<any> {
  const stamp = Math.max(
    ...SERVER_FILES.map((f) => {
      try {
        return statSync(path.join(HERE, f)).mtimeMs;
      } catch {
        return 0;
      }
    }),
  );
  const url = `${pathToFileURL(path.join(HERE, file)).href}?v=${Math.round(stamp)}`;
  return nativeImport(url);
}

export default async function mathBoardExtension(pi: ExtensionAPI) {
  const { BoardServer, defaultDataDir, openBrowser, sanitizeShape, staleSources, cameraRect, searchIcons, iconIndex } =
    await loadSourceModule("server.mjs");
  const { exportLesson, exportNotice, chapterRegion, overviewRegion } = await loadSourceModule("export.mjs");

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

  // Field descriptions stay one short line: formats, examples and semantics are in board_docs.
  // The reveal enum and the Style fields repeat in every item kind, so they carry no description
  // (board_update's description lists them once).
  const Reveal = Type.Union([Type.Literal("draw"), Type.Literal("write"), Type.Literal("wipe"), Type.Literal("fade"), Type.Literal("none")]);

  const EquationOpSchema = Type.Union([
    Type.Object({
      op: Type.Literal("add"),
      latex: Type.String(),
      label: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number({ description: "Omit x,y for auto layout" })),
      y: Type.Optional(Type.Number()),
      color: Type.Optional(Type.String()),
      size: Type.Optional(Type.Number()),
      z: Type.Optional(Type.Number()),
      chapter: Type.Optional(Type.String()),
      step: Type.Optional(Type.Integer({ minimum: 0 })),
      reveal: Type.Optional(Reveal),
      duration: Type.Optional(Type.Number()),
      order: Type.Optional(Type.Number()),
    }),
    Type.Object({
      op: Type.Literal("update"),
      id: Type.String(),
      latex: Type.Optional(Type.String()),
      label: Type.Optional(Type.String()),
      x: Type.Optional(Type.Number()),
      y: Type.Optional(Type.Number()),
      color: Type.Optional(Type.String()),
      size: Type.Optional(Type.Number()),
    }),
    Type.Object({
      op: Type.Literal("delete"),
      id: Type.String(),
    }),
  ]);

  // [x, y] as a fixed-length array, not Type.Tuple: TypeBox emits the draft-07
  // tuple form (`items: [...]`), which Anthropic rejects as invalid 2020-12.
  const PointSchema = Type.Array(Type.Number(), { minItems: 2, maxItems: 2 });

  // Styling and animation fields shared by every shape kind (listed once in board_update's description).
  const Style = {
    z: Type.Optional(Type.Number()),
    opacity: Type.Optional(Type.Number()),
    dash: Type.Optional(Type.String()),
    chapter: Type.Optional(Type.String()),
    step: Type.Optional(Type.Integer({ minimum: 0 })),
    reveal: Type.Optional(Reveal),
    duration: Type.Optional(Type.Number()),
    order: Type.Optional(Type.Number()),
  };

  const ShapeSchema = Type.Union([
    Type.Object({
      type: Type.Literal("stroke"),
      ...Style,
      points: Type.Array(PointSchema, { minItems: 2 }),
      color: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
    }),
    Type.Object({
      type: Type.Literal("rect"),
      ...Style,
      x: Type.Number(),
      y: Type.Number(),
      w: Type.Number(),
      h: Type.Number(),
      color: Type.Optional(Type.String()),
      fill: Type.Optional(Type.String()),
    }),
    Type.Object({
      type: Type.Literal("ellipse"),
      ...Style,
      x: Type.Number(),
      y: Type.Number(),
      w: Type.Number(),
      h: Type.Number(),
      color: Type.Optional(Type.String()),
      fill: Type.Optional(Type.String()),
    }),
    Type.Object({
      type: Type.Literal("line"),
      ...Style,
      points: Type.Array(PointSchema, { minItems: 2 }),
      color: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
    }),
    Type.Object({
      type: Type.Literal("arrow"),
      ...Style,
      points: Type.Array(PointSchema, { minItems: 2, maxItems: 4, description: "Last segment gets the head" }),
      color: Type.Optional(Type.String()),
      width: Type.Optional(Type.Number()),
    }),
    Type.Object({
      type: Type.Literal("text"),
      ...Style,
      text: Type.String(),
      x: Type.Number(),
      y: Type.Number({ description: "Baseline" }),
      size: Type.Optional(Type.Number()),
      font: Type.Optional(Type.Union([Type.Literal("serif"), Type.Literal("sans"), Type.Literal("mono")])),
      anchor: Type.Optional(Type.Union([Type.Literal("start"), Type.Literal("middle"), Type.Literal("end")])),
      bold: Type.Optional(Type.Boolean()),
      italic: Type.Optional(Type.Boolean()),
      color: Type.Optional(Type.String()),
    }),
  ]);

  const ItemOpSchema = Type.Union([
    Type.Object({
      op: Type.Literal("update"),
      id: Type.String(),
      fields: Type.Record(Type.String(), Type.Unknown(), { description: "Fields to set; type is fixed" }),
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
    baseRevision: Type.Integer({ minimum: 0 }),
    title: Type.Optional(Type.String()),
    clear: Type.Optional(
      Type.Array(Type.Union([Type.Literal("equations"), Type.Literal("scene"), Type.Literal("all")])),
    ),
    equations: Type.Optional(Type.Array(EquationOpSchema)),
    chapters: Type.Optional(
      Type.Array(
        Type.Union([
          Type.Object({
            op: Type.Literal("add"),
            id: Type.String(),
            title: Type.String(),
            x: Type.Optional(Type.Number({ description: "Omit x,y to auto-place" })),
            y: Type.Optional(Type.Number()),
            w: Type.Optional(Type.Number()),
            h: Type.Optional(Type.Number()),
            frame: Type.Optional(Type.Boolean()),
          }),
          Type.Object({ op: Type.Literal("update"), id: Type.String(), title: Type.Optional(Type.String()), x: Type.Optional(Type.Number()), y: Type.Optional(Type.Number()), w: Type.Optional(Type.Number()), h: Type.Optional(Type.Number()), frame: Type.Optional(Type.Boolean()) }),
          Type.Object({ op: Type.Literal("delete"), id: Type.String(), keepItems: Type.Optional(Type.Boolean({ description: "Else its items are erased" })) }),
        ]),
      ),
    ),
    camera: Type.Optional(
      Type.Union([
        Type.Object({ chapter: Type.String() }),
        Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number(), h: Type.Number() }),
        Type.Null(),
      ], { description: "{chapter}, a board rect, or null = home" }),
    ),
    items: Type.Optional(
      Type.Array(ItemOpSchema),
    ),
    check: Type.Optional(Type.Boolean()),
    scene: Type.Optional(
      Type.Object({
        mode: Type.Union([Type.Literal("append"), Type.Literal("replace")], {
          description: "replace swaps the whole scene",
        }),
        shapes: Type.Optional(Type.Array(ShapeSchema, { maxItems: 2000 })),
        elements: Type.Optional(
          Type.Array(Type.Record(Type.String(), Type.Unknown()), { maxItems: 2000, description: "Legacy; old saves only" }),
        ),
        artifacts: Type.Optional(
          Type.Array(Type.Record(Type.String(), Type.Unknown()), {
            maxItems: 100,
            description: "{type: plot|svg|mermaid|molecule|icon, x, y, width, height, ...}: see board_docs",
          }),
        ),
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
    exposure: "deferred",
    description:
      "Read the shared blackboard: revision, chapters, camera, steps, and the layout (id, type, position, size, step) of one chapter. Read before board_update (pass the revision as baseRevision) and to resolve references like \"step 4, eq2\".",
    parameters: Type.Object({
      includeScene: Type.Optional(
        Type.Boolean({ description: "Also return the scene JSON" }),
      ),
      includeSources: Type.Optional(
        Type.Boolean({ description: "Include artifact sources" }),
      ),
      chapter: Type.Optional(
        Type.String({ description: "Chapter id, 'all' or 'free' (default: camera's)" }),
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
        `Pi blackboard running on 127.0.0.1:${s.port}. board_open (or /board open) gives the authenticated browser URL.`,
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
    exposure: "deferred",
    description:
      "Draw on the shared blackboard; each call that adds items is one lesson step the learner watches being drawn. " +
      "Coordinates: the home board and every chapter are 1200x800, origin top-left, y down; items with `chapter` use that chapter's local coordinates. " +
      "Text y is the baseline; equation, rect, ellipse and artifact x,y is the top-left. " +
      "`baseRevision` = the revision from your last board_read or board_update (compare-and-swap); on a conflict, board_read again and re-apply your change to the current board, never retry blindly. " +
      "Each result lists layout warnings (overlaps, items outside their chapter, failed renders): fix them with `items`. " +
      "Items also take id (short, e.g. \"eq1\"), z, opacity, dash, chapter, step, reveal, duration, order. " +
      "Formats and examples: board_docs.",
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
    exposure: "deferred",
    description:
      "Render the board in a headless browser and return a PNG as the learner sees it, plus each item's measured box and the layout warnings. Use it after significant changes, then fix problems with board_update.",
    parameters: Type.Object({
      region: Type.Optional(
        Type.Object({ x: Type.Number(), y: Type.Number(), w: Type.Number({ minimum: 10 }), h: Type.Number({ minimum: 10 }) }, { description: "Board-space area (default: camera view)" }),
      ),
      width: Type.Optional(Type.Number({ description: "Image px (default 1200, max 2400)" })),
      chapter: Type.Optional(Type.String({ description: "Chapter to capture" })),
      overview: Type.Optional(Type.Boolean({ description: "All chapters" })),
    }),
    async execute(_toolCallId, params) {
      const s = await ensureServer();
      const board = s.getState();
      let region = params.region;
      if (!region && params.chapter) {
        const c = (board.chapters ?? []).find((ch: any) => ch.id === params.chapter);
        if (!c) throw new Error(`unknown chapter "${params.chapter}"`);
        region = chapterRegion(c);
      }
      // Region helpers are shared with /board export, so its PNGs match these snapshots.
      if (!region && params.overview && board.chapters?.length) region = overviewRegion(board.chapters);
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
    exposure: "deferred",
    description:
      "Search the offline science illustration library (~2000 Bioicons: anatomy, organs, cells, blood and immunology, microbes, viruses, DNA, plants, animals, lab equipment). Returns icon ids for an artifact {type:'icon', icon:id, x, y, width}. No query lists the categories.",
    parameters: Type.Object({
      query: Type.Optional(Type.String({ description: "Keywords, e.g. 'heart cross section'" })),
      category: Type.Optional(Type.String({ description: "Category substring" })),
      limit: Type.Optional(Type.Number({ description: "Default 25" })),
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
    exposure: "deferred",
    description:
      "Save the board as a named snapshot, list snapshots, or load one (replaces the whole board; needs baseRevision from board_read). Details: board_docs saves.",
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("save"), Type.Literal("load"), Type.Literal("list")],
        {
          description: "load replaces the board",
        },
      ),
      name: Type.Optional(
        Type.String({
          description: "[A-Za-z0-9._-], default 'default'",
        }),
      ),
      baseRevision: Type.Optional(
        Type.Integer({
          minimum: 0,
          description: "Required for load",
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

  const boardDocsTool = defineTool({
    name: "board_docs",
    label: "Board reference",
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    exposure: "deferred",
    description:
      "Reference for the blackboard: artifact formats with examples (plot, svg, mermaid, molecule, icon), marks, equations, chapters and camera, animation, layout and style, saves. Call it before using a format for the first time.",
    parameters: Type.Object({
      topic: StringEnum(DOC_TOPICS, { description: "overview lists what you can draw" }),
    }),
    async execute(_toolCallId, params) {
      const topic = params.topic as DocTopic;
      const text = Object.hasOwn(BOARD_DOCS, topic) ? BOARD_DOCS[topic] : undefined;
      if (!text) throw new Error(`unknown topic "${String(params.topic)}"; one of: ${DOC_TOPICS.join(", ")}`);
      return { content: [{ type: "text", text: `board_docs ${topic}:\n${text}` }], details: { topic } };
    },
  });

  /* ------------------------------------------------------------------ */
  /* Lazy activation: board_open (and /board) switch the board tools on  */
  /* ------------------------------------------------------------------ */

  /** Every board tool except the loader; registered `deferred`, so inactive until activated. */
  const BOARD_TOOL_NAMES = ["board_read", "board_update", "board_snapshot", "board_library", "board_save", "board_docs"];

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
   * activate the board tools, and open the browser in the TUI only. With `unlessViewed`, a
   * board that a browser already shows is not opened again.
   */
  async function openBoard(ctx: ExtensionContext, { unlessViewed = false } = {}) {
    const s = await ensureServer();
    const activationError = activateBoardTools();
    const viewed = unlessViewed && (s.clients?.size ?? 0) > 0;
    const opened = ctx.mode === "tui" && !viewed ? await openBrowser(s.url) : false;
    ctx.ui.setStatus("math-board", `⬛ 127.0.0.1:${s.port}`);
    return { s, opened, viewed, activationError };
  }

  const boardOpenTool = defineTool({
    name: "board_open",
    label: "Open board",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    description:
      "Open the shared blackboard to teach visually: starts it, shows it in the learner's browser and activates the board tools (board_read, board_update, board_docs, ...). Returns the URL. Safe to call again.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const { s, opened, viewed, activationError } = await openBoard(ctx, { unlessViewed: true });
      const shown = opened ? "opened in the learner's browser" : viewed ? "already open in a browser" : "not opened automatically; give the learner this URL";
      const text = [
        staleWarning(),
        `Blackboard: ${s.url} (${shown}).`,
        activationError
          ? `Could not activate the board tools: ${activationError}`
          : "Board tools are active. Call board_docs (topic) for formats before using an artifact type the first time.",
      ]
        .filter(Boolean)
        .join("\n");
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
      "  /board save [n]   persist board to disk (name, default 'default')",
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
      const nameArg = rest[0];
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
            const activationError = activateBoardTools(); // the model can read and continue the loaded lesson
            if (activationError)
              ctx.ui.notify(`Board tools not activated: ${activationError}`, "warning");
            ctx.ui.notify(
              `Loaded "${nameArg ?? "default"}" (rev ${s.revision}). Use /board open to view.`,
              "info",
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

  // board_open is direct, so registering it activates it; the others are `deferred` and stay
  // inactive (not declared to the model) until board_open or /board activates them.
  for (const tool of [boardOpenTool, boardReadTool, boardUpdateTool, boardSnapshotTool, boardLibraryTool, boardSaveTool, boardDocsTool])
    pi.registerTool(tool);

  // Inside the learning folder (and not in a subagent), tell the tutor when and how to use
  // the board. Outside it, add nothing. The text is constant, so the cached prompt holds.
  pi.on("before_agent_start", (event, ctx) => {
    if (process.env.PI_SUBAGENT_NAME || !isLearningFolder(ctx.cwd)) return;
    event.systemPromptOptions.sections.board_teaching = BOARD_TEACHING;
  });

  // Stop the server when the session goes away (quit, reload, switch, fork).
  // Cleanup is idempotent and cheap when nothing is running.
  pi.on("session_shutdown", async () => {
    await stopServer();
  });
}

