/**
 * Five realistic lessons, written the way the tutor builds them: one board_update per lesson
 * step (baseRevision is filled in by the caller), chapters, camera moves and short ids.
 * Used by scripts/demo-lessons.mjs (renders them through the real tools) and by the tests
 * (layout warnings and DOM checks), so keep the coordinates sensible rather than perfect.
 */

const CHALK = "#e8e3d9", BLUE = "#5fb3d9", YELLOW = "#f2c14e", RED = "#ef6f6c", GREEN = "#8de0be", MUTED = "#c7c5ad";

/* ---------- 1. physics: roller coaster loop ---------- */
// Loop of radius 240 (SVG units = chapter px), centre O; the cart rides inside the track at the top.
const LOOP_SVG = `<svg viewBox="0 0 600 600" xmlns="http://www.w3.org/2000/svg">
  <circle cx="300" cy="330" r="240" fill="none" stroke="#8a8578" stroke-width="7"/>
  <path d="M 20 590 Q 60 470 120 520" fill="none" stroke="#8a8578" stroke-width="7" stroke-linecap="round"/>
  <line x1="0" y1="592" x2="600" y2="592" stroke="#8a8578" stroke-width="2" stroke-dasharray="8 6"/>
  <g>
    <rect x="258" y="98" width="84" height="38" rx="7" fill="#e8e3d922" stroke="#e8e3d9" stroke-width="3"/>
    <circle cx="276" cy="99" r="8" fill="#000" stroke="#e8e3d9" stroke-width="3"/>
    <circle cx="324" cy="99" r="8" fill="#000" stroke="#e8e3d9" stroke-width="3"/>
  </g>
  <circle cx="300" cy="330" r="5" fill="#e8e3d9"/>
  <text x="284" y="360" fill="#e8e3d9" font-family="Georgia, serif" font-size="22" font-style="italic">O</text>
</svg>`;

export const PHYSICS = {
  slug: "physics",
  title: "Roller coaster · free-body diagrams",
  steps: [
    {
      title: "Roller coaster · free-body diagrams",
      chapters: [{ op: "add", id: "fbd", title: "Cart at the top of the loop" }],
      scene: { mode: "append", artifacts: [{ type: "svg", id: "loop", x: 60, y: 60, width: 600, height: 600, source: LOOP_SVG, label: "loop", chapter: "fbd" }],
        shapes: [{ type: "text", id: "h1", text: "Top of the loop", x: 720, y: 150, size: 34, chapter: "fbd" }] },
      camera: { chapter: "fbd" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "arrow", id: "fN", points: [[340, 200], [340, 300]], color: BLUE, width: 3, chapter: "fbd" },
        { type: "text", id: "lN", text: "N", x: 306, y: 280, size: 28, italic: true, color: BLUE, chapter: "fbd" },
        { type: "arrow", id: "fmg", points: [[380, 200], [380, 320]], color: YELLOW, width: 3, chapter: "fbd" },
        { type: "text", id: "lmg", text: "mg", x: 392, y: 312, size: 28, italic: true, color: YELLOW, chapter: "fbd" },
      ] },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "arrow", id: "fv", points: [[410, 170], [540, 170]], color: GREEN, width: 3, chapter: "fbd" },
        { type: "text", id: "lv", text: "v", x: 550, y: 178, size: 28, italic: true, color: GREEN, chapter: "fbd" },
        { type: "line", id: "r", points: [[360, 390], [530, 560]], dash: "7 5", chapter: "fbd" },
        { type: "text", id: "lr", text: "r", x: 462, y: 462, size: 26, italic: true, chapter: "fbd" },
      ] },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "text", id: "t1", text: "N and mg both point down,\ntoward the centre O", x: 720, y: 210, size: 22, color: MUTED, chapter: "fbd" },
      ] },
      equations: [{ op: "add", id: "ac", latex: "a_c = \\frac{v^2}{r}", label: "centripetal acceleration", x: 720, y: 300, chapter: "fbd" }],
    },
    {
      chapters: [{ op: "add", id: "deriv", title: "Minimum speed at the top" }],
      equations: [{ op: "add", id: "eq1", latex: "\\sum F = \\frac{m v^2}{r}", label: "Newton II, toward the centre", x: 80, y: 80, chapter: "deriv" }],
      camera: { chapter: "deriv" },
    },
    { equations: [{ op: "add", id: "eq2", latex: "N + mg = \\frac{m v^2}{r}", label: "at the top", x: 80, y: 210, chapter: "deriv" }] },
    {
      scene: { mode: "append", shapes: [
        { type: "ellipse", id: "f1", x: 71, y: 245, w: 50, h: 50, color: RED, reveal: "draw", chapter: "deriv" },
        { type: "text", id: "t2", text: "N → 0: the track stops pushing", x: 460, y: 290, size: 22, color: RED, chapter: "deriv" },
      ] },
    },
    { equations: [{ op: "add", id: "eq3", latex: String.raw`N = 0 \;\Rightarrow\; mg = ` + "\\frac{m\\,v_{\\min}^2}{r}", label: "barely on the track", x: 80, y: 350, chapter: "deriv" }] },
    {
      equations: [{ op: "add", id: "eq4", latex: "\\boxed{v_{\\min} = \\sqrt{g\\,r}}", label: "result", x: 80, y: 500, color: YELLOW, chapter: "deriv" }],
      scene: { mode: "append", shapes: [{ type: "text", id: "t3", text: "units: √(m/s² · m) = m/s", x: 460, y: 570, size: 22, color: MUTED, chapter: "deriv" }] },
      camera: { x: 1440, y: 300, w: 750, h: 500 },
    },
  ],
};

