# Prior Art: AI Professor Blackboard
**Scope:** Browser-based, LLM-tool-driven visualization surfaces for teaching — math, plots, geometry, chemistry, biology/anatomy, physics, CS diagrams — with long multi-step lessons and step-by-step animation. Our stack: local Node HTTP server + React SVG page; LLM emits JSON (KaTeX, shapes, sanitized SVG, Mermaid); human is view-only.

**Compiled:** 2026-10-27 · Researched via live web search + source fetches. All URLs verified reachable.

---

## 1. LLM-driven whiteboards, tutors, and canvas products

### 1.1 tldraw family (the richest prior art for "agent + canvas")

- **Make Real** — https://makereal.tldraw.com/ · repo: https://github.com/tldraw/make-real (archived) · starter template: https://github.com/tldraw/make-real-starter
  Sketch a UI, prompt a model, get working HTML previewed live on the canvas. The original prompt sent a **PNG screenshot + SVG export of the selection** to GPT-4o and asked for a single self-contained HTML file. Backstory: https://tldraw.dev/blog/make-real-the-story-so-far
  **Idea to steal:** the "screenshot + vector export of just the relevant region" prompt pattern; regenerating from current state each time (idempotent, no long-lived patch model).

- **tldraw computer** — https://computer.tldraw.com/ (collab with Google AI Studio: https://aistudio.google.com/case-studies/tldraw)
  Infinite canvas of cells; each tappable cell runs an LLM ("LLM as runtime" / "natural language computing"); cells connect into pipelines, outputs feed inputs; multiplayer.
  **Idea to steal:** board regions as *composable* cells — e.g., a "plot" cell fed by a "function" cell; grid-based lesson layout where each step has a home.

- **Agent starter kit** — https://tldraw.dev/starter-kits/agent (scaffold: `npm create tldraw@latest -- --template agent`) · template repo: https://github.com/tldraw/agent-template
  Full agent loop over the canvas: create/update/delete shapes, pen strokes, higher-level ops (align/distribute/stack), move its own viewport, todo list, scheduled follow-ups. Context system is the key: **screenshot of viewport + "BlurryShape" (in-viewport overview: bounds/id/type/text) + "FocusedShape" (full detail) + "PeripheralShapeCluster" (grouped bounds+count for shapes off-screen)**. Streaming: shapes apply incrementally as actions stream in.
  **Idea to steal:** the tiered-shape-JSON context format (in-view vs focused vs peripheral), `sanitizeAction()` layer that fixes hallucinated shape IDs/coordinates before applying, and the action-JSON schemas with `meta({title, description})` for tool descriptions.

- **Spatial harness blog: "How we built a spatial harness for agents on the canvas"** — https://tldraw.dev/blog/harnessing-the-agents
  tldraw's answer to "coding agents are bad at 2D": agents **write code against the live `Editor` API** (CodeAct/Code Mode style) instead of discrete tool calls; canvas context moved behind tool calls the agent pulls on demand (RLM-inspired); **canvas linting** warns the agent when e.g. two text shapes overlap. Noted that agents behave differently on canvas: they organize hierarchically, take space, draw when explaining.
  **Idea to steal:** a lint step that returns machine-checkable warnings (overlap, off-viewport, tiny text) as tool output — cheaper and more actionable than vision-model critique.

- **tldraw AI integrations docs** — https://tldraw.dev/docs/ai
  Three patterns: canvas as **output surface** (embed/custom shapes incl. `srcdoc` iframe with `sandbox="allow-scripts"` for AI-generated HTML), **visual workflows** (AI as nodes in node-graph), **agents** (read+manipulate). Export API: `editor.getSvgString(...)` / `editor.toImage(...)`; explicit advice: **"Sending both to the model works best: the image shows spatial relationships and styling, and the structured data gives exact text and positions."**
  **Idea to steal:** a built-in `render` tool that returns PNG *and* compact shape JSON in one call.

- **tldraw SVG sanitizer** — https://github.com/tldraw/tldraw/pull/7896 (fix for issue #7876, merged 2026-02)
  ~643-line allowlist sanitizer derived from DOMPurify's tag/attribute tables; SVG-mode ↔ HTML-mode switching at `foreignObject` boundaries; hard URI rules (`image`→raster `data:` only, `use`→fragment-only, `a`→http/https/mailto); strips `@import`, `expression()`, external `url()` in CSS. Exported as `sanitizeSvg(svgText)`.
  **Idea to steal:** the URI/CSS hardening rules are a ready-made spec for our SVG ingest path.

### 1.2 AI tutors / pedagogy-driven systems

- **Khanmigo (Khan Academy)** — https://www.khanmigo.ai/ · GPT-4 partnership: https://openai.com/index/khan-academy/
  Socratic tutor ("guide, don't give answers"), safety-first guardrails, teacher/learner dual personas.
  **Idea to steal:** tutor persona prompts: level-appropriate pacing, check-questions between board steps, refuse to just dump derivations.

