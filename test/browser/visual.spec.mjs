/**
 * Visual defaults on the black board, checked at DOM level (no pixel comparisons): the demo
 * lessons lay out without warnings, plot chrome and labels stay legible, Mermaid uses the chalk
 * theme, molecules are drawn and framed, tiny diagrams are reported, and the overview keeps
 * chapter titles readable.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
import { LESSONS, PHYSICS, MRI, CHEM } from "../../scripts/demo-lessons-data.mjs";

let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-visual-"));
  server = new BoardServer({ dataDir, autosave: false });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

/** Open the board like a snapshot page (static: every step shown, no camera following). */
async function open(page) {
  await page.goto(`${server.url}&nofollow=1`);
  await expect(page.locator("#conn")).toContainText("Connected");
}
/** Wait until the page has committed the server's revision and finished async rendering. */
async function settled(page) {
  await page.waitForFunction((rev) => window.__board && window.__board.revision >= rev && window.__board.pending === 0, server.revision, { timeout: 15000 });
}
function play(lesson) {
  server.update({ baseRevision: server.revision, clear: ["all"] });
  for (const step of lesson.steps) server.update({ baseRevision: server.revision, ...step });
}
/** The SVG markup behind an image artifact (svg, mermaid, molecule): its data URI decoded. */
async function imageSvg(page, id) {
  const href = await page.locator(`#blackboard g[data-id="${id}"] image`).getAttribute("href");
  expect(href).toMatch(/^data:image\/svg\+xml/);
  return decodeURIComponent(href.replace(/^data:image\/svg\+xml;charset=utf-8,/, ""));
}

test("the three demo lessons render completely with no layout warnings", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await open(page);
  for (const lesson of LESSONS) {
    play(lesson);
    await settled(page);
    const lint = await page.evaluate(() => window.__boardLint());
    expect(lint.issues, lesson.slug).toEqual([]);
    const artifacts = lesson.steps.flatMap((s) => s.scene?.artifacts ?? []);
    for (const a of artifacts.filter((x) => x.type !== "plot"))
      await expect(page.locator(`#blackboard g[data-id="${a.id}"] image`), `${lesson.slug} ${a.id}`).toHaveCount(1);
    expect(await page.locator("#blackboard [data-render-error]").count()).toBe(0);
  }
  expect(errors).toEqual([]);
});

test("plot axes, ticks and labels are legible on black and never collide at the top of the axis", async ({ page }) => {
  await open(page);
  server.update({ ...MRI.steps[0], scene: { mode: "append", artifacts: [{ ...MRI.steps[0].scene.artifacts[0], vlines: [{ x: -1, label: "−1/a" }, { x: 1 }] }] } });
  await settled(page);
  const p = await page.evaluate(() => {
    const g = document.querySelector('#blackboard g[data-id="p1"] .plot');
    const css = (el, k) => getComputedStyle(el).getPropertyValue(k);
    const box = (el) => { const b = el.getBBox(); return { x: b.x, y: b.y, w: b.width, h: b.height }; };
    const tick = g.querySelector(".plot-ticks text"), axes = g.querySelector(".plot-axes");
    const ylabel = g.querySelector(".plot-ylabel"), area = g.querySelector("clipPath rect");
    const pointLabel = [...g.querySelectorAll("text")].find((t) => t.textContent === "S(0)");
    const children = [...g.children];
    return {
      axisStroke: css(axes, "stroke"), tickFill: css(tick, "fill"), tickSize: css(tick, "font-size"),
      tickHalo: [css(tick, "stroke"), css(tick, "paint-order")],
      ticksAfterCurves: children.indexOf(g.querySelector(".plot-ticks")) > children.findIndex((c) => c.querySelector?.("polyline")),
      ylabel: box(ylabel), plotTop: Number(area.getAttribute("y")), point: box(pointLabel),
      vlineLabel: [...g.querySelectorAll("text")].some((t) => t.textContent === "−1/a"),
    };
  });
  expect(p.axisStroke).toBe("rgb(155, 150, 138)");
  expect(p.tickFill).toBe("rgb(185, 180, 166)");
  expect(p.tickSize).toBe("14px");
  expect(p.tickHalo).toEqual(["rgb(0, 0, 0)", "stroke"]);
  expect(p.ticksAfterCurves).toBe(true);
  // The y label sits in its own row above the plot area, clear of the point label S(0) at the peak.
  expect(p.ylabel.y + p.ylabel.h).toBeLessThanOrEqual(p.plotTop);
  const overlap = Math.min(p.ylabel.x + p.ylabel.w, p.point.x + p.point.w) > Math.max(p.ylabel.x, p.point.x) &&
    Math.min(p.ylabel.y + p.ylabel.h, p.point.y + p.point.h) > Math.max(p.ylabel.y, p.point.y);
  expect(overlap).toBe(false);
  expect(p.vlineLabel).toBe(true);
});