/* ---------- 2. MRI: k-space ---------- */
function kspaceSvg() {
  const lines = [], n = 16, x0 = 70, step = 30, x1 = x0 + n * step; // 70..550
  for (let i = 0; i <= n; i++) {
    const p = x0 + i * step;
    lines.push(`<line x1="${p}" y1="${x0}" x2="${p}" y2="${x1}" stroke="#ffffff26" stroke-width="1"/>`);
    lines.push(`<line x1="${x0}" y1="${p}" x2="${x1}" y2="${p}" stroke="#ffffff26" stroke-width="1"/>`);
  }
  // Rows already acquired (faint), the row being filled now (bright, with sample dots), the rest empty.
  const current = 4;
  for (let r = 0; r < current; r++) lines.push(`<line x1="${x0}" y1="${x0 + 15 + r * step}" x2="${x1}" y2="${x0 + 15 + r * step}" stroke="#f2c14e" stroke-opacity="0.35" stroke-width="4"/>`);
  const cy = x0 + 15 + current * step;
  lines.push(`<line x1="${x0}" y1="${cy}" x2="${x1 - 6}" y2="${cy}" stroke="#f2c14e" stroke-width="5" marker-end="url(#ah)"/>`);
  for (let c = 0; c < 10; c++) lines.push(`<circle cx="${x0 + 15 + c * step}" cy="${cy}" r="4.5" fill="#f2c14e"/>`);
  return `<svg viewBox="0 0 620 620" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <marker id="ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="5" markerHeight="5" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#f2c14e"/></marker>
    <marker id="ax" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#e8e3d9"/></marker>
  </defs>
  ${lines.join("\n  ")}
  <line x1="40" y1="310" x2="590" y2="310" stroke="#e8e3d9" stroke-width="2.5" marker-end="url(#ax)"/>
  <line x1="310" y1="590" x2="310" y2="30" stroke="#e8e3d9" stroke-width="2.5" marker-end="url(#ax)"/>
  <text x="586" y="342" fill="#e8e3d9" font-family="Georgia, serif" font-size="26" font-style="italic" text-anchor="end">k<tspan font-size="18" dy="6">x</tspan></text>
  <text x="324" y="44" fill="#e8e3d9" font-family="Georgia, serif" font-size="26" font-style="italic">k<tspan font-size="18" dy="6">y</tspan></text>
</svg>`;
}

