/**
 * Equations and math table cells are HTML (KaTeX) inside SVG <foreignObject>s. WebKit (Safari and
 * the Mac app's WKWebView) paints KaTeX's positioned spans there on layers of their own, at 1:1
 * scale and, without the root's position:fixed, at the foreignObject's untransformed x,y: every
 * equation then piles up unscaled at the top left. style.css and app.jsx (WEBKIT_FO) correct
 * that. The DOM reports the right boxes even while the paint is wrong, so these checks read the
 * painted pixels.
 */
import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";

let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-fo-"));
  server = new BoardServer({ dataDir, autosave: false });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

/** Number of bright (chalk) pixels painted inside a screen rectangle. */
async function brightPixels(page, box) {
  const clip = { x: Math.max(0, Math.floor(box.x)), y: Math.max(0, Math.floor(box.y)), width: Math.max(1, Math.ceil(box.w)), height: Math.max(1, Math.ceil(box.h)) };
  const png = (await page.screenshot({ clip, animations: "disabled" })).toString("base64");
  return page.evaluate(async (b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
    const canvas = document.createElement("canvas");
    canvas.width = bmp.width; canvas.height = bmp.height;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    let n = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i] + d[i + 1] + d[i + 2] > 450) n++;
    return n;
  }, png);
}
/**
 * Where the HTML roots of item id should be on screen, from the layout alone: the top left of
 * their foreignObject and their size in board units times the view's scale. Not from their
 * client rects, which are what a browser computes, not what it paints.
 */
const expectedBoxes = (page, id) => page.evaluate((id) => {
  const k = document.getElementById("blackboard").getScreenCTM().a;
  return [...document.querySelectorAll(`#blackboard g[data-id="${id}"] foreignObject > div`)].map((root) => {
    const fo = root.parentNode.getBoundingClientRect();
    return { x: fo.x, y: fo.y, w: root.offsetWidth * k, h: root.offsetHeight * k };
  });
}, id);
const inset = (b, d) => ({ x: b.x + d, y: b.y + d, w: b.w - 2 * d, h: b.h - 2 * d });

test("equations and math table cells are painted in their chapters at any zoom", async ({ page }) => {
  await page.goto(`${server.url}&nofollow=1`);
  await expect(page.locator("#conn")).toContainText("Connected");
  server.update({
    baseRevision: server.revision,
    chapters: [{ op: "add", id: "a", title: "A", x: 0, y: 0 }, { op: "add", id: "b", title: "B", x: 1600, y: 900 }],
    equations: [
      { op: "add", id: "e1", latex: "a^2 + b^2 = c^2", x: 200, y: 300, chapter: "a" },
      { op: "add", id: "e2", latex: "F = m a", x: 200, y: 300, chapter: "b" },
    ],
    scene: { mode: "append", artifacts: [{ type: "table", id: "t", header: ["n", "$n^2$"], rows: [["1", "$1^2$"], ["2", "$2^2$"]], x: 700, y: 250, width: 400, height: 240, chapter: "b" }] },
  });
  await page.waitForFunction((rev) => window.__board && window.__board.revision >= rev && window.__board.pending === 0, server.revision, { timeout: 15000 });

  // Zoomed out over both chapters, into chapter b, and zoomed in on chapter a.
  for (const [view, ids] of [[[-100, -100, 3400, 2200], ["e1", "e2", "t"]], [[1500, 800, 1200, 800], ["e2", "t"]], [[-50, -50, 700, 500], ["e1"]]]) {
    await page.evaluate((v) => window.__setView(...v), view);
    for (const id of ids) {
      const boxes = await expectedBoxes(page, id);
      expect(boxes.length, id).toBeGreaterThan(0);
      for (const box of boxes) {
        expect(await brightPixels(page, inset(box, 3)), `${id} painted in its box, view ${view}`).toBeGreaterThan(5);
        // Drawn unscaled, an equation would spill past its box when zoomed out.
        if (id !== "t") expect(await brightPixels(page, { x: box.x + box.w + 2, y: box.y, w: box.w, h: box.h }), `${id} only in its box, view ${view}`).toBe(0);
      }
    }
  }
  // Zoomed out, nothing is painted where unscaled, untransformed HTML would land (board x,y as
  // screen pixels): that is empty board in this view.
  await page.evaluate(() => window.__setView(-100, -100, 3400, 2200));
  const svg = await page.locator("#blackboard").boundingBox();
  expect(await brightPixels(page, { x: svg.x + 200, y: svg.y + 300, w: 220, h: 60 })).toBe(0);

  // The page measures an equation where it is drawn (layout lint, pointing, hover).
  const lint = await page.evaluate(() => window.__boardLint().items.find((i) => i.id === "e1"));
  const [e1] = await expectedBoxes(page, "e1");
  const k = await page.evaluate(() => document.getElementById("blackboard").getScreenCTM().a);
  expect(Math.abs(lint.w - e1.w / k)).toBeLessThan(3);
  expect(Math.abs(lint.h - e1.h / k)).toBeLessThan(3);
  expect(lint.x).toBe(200);

  // A fading item fades its equation, and a covered one hides it.
  await page.evaluate(() => {
    const g = document.querySelector('#blackboard g[data-id="e2"]');
    g.style.opacity = "0";
    g.style.setProperty("--fade", "0");
    document.querySelector('#blackboard g[data-id="t"]').classList.add("covered");
  });
  const [e2] = await expectedBoxes(page, "e2");
  expect(await brightPixels(page, e2)).toBe(0);
  for (const cell of await expectedBoxes(page, "t")) expect(await brightPixels(page, inset(cell, 3))).toBe(0);
});

test("pointing dims the equations it does not point at", async ({ page }) => {
  await page.goto(`${server.url}&nofollow=1`);
  await expect(page.locator("#conn")).toContainText("Connected");
  server.update({
    baseRevision: server.revision,
    equations: [
      { op: "add", id: "p", latex: "a^2 + b^2 = c^2", x: 100, y: 120 },
      { op: "add", id: "q", latex: "E = m c^2", x: 700, y: 120 },
    ],
  });
  await page.waitForFunction((rev) => window.__board && window.__board.revision >= rev && window.__board.pending === 0, server.revision, { timeout: 15000 });
  await page.evaluate(() => window.__setView(0, 0, 1200, 800));
  const [[p], [q]] = [await expectedBoxes(page, "p"), await expectedBoxes(page, "q")];
  expect(await brightPixels(page, inset(q, 2))).toBeGreaterThan(5);
  // The veil is drawn over the board: in WebKit the equations are layers of their own, and they
  // must still sit under it.
  server.update({ focus: ["p"] });
  await expect(page.locator("#overlay .focus-veil")).toHaveCount(1);
  await expect.poll(() => brightPixels(page, inset(q, 2))).toBe(0);
  expect(await brightPixels(page, inset(p, 2))).toBeGreaterThan(5);
});
