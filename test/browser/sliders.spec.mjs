import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-sliders-"));
  server = new BoardServer({ dataDir });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});

const FID = {
  type: "plot", id: "fid", chapter: "c1", x: 60, y: 80, width: 700, height: 500, xRange: [0, 10], yRange: [-1.1, 1.1], duration: 100,
  params: [{ name: "w", min: 0.5, max: 6, value: 3, step: 0.5, label: "ω", period: 1 }, { name: "T2", min: 0.5, max: 8, value: 3 }],
  functions: [{ expr: "exp(-x/T2) cos(w x)", label: "M_x" }],
  points: [{ x: "T2", y: "exp(-1)", label: "1/e", drag: true }],
  vlines: [{ x: "T2" }],
};

/** A board with the FID plot fully drawn; returns helpers for its sliders. */
async function fid(page, plot = FID) {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(server.url);
  await expect(page.locator("#conn")).toContainText("Connected");
  server.update({ chapters: [{ op: "add", id: "c1", title: "Free induction decay", x: 0, y: 0 }], camera: { chapter: "c1" }, scene: { mode: "append", artifacts: [plot] } });
  const g = page.locator('#blackboard g[data-id="fid"]');
  await expect.poll(() => g.evaluate((el) => el.style.visibility !== "hidden" && !el.dataset.revealing), { timeout: 5000 }).toBe(true);
  const params = () => g.locator(".plot").getAttribute("data-params");
  const curve = () => g.locator("polyline").first().getAttribute("points");
  return { g, params, curve, errors, track: (i) => g.locator(".slider-track").nth(i), play: (i) => g.locator(".slider-play").nth(i) };
}

test("sliders redraw the plot live: drag, keys, a draggable point, play; nothing is written to the board", async ({ page }) => {
  const { g, params, curve, errors, track, play } = await fid(page);
  const rev = server.revision;
  await expect(g.locator(".slider-track")).toHaveCount(2);
  expect(await params()).toBe("w = 3.0, T2 = 3.00");
  const before = await curve();
  // Drag ω's knob to the right end of its track.
  const box = await track(0).boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 40, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(params).toBe("w = 6.0, T2 = 3.00");
  expect(await curve()).not.toBe(before);
  // Arrow keys move the focused slider by one step and do not step the lesson.
  const indicator = await page.textContent("#step-indicator");
  await track(0).focus();
  await page.keyboard.press("ArrowLeft");
  await page.keyboard.press("ArrowLeft");
  await expect.poll(params).toBe("w = 5.0, T2 = 3.00");
  expect(await page.textContent("#step-indicator")).toBe(indicator);
  expect(await g.evaluate((el) => el.style.visibility)).not.toBe("hidden");
  await page.keyboard.press("Home");
  await expect.poll(params).toBe("w = 0.5, T2 = 3.00");
  // The draggable 1/e point sits at x = T2: dragging it to the right moves the T2 slider.
  const dot = await g.locator(".plot-drag").boundingBox();
  await page.mouse.move(dot.x + dot.width / 2, dot.y + dot.height / 2);
  await page.mouse.down();
  await page.mouse.move(dot.x + dot.width / 2 + 140, dot.y + dot.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => Number((await params()).match(/T2 = ([\d.]+)/)[1])).toBeGreaterThan(4);
  // ▶ sweeps ω back and forth until paused.
  await play(0).click();
  await expect(play(0)).toHaveAttribute("aria-label", "Pause ω");
  const seen = new Set();
  await expect.poll(async () => { seen.add((await params()).split(",")[0]); return seen.size; }, { timeout: 5000 }).toBeGreaterThan(3);
  await play(0).click();
  await expect(play(0)).toHaveAttribute("aria-label", "Play ω");
  const paused = await params();
  await page.waitForTimeout(300);
  expect(await params()).toBe(paused);
  // Using a slider is viewing, not drawing: no revision, no pan, and the camera keeps following.
  expect(server.revision).toBe(rev);
  await expect(page.locator("#btn-follow")).toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test("a click on the plot copies its reference with the learner's slider values", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  const { g, track } = await fid(page);
  await track(1).focus();
  await page.keyboard.press("End");
  const box = await g.locator(".plot-axes").boundingBox();
  await page.mouse.click(box.x + box.width * 0.7, box.y + box.height * 0.3);
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("step 1, fid (chapter c1) with w = 3.0, T2 = 8.00");
  // A click on a slider changes the slider and copies nothing new.
  await page.evaluate(() => navigator.clipboard.writeText(""));
  const t = await track(0).boundingBox();
  await page.mouse.click(t.x + t.width * 0.05, t.y + t.height / 2);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("");
});

test("each tab and the layout check see the tutor's values; a changed plot starts from its new values", async ({ page, context }) => {
  const { params, track } = await fid(page);
  await track(0).focus();
  await page.keyboard.press("End");
  await expect.poll(params).toBe("w = 6.0, T2 = 3.00");
  const other = await context.newPage();
  await other.goto(server.url);
  await expect(other.locator('#blackboard g[data-id="fid"] .plot')).toHaveAttribute("data-params", "w = 3.0, T2 = 3.00");
  // The measured layout: the slider rows stay inside the plot's box, nothing overlaps.
  const lint = await other.evaluate(() => window.__boardLint());
  expect(lint.issues).toEqual([]);
  const item = lint.items.find((i) => i.id === "fid");
  expect(item.y + item.h).toBeLessThanOrEqual(80 + 500 + 1);
  // The tutor sets a new value: every tab shows it, the learner's own change included.
  server.update({ baseRevision: server.revision, items: [{ op: "update", id: "fid", fields: { params: [{ ...FID.params[0], value: 1 }, FID.params[1]] } }] });
  await expect.poll(params).toBe("w = 1.0, T2 = 3.00");
  await expect(other.locator('#blackboard g[data-id="fid"] .plot')).toHaveAttribute("data-params", "w = 1.0, T2 = 3.00");
});

test("a plot without sliders draws exactly as before (no slider rows, no data-params)", async ({ page }) => {
  const { g } = await fid(page, { type: "plot", id: "fid", chapter: "c1", x: 60, y: 80, width: 700, height: 500, functions: [{ expr: "sin(x)" }], points: [{ x: 1, y: 0.5 }] });
  await expect(g.locator(".plot-slider")).toHaveCount(0);
  expect(await g.locator(".plot").getAttribute("data-params")).toBeNull();
  await expect(g.locator(".plot-drag")).toHaveCount(0);
});

test("slider values show the decimals their step has, in the label and the copied reference", async ({ page }) => {
  const { params, track } = await fid(page, { ...FID, params: [
    { name: "a", min: 0, max: 1, value: 0.25, step: 0.25 },
    { name: "b", min: 0, max: 10, value: 7.5, step: 2.5 },
    { name: "c", min: 0, max: 0.9, value: 0.45, step: 0.15 },
  ], height: 600, functions: [{ expr: "a x + b + c" }], points: [], vlines: [] });
  expect(await params()).toBe("a = 0.25, b = 7.5, c = 0.45");
  await track(0).focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(params).toBe("a = 0.50, b = 7.5, c = 0.45");
});
