# Pi Blackboard

A full-window, black chalkboard in your browser that Pi draws on while it explains things, like a professor at a blackboard. It is **view-only for you**: Pi places equations, diagrams, plots, molecules and illustrations through tools; you watch them being drawn, step back and forth through the lesson, pan and zoom. Everything runs locally and offline (no CDN, no extra model or API keys).

What Pi can draw:

- **Math**: KaTeX equations (`\color`, `\boxed`, `\cancel`, …), chemistry with `\ce{…}` (mhchem)
- **Plots**: function graphs, parametric curves, shaded areas, points, asymptotes (safe expression parser, no `eval`)
- **Molecules**: 2D structures from SMILES strings (SmilesDrawer)
- **Science illustrations**: ~2000 offline Bioicons (anatomy, organs, cells, organelles, blood/immunology, microbes, viruses, DNA, plants, animals, lab equipment), searchable by keyword
- **Diagrams**: hand-authored SVG (markers, gradients, symbols, CSS, SMIL animation) and Mermaid (flowcharts, sequence, class, state, ER, gantt, mindmaps, graphs; auto-layout)
- **Marks**: lines, arrows, curves, rectangles, ellipses, text (LaTeX-style serif by default)

## Start

The extension lives in Pi's user extension directory. Run `/reload` (or restart Pi), then:

```text
/board            # open the board in your browser (also /board open)
/board status     # server URL, revision, autosave/chapters info
/board save name  # named snapshot      /board load name   # restore it
/board clear      # clear everything (or: /board clear equations|scene)
/board stop       # stop the server
```

Ask Pi to explain something "on the board". The server starts lazily on first use, listens only on `127.0.0.1`, and the URL carries a private `#token=…`: don't share it.

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

The controls and a `step n / N` indicator appear in the top-right on hover. Manually panning pauses camera following until you press Follow.

## How lessons are built

- **Coordinates**: each chapter (and the home board) is a 1200×800 space, origin top-left. Text `y` is the baseline; equation `x,y` is the top-left of its box; rect/ellipse/artifact `x,y` is the top-left corner.
- **Chapters**: named 1200×800 regions placed left-to-right on an unbounded canvas. Items with `chapter: id` use chapter-local coordinates, so moving a chapter moves its content. Deleting a chapter erases its items unless `keepItems`.
- **Camera**: `camera: {chapter}` (or a board rect, or `null` for home) glides every following viewer to where Pi is teaching, with a smooth pan/zoom.
- **Steps & animation**: every `board_update` that adds items is one lesson step. New steps are drawn live: diagrams sweep in, strokes are traced like handwriting, plots are drawn axis-and-curve, text and equations are written left to right. Items can set `step`, `reveal` (`draw`, `write`, `wipe`, `fade`, `none`), `duration` and `order`. Emphasis uses the same machinery: an ellipse with `reveal:"draw"` circles a term, a translucent rect with `reveal:"wipe"` highlights it.
- **Layering**: `z` orders items of every kind; `opacity`, `dash`, `fill`, text `font` (`serif`/`sans`/`mono`), `anchor`, `bold`, `italic`, multi-line text.

## Model tools

| Tool | Purpose |
|---|---|
| `board_read` | Revision, title, chapter table of contents, camera, steps, and the layout (id, type, position, size) of one chapter at a time (`chapter` param; default: the camera's chapter). Read before updating. |
| `board_update` | Compare-and-swap update (`baseRevision`). `chapters`, `equations` (add/update/delete), `scene` (`shapes`, `artifacts`; append/replace), `items` (update/move/delete **any** item by id), `camera`, `title`, `clear`. After each update the rendered layout is measured and overlapping text/equations, overlapping artifacts, items spilling out of their chapter and artifacts that failed to render are reported. |
| `board_snapshot` | PNG of the board as the viewer sees it (default: what the camera shows; or `chapter`, `overview`, `region`, `width`), plus each item's measured bounding box and layout warnings. Uses Playwright's bundled Chromium or the system Chrome; the headless page closes after 5 idle minutes. |
| `board_library` | Search the offline illustration library by keyword/category; returns icon ids. |
| `board_save` | `save` / `list` / `load` named snapshots (`load` requires `baseRevision`). |

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
- `PI_MATH_BOARD_DATA_DIR` overrides the data directory (the test scripts use temporary directories so they never touch real saves).
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
cd ~/.pi/agent/extensions/math-board
npm ci --legacy-peer-deps
npm run build          # bundle the browser app into public/
npm run build:icons    # (re)build the icon library (network)
npm test               # unit/HTTP/hardening tests
npm run test:browser   # Playwright browser tests
npm run test:load      # real Pi loader + /reload regression
node scripts/e2e-snapshot.mjs   # end-to-end: update → layout check → snapshot
```

Research notes on prior art (tldraw agent kit, TheoremExplainAgent, Code2Video, HeyTutor, Manim-style timelines, etc.) are in `docs/prior-art.md`.
