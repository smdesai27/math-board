import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-teaching-"));
  server = new BoardServer({ dataDir });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

async function lesson(page, hash = "&static=1") {
  await page.goto(server.url + hash);
  await expect(page.locator("#conn")).toContainText("Connected");
  server.update({
    chapters: [{ op: "add", id: "c1", title: "Energy", x: 0, y: 0 }],
    camera: { chapter: "c1" },
    equations: [{ op: "add", id: "q", latex: "E_k = ?", x: 100, y: 120, chapter: "c1" }, { op: "add", id: "ans", latex: "\\tfrac12 m v^2", x: 100, y: 260, chapter: "c1", cover: true }],
    scene: { mode: "append", shapes: [{ type: "text", id: "note", text: "kinetic energy", x: 500, y: 150, chapter: "c1" }] },
  });
  await expect(page.locator('#blackboard g[data-id="ans"]')).toHaveCount(1);
}
const opacity = (page, id) => page.locator(`#blackboard g[data-id="${id}"]`).evaluate((g) => Number(getComputedStyle(g).opacity));

test("focus rings the items the tutor points at and dims the rest, until its next update", async ({ page }) => {
  await lesson(page);
  await expect(page.locator("#overlay .focus-ring")).toHaveCount(0);
  server.update({ focus: ["q"] });
  const ring = page.locator("#overlay .focus-ring");
  await expect(ring).toHaveCount(1);
  // The ring sits around the equation, in the same view as the board.
  const [r, f] = [await ring.boundingBox(), await page.locator('#blackboard g[data-id="q"] .formula').boundingBox()];
  expect(r.x).toBeLessThan(f.x);
  expect(r.y).toBeLessThan(f.y);
  expect(r.x + r.width).toBeGreaterThan(f.x + f.width);
  expect(r.y + r.height).toBeGreaterThan(f.y + f.height);
  expect(r.width).toBeLessThan(f.width + 60);
  await expect.poll(() => opacity(page, "note")).toBeLessThan(0.5);
  expect(await opacity(page, "q")).toBe(1);
  // Panning keeps the ring on its item.
  await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(async () => Math.round((await ring.boundingBox()).x - (await page.locator('#blackboard g[data-id="q"] .formula').boundingBox()).x)).toBe(Math.round(r.x - f.x));
  // Stepped back, the board is as it was: no pointing. Live again, it is back.
  await page.keyboard.press("ArrowLeft");
  await expect(ring).toHaveCount(0);
  await page.keyboard.press("End");
  await expect(ring).toHaveCount(1);
  server.update({ title: "on we go" });
  await expect(ring).toHaveCount(0);
  await expect.poll(() => opacity(page, "note")).toBe(1);
  // The layout check still measures every item while one is pointed at.
  server.update({ focus: ["note"] });
  await expect(ring).toHaveCount(1);
  expect((await page.evaluate(() => window.__boardLint())).items.map((i) => i.id).sort()).toEqual(["ans", "note", "q"]);
});

