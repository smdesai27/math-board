# Design

Why math-board is built the way it is. The short version: the model draws and I watch, everything stays on my machine, and the tutor checks its own layout with measurements instead of guessing from a picture.

## View-only, by design

I never draw on the board. The tutor does.

Nearly every tool I looked at that lets an agent draw also lets the human draw back: tldraw, Excalidraw, draw.io, Miro. That decides what the page has to be. It becomes an editor, with an editor's state merging and an editor's attack surface. A view-only page can be a renderer of validated data and nothing more.

It also keeps the roles clear. The conversation and the learner's answers stay in the terminal. The board is the professor's blackboard, not a shared notebook.

What I can do on the page: pan, zoom, step back and forward, replay a chapter, see the whole lesson, follow the tutor's camera. Hovering an item shows `step n · id · chapter`, and a click copies it, so I can say "step 4, eq2" in the terminal without the page ever talking to the model. Clear and Save are the only buttons that write, and Clear asks again if the board changed while I was deciding.

Sliders on a plot are the one control that changes what an item shows. They still don't write: the values live in my tab, so the tutor, the snapshots and other tabs see each slider where the tutor set it, and a click on the plot copies a reference with my values, so I can say "with w = 4.5" in the terminal. The expressions they feed are the same JSON the server checked; moving a slider runs no new code.

Because the page never talks to the model, the tutor can't tell on its own whether I'm watching. The server can, so read, update and load results end with "No browser is showing the board" when nobody is, and the tutor knows to call `board_open` instead of drawing for an empty room. The headless page behind the layout checks doesn't count as a viewer.

## One implementation, two adapters

`tools.mjs` holds every tool's name, description, schema and handler, plus the `board_docs` reference and the `board_teaching` text. `index.ts` adapts it to pi. `mcp/server.mjs` adapts it to MCP. Each adapter owns only what its host has: pi gets lazy activation, `/board`, the prompt section and `/board export`; MCP gets server instructions and the stdio lifecycle.

Why: one learner workflow across every agent. If the Claude Code board drifted from the pi one, a learner would have two tools to learn, and every fix would have to happen twice. pi builds the schemas from `tools.mjs` with its own TypeBox when it loads the extension. The MCP server reads them from `mcp/schemas.json`, which `npm run build` writes from the same code, so it needs no TypeBox at runtime. The tests check that both sides send the model identical names, descriptions and JSON schemas, and CI fails if `mcp/schemas.json` is stale.

The two boards are separate on purpose: separate servers, tokens and data folders (the MCP board uses the `mcp/` subfolder), so one agent can never overwrite the other's autosave. Moving a lesson between them is copying a save file.

## Compare-and-swap revisions

The board has one state and one revision number that only goes up. Every write says which revision it was based on, and a stale write is rejected instead of merged.

There is more than one writer: the tutor, the page's Clear button, `/board load` and `/board clear` typed in pi, a second tool call still in flight. Merging edits from a model is a problem I don't need. On a conflict the tutor calls `board_read` and re-applies what it meant to do against the board as it is now, and the tool description tells it never to retry blindly. It's cheap to build and it means work is never lost silently.

## Chapters are 1200×800

The home board and every chapter are a 1200×800 space, origin top-left, y down. Chapters sit left to right on an unbounded canvas, and items inside a chapter use its local coordinates.

Why a fixed frame: models place things better in a bounded space they can reason about than on an infinite canvas, and a fixed frame turns "this spilled out" into a warning the server can check. 3:2 is close to a laptop screen, so a chapter fills the window when the camera lands on it. Local coordinates mean a chapter can move without rewriting its contents.

The teaching rule is one concept per chapter. The chapter is that concept's place on the board, and the camera takes me to the one being taught.

An equation given without `x,y` is stacked down the left side of its own chapter, and the position it gets is stored. Placing it once, in its chapter, means `board_read` reports where it really is, nothing moves when something else on the board changes, and "step 4, eq2" still points at the same place later.

## Steps

Every `board_update` that adds items is one lesson step. That matches the rhythm (draw one step, ask one question) and makes replay free: stepping back is just showing fewer steps. Items can set their own `step`, `reveal`, `duration` and `order` when one call should build up in parts.

## Layout checks, not vision critique

After every update a headless copy of the page (the same one `board_snapshot` uses) measures what it actually rendered, and the tool result lists what's wrong: overlapping text and equations, overlapping artifacts, items outside their chapter, artifacts that failed to render, and Mermaid diagrams shrunk until their text is unreadable (with the size they need). This update's problems come first. `board_snapshot` also returns each item's measured box.

Why: asking a model to look at a screenshot and say what's wrong is slow, spends image tokens, and misses small overlaps. A measured box is exact and tells the tutor what to move and by how much. The snapshot is still there for when the tutor needs to see the board, but the numbers come first. tldraw's canvas linting pointed this way, and even the vision critics that work, like Code2Video's, get a placement vocabulary to work with (see [prior-art.md](prior-art.md)).

## Small at rest

Not every pi session is a lesson, so an unused board shouldn't tax every turn. In pi only `board_open` is active until the board is opened: 255 characters per turn instead of 12,204 for all seven tools. The long reference (artifact formats, SVG rules, plot grammar, animation, layout) lives in `board_docs`, which the tutor fetches by topic before it uses a format for the first time. The `board_teaching` section is constant text, so the prompt cache holds.

