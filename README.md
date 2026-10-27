# Pi Blackboard

[![CI](https://github.com/smdesai27/math-board/actions/workflows/ci.yml/badge.svg)](https://github.com/smdesai27/math-board/actions/workflows/ci.yml)

A full-window, black chalkboard in your browser that Pi draws on while it explains things, like a professor at a blackboard. It is **view-only for you**: Pi places equations, diagrams, plots, molecules and illustrations through tools; you watch them being drawn, step back and forth through the lesson, pan and zoom. Everything runs locally and offline (no CDN, no extra model or API keys). Claude Code and other MCP clients get the same tools through a stdio MCP server: see [Use from Claude Code (MCP)](#use-from-claude-code-mcp).

What Pi can draw:

- **Math**: KaTeX equations (`\color`, `\boxed`, `\cancel`, …), chemistry with `\ce{…}` (mhchem)
- **Plots**: function graphs, parametric curves, shaded areas, points, asymptotes (safe expression parser, no `eval`)
- **Molecules**: 2D structures from SMILES strings (SmilesDrawer)
- **Science illustrations**: ~2000 offline Bioicons (anatomy, organs, cells, organelles, blood/immunology, microbes, viruses, DNA, plants, animals, lab equipment), searchable by keyword
- **Diagrams**: hand-authored SVG (markers, gradients, symbols, CSS, SMIL animation) and Mermaid (flowcharts, sequence, class, state, ER, gantt, mindmaps, graphs; auto-layout)
- **Marks**: lines, arrows, curves, rectangles, ellipses, text (LaTeX-style serif by default)

## Start

This repository is a local Pi package: `package.json` declares `"pi": { "extensions": ["./index.ts"] }`. Install it once with `pi install ~/math-board` (or the path to your clone). Pi loads local packages in place, without copying them, so the checkout is what runs. After installing, run `/reload` (or restart Pi), then:

```text
/board            # open the board in your browser (also /board open)
/board status     # server URL, revision, autosave/chapters info
/board save name  # named snapshot      /board load name   # restore it
/board export [name]  # write the lesson to ./viz/: board.json, PNGs, lesson.md
/board clear      # clear everything (or: /board clear equations|scene)
/board stop       # stop the server
```

Ask Pi to explain something "on the board". The server starts lazily on first use, listens only on `127.0.0.1`, and the URL carries a private `#token=…`: don't share it.

## Use from Claude Code (MCP)

The same board tools run as a stdio MCP server, `mcp/server.mjs`, so Claude Code or any other MCP client can teach on a board without Pi. There is one implementation of the tools, `tools.mjs` (schemas, descriptions, handlers, `board_docs` text); the Pi extension (`index.ts`) and the MCP server are two thin adapters over it. Both send the model the same tool names, descriptions and JSON schemas and return the same results, and the tutoring rhythm Pi adds as its `board_teaching` prompt section (read, draw one step, ask one check question) is the MCP server's instructions. One learner workflow, whichever agent is teaching.

After `npm ci` in the checkout (see [Build and tests](#build-and-tests)), register it with Claude Code once:

```sh
claude mcp add math-board -- node ~/math-board/mcp/server.mjs
```

That registers it for the folder you run it in (scope `local`): run it in your learning folder (`~/Learn`) to get the board, and its tutoring instructions, only there, as Pi adds `board_teaching` only there; add `--scope user` to have it in every project. `claude mcp list` should show `✔ Connected`, and `/mcp` inside Claude Code reconnects it after you change the code. Other MCP clients take the same command as a stdio server:

```json
{
  "mcpServers": {
    "math-board": {
      "command": "node",
      "args": ["~/math-board/mcp/server.mjs"]
    }
  }
}
```

- **Tools**: `board_open`, `board_read`, `board_update`, `board_snapshot`, `board_library`, `board_save` and `board_docs`, as in the [Model tools](#model-tools) table. All seven are listed from the start (MCP has no lazy activation as in Pi); the model calls `board_open` to show the board. `board_snapshot` returns the PNG as an MCP image block, followed by the text summary.
- **Browser**: `board_open` opens the board in your default browser unless a browser already shows it, and returns the URL either way. With `MATH_BOARD_NO_BROWSER=1` (`claude mcp add math-board -e MATH_BOARD_NO_BROWSER=1 -- node …`) it only returns the URL.
- **Separate boards**: the Pi extension and the MCP server are the same tools on separate boards. The MCP server hosts its own board server, started on the first tool call that needs it, on `127.0.0.1` only with its own token, and keeps its autosave and named saves in `.data/mcp/` inside the package, apart from Pi's `.data/`, so the two never overwrite each other's autosave. `PI_MATH_BOARD_DATA_DIR` overrides the directory; if you set it for both, give each its own. To continue a lesson in the other agent, copy `saves/<name>.json` across and load it with `board_save`.
- **Lifecycle and privacy**: stdout carries only JSON-RPC (diagnostics go to stderr), nothing listens beyond loopback, and there is no telemetry. When the client disconnects or on SIGINT/SIGTERM the server flushes the autosave, closes the headless browser and exits. `/board` (and `/board export`) are Pi commands; the MCP server has no counterpart.
- **Dependencies**: the server uses the official MCP TypeScript SDK in its current stable major, v2, which ships as `@modelcontextprotocol/server` (the older single `@modelcontextprotocol/sdk` package is the v1 maintenance line), pinned in `dependencies`; the tests use `@modelcontextprotocol/client` (a dev dependency). It builds the schemas with `typebox`, the TypeBox that Pi passes to extensions, so it is an `optionalDependency` pinned to Pi 1.4.0's version: Pi warns when a package lists a host-provided package (`typebox`, `@earendil-works/pi-ai`, …) in `dependencies`, and nothing in the extension imports it. `npm ci` installs optional dependencies; don't pass `--omit=optional` if you use the MCP server.

## Viewing controls

| Action | Keys / mouse |
|---|---|
| Pan | scroll / two-finger swipe, drag, Shift+arrows |
| Zoom at cursor | ⌘/Ctrl+scroll, pinch, `+` / `-` |
| Step back / forward through the lesson | `←` / `→` |
| Replay the chapter in view | `r` (or Replay) |
| Play on from the current step / pause | `Space` |
| Back to live (latest step) | `End` |
| Previous / next chapter | `[` / `]`, PageUp / PageDown |
| Whole lesson | `o` (Overview) |
| Follow Pi's camera again | `f`, double-click, `0` (Follow) |
| Reference an item for Pi | hover shows `step n · id · chapter`; click copies `step n, id (chapter c)` to the clipboard, to paste into the terminal |

The controls and a `step n / N` indicator appear in the top-right on hover. Manually panning pauses camera following until you press Follow.

## How lessons are built

- **Coordinates**: each chapter (and the home board) is a 1200×800 space, origin top-left. Text `y` is the baseline; equation `x,y` is the top-left of its box; rect/ellipse/artifact `x,y` is the top-left corner.
- **Chapters**: named 1200×800 regions placed left-to-right on an unbounded canvas. Items with `chapter: id` use chapter-local coordinates, so moving a chapter moves its content. Deleting a chapter erases its items unless `keepItems`.
- **Camera**: `camera: {chapter}` (or a board rect, or `null` for home) glides every following viewer to where Pi is teaching, with a smooth pan/zoom.
- **Steps & animation**: every `board_update` that adds items is one lesson step. New steps are drawn live: diagrams sweep in, strokes are traced like handwriting, plots are drawn axis-and-curve, text and equations are written left to right. Items can set `step`, `reveal` (`draw`, `write`, `wipe`, `fade`, `none`), `duration` and `order`. Emphasis uses the same machinery: an ellipse with `reveal:"draw"` circles a term, a translucent rect with `reveal:"wipe"` highlights it.
- **Layering**: `z` orders items of every kind; `opacity`, `dash`, `fill`, text `font` (`serif`/`sans`/`mono`), `anchor`, `bold`, `italic`, multi-line text.

### Rendering defaults

- Mermaid diagrams use a chalk theme: serif text, dark nodes with chalk outlines and chalk edges, with opaque label backgrounds so edges never cross their labels. The layout check warns when a diagram is shrunk until its text falls below about 12 px, and says how large it needs to be.
- Plots draw tick, axis, curve and marker labels (`vlines`/`hlines` `label`) on top of the curves with a thin black outline; the y-axis label sits above the plot area. Molecules are framed to the drawn structure so they fill their box (zoom capped at about 2x). In zoomed-out views (Overview, overview snapshots) chapter titles keep a readable size on screen.
- `node scripts/demo-lessons.mjs <out-dir> [physics|mri|chem]` builds three sample lessons through the real tools and writes every chapter, the camera view and the overview at 1200 and 1600 px plus `warnings.json`. Like `e2e-snapshot.mjs`, it needs pi installed or `PI_HOST_ROOT` set.

## Model tools

| Tool | Purpose |
|---|---|
| `board_open` | Open the board: starts the server, opens the browser (interactive mode only) and switches on the other board tools, which stay inactive until then so an unused board costs the model about 235 characters per turn instead of about 22,000. Returns the URL; safe to call again. `/board open` (and `/board load`) also switch the tools on. |
| `board_read` | Revision, title, chapter table of contents, camera, steps, and the layout (id, type, position, size) of one chapter at a time (`chapter` param; default: the camera's chapter). Read before updating. |
| `board_update` | Compare-and-swap update (`baseRevision`). `chapters`, `equations` (add/update/delete), `scene` (`shapes`, `artifacts`; append/replace), `items` (update/move/delete **any** item by id), `camera`, `title`, `clear`. After each update the rendered layout is measured and overlapping text/equations, overlapping artifacts, items spilling out of their chapter and artifacts that failed to render are reported. |
| `board_snapshot` | PNG of the board as the viewer sees it (default: what the camera shows; or `chapter`, `overview`, `region`, `width`), plus each item's measured bounding box and layout warnings. Uses Playwright's bundled Chromium or the system Chrome; the headless page closes after 5 idle minutes. |
| `board_library` | Search the offline illustration library by keyword/category; returns icon ids. |
| `board_save` | `save` / `list` / `load` named snapshots (`load` requires `baseRevision`). |
| `board_docs` | Reference text by `topic` (`overview`, `workflow`, `chapters`, `equations`, `marks`, `plot`, `svg`, `mermaid`, `molecule`, `icon`, `animation`, `layout`, `saves`): artifact formats with examples, SVG rules, plot expression grammar, reveal/animation options, chapters and camera, layout conventions, saves. |

The tools are defined once, in `tools.mjs`, and the MCP server offers the same seven (see [Use from Claude Code (MCP)](#use-from-claude-code-mcp)).

Inside the learning folder (`~/Learn`, or `$PI_LEARN_DIR`), and not in subagents, the extension adds a short, constant `board_teaching` section to the system prompt: when to draw, one step then one check question, one concept per chapter, and reading the board to resolve references like "step 4, eq2".

### Artifact types (`scene.artifacts`)

```jsonc
{ "type": "svg", "source": "<svg viewBox=…>…</svg>", "x": 40, "y": 90, "width": 680, "height": 520 }
{ "type": "mermaid", "source": "graph LR\n  A[Input] --> B(Process) --> C[Output]", "x": 620, "y": 120, "width": 420, "height": 200 }
{ "type": "plot", "x": 40, "y": 40, "width": 560, "height": 360, "xRange": [-6.3, 6.3],
  "functions": [{ "expr": "sin(x)", "label": "sin x" }, { "expr": "x^2/8 - 1", "dash": "7 5" }],
  "areas": [{ "expr": "sin(x)", "from": 0, "to": 3.14159 }], "points": [{ "x": 0, "y": 0, "label": "O" }],
  "parametric": [{ "x": "cos(t)", "y": "sin(t)", "t": [0, 6.283] }], "vlines": [{ "x": 3.14159 }],
  "xLabel": "x", "yLabel": "y", "equalAspect": false }
{ "type": "molecule", "smiles": "CC(=O)Oc1ccccc1C(=O)O", "x": 640, "y": 40, "width": 260, "height": 200 }
{ "type": "icon", "icon": "heart-cross-section-2", "x": 700, "y": 100, "width": 220, "card": true }
```

All artifacts accept `chapter`, `z`, `opacity`, `label`, `step`, `reveal`, `duration`, `order`. Plot expressions support `+ - * / ^`, implicit multiplication (`2x`, `3(x+1)`), `pi`, `e`, `tau` and `sin cos tan asin acos atan sinh cosh tanh sec csc cot exp ln log log2 log10 sqrt cbrt abs sign floor ceil round min max pow atan2 hypot mod step sinc gauss`. `card:true` puts an illustration on a soft light panel (for drawings made for white paper).

**SVG rules**: shapes, `line`, `text`/`tspan`/`textPath`, `defs`/`symbol`/`use`, markers, gradients, patterns, clip paths, masks, a `<style>` block and SMIL animation are allowed. Scripts, `foreignObject`, `image`, external URLs, `data:` URIs and `@import` are rejected; `url(…)` and `href` must point to an `#id` inside the same SVG; every attribute must be quoted. A missing `xmlns` is added automatically. Errors name the offending element or attribute; an SVG that is not well-formed XML shows a red "failed to render" box and is reported in the layout check.

## Persistence

- **Autosave**: every change is written (debounced, atomically) to `.data/autosave.json`; a fresh board server restores it on start, so `/reload` or restarting Pi keeps the board.
- **Named snapshots**: `/board save name`, `board_save`, or the Save button write `.data/saves/<name>.json`. Loading re-validates everything; unsupported items are skipped rather than failing the load.
- **Lesson export**: `/board export [name]` writes the running board to `viz/board-<name>-<YYYYMMDD-HHMM>/` in Pi's current folder, adding `-2`, `-3`, … rather than overwriting: `board.json` (the named-save format: copied to `saves/<name>.json` in the data directory it loads with `/board load <name>`), `chapter-<id>.png` per chapter (1600 px, rendered like `board_snapshot`), `home.png` for items outside the chapters (unless a chapter covers the home board), `overview.png` when there is more than one region, and `lesson.md`, a note with standard markdown image links for Obsidian and GitHub. It is manual only: it runs when you type it, never on autosave, shutdown or from a model tool, and it never starts a board server. Without a headless browser it still writes `board.json` and `lesson.md` and says why the images are missing.
- **Data directory**: `.data/` inside the package (git-ignored, so boards never end up in commits), unless `PI_MATH_BOARD_DATA_DIR` points elsewhere. The MCP server uses `.data/mcp/` instead, so its board and Pi's never share an autosave. The tests and scripts always use temporary directories, so they never touch real saves.
- Limits: 200 chapters, 1000 equations, 5000 shapes, 100 artifacts per update, 6 MiB per board, 128 KiB per SVG.

## Safety

- Loopback-only server, random bearer token per session, exact Host/Origin checks, bounded request bodies, compare-and-swap revisions, atomic saves.
- The page is view-only; browser actions never trigger Pi turns.
- KaTeX renders with `trust:false`, strict mode and expansion limits. Labels and text are inserted as text, never HTML.
- SVG, Mermaid, molecules and icons are all displayed through `<image>` (image context: no scripts, no external loads), after allowlist validation. Mermaid runs with `securityLevel: strict` and rejects links, callbacks and embedded markup. SMILES strings are restricted to SMILES characters. Plot expressions are compiled by a small parser (`shared/expr.mjs`) that only knows arithmetic, a fixed function table and the plot variables.
- Static files come from an explicit allowlist; icons are pre-sanitized at build time with the same validator.
- Source-change detection: tool output warns if the extension's files changed after the server loaded; `/reload` picks up server changes (server code is imported with a version query).

## Icons and credits

The illustration library is built by `npm run build:icons` (downloads Bioicons, keeps CC0, CC-BY 3.0/4.0, MIT and BSD icons up to 128 KiB, inlines their CSS, strips editor metadata, filters, raster images and external references, and validates each with the board's SVG validator). Author and license for every icon are listed in `public/icons/CREDITS.md`; CC-BY icons require attribution to their authors if you publish material that uses them.

## Build and tests

```sh
cd ~/math-board
npm ci --legacy-peer-deps   # plain `npm ci` also works with npm 10.9 and 11
npm run build          # bundle the browser app into public/
npm run build:icons    # (re)build the icon library (network)
npm test               # unit/HTTP/hardening tests, and the MCP server driven over stdio
npm run test:browser   # Playwright browser tests
npm run test:load      # real Pi loader + /reload regression
node scripts/e2e-snapshot.mjs   # end-to-end: update → layout check → snapshot → /board export
```

`npm run test:load` and `scripts/e2e-snapshot.mjs` load the extension through Pi's real loader, so they need Pi installed globally (`npm install -g @earendil-works/pi-coding-agent`; they find it with `npm root -g`) or `PI_HOST_ROOT` set to an installed `@earendil-works/pi-coding-agent` package directory:

```sh
PI_HOST_ROOT=/path/to/node_modules/@earendil-works/pi-coding-agent npm run test:load
```

Set `PI_HOST_ROOT` as well when `npm root -g` prints a masked path (npm 11 hides UUID-like path segments). `npm test` includes `test/mcp.test.mjs`, which spawns `node mcp/server.mjs` with a temporary data directory and `MATH_BOARD_NO_BROWSER=1` and talks to it with the MCP SDK client; its `board_snapshot` check is skipped, with the reason, when no headless browser is available. The browser tests need Playwright's Chromium (`npx playwright install chromium`); the snapshot script uses it too, or the system Chrome, and writes `/tmp/board-e2e.png` unless given another path; its `/board export` goes to a temporary folder. CI (`.github/workflows/ci.yml`) runs `npm test`, `test:browser` and `test:load` (against pi 1.4.0) on Node 22 for every push and pull request to `main`.

Research notes on prior art (tldraw agent kit, TheoremExplainAgent, Code2Video, HeyTutor, Manim-style timelines, etc.) are in `docs/prior-art.md`.