test("a covered item stays hidden until the learner clicks its cover; the tutor's board_read says so", async ({ page }) => {
  await lesson(page);
  const cover = page.locator('#overlay .cover[data-cover-for="ans"]');
  await expect(cover).toHaveCount(1);
  expect(await opacity(page, "ans")).toBe(0);
  // The cover is over the answer, and the answer is still measured.
  const [c, f] = [await cover.boundingBox(), await page.locator('#blackboard g[data-id="ans"] .formula').boundingBox()];
  expect(c.x).toBeLessThan(f.x);
  expect(c.x + c.width).toBeGreaterThan(f.x + f.width);
  expect((await page.evaluate(() => window.__boardLint())).items.some((i) => i.id === "ans" && i.w > 0)).toBe(true);
  const sse = (s) => [...s.clients].filter((r) => !r.snapshot).length;
  expect(sse(server)).toBe(1);
  await expect.poll(() => server.learnerLine()).toMatch(/looking at chapter c1 · on the latest step \(1\) · has not uncovered ans/);
  const rev = server.revision;
  await cover.click();
  await expect(cover).toHaveCount(0);
  await expect.poll(() => opacity(page, "ans")).toBe(1);
  await expect.poll(() => server.learnerLine()).toMatch(/uncovered ans/);
  expect(server.revision).toBe(rev); // lifting a cover is the learner's own view, not a change to the board
  await expect(page.locator("#toast")).toBeHidden(); // and it does not copy a reference
  // A new cover in a later step appears with its step; the keyboard lifts it too.
  server.update({ scene: { mode: "append", shapes: [{ type: "text", id: "hint", text: "think about v", x: 500, y: 300, chapter: "c1", cover: true }] } });
  const hint = page.locator('#overlay .cover[data-cover-for="hint"]');
  await expect(hint).toHaveCount(1);
  await hint.focus();
  await page.keyboard.press("Enter");
  await expect(hint).toHaveCount(0);
  // The tutor lifts a cover for everyone.
  server.update({ scene: { mode: "append", shapes: [{ type: "text", id: "last", text: "done", x: 500, y: 400, chapter: "c1", cover: true }] } });
  await expect(page.locator('#overlay .cover[data-cover-for="last"]')).toHaveCount(1);
  server.update({ items: [{ op: "update", id: "last", fields: { cover: false } }] });
  await expect(page.locator("#overlay .cover")).toHaveCount(0);
  await expect.poll(() => opacity(page, "last")).toBe(1);
});

test("the tab reports its step, sliders and the item last clicked; the headless check page reports nothing", async ({ page }) => {
  await lesson(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "plot", id: "p", chapter: "c1", x: 500, y: 300, width: 500, height: 360, functions: [{ expr: "a x" }], params: [{ name: "a", min: 0, max: 4, value: 1, step: 1 }] }] } });
  await expect(page.locator('#blackboard g[data-id="p"] .slider-track')).toHaveCount(1);
  await expect.poll(() => server.learnerLine()).toMatch(/on the latest step \(2\) · sliders p: a = 1/);
  await page.locator('#blackboard g[data-id="p"] .slider-track').focus();
  await page.keyboard.press("End");
  await expect.poll(() => server.learnerLine()).toMatch(/sliders p: a = 4/);
  const note = await page.locator('#blackboard g[data-id="note"]').boundingBox();
  await page.mouse.click(note.x + note.width / 2, note.y + note.height / 2);
  await expect.poll(() => server.learnerLine()).toMatch(/last clicked note/);
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => server.learnerLine()).toMatch(/stepped back to step 1 of 2/);
  // The snapshot page (nofollow) shows the same board and never reports a view.
  const before = server.learner.at;
  const check = await page.context().newPage();
  await check.setExtraHTTPHeaders({ "x-math-board-snapshot": "1" });
  await check.goto(`${server.url}&nofollow=1`);
  await expect(check.locator('#overlay .cover[data-cover-for="ans"]')).toHaveCount(1);
  await check.waitForTimeout(1200);
  expect(server.learner.at).toBe(before);
});

test("items placed below and right of another land clear of it, measured in the page", async ({ page }) => {
  await lesson(page);
  const lint = async () => {
    await page.waitForFunction((rev) => window.__board.revision >= rev && window.__board.pending === 0, server.revision);
    const out = await page.evaluate(() => window.__boardLint());
    server.noteBoxes(out.items, server.revision);
    return out;
  };
  await lint();
  server.update({
    equations: [{ op: "add", id: "next", latex: "E_p = mgh", below: "q" }],
    scene: { mode: "append", shapes: [{ type: "text", id: "side", text: "what we want", rightOf: "q" }, { type: "arrow", id: "link", from: "note", to: "q" }] },
  });
  const { items, issues } = await lint();
  const box = (id) => items.find((i) => i.id === id);
  expect(issues).toEqual([]);
  expect(box("next").x).toBe(box("q").x);
  expect(box("next").y - (box("q").y + box("q").h)).toBeGreaterThanOrEqual(20);
  expect(box("next").y - (box("q").y + box("q").h)).toBeLessThanOrEqual(30);
  expect(box("side").x - (box("q").x + box("q").w)).toBeGreaterThanOrEqual(20);
  expect(Math.abs(box("side").y - box("q").y)).toBeLessThanOrEqual(8);
});