## Strict input, honest reports

The board rejects what it doesn't understand instead of guessing. An unknown or misspelled field, a number sent as a string, an empty text, a bad or duplicate id: the whole update is refused with the reason, and nothing in it is applied. A field the board quietly ignored would be something the tutor believes it drew, and I'd be looking at a board that doesn't match the explanation.

Loading goes the other way, for the same reason. A save or an autosave from an older version may hold things this one can't use, so those are skipped rather than failing the whole lesson, but the result says what was skipped and how many. An autosave that can't be restored at all is moved aside and reported, not overwritten.

The SVG check follows the same idea. It parses the source with a real XML parser, checks the parsed tree (names, and attribute and CSS values after decoding), and writes the SVG back out from the tree. A check that reads the raw text can disagree with the browser's parser; checking the tree and storing what was checked can't.

## Local only

Everything renders in my browser from files in `public/`. KaTeX, Mermaid, SmilesDrawer and React are bundled at build time, the illustrations are an offline library, the fonts are local, and the layout checks and snapshots use a headless Chromium on the same machine, with its sandbox on. No CDN, no cloud, no extra API keys, nothing to pay for. The model I already tutor with is the only model involved.

Lessons live in a folder on my machine too. A checkout keeps them in `.data/` next to the code. An installed copy gets replaced or cleaned on update, so it keeps them in a per-user folder instead (Application Support on macOS, `$XDG_STATE_HOME` or `~/.local/state` on Linux, `%LOCALAPPDATA%` on Windows), and `MATH_BOARD_DATA_DIR` overrides both.

It also keeps the security story short: loopback, a token, and a page that only renders validated data. [SECURITY.md](../SECURITY.md) has the details.

## html artifacts: code, fenced in, off by default

Some things don't fit any declarative format: a 3D model you can turn, a pendulum that actually swings. For those the model can write HTML and JavaScript, the way Claude's artifacts work, if I start the board with `MATH_BOARD_HTML=1`. Sliders on plots come first, though: they cover most "what happens when this changes" questions at a fraction of the tokens, and nothing in them runs.

Why off by default: it reverses the rule above, it costs the tutor thousands of output tokens per diagram, it's the one part of the board where a mistake can freeze my tab, and the sandbox can't close every network path (WebRTC from a nested frame gets out; see SECURITY.md), so a prompt-injected artifact could leak what's in it. Turning it on is a decision I make for my own setup.

How it's fenced: each artifact gets a sandboxed frame with an opaque origin, served with its own policy that blocks network requests, that can load only the libraries the board ships (three.js, d3, matter.js, lil-gui, fft.js, KaTeX), so a 3D scene is 30 lines instead of 300. The frames live in a layer over the board rather than inside the SVG, because Safari neither scales nor places a frame inside `foreignObject`; a small sync step puts each one over its slot on every pan, zoom, step and fade.

A frame can't hurt the board page, but it can block it: sandboxed frames from the same host share the page's process in Safari and Chromium, so `while (true) {}` freezes the tab. Each new frame therefore runs first in the headless layout check, one at a time, and my browser gets it only after it reported ready there; a layout check goes through every new frame its update added, so the tutor hears about each one in that update's result. That catches mistakes, not code written to slip past it, so a frozen tab has a way out: `&html=off` after the token loads no frame in that tab. The check page loads frames only during its calls (a layout check just the one it checks, a snapshot all of them) and unloads them afterwards, so no model code runs there between calls, and my own tab loads a frame only when its chapter comes near the screen.

## What I left out on purpose

- **Human drawing.** See above. If I want to say something, I say it in the terminal, where the tutor reads it.
- **Automatic export.** `/board export` runs only when I type it: never on shutdown, never on autosave, never from a model tool. Lessons I want to keep, I keep on purpose. I don't want a folder of every board I ever opened.
- **Cloud anything.** No accounts, no sync service, no hosted rendering, no bundled model with its own keys. The voice-first tutors I looked at all do this, and it's exactly why none of them can be reached from pi.
- **Model-written code, by default.** Manim-style generators have the model write code that then runs. Here the model sends JSON that gets validated. It's less expressive, and nothing the model writes is executed, unless I turn on html artifacts (below).

## Open

Not done yet, roughly in the order I want them:

- **Equation morphs.** A derivation step that transforms the line above in place (terms moving, cancelling, regrouping) instead of always writing a new line. The idea is Manim's `TransformMatchingTex`.
- **Layout maps.** Named anchors or a free-space map for each chapter, so the tutor places items by region instead of raw coordinates and the warnings can say where there is room. Code2Video found a coarse grid beat free placement.
- **Vectors.** A first-class vector item in plot coordinates, for forces, fields and magnetization, so an arrow sits on the axes it belongs to instead of being placed by hand next to them.
- **Quiz mirroring.** The questions Eero's quiz extension asks in the terminal, shown on the board next to the drawing they're about, without changing his extension.

The full survey of what else exists, and what's worth borrowing, is in [alternatives-2026-10-27.md](alternatives-2026-10-27.md).
