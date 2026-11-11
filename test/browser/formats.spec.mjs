import { test, expect } from "@playwright/test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-formats-"));
  server = new BoardServer({ dataDir });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});
// A 2x1 red PNG.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAABCAYAAAD0In+KAAAAD0lEQVR4AWP8z8DwnwEIAAsEAgCQkjTnAAAAAElFTkSuQmCC", "base64");
const FILE = `${"ab".repeat(32)}.png`;

async function draw(page, artifacts) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${server.url}&static=1`);
  await expect(page.locator("#conn")).toContainText("Connected");
  server.update({ scene: { mode: "append", artifacts } });
  await page.waitForFunction((rev) => window.__board.revision >= rev && window.__board.pending === 0, server.revision);
  return { errors, lint: () => page.evaluate(() => window.__boardLint()) };
}

test("a table draws its header, cells, math and highlights inside its box", async ({ page }) => {
  const { errors, lint } = await draw(page, [{ type: "table", id: "tt", x: 60, y: 80, header: ["p", "q", "$p \\land q$"], rows: [["T", "T", "T"], ["T", "F", "F"]], highlight: [{ row: 1 }, { col: 2 }] }]);
  const g = page.locator('#blackboard g[data-id="tt"]');
  await expect(g.locator("text")).toHaveCount(8);
  await expect(g.locator(".table-math .katex")).toHaveCount(1);
  await expect(g.locator(".table-highlight")).toHaveCount(2);
  const { items, issues } = await lint();
  expect(issues).toEqual([]);
  const box = items.find((i) => i.id === "tt");
  expect(box.w).toBeLessThanOrEqual(392);
  expect(box.h).toBeLessThanOrEqual(134);
  // The math cell sits in the third column of the header row.
  const [math, table] = [await g.locator(".table-math .katex").boundingBox(), await g.boundingBox()];
  expect(math.x).toBeGreaterThan(table.x + (table.width * 2) / 3);
  expect(math.y + math.height).toBeLessThan(table.y + table.height / 3 + 4);
  expect(errors).toEqual([]);
});

test("a code listing keeps its indentation, numbers its lines and marks the highlighted ones", async ({ page }) => {
  const { errors, lint } = await draw(page, [{ type: "code", id: "c", x: 60, y: 80, language: "python", highlight: [2], source: "while lo <= hi:\n    mid = (lo + hi) // 2\n    x = '<b>&amp;'" }]);
  const g = page.locator('#blackboard g[data-id="c"]');
  await expect(g.locator(".code-highlight")).toHaveCount(1);
  expect(await g.locator("text").allTextContents()).toEqual(["python", "1", "while lo <= hi:", "2", "    mid = (lo + hi) // 2", "3", "    x = '<b>&amp;'"]);
  // Indentation is drawn: the second line starts to the right of the first.
  const starts = await g.locator("text").evaluateAll((els) => els.filter((e) => /^\s*(while|mid)/.test(e.textContent)).map((e) => { const r = document.createRange(); const node = e.firstChild; const at = e.textContent.search(/\S/); r.setStart(node, at); r.setEnd(node, at + 1); return r.getBoundingClientRect().x; }));
  expect(starts[1]).toBeGreaterThan(starts[0] + 20);
  expect(await page.locator("#blackboard b").count()).toBe(0); // markup in a listing stays text
  expect((await lint()).issues).toEqual([]);
  expect(errors).toEqual([]);
});

test("bar charts and histograms draw one bar per value or bin", async ({ page }) => {
  const { errors, lint } = await draw(page, [
    { type: "chart", id: "b", kind: "bar", x: 40, y: 60, width: 420, height: 300, title: "Groups", bars: [{ label: "A", value: 12 }, { label: "B", value: 6 }, { label: "O", value: -3 }] },
    { type: "chart", id: "h", kind: "histogram", x: 520, y: 60, width: 420, height: 300, bins: 4, range: [0, 8], values: [1, 1, 1, 3, 5, 5, 7, 9] },
  ]);
  const heights = (id) => page.locator(`#blackboard g[data-id="${id}"] .chart-bar`).evaluateAll((els) => els.map((e) => Math.round(e.height.baseVal.value)));
  const b = await heights("b");
  expect(b.length).toBe(3);
  expect(Math.abs(b[0] - 2 * b[1])).toBeLessThanOrEqual(1); // 12 is twice 6
  expect(await page.locator('#blackboard g[data-id="b"] text').allTextContents()).toEqual(expect.arrayContaining(["Groups", "A", "B", "O", "12", "6", "−3"]));
  // 3, 1, 2, 1 values in [0,2), [2,4), [4,6), [6,8]; 9 is outside the range.
  const h = await heights("h");
  expect(h.length).toBe(4);
  expect(Math.abs(h[0] - 3 * h[1])).toBeLessThanOrEqual(2);
  expect(Math.abs(h[2] - 2 * h[3])).toBeLessThanOrEqual(2);
  expect((await lint()).issues).toEqual([]);
  expect(errors).toEqual([]);
});

test("vectors and segments sit on the plot's own axes and follow its sliders", async ({ page }) => {
  const { errors } = await draw(page, [{ type: "plot", id: "v", x: 60, y: 60, width: 500, height: 500, xRange: [-2, 2], yRange: [-2, 2], equalAspect: true, params: [{ name: "a", min: 0, max: 3, value: 0, step: 1 }],
    vectors: [{ from: [0, 0], to: [1, 0], label: "i" }, { from: [0, 0], to: ["cos(a)", "sin(a)"], label: "r" }], segments: [{ from: [1, 0], to: [1, 1] }] }]);
  const g = page.locator('#blackboard g[data-id="v"]');
  await expect(g.locator(".plot-vector")).toHaveCount(2);
  await expect(g.locator(".plot-segment")).toHaveCount(1);
  const tip = (i) => g.locator(".plot-vector polygon").nth(i).evaluate((p) => { const q = p.points.getItem(0); return [Math.round(q.x), Math.round(q.y)]; });
  // With a = 0 both vectors end at (1, 0); the head of a horizontal vector is at the origin's height.
  expect(await tip(1)).toEqual(await tip(0));
  await g.locator(".slider-track").focus();
  await page.keyboard.press("ArrowRight"); // a = 1: the second vector turns up and to the left of (1, 0)
  await expect.poll(async () => (await tip(1))[1]).toBeLessThan((await tip(0))[1] - 50);
  expect((await tip(1))[0]).toBeLessThan((await tip(0))[0]);
  expect(errors).toEqual([]);
});

test("an image artifact shows the board's copy of the file; a missing file is reported like a failed artifact", async ({ page }) => {
  await mkdir(path.join(dataDir, "images"), { recursive: true });
  await writeFile(path.join(dataDir, "images", FILE), PNG);
  const { errors, lint } = await draw(page, [{ type: "image", id: "ok", x: 60, y: 60, width: 400, file: FILE, natural: [2, 1] }, { type: "image", id: "gone", x: 60, y: 400, width: 300, height: 100, file: `${"cd".repeat(32)}.png` }]);
  const image = page.locator('#blackboard g[data-id="ok"] image');
  await expect(image).toHaveAttribute("href", `/images/${FILE}`);
  expect(await image.evaluate((el) => [el.width.baseVal.value, el.height.baseVal.value])).toEqual([400, 200]);
  const { issues } = await lint();
  expect(issues).toEqual([expect.stringMatching(/artifact gone FAILED TO RENDER: the image file is missing/)]);
  expect(errors).toEqual([]);
});