test("Mermaid diagrams use the chalk theme: serif light text, dark nodes, chalk edges, opaque label backgrounds", async ({ page }) => {
  await open(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "mermaid", id: "m", x: 40, y: 40, width: 700, height: 300, source: "graph LR\n  A[RF pulse] -->|next TR| B[Readout]\n  B ==> C((Image))" }] } });
  await settled(page);
  const svg = await imageSvg(page, "m");
  // Computed styles of the diagram's own stylesheet, with the markup mounted inline in the page.
  const s = await page.evaluate((markup) => {
    const host = document.createElement("div");
    host.style.cssText = "position:absolute;left:-5000px;top:0";
    host.innerHTML = markup;
    document.body.appendChild(host);
    const q = (sel) => host.querySelector(sel), css = (el, k) => getComputedStyle(el).getPropertyValue(k);
    const out = {
      nodeFill: css(q(".node rect"), "fill"), nodeStroke: css(q(".node rect"), "stroke"),
      text: css(q(".node text"), "fill"), font: css(q(".node text"), "font-family"),
      link: [css(q(".flowchart-link"), "stroke"), css(q(".flowchart-link"), "stroke-width")],
      thick: css(q(".edge-thickness-thick"), "stroke-width"),
      labelBg: [css(q(".edgeLabel rect.background"), "opacity"), css(q(".edgeLabel rect.background"), "fill")],
      arrow: Number(q('marker[id$="-pointEnd"]').getAttribute("markerWidth")),
    };
    host.remove();
    return out;
  }, svg);
  expect(s.nodeFill).toBe("rgb(22, 22, 22)");
  expect(s.nodeStroke).toBe("rgb(189, 184, 168)");
  expect(s.text).toBe("rgb(232, 227, 217)");
  expect(s.font).toMatch(/Charter/);
  expect(s.link).toEqual(["rgb(199, 197, 173)", "1.8px"]);
  expect(s.thick).toBe("3.5px");
  expect(s.labelBg).toEqual(["1", "rgb(0, 0, 0)"]);
  expect(s.arrow).toBeGreaterThan(10);
});

test("the layout check reports a Mermaid diagram shrunk below reading size", async ({ page }) => {
  await open(page);
  const source = "graph LR\n  A[RF pulse] --> B[Phase encode] --> C[Frequency encode] --> D[Readout] --> E[Fourier transform] --> F[Image]";
  server.update({ scene: { mode: "append", artifacts: [
    { type: "mermaid", id: "tiny", x: 40, y: 40, width: 320, height: 90, source },
    { type: "mermaid", id: "roomy", x: 40, y: 300, width: 1120, height: 300, source },
  ] } });
  await settled(page);
  const { issues } = await page.evaluate(() => window.__boardLint());
  expect(issues.filter((i) => /^mermaid /.test(i))).toHaveLength(1);
  expect(issues.find((i) => /^mermaid /.test(i))).toMatch(/^mermaid tiny: text renders at about \d+ px .* it needs at least \d+x\d+/);
});

