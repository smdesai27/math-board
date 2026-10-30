# Changelog

## 0.3.1 (2026-10-30)

Documentation changes only. No code changes.

## 0.3.0 (2026-10-27)

The first public release. Everything before it was unreleased and were never released.

**The board**

- A full-window black chalkboard on `127.0.0.1`, view-only: the model draws through tools, you watch.
- KaTeX equations with mhchem chemistry; function, parametric and area plots; molecules from SMILES; about 2000 offline Bioicons; hand-written SVG; Mermaid diagrams; lines, arrows, strokes, rectangles, ellipses and text.
- Chapters: named 1200×800 regions on an unbounded canvas. A camera that moves every following viewer to the chapter being taught.
- Equations without `x,y` stack down the left side of their own chapter, and the position is stored, so they never move when something else changes.
- Every update that adds items is one lesson step, drawn live (traced, written, wiped or faded) and replayable. Step back and forward, replay a chapter, play on, overview.
- Hover references: hovering an item shows `step n · id · chapter`, and a click copies `step n, id (chapter c)` so you can point at it in the terminal.
- After `/reload` or `/board stop`, the next board in the same process reuses the port and token, so an open tab reconnects by itself. If the server is gone for good, the page says so after about 10 seconds.

**Tools**

- `board_open`, `board_read`, `board_update`, `board_snapshot`, `board_library`, `board_save` and `board_docs`, defined once in `tools.mjs`.
- Compare-and-swap revisions on every write, and a measured layout check after every update: overlapping text and equations, overlapping artifacts, items outside their chapter, artifacts that failed to render, this update's problems first.
- Strict input: an unknown or misspelled field, a wrong type, an empty text or a bad or duplicate id rejects the whole update with the reason, and nothing is applied.
- Read, update and load results end with "No browser is showing the board" when nobody is watching, so the tutor knows to call `board_open`. The headless snapshot page doesn't count as a viewer.
- `board_open` puts the URL, with its token, in the model's result only when no browser could be opened.
- `board_snapshot` returns a PNG of what the viewer sees plus each item's measured box. The headless Chromium behind it and the layout check runs with its OS sandbox (without it only where it can't start, and the results say so), recovers from a crashed page, and has a time limit on every call.
- Lazy activation in pi: only `board_open` is active until the board is opened, so an unused board costs the model 255 characters per turn instead of 12,197 for all seven tools.
- `board_docs`: the long reference (artifact formats, SVG rules, plot grammar, animation, chapters, layout, saves) fetched by topic instead of sitting in every tool schema.
- `board_teaching`: a short, constant system prompt section in the learning folder (`~/Learn` or `$MATH_BOARD_LEARN_DIR`, which also reads `PI_LEARN_DIR`; not in subagents). `MATH_BOARD_TEACHING=always` or `never` overrides where it appears; the default is `auto`. Read, draw one step, ask one check question.

**Safety**

- SVG is parsed with a strict XML parser (`@rgrove/parse-xml`), checked on the parsed tree (names, decoded attribute and CSS values) and written back out from it.
- Mermaid `%%{…}%%` directives are rejected.

**Saves and export**

- Lessons live in `.data/` in a checkout and in a per-user folder for an installed copy, from npm, npx or pi's git install (`~/Library/Application Support/math-board`, `$XDG_STATE_HOME/math-board` or `~/.local/state/math-board`, `%LOCALAPPDATA%\math-board`). `MATH_BOARD_DATA_DIR` overrides it; `PI_MATH_BOARD_DATA_DIR` still works.
- Debounced, atomic autosave with three older copies, restored when the server starts. A failed write is reported. An autosave that can't be restored is moved aside as `autosave.corrupt-<time>.json` and reported, never overwritten.
- Loading a save or restoring the autosave skips what it can't use and says what and how many, instead of dropping it silently. Saves carry a format version.
- A `board.lock` file warns when two boards share a data folder.
- Named snapshots with `/board save`, `board_save` or the Save button.
- `/board export [name]` writes `board.json`, a PNG per chapter, home and overview images, and `lesson.md` into `./viz/`, as private files. Manual only.

**MCP server**

- `mcp/server.mjs` (`npx -y pi-math-board`): the same seven tools over stdio for Claude Code and other MCP clients, with `board_teaching` as the server instructions. Its own board, token and data folder: the `mcp/` subfolder of the data folder above. `MATH_BOARD_NO_BROWSER=1` returns the URL without opening a browser.

**Packaging and CI**

- Three runtime dependencies: the MCP SDK, `playwright-core` and `@rgrove/parse-xml`. The browser libraries (React, KaTeX, Mermaid, SmilesDrawer) are bundled at build time and moved to devDependencies, and Excalidraw is gone. The MCP tool schemas are generated at build time into `mcp/schemas.json`.
- `THIRD_PARTY_NOTICES.md`, generated by the build from the bundle, with the full license texts.
- CI runs a TypeScript type check of `index.ts` against pi's types, and fails when `public/`, `mcp/schemas.json` or `THIRD_PARTY_NOTICES.md` don't match a fresh build.

**Visual fixes from building real lessons**

- Plot tick, axis and marker labels draw above the curves with a dark outline; the y-axis label sits above the plot; `vlines` and `hlines` labels render.
- Mermaid has a chalk theme (serif text, dark nodes, opaque edge labels, larger arrowheads), and the layout check warns when a diagram is shrunk until its text is unreadable.
- Molecules are framed to the drawn structure so they fill their box.
- Chapter titles and frames stay readable in the overview.