- **Google LearnLM** — paper: https://arxiv.org/abs/2412.16429 ("LearnLM: Improving Gemini for Learning") · announcement: https://blog.google/products-and-platforms/products/education/google-learnlm-gemini-generative-ai/
 Pedagogical instruction-following via *system-level pedagogy specs* in training/eval: manages cognitive load, activates prior knowledge, encourages active engagement. Infused into Gemini ("world's leading model for learning" per I/O 2025: https://blog.google/products-and-platforms/products/education/google-gemini-learnlm-update/).
  **Idea to steal:** write our own compact "teaching-spec" into the board agent's system prompt: plan → set context → draw step → check understanding → summarize; one concept per board region.

- **Google "Learn About"** — https://learning.google.com/experiments/learn-about — conversational learning companion with **interactive visual guides** ("quizzes and AI-generated images to test understanding").

- **Google "Learn Your Way"** — https://learnyourway.withgoogle.com/ · research blog: https://research.google/blog/learn-your-way-reimagining-textbooks-with-generative-ai/ · "Towards an AI-Augmented Textbook": https://arxiv.org/abs/2509.13348
 Transforms static textbook PDFs into interactive, personalized learning journeys with navigable concept maps and AI-generated visual explanations.
  **Idea to steal:** import source material (textbook/PDF), auto-generate a lesson outline with a concept graph, then let board steps trace it.

### 1.3 Canvas-as-artifact products

- **Claude Artifacts** — https://support.claude.com/en/articles/17153992-what-are-artifacts-and-how-do-i-use-them · feature page: https://claude.com/features/artifacts
 Side-panel artifacts: React/SVG/HTML/Mermaid/Markdown, versioning, one-click remix. The leaked artifacts system prompt (https://gist.github.com/dedlim/6bf6d81f77c19e20cd40594aa09e3ecd) is a masterclass in prompting models to emit *complete, self-contained, single-file* visual outputs with explicit format rules (e.g., standalone SVG allowed; single complete HTML file; React for Markdown).
  **Idea to steal:** artifact-type taxonomy with per-type output contracts and "must be fully complete, no placeholders" rules; version history per board state.

- **OpenAI Canvas** — https://openai.com/index/introducing-canvas/
 Chat + side document, targeted inline edits, shortcut actions, code execution.
  **Idea to steal:** targeted-edit actions ("highlight just this formula region and fix it") rather than whole-board regeneration; user can steer even in a view-only page (click a shape → "explain/redo this").

- **Excalidraw AI (Plus)** — https://plus.excalidraw.com/ai — "AI diagrams made editable… bring your own AI key, **or ask your agent over MCP**. Then edit like anything else on the canvas."
  **Idea to steal:** keep every AI diagram as editable primitives (never rasterized), so the LLM (or human) can iterate on prior output.

- **Excalidraw text-to-diagram (Mermaid)** — https://docs.excalidraw.com/docs/@excalidraw/mermaid-to-excalidraw/api · npm: https://www.npmjs.com/package/@excalidraw/mermaid-to-excalidraw
 `parseMermaidToExcalidraw()` converts Mermaid text into skeleton Excalidraw elements; unknown types fall back to image.
  **Idea to steal:** text→diagram via a constrained DSL + *lossy fallback* (render unsupported as image) — matches our sanitizer posture.

- **Excalidraw skills for coding agents** — https://github.com/coleam00/excalidraw-diagram-skill · https://nicholasspisak.github.io/excalidraw/
 Skills that teach Claude Code/Codex the Excalidraw JSON element schema so they draw directly.
  **Idea to steal:** publish our board's element/tool schemas as an agent skill / system-prompt appendix with golden examples — schema fluency is the difference between broken and usable diagrams.

- **Eraser.io** — https://www.eraser.io/ai · docs: https://docs.eraser.io/ai-diagrams · agent integrations/MCP: https://docs.eraser.io/using-ai-agent-integrations · diagramming API: https://www.eraser.io/product/diagramming-api
 Diagram-as-code syntax (```mermaid-like) + natural language → beautiful editable diagrams; MCP for IDE agents.
  **Idea to steal:** their syntax-first generation + "iterate with AI to edit" loop is exactly the LLM-tool-call-friendly design we want.

- **Napkin.ai** — https://www.napkin.ai/ · API: https://www.napkin.ai/api/
 Paste text → curated, brandable vector visuals (flowcharts, mind maps, data charts); an "agency" of specialized agents picks a visual type, content shapes it, then styling passes; recently "Napkin Slides" builds decks.
  **Idea to steal:** a **template/pattern library of explanatory visual idioms** (cycle, split, funnel, timeline, compare-contrast) the LLM selects *by name*, instead of freehand coordinates — reliability skyrockets.

- **Fermat (AI whiteboard startup)** — https://liveblocks.io/blog/how-fermat-enabled-realtime-collaboration-in-their-ai-powered-whiteboard
 Collaborative canvas for math/creative work where GPT-4 wrote TikZ/rendered cells; realtime multiplayer around it.
  **Idea to steal:** LaTeX/TikZ as one *backend target* for "one prompt → many candidate renders" (see AutomaTikZ below).

### 1.4 Research: LLMs that generate teaching visuals

- **TheoremExplainAgent + TheoremExplainBench** — paper: https://arxiv.org/abs/2502.19400 (ACL 2025: https://aclanthology.org/2025.acl-long.332/) · bench: https://huggingface.co/datasets/TIGER-Lab/TheoremExplainBench · code: https://github.com/TIGER-AI-Lab/TheoremExplainAgent
 Agentic tool-driven Manim generation for >5-min theorem videos; 240-theorem benchmark; 5 metrics (Accuracy&Depth, Visual Relevance, Logical Flow, Element Layout, Visual Consistency). Findings: **agentic planning is essential for long-form video; o3-mini hit 93.8% render-success but most videos still had "minor issues with visual element layout"**; multimodal explanations expose reasoning flaws that text hides.
  **Idea to steal:** adopt their rubric (Element Layout, Logical Flow, Visual Relevance…) as our board agent's self-check checklist.

- **Code2Video** — paper: https://arxiv.org/abs/2510.01174 · code: https://github.com/showlab/Code2Video
 Planner→Coder→Critic agent pipeline over **Manim as renderable environment**; storyboard JSON (sections = lecture lines paired with animations); **visual anchor prompt = 6×6 grid** mapping cells to coordinates so the LLM places elements discretely (ablation: grid ≫ free placement; 6×6 best); occupancy table per section; ScopeRefine error repair; MMMC benchmark built from 3Blue1Brown; TeachQuiz metric (unlearn→watch→re-quiz). Planner ablation: remove Planner, scores collapse ~41 points.
  **Idea to steal:** (a) the **anchor-grid placement** scheme for our board coordinates; (b) storyboard-JSON lesson format with lecture-line ↔ animation pairing; (c) unlearn/quiz eval for lesson quality.

- **Generative Manim** — https://github.com/marcelo-earth/generative-manim · demo: https://generative-manim.streamlit.app/ — LLM→Manim code→render; API service.
- **AIManim** — https://github.com/sakhadib/aimanim — plan → generate scene → render → **repair failed code** → stitch.
- **Math-To-Manim** — https://github.com/HarleyCoops/Math-To-Manim — six-stage specialist-agent reasoning chain.
- **manim-skill (Claude Code plugin)** — https://github.com/vumichien/manim-skill — four-role pipeline (topic/paper → rendered animation).
  **Idea to steal (all):** the "generate → render → read error/see output → repair" loop as a board-tool loop, and multi-role prompts (planner vs board-writer vs critic).

- **Manim ports that run in the browser (no Python server!)**
  - **manim-web** — https://github.com/maloyan/manim-web · docs: https://maloyan.github.io/manim-web/ — TypeScript port of Manim scene API (`Scene`, `Circle`, `Create`, `FadeOut`…) on WebGL/Three.js; "no server, no video encoding, no Python."
  - **ecmanim** — https://opensource.johnhenry.me/ecmanim/ — Scene/mobject/animation API in-browser.
  - **Rust+WebGPU Manim** — https://news.ycombinator.net/item?id=49091703 — same Python API, Rust core via WebGPU.
  **Idea to steal:** a *library-scene* tool on our board: LLM emits a scene JSON (objects + animation sequence), page executes via a Manim-like TS engine — full 3Blue1Brown feel, zero backend.

### 1.5 MCP whiteboard/diagram servers (tool-surface precedents)

- **draw.io MCP (official)** — https://www.drawio.com/docs/manual/generate/drawio-mcp-server · https://github.com/jgraph/drawio-mcp — LLM creates `.drawio` XML; "Open in draw.io" links.
- **Mermaid Chart MCP (official)** — https://mermaid.ai/docs/ai/mcp-server — create/validate/render Mermaid in-chat; also Claude MCP App.
- **mcp-excalidraw** — https://www.npmjs.com/package/mcp-excalidraw — generates Excalidraw scenes with live web preview.
- **mcp-diagram-generator** — https://www.npmjs.com/package/mcp-diagram-generator — multi-backend (Draw.io etc.) diagram MCP for Claude Code.
- **Comparison guide** — https://diagram.la/guides/diagram-mcp-server — surveys Excalidraw/draw.io/Mermaid/Miro/Lucid/Eraser/Whimsical/Figma MCP servers and *where the diagram ends up*.
  **Idea to steal:** tool design where **structured diagram text (Mermaid/drawio-xml) is the artifact**, the renderer is local — easy validation, easy diffing between lesson steps.

### 1.6 Open-source "AI teacher whiteboard" projects (closest cousins)

- **HeyTutor** — https://github.com/kaizen403/heytutor
 Two coordinated streams: **(1) a deterministic scene-engine that compiles+validates a diagram and commits it *only after verification*** (numeric values from a solver, never the LLM), **(2) a teaching LLM that narrates and `WRITE`s equations in a work area**, revealing the committed diagram in sync with speech (`[FOCUS:id]` can only trace already-committed geometry). Konva + roughjs + tegaki; TTS-synced reveal.
  **Idea to steal (big):** **LLM never supplies coordinates** — it declares intent; a scene engine validates/solves/compiles; narration references committed elements by ID. This kills the "hallucinated geometry" class of bugs.

- **ChatTutor** — https://github.com/HugeCatLab/ChatTutor — "AI teacher equipped with an electronic whiteboard."
- **FeynmanAI** — https://github.com/Gagancreates/FeynmanAI — voice-first real-time canvas tutor (draws while speaking).
- **Oluko** — https://github.com/Akeem1955/Oluko — voice-first whiteboard teaching platform (Amazon Nova).
- **whiteboard-teacher-ai** — https://github.com/Luisbh-dev/whiteboard-teacher-ai — Gemini + React infinite-whiteboard math/physics tutor.
- **Chalk** — https://devpost.com/software/chalk-whiteboard-tutor — live voice tutor drawing on whiteboard, handles interruptions.
- **chat-paint** — https://github.com/yongzhuo/chat-paint — ChatTutor/豆包老师-style "talk while drawing" board.
  **Idea to steal (all):** streaming "draw while talking" reveal UX; interruption handling; two-panel (work area + diagram zone) board layout.

---

## 2. Declarative visualization primitives (what LLMs emit, safety, offline-bundleability)

Legend: ✅ bundleable offline & no arbitrary JS · ⚠️ embeds/CDN/API-key constraints.

### Math & equations
- **KaTeX** — https://katex.org/ — fast TeX→HTML+CSS; no `eval`; ✅ (we already use it). **Extend with mhchem** (below) and `auto-render`.
- **KaTeX mhchem extension** — https://github.com/KaTeX/KaTeX/blob/main/contrib/mhchem/README.md · manual: https://mhchem.github.io/MathJax-mhchem/ — `\ce{}` and `\pu{}` chemical equations inside math. **Idea to steal:** chemistry *equations* stay in KaTeX (safe), only *structures* need a molecule renderer.

### Plots & graphs
- **function-plot** — https://mauriciopoppe.github.io/function-plot/ · https://github.com/mauriciopoppe/function-plot — 2D plotter over d3; JSON config (`{ fn, graphType, domain }`); ships its own interval-arithmetic evaluator (no eval). ✅ MIT. **Best fit: replace our hand-rolled plot shapes.**
- **Mafs** — https://mafs.dev/ · https://github.com/stevenpetryk/mafs — React components (`<Coordinates.Cartesian>`, `<Plot.OfX>`, vectors, `<Point>`); declarative JSX that LLMs (esp. Claude React-artifact-trained) write very well; MIT. ✅ **Best fit for our React page.**
- **JSXGraph** — https://jsxgraph.org/home/ · https://github.com/jsxgraph/jsxgraph — interactive geometry/function plotting/charting; constructions via JSON or `JessieCode` (a *sandboxed parser*, not eval); LGPL, self-contained. ✅ **Best fit for geometry lessons (circumcircles, tangents, ruler-compass demos).**
- **GeoGebra Apps API** — https://geogebra.github.io/docs/reference/en/GeoGebra_Apps_API/ — applet embedding, `evalCommand`, Base64 construction save/load. ⚠️ (iframe applet, hosting/license constraints; heavy) — worth exposing only as a fallback for "power constructions," not core.
- **Desmos API** — https://www.desmos.com/api — `setExpression({latex})`; the most LLM-known calculator grammar. ⚠️ (CDN + API key for commercial) — not offline. **Idea to steal:** adopt Desmos-style LaTeX-as-expr syntax for our plot tool schema.

### Math diagram DSLs
- **Penrose** — https://penrose.github.io/ · https://github.com/penrose/penrose (MIT, ~8k★) · SIGGRAPH paper: https://penrose.cs.cmu.edu/siggraph20 — triples (.domain substance / .sub / .sty) → publication-quality diagrams from mathematical notation. LLMs can emit the DSL; renderer is WASM/OCaml — self-contained but **heavy**. ⚠️✅ **Idea to steal:** style-scheme separation ("theorem substance" vs "blackboard style") and their Substance-Language approach for abstract diagram semantics.
- **TikZJax** — https://rod2ik.github.io/tikzjax/ · npm `@rod2ik/tikzjax` (GPL-3) — real LaTeX/TikZ in the browser via WASM (no server); also circuit support via packages. ✅ offline (big download); **Idea to steal:** accept `\begin{tikzpicture}` as an expert escape hatch.

### Data / general
- **Vega-Lite** — https://vega.github.io/vega-lite/ — pure-JSON chart grammar; renderer is safe-by-construction (no script execution); ✅ offline-bundleable. **Best "charts/data" tool for LLMs** (JSON schema validated, deterministic).
- **D3** — https://d3js.org/ — powerful but arbitrary JS; ⚠️ not for direct LLM emission; use only via Vega-Lite or our own wrappers.
- **Mermaid** — https://mermaid.js.org/ — flowcharts/sequence/class/state/gantt from text; JS renderer, no eval; ✅ offline. We already use it. **Idea to steal:** add `mindmap` + `timeline` types for lesson structure overviews.
- **Layout engines: ELK.js** — https://github.com/kieler/elkjs (layered layout; used by netlistsvg) · **dagre** — https://github.com/dagrejs/dagre — pure-JS node-edge layout; ✅. **Idea to steal:** `layout` tool that takes nodes+edges JSON → positions, so LLMs never hand-place graph nodes.

### Chemistry
- **SmilesDrawer** — https://reymond-group.github.io/smilesDrawer/ · https://github.com/reymond-group/smilesDrawer — parse+draw 2D structures from SMILES, pure JS, **zero dependencies**; ✅ MIT. **Best fit.**
- **RDKit.js (MinimalLib)** — https://github.com/rdkit/rdkit-js · docs https://rdkitjs.com/ — WASM cheminformatics (2D depict + 3D + substructure matching); ✅ offline bundle. **Idea to steal:** `substructure` matching lets the professor highlight "the carbonyl here" programmatically.
- **3Dmol.js** — https://3dmol.org/doc/ · https://github.com/3dmol/3Dmol.js — WebGL molecule viewer (pdb/sdf/mol2/xyz), **declarative config incl. a URL-style spec**; BSD. ✅ (has CDN but bundleable). **Idea to steal:** declarative style spec ` cartoon: { color: 'spectrum' }` — expose as a `molecule3d` tool.

### Anatomy / biology
- **Bioicons** — https://bioicons.com/ · https://github.com/duerrsimon/bioicons — MIT/CC0 SVG icons for bio/chem; ✅ offline-packable set. **Idea to steal:** curated local icon library → LLM references by ID (`anatomy: { icon: "heart", x, y }`) rather than drawing anatomy freehand.
- **Servier Medical ART** — https://smart.servier.com/ — free medical SVGs (CC BY, attribution required) — anatomy/physiology sets.
- **SciDraw** — https://scidraw.io/ — free scientific illustrations.
- **Wikimedia Gray's Anatomy SVG plates** — https://commons.wikimedia.org/wiki/Category:SVG_Gray%27s_Anatomy_plates (140 plates) — public-domain anatomy SVGs; ✅ can host locally + label overlays.
- **BioRender (commercial reference point)** — https://www.biorender.com/ · Leo AI agent: https://www.biorender.com/product/leo-ai-figure-builder — "sketch → agent plans/builds figure"; the UX gold standard for bio figures, worth imitating in miniature.

### Circuits
- **schemdraw** — https://schemdraw.readthedocs.io/en/latest/ · https://github.com/cdelker/schemdraw — Python→SVG circuit schematics (MIT); excellent declarative API but Python (server-side render → embed as sanitized SVG).
- **netlistsvg** — https://github.com/nturley/netlistsvg — JSON netlist→SVG **using elkjs in JS**; ✅ pattern to copy for a JS circuit layout tool.
- **KiCanvas** — https://kicanvas.org/ · https://github.com/theacodes/kicanvas — browser KiCad schematic viewer (TypeScript).
- **circuitikz** — https://ctan.org/pkg/circuitikz — LaTeX circuits (usable through TikZJax).
  **Idea to steal:** `circuit` tool with element-chain DSL (`R .right label:"R₁"; C .down`) like schemdraw, rendered in JS.

---

## 3. Animation & step-by-step reveal

- **Manim Community (the scene model)** — https://docs.manim.community/en/stable/ · https://www.manim.community/
 `Scene.construct()`; mobjects; `self.play(Create/Write/FadeIn/Transform)`; `self.wait()`; camera. The core abstraction: **a timeline of animation commands over persistent objects** — this is what we should mirror in JSON (`[{op:"create", target:"circle", anim:"draw", dur:1}, ...]`).
  **Idea to steal:** `TransformMatchingTex`-style morphs between equation states; `Succession`/`LaggedStart` for staged reveals.

- **Manim-in-browser ports** (§1.4): manim-web (https://maloyan.github.io/manim-web/), ecmanim, WebGPU Rust Manim — proof that scene-API + WebGL works client-side.
  **Idea to steal:** keep a Manim-compatible JSON shape so lessons are portable to real Manim renders later.

- **Motion Canvas** — https://motioncanvas.io/ · https://github.com/motion-canvas/motion-canvas — TypeScript **generator functions** describe animations (`yield* circle.play(...)`); editor with time-scrub; built for "informative vector animations **synchronized with voice-overs**"; preview runs in browser.
  **Idea to steal:** the timeline = generator of named nodes with timing metadata; narration→keyframe alignment model (each narration sentence maps to board sub-timeline).

- **reveal.js fragments** — https://revealjs.com/fragments/ · demo: https://revealjs.com/demo/ · React API: https://revealjs.com/react/ · Quarto advanced (r-stack): https://quarto.org/docs/presentations/revealjs/advanced.html
 Elements with `class="fragment"` are stepped through **before** advancing; styles: fade-in/out, grow, shrink, slide; `.r-stack` overlays; programmatic `Reveal.slide(h,v,f)`.
  **Idea to steal:** per-element `step` indices (declarative order field on our shapes) — presenter-style "next sub-step" navigation for long lessons, human-paced instead of time-based.

- **Progressive stroke drawing (handwriting effect)** — CSS-Tricks: https://css-tricks.com/how-to-get-handwriting-animation-with-irregular-svg-strokes/ · technique guide: https://www.css-animation.com/core-css-animation-fundamentals/animating-svg-with-css/drawing-svg-lines-with-stroke-dashoffset/ · vanilla how-to: https://leonardwojcik.com/handwriting-animation/
 Animate `stroke-dasharray`/`stroke-dashoffset` from `path.getTotalLength()` → lines "draw themselves." Cheap, pure-SVG, no JS libs.
  **Idea to steal:** default reveal animation for every stroke = dashoffset draw-on, sequentially ordered — instant "professor writing on board."

- **Rough.js** — https://roughjs.com/ · https://github.com/rough-stuff/rough — hand-drawn-style primitives (canvas+SVG); what Excalidraw uses.
- **perfect-freehand** — https://github.com/steveruizok/perfect-freehand — pressure-based variable-width stroke outlines; the Excalidraw pen feel.
- **rough-notation** — https://github.com/pshihn/rough-notation — animated hand-drawn annotations (circles, highlights, underlines) around elements. **Perfect "professor emphasizes the key term" tool.**
  **Idea to steal:** combine: hand-drawn styling (rough) + dashoffset write-on + `rough-notation`-style emphasis marks.

- **Motion (motion.dev)** — https://motion.dev/ — springs/tween primitives for React; good for camera moves & UI transitions (§4).

### Timeline/keyframe JSON specs (precedents)
- **Code2Video storyboard JSON** (sections → lecture_lines[] ↔ animations[]) — https://arxiv.org/html/2510.01174 §A.2.5.
- **HeyTutor reveal orders** — scene engine owns "reveal order," narration drives progression — https://github.com/kaizen403/heytutor.
- **Mermaid timeline** — https://mermaid.js.org/ — declarative event-sequence diagrams, LLMs know it cold.
  **Recommendation synthesized from these:** lesson spec = array of **steps**, each step = `{narration, appear:[ids], emphasize:[ids], erase:[ids], camera:{center,zoom}}`.

---

## 4. Long lessons & infinite canvas (layout, camera, navigation)

- **tldraw agent viewport system** — https://tldraw.dev/starter-kits/agent — every prompt includes **user viewport bounds + coordinates + screenshot + shape data in view + peripheral clusters outside**; agent can move its own viewport ("look at" regions); coordinates are offset-normalized and rounded for the model.
  **Idea to steal:** pages-as-regions on one infinite canvas: each lesson step gets a region; `camera` tool animates view between regions (Prezi-style); region headers as persistent anchors.

- **tldraw spatial harness** — https://tldraw.dev/blog/harnessing-the-agents — **canvas linting** (warn on overlapping text), agents pull canvas context on demand instead of dumping it all upfront (avoids token pollution on big boards); "agents act differently on canvas — they organize hierarchically."
  **Idea to steal:** for long lessons, give the agent a *table of contents* tool (regions + bounds + one-line summaries) instead of the full board JSON; details on demand per region.

- **Code2Video visual anchors** — https://arxiv.org/html/2510.01174 §4.3/A.1.3 — 6×6 anchor grid + **occupancy table** (element→anchor→scale→code lines) maintained during generation; Critic detects overlap/occlusion/off-screen/empty-imbalance; ablation shows 6×6 grid beats both finer grids and free placement.
  **Idea to steal:** expose board coordinates as a coarse anchor grid (e.g., A1–F6) in tool schemas; keep an occupancy table client-side; return it as lint context.

- **ELK.js / dagre** — https://github.com/kieler/elkjs · https://github.com/dagrejs/dagre — automatic layout for diagram-style content (mermaid uses layered layouts; netlistsvg uses elk).
  **Idea to steal:** `auto_layout(nodes, edges)` tool so CS diagrams (graphs, pipelines) never overlap by construction.

- **TheoremExplainAgent long-form finding** — https://arxiv.org/abs/2502.19400 — agentic planning essential for >5-min content; **visual layout is the dominant residual error** in LLM-generated teaching visuals.
  **Idea to steal:** budget agent loop iterations for layout fixes specifically (lint → move → re-check), not just content.

- **3Blue1Brown / MMMC** — https://www.3blue1brown.com/ · benchmark: https://arxiv.org/abs/2510.01174 §3.2 — reference standard for what a great lesson looks like (17-min arcs, 13 domains, timestamped sub-clips).
  **Idea to steal:** segment lessons into ~3-minute "chapters," each with its own board region + summary; matches human attention findings in Code2Video §5.3 (completion willingness drops on long videos).

---

## 5. Letting the agent SEE the board (feedback loops)

- **tldraw agent "eyes"** — https://tldraw.dev/starter-kits/agent · https://tldraw.dev/docs/ai — dual-channel context: **screenshot (PNG of viewport) + simplified shape JSON**; `PromptPartUtil` classes assemble per-modality parts; actions validated/sanitized after streaming. `editor.getSvgString()` / `editor.toImage()` are the export primitives.
  **Idea to steal:** implement `get_board_view(region?)` tool returning both a downscaled PNG (via SVG→canvas rasterization) and the compact shape list; call it after each drawing batch.

- **Code2Video Critic** — https://arxiv.org/html/2510.01174 §4.3 — VLM reviews rendered video *with the visual anchor grid + occupancy table* as context, so its feedback ("move to empty cell C4") is **actionable**, not just "the label is misplaced."
  **Idea to steal:** never ask a vision model "is this good?" bare — always give it the placement vocabulary (anchors, shape IDs, occupancy) so fixes are mechanical.

- **AgentVision** — https://github.com/amitpatole/agent-vision — render → see → report → fix for agent-authored UI/charts/SVG/PDF (overflow, contrast, clipping).
- **QodeX** — https://qodexcli.github.io/QodeX/ — local-first agent renders artifact **in real Chromium, screenshots it, vision model verdict, self-corrects until it looks right.**
- **VisionCoder OpenEnv** — https://github.com/amaljoe/vision-coder-openenv — RL environment: screenshot → refine HTML → match.
- **canvas-flow** — https://github.com/fernandomenuk/canvas-flow — human-in-the-loop review of agent HTML: "point at it, don't screenshot it."
  **Idea to steal:** deterministic geometric lints (overlap/bounds/contrast ratios/label-in-shape) *before* spending a vision call; keep a human "point & complain" affordance even in a view-only page.

### Rasterizing our board for the model
- **html-to-image** — https://github.com/bubkoo/html-to-image — DOM→PNG in-browser (SVG foreignObject trick); works for our React page since we're view-only & same-origin.
- **resvg-js** — https://github.com/thx/resvg-js — fast **WASM SVG→PNG** (Node or browser) with font loading control; ideal server-side in our local Node app (no headless browser needed).
- **Playwright** — headless Chromium screenshot when true fidelity matters (e.g., Mermaid/JSXGraph measurements before JS settles); pattern used by QodeX.
  **Recommendation:** SVG in → `resvg-js` PNG out (server, fast, deterministic); reserve Playwright for validating JS-driven widgets.

---

## 6. Security: rendering LLM-generated SVG/HTML safely

Primary survey (read it): **"Untrusted SVG rendering — isolation strategies"** — https://nothing.graphics/docs/wg/research/untrusted-svg-rendering

- **Attack inventory (why sanitizing is hard):** `<script>`, event-handler attrs (`onload`/`onerror`/SMIL `onbegin`), `javascript:` URLs in `href`/`xlink:href`, **SMIL `animate`/`set`/`animateMotion` retargeting an `href` to `javascript:` over time** (not "script", so script-blockers miss it), `foreignObject` (full HTML XSS surface), `use` pulling external docs, CSS `@import`/`behavior:`, and **mXSS reparse-mutation** (sanitize→serialize→re-parse ≠ what you sanitized). Sources cited there: PortSwigger SVG XSS vector (https://portswigger.net/research/svg-animate-xss-vector), W3C SVG Security wiki, OWASP.

- **Strategy I — allowlist sanitization (DOMPurify)** — https://github.com/cure53/DOMPurify · https://dompurify.com/
  `DOMPurify.sanitize(svg, { USE_PROFILES: { svg: true, svgFilters: true }, ADD_TAGS: [...] })`; strips `script`, `foreignObject`, `use`, entire SMIL family; URI scheme allowlist. **Caveat: guarantee is operational, not structural** — CVE-2020-26870 and CVE-2024-45801 were both mXSS bypasses; keep it current (Cure53 maintain aggressively).
  **Idea to steal:** use the SVG profile + `SANITIZE_DOM` off + our own tag whitelist (presentation attrs only, `data-` attrs allowed, drop `style` where possible).

- **tldraw's custom sanitizer** — https://github.com/tldraw/tldraw/pull/7896 — allowlist tables derived from DOMPurify, **mode-switching at `foreignObject`**, URI rules (`image`→raster `data:` only; `use`→`#fragment` only; `a`→http/https/mailto), CSS filtering, runs at *every* ingestion point (paste/drop/API), public `sanitizeSvg()`. They render inline, so they *must* sanitize.
  **Idea to steal:** copy the URI/CSS rules verbatim into our sanitizer spec.

- **Strategy II — image-context isolation (our best trick):** when SVG is referenced via `<img src=data:...>`, `background-image`, or `canvas.drawImage`, the browser's **secure static processing mode** (SVG Integration spec: https://svgwg.org/specs/integration/ · MDN: https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image) *structurally* forbids script execution, external fetches, event listeners — content-independent guarantee. Cost: no DOM access (fine — we're view-only!), no animation (SMIL dies), external refs silently dropped. **Excalidraw does exactly this** (imported SVG = opaque image asset).
  **Idea to steal:** render LLM SVG artifacts through the image path; keep interactivity for shapes *we* generated in our own schema, not for raw LLM SVG.

- **Strategy III — sandboxed iframe** — MDN iframe `sandbox`: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe · srcdoc: https://developer.mozilla.org/en-US/docs/Web/API/HTMLIFrameElement/srcdoc — `sandbox=""` (or with **no** `allow-same-origin`) kills scripts + opaque origin; **never combine `allow-scripts` + `allow-same-origin`** (content can de-sandbox itself); animations still run; needs `postMessage` bridge for interaction. Ready-made packages: **html-preview-sandbox** (DOMPurify + sandboxed iframe for AI-generated HTML) — https://github.com/preview-sandbox/html-preview-sandbox · Tesserae `Sandbox` component — https://docs.curiosity.ai/tesserae/media/sandbox · tldraw's `EmbedShapeUtil` iframe pattern — https://tldraw.dev/docs/ai
  **Idea to steal:** if we ever preview LLM HTML/CSS "widgets" on the board, it's `srcdoc` + `sandbox="allow-scripts"` + strict CSP + no same-origin.

- **Strategy IV — parse into model:** Figma (vector networks), Penpot, Excalidraw (image-asset fallback) — **projection IS sanitization**: markup never mounts. Highest fidelity loss, lowest upkeep.
  **Idea to steal:** this is our architecture's stance — LLM emits *our* JSON schema (shapes/KaTeX/Mermaid/SMILES/etc.), and raw SVG is only a tolerated, sanitized, image-context input.

- **CSP as second layer** — https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/script-src — `script-src 'self'` blocks inline script/handlers/`javascript:` in mounted SVG, **but does NOT stop SMIL or mXSS** — pair with sanitizer, don't substitute.

- **Extra precedent:** svg-sanitizer bypass advisories (https://github.com/darylldoyle/svg-sanitizer/security/advisories/GHSA-9rjx-3jch-6vjf, svgo `removeScripts` bypass GHSA-w27v-7q3p-w38r) confirm: *hand-rolled sanitizers keep getting bypassed; use maintained DOMPurify + structural isolation.*

---

## 7. Prioritized Top-10 recommendations for our extension

*(Constraints honored: local-first, offline-bundleable, view-only, LLM tool-driven, sanitized.)*

1. **Tiered board-state feedback (tldraw agent kit).** After each tool call (or on demand), return: viewport PNG + compact shape JSON (id/type/bounds/text for in-view; cluster summaries outside). Source: https://tldraw.dev/starter-kits/agent, https://tldraw.dev/docs/ai
2. **Domain primitives as tools, not raw SVG.** Add tools backed by: Mafs or function-plot (plots), JSXGraph (geometry), KaTeX+mhchem (equations/chem), Vega-Lite (data charts), Mermaid (CS diagrams), SmilesDrawer/RDKit.js (molecules), 3Dmol.js (3D structures), Bioicons/Servier SVG sets (bio/anatomy), schemdraw-style DSL (circuits). All ✅ offline & no arbitrary JS. (§2)
3. **LLM declares intent; a scene engine validates.** HeyTutor's split: tool params are *verified* (schema + geometric/numeric solving) before commit; invalid/partial diagrams never reach the board. Add `sanitizeAction`-style corrections (tldraw agent kit) for IDs/coords. Source: https://github.com/kaizen403/heytutor, https://tldraw.dev/starter-kits/agent
4. **Lesson = JSON storyboard with steps** (Manim/Motion-Canvas-inspired): each step = narration + appear/emphasize/erase lists + camera target. Pair each lecture line with its animation (Code2Video) and export-compat Manim-style ops (`create/write/fade/transform`). Sources: https://docs.manim.community/en/stable/, https://arxiv.org/abs/2510.01174
5. **Anchor-grid placement + occupancy lint.** Coarse grid coordinates (A1–F6 style) in tool schemas; client-side occupancy table; deterministic overlap/bounds lint returned as warnings to the agent before any vision call. Sources: https://arxiv.org/html/2510.01174 §4.3, https://tldraw.dev/blog/harnessing-the-agents
6. **Handwriting reveal as default animation.** `getTotalLength()` → dashoffset draw-on for strokes, sequential by step index; rough.js/perfect-freehand styling; rough-notation-style emphasis marks on KaTeX terms. Sources: §3 (CSS-Tricks, roughjs.com, rough-notation).
7. **Auto-layout for graph content.** `layout(nodes, edges)` via ELK.js/dagre before rendering Mermaid-adjacent diagrams or pipelines; LLM never places node-edge layouts freehand. Sources: https://github.com/kieler/elkjs, https://github.com/dagrejs/dagre
8. **Camera moves on infinite canvas, chaptered lessons.** Region per step (~≤3 min "chapters"), animated pan/zoom between regions (Prezi/tldraw viewport API), TOC tool so the agent sees regions+summaries instead of the whole board. Sources: https://computer.tldraw.com/, https://tldraw.dev/starter-kits/agent, https://arxiv.org/abs/2510.01174 §5.3
9. **Vision self-check loop only after deterministic lints pass:** render (resvg-js for SVG, or html-to-image/Playwright for JS widgets) → VLM critique *with anchor grid + shape IDs + issue checklist* (Element Layout / overlap / off-canvas / contrast, per TheoremExplainBench & Code2Video Critic) → targeted fix. Sources: https://github.com/thx/resvg-js, https://github.com/amitpatole/agent-vision, https://arxiv.org/abs/2502.19400
10. **Defense-in-depth rendering:** raw LLM SVG → DOMPurify SVG-profile allowlist (tldraw-rule URIs/CSS) → **mounted as `<img data:…>` (image-context isolation)**; any LLM HTML only in `srcdoc` iframe `sandbox="allow-scripts"` (never `allow-same-origin`), strict CSP (`script-src 'self'`, no unsafe-inline) as backstop. Sources: https://nothing.graphics/docs/wg/research/untrusted-svg-rendering, https://github.com/preview-sandbox/html-preview-sandbox

---

## Appendix: sources considered but not central
- AutomaTikZ (text→TikZ synthesis) — https://arxiv.org/abs/2310.00367 — relevant for "LLM writes TikZ" but superseded for us by TikZJax-in-browser.
- Figma/Penpot import models — cited within §6 survey (projection-as-sanitization).
- Manimator (papers→visual explanations) — https://arxiv.org/abs/2507.14306 — niche but consistent with the Planner→render→repair pattern.
- "Learn Your Way"/"Learn About" — included in §1.2 as the closest *product* framing of "AI professor + visuals" from a major lab.