test("molecules are drawn in chalk colours and framed to their box", async ({ page }) => {
  await open(page);
  play(CHEM);
  server.update({ baseRevision: server.revision, scene: { mode: "append", artifacts: [
    { type: "molecule", id: "palm", smiles: "CCCCCCCCCCCCCCCC(=O)O", x: 40, y: 560, width: 560, height: 160, chapter: "asa" },
  ] } });
  await settled(page);
  for (const id of ["m1", "palm"]) {
    const m = await page.evaluate((markup) => {
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      const [, , w, h] = doc.documentElement.getAttribute("viewBox").split(/\s+/).map(Number);
      return {
        strokes: doc.querySelectorAll("path,line,polygon").length,
        labels: [...doc.querySelectorAll("text")].map((t) => t.textContent).join(""),
        fills: [...doc.querySelectorAll("[fill]")].map((e) => e.getAttribute("fill").toLowerCase()),
        aspect: w / h,
      };
    }, await imageSvg(page, id));
    expect(m.strokes, id).toBeGreaterThan(10);
    expect(m.labels, id).toContain("O");
    expect(m.fills, id).toContain("#ef6f6c"); // oxygen
    expect(m.fills.filter((f) => f === "#000" || f === "#000000"), id).toEqual([]);
    if (id === "palm") expect(m.aspect).toBeGreaterThan(2.5); // a long chain fills a wide box
  }
});

test("chapter titles keep a readable on-screen size in the overview; frames keep their weight", async ({ page }) => {
  await open(page);
  play(PHYSICS);
  await settled(page);
  const title = (view) => page.evaluate((v) => {
    window.__setView(...v);
    const svg = document.getElementById("blackboard"), t = svg.querySelector(".chapter-title");
    const unitsPerPx = Math.max(v[2] / svg.clientWidth, v[3] / svg.clientHeight);
    return { boardPx: parseFloat(getComputedStyle(t).fontSize), screenPx: parseFloat(getComputedStyle(t).fontSize) / unitsPerPx };
  }, view);
  // Two chapters side by side, as board_snapshot's overview frames them.
  const overview = await title([-60, -80, 2760 + 120, 800 + 140]);
  expect(overview.screenPx).toBeGreaterThanOrEqual(14.5);
  // At full size the title is the plain 22 px label.
  expect((await title([0, 0, 1200, 800])).boardPx).toBe(22);
  await expect(page.locator("#blackboard .chapter-frame rect").first()).toHaveAttribute("vector-effect", "non-scaling-stroke");
});

test("plots whose range is about one ULP wide (or clamped to one value) render with bounded ticks instead of hanging", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const tiny = [999999.9999999999, 1e6]; // one ULP apart: the tick step is below half an ULP
  const plot = (id, x, extra) => ({ type: "plot", id, x, y: 40, width: 360, height: 280, functions: [{ expr: "x" }], parametric: [], areas: [], points: [], vlines: [], hlines: [], ...extra });
  // Served straight to the page, so the browser's own guard is tested whatever the server accepts.
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.board.scene.artifacts = [
      plot("ulp", 40, { xRange: tiny, yRange: tiny }),
      plot("flat", 420, { xRange: [1e6, 1e6], yRange: [1e6, 1e6] }),
      plot("normal", 800, { xRange: [-10, 10] }),
    ];
    await route.fulfill({ response, json });
  });
  await open(page);
  await expect(page.locator("#blackboard .plot")).toHaveCount(3);
  const ticks = await page.evaluate(() => Object.fromEntries(["ulp", "flat", "normal"].map((id) => {
    const g = document.querySelector(`#blackboard g[data-id="${id}"] .plot`);
    return [id, { grid: g.querySelectorAll("line").length, labels: g.querySelectorAll(".plot-ticks text").length }];
  })));
  for (const id of ["ulp", "flat"]) {
    expect(ticks[id].grid, id).toBeLessThanOrEqual(2 * 201 + 2);
    expect(ticks[id].labels, id).toBeLessThanOrEqual(2 * 201);
  }
  expect(ticks.normal.labels).toBeGreaterThan(4);
  expect(errors).toEqual([]);
});

test("equations measure the same in board units at any window size", async ({ page }) => {
  await open(page);
  server.update({ equations: [{ op: "add", id: "eq", latex: "\\int_0^\\infty e^{-x^2}\\,dx = \\frac{\\sqrt\\pi}{2}", label: "Gauss", x: 100, y: 100 }] });
  await settled(page);
  const box = () => page.evaluate(() => { window.__setView(0, 0, 1200, 800); return window.__boardLint().items.find((i) => i.id === "eq"); });
  const wide = await box();
  for (const size of [{ width: 600, height: 400 }, { width: 2400, height: 1600 }]) {
    await page.setViewportSize(size);
    const other = await box();
    for (const k of ["x", "y", "w", "h"]) expect(Math.abs(other[k] - wide[k]), `${k} at ${size.width} px`).toBeLessThanOrEqual(1);
  }
});