export const MRI = {
  slug: "mri",
  title: "Understanding k-space",
  steps: [
    {
      title: "Understanding k-space",
      chapters: [{ op: "add", id: "signal", title: "A slab and its signal" }],
      scene: { mode: "append", artifacts: [{
        type: "plot", id: "p1", x: 60, y: 90, width: 720, height: 440, xRange: [-4, 4], chapter: "signal",
        functions: [{ expr: "sinc(pi*x)", label: "S(k)" }],
        areas: [{ expr: "sinc(pi*x)", from: -1, to: 1 }],
        vlines: [{ x: -1 }, { x: 1 }],
        points: [{ x: 0, y: 1, label: "S(0)" }],
        xLabel: "k (1/cm)", yLabel: "S(k)", title: "Signal from a 1 cm slab",
      }] },
      camera: { chapter: "signal" },
    },
    {
      scene: { mode: "append", artifacts: [{
        type: "plot", id: "p0", x: 820, y: 260, width: 330, height: 220, xRange: [-2, 2], yRange: [-0.2, 1.3], chapter: "signal",
        functions: [{ expr: "step(x+0.5) - step(x-0.5)", label: "ρ(x)", color: GREEN }], xLabel: "x (cm)",
      }], shapes: [
        { type: "text", id: "t1", text: "a slab in x  ↔  a sinc in k", x: 820, y: 160, size: 24, chapter: "signal" },
        { type: "text", id: "t2", text: "main lobe: |k| < 1/a", x: 820, y: 200, size: 20, color: MUTED, chapter: "signal" },
      ] },
    },
    {
      chapters: [{ op: "add", id: "kspace", title: "Filling k-space" }],
      scene: { mode: "append", artifacts: [{ type: "svg", id: "grid", x: 60, y: 60, width: 620, height: 620, source: kspaceSvg(), label: "k-space grid", chapter: "kspace" }],
        shapes: [{ type: "text", id: "h2", text: "k-space is filled line by line", x: 730, y: 140, size: 30, chapter: "kspace" }] },
      camera: { chapter: "kspace" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "arrow", id: "a1", points: [[722, 252], [640, 252]], color: YELLOW, width: 2.5, chapter: "kspace" },
        { type: "text", id: "t3", text: "one readout = one line (fixed ky)", x: 730, y: 260, size: 22, color: YELLOW, chapter: "kspace" },
        { type: "text", id: "t4", text: "next TR: step ky, repeat", x: 730, y: 320, size: 22, color: MUTED, chapter: "kspace" },
      ] },
    },
    {
      chapters: [{ op: "add", id: "fourier", title: "Signal = Fourier transform" }],
      equations: [
        { op: "add", id: "eq1", latex: "S(k) = \\int \\rho(x)\\, e^{-i 2\\pi k x}\\, dx", label: "signal equation", x: 60, y: 60, chapter: "fourier" },
        { op: "add", id: "eq2", latex: "k(t) = \\frac{\\gamma\\, G\\, t}{2\\pi}", label: "the gradient moves us through k", x: 60, y: 190, chapter: "fourier" },
      ],
      camera: { chapter: "fourier" },
    },
    { equations: [{ op: "add", id: "eq3", latex: "\\rho(x) = \\int S(k)\\, e^{+i 2\\pi k x}\\, dk", label: "inverse FT: the image", x: 640, y: 190, color: YELLOW, chapter: "fourier" }] },
    {
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "seq", x: 60, y: 360, width: 1080, height: 300, chapter: "fourier", label: "pulse sequence",
        source: "flowchart LR\n  RF[\"RF pulse 90°\"] --> PE[\"Phase-encode Gy\"]\n  PE --> RO[\"Readout Gx + sample\"]\n  RO --> L[\"One line of k-space\"]\n  L -->|next TR| RF\n  L --> FT[\"Inverse FFT → image\"]",
      }] },
    },
  ],
};

/* ---------- 3. chemistry and biology: aspirin ---------- */
export const CHEM = {
  slug: "chem",
  title: "Aspirin and the heart",
  steps: [
    {
      title: "Aspirin and the heart",
      chapters: [{ op: "add", id: "asa", title: "Making aspirin" }],
      scene: { mode: "append", artifacts: [
        { type: "molecule", id: "m0", smiles: "OC(=O)c1ccccc1O", x: 60, y: 90, width: 320, height: 260, label: "salicylic acid", chapter: "asa" },
        { type: "molecule", id: "m1", smiles: "CC(=O)Oc1ccccc1C(=O)O", x: 560, y: 70, width: 400, height: 300, label: "aspirin", chapter: "asa" },
      ], shapes: [
        { type: "arrow", id: "a1", points: [[400, 220], [530, 220]], width: 3, chapter: "asa" },
        { type: "text", id: "t1", text: "salicylic acid", x: 220, y: 390, size: 22, anchor: "middle", color: MUTED, chapter: "asa" },
        { type: "text", id: "t2", text: "aspirin (acetylsalicylic acid)", x: 760, y: 400, size: 22, anchor: "middle", color: MUTED, chapter: "asa" },
      ] },
      camera: { chapter: "asa" },
    },
    { equations: [{ op: "add", id: "eq1", latex: "\\ce{C7H6O3 + (CH3CO)2O -> C9H8O4 + CH3COOH}", label: "esterification (acetylation of the phenol)", x: 60, y: 480, chapter: "asa" }] },
    {
      chapters: [{ op: "add", id: "heart", title: "Why a low dose protects the heart" }],
      scene: { mode: "append", artifacts: [
        { type: "icon", id: "ic1", icon: "heart-front", x: 60, y: 90, width: 240, card: true, label: "heart", chapter: "heart" },
        { type: "icon", id: "ic2", icon: "heart-front", x: 340, y: 90, width: 240, label: "heart", chapter: "heart" },
      ], shapes: [
        { type: "text", id: "t3", text: "card: true", x: 180, y: 450, size: 20, anchor: "middle", color: MUTED, chapter: "heart" },
        { type: "text", id: "t4", text: "no card", x: 460, y: 450, size: 20, anchor: "middle", color: MUTED, chapter: "heart" },
      ] },
      camera: { chapter: "heart" },
    },
    {
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "cox", x: 640, y: 80, width: 500, height: 560, chapter: "heart", label: "mechanism",
        source: "graph TD\n  A[Aspirin] -->|acetylates COX-1| B[COX-1 blocked in platelets]\n  B --> C[Less thromboxane A2]\n  C --> D[Less platelet aggregation]\n  D --> E((Fewer clots))",
      }], shapes: [
        { type: "text", id: "t5", text: "irreversible: lasts the platelet's life (~10 days)", x: 60, y: 560, size: 22, chapter: "heart" },
      ] },
    },
  ],
};

/* ---------- 4. computer science: binary search and a state machine ---------- */
export const CS = {
  slug: "cs",
  title: "Searching and state machines",
  steps: [
    {
      title: "Searching and state machines",
      chapters: [{ op: "add", id: "search", title: "Binary search" }],
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "bs", x: 40, y: 60, width: 520, height: 700, chapter: "search", label: "binary search",
        source: "flowchart TD\n  S([\"lo = 0, hi = n − 1\"]) --> C{\"lo ≤ hi?\"}\n  C -->|no| N([\"not found\"])\n  C -->|yes| M[\"mid = ⌊(lo + hi) / 2⌋\"]\n  M --> Q{\"a[mid] vs target\"}\n  Q -->|equal| F([\"found at mid\"])\n  Q -->|smaller| L[\"lo = mid + 1\"]\n  Q -->|larger| H[\"hi = mid − 1\"]\n  L --> C\n  H --> C",
      }] },
      camera: { chapter: "search" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "text", id: "t1", text: "each pass halves the range", x: 620, y: 110, size: 28, chapter: "search" },
        { type: "text", id: "t2", text: "n → n/2 → n/4 → … → 1: about log₂ n passes", x: 620, y: 150, size: 22, color: MUTED, chapter: "search" },
      ] },
    },
    {
      scene: { mode: "append", artifacts: [{
        type: "plot", id: "p1", x: 620, y: 200, width: 540, height: 420, xRange: [1, 16], yRange: [0, 260], chapter: "search",
        functions: [{ expr: "x^2", label: "n²", color: RED }, { expr: "x*log2(x)", label: "n log₂ n", color: GREEN }],
        xLabel: "n", yLabel: "comparisons", title: "n lookups in a sorted list of n",
      }], shapes: [
        { type: "text", id: "t3", text: "linear search each time: n²\nbinary search each time: n log₂ n", x: 620, y: 680, size: 22, color: MUTED, chapter: "search" },
      ] },
    },
    {
      chapters: [{ op: "add", id: "states", title: "A connection as a state machine" }],
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "tcp", x: 40, y: 40, width: 600, height: 720, chapter: "states", label: "TCP-like connection",
        source: "stateDiagram-v2\n  [*] --> Closed\n  Closed --> SynSent : connect / send SYN\n  Closed --> Listen : listen\n  Listen --> SynRcvd : SYN / send SYN+ACK\n  SynSent --> Established : SYN+ACK / send ACK\n  SynRcvd --> Established : ACK\n  Established --> FinWait : close / send FIN\n  FinWait --> Closed : ACK",
      }] },
      camera: { chapter: "states" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "text", id: "t4", text: "each edge: event / action", x: 690, y: 140, size: 28, chapter: "states" },
        { type: "text", id: "t5", text: "client: connect, send SYN,\nwait for SYN+ACK", x: 690, y: 230, size: 22, color: BLUE, chapter: "states" },
        { type: "text", id: "t6", text: "server: listen, answer a SYN\nwith SYN+ACK, wait for ACK", x: 690, y: 340, size: 22, color: YELLOW, chapter: "states" },
        { type: "text", id: "t7", text: "data moves only in Established", x: 690, y: 460, size: 22, color: MUTED, chapter: "states" },
      ] },
    },
  ],
};

/* ---------- 5. history: the printing press ---------- */
export const HISTORY = {
  slug: "history",
  title: "From the printing press to the web",
  steps: [
    {
      title: "From the printing press to the web",
      chapters: [{ op: "add", id: "timeline", title: "Copying an idea gets cheaper" }],
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "tl", x: 40, y: 110, width: 1120, height: 460, chapter: "timeline", label: "timeline",
        source: "timeline\n  1450 : Printing press : movable metal type\n  1837 : Telegraph : text over wires\n  1920 : Broadcast radio : one voice, many listeners\n  1991 : World Wide Web : anyone can publish",
      }], shapes: [{ type: "text", id: "h1", text: "Four ways to reach readers", x: 60, y: 90, size: 34, chapter: "timeline" }] },
      camera: { chapter: "timeline" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "text", id: "t1", text: "each step cut the cost of reaching one more reader", x: 60, y: 640, size: 28, chapter: "timeline" },
        { type: "text", id: "t2", text: "the question to follow: who gets to publish?", x: 60, y: 700, size: 22, color: YELLOW, chapter: "timeline" },
      ] },
    },
    {
      chapters: [{ op: "add", id: "press", title: "The press: causes and effects" }],
      scene: { mode: "append", artifacts: [{
        type: "mermaid", id: "mm", x: 40, y: 60, width: 1120, height: 700, chapter: "press", label: "causes and effects",
        source: "mindmap\n  Printing press\n    Causes\n      Cheap paper\n      Metalworking skill\n      Demand for books\n    Effects\n      Reformation pamphlets\n      Standard spelling\n      Scientific journals",
      }] },
      camera: { chapter: "press" },
    },
    {
      chapters: [{ op: "add", id: "argument", title: "Did the press cause the Reformation?" }],
      scene: { mode: "append", shapes: [
        { type: "rect", id: "bc", x: 330, y: 70, w: 540, h: 100, chapter: "argument" },
        { type: "text", id: "claim", text: "The press made the Reformation possible", x: 600, y: 130, size: 26, anchor: "middle", chapter: "argument" },
      ] },
      camera: { chapter: "argument" },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "rect", id: "b1", x: 40, y: 300, w: 340, h: 120, color: GREEN, chapter: "argument" },
        { type: "text", id: "s1", text: "Printed copies of Luther's\ntheses spread across\nGermany in weeks", x: 210, y: 340, size: 21, anchor: "middle", chapter: "argument" },
        { type: "rect", id: "b2", x: 430, y: 300, w: 340, h: 120, color: GREEN, chapter: "argument" },
        { type: "text", id: "s2", text: "A printed German Bible\nlet readers check\nthe Church's claims", x: 600, y: 340, size: 21, anchor: "middle", chapter: "argument" },
        { type: "arrow", id: "a1", points: [[210, 300], [440, 172]], color: GREEN, width: 2.5, chapter: "argument" },
        { type: "arrow", id: "a2", points: [[600, 300], [600, 172]], color: GREEN, width: 2.5, chapter: "argument" },
        { type: "text", id: "l1", text: "supports", x: 250, y: 230, size: 20, italic: true, color: GREEN, chapter: "argument" },
      ] },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "rect", id: "b3", x: 820, y: 300, w: 340, h: 120, color: RED, chapter: "argument" },
        { type: "text", id: "o1", text: "Wycliffe and Hus said much\nthe same a century earlier,\nbefore print", x: 990, y: 340, size: 21, anchor: "middle", chapter: "argument" },
        { type: "arrow", id: "a3", points: [[990, 300], [760, 172]], color: RED, width: 2.5, chapter: "argument" },
        { type: "text", id: "l3", text: "objects", x: 900, y: 230, size: 20, italic: true, color: RED, chapter: "argument" },
      ] },
    },
    {
      scene: { mode: "append", shapes: [
        { type: "rect", id: "b4", x: 820, y: 560, w: 340, h: 120, color: YELLOW, chapter: "argument" },
        { type: "text", id: "r1", text: "but without print, their\nideas stayed in England\nand Bohemia", x: 990, y: 600, size: 21, anchor: "middle", chapter: "argument" },
        { type: "arrow", id: "a4", points: [[990, 560], [990, 422]], color: YELLOW, width: 2.5, chapter: "argument" },
        { type: "text", id: "l4", text: "answers", x: 1005, y: 500, size: 20, italic: true, color: YELLOW, chapter: "argument" },
        { type: "text", id: "t3", text: "claim on top, reasons below,\narrows say how each one bears on it", x: 60, y: 620, size: 22, color: MUTED, chapter: "argument" },
      ] },
    },
  ],
};

export const LESSONS = [PHYSICS, MRI, CHEM, CS, HISTORY];
