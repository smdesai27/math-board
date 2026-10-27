import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-browser-"));
  server = new BoardServer({ dataDir });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});
async function ready(page) {
  await page.goto(server.url);
  await expect(page.locator("#blackboard")).toBeVisible();
  await expect(page.locator("#conn")).toContainText("Connected");
}
test("quiet SVG blackboard renders positioned KaTeX and model updates without echo", async ({
  page,
}) => {
  const errors = [],
    external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route("**/*", (route) => {
    if (!route.request().url().startsWith(`http://127.0.0.1:${server.port}/`)) {
      external.push(route.request().url());
      return route.abort();
    }
    return route.continue();
  });
  await ready(page);
  server.update({
    title: "A curve and its equation",
    equations: [{ op: "add", id: "eq", latex: "y = \\sin x", label: "A simple curve", x: 760, y: 280 }],
    scene: { mode: "replace", shapes: [
      { type: "line", points: [[120, 430], [1080, 430]] },
      { type: "line", points: [[600, 660], [600, 150]] },
      { type: "stroke", points: Array.from({ length: 81 }, (_, i) => [160 + i * 11, 430 - Math.sin((i * 11 - 440) / 95) * 150]) },
    ] },
  });
  await expect(page.locator("#blackboard .katex")).toHaveCount(1);
  await expect(page.locator("#board-title")).toContainText("curve");
  await expect(page.locator("#blackboard polyline")).toHaveCount(3);
  expect(await page.locator("#blackboard foreignObject").getAttribute("x")).toBe("760");
  const modelRevision = server.revision;
  // Selection and pan should not POST a scene, nor should updateScene echo.
  await page.mouse.click(620, 650);
  await page.waitForTimeout(600); // assert stability across two autosave debounce windows
  expect(server.revision).toBe(modelRevision);
  server.update({ baseRevision: server.revision, equations: [{ op: "add", label: "Added", latex: "x^2 = 1", x: 300, y: 500 }] });
  await expect(page.locator("#blackboard .katex")).toHaveCount(2);
  await expect(page.locator("#blackboard foreignObject").nth(1)).toHaveAttribute("x", "300");
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});

test("two tabs sync and remote revisions do not echo writes", async ({
  page,
  context,
}) => {
  await ready(page);
  const tab = await context.newPage();
  await ready(tab);
  server.update({ baseRevision: server.revision, equations: [{ op: "add", latex: "\\frac{1}{2}" }] });
  await expect(tab.locator("#blackboard .katex")).toHaveCount(1);
  const rev = server.revision;
  await tab.mouse.click(600, 500);
  await page.mouse.click(650, 550);
  // Wait through the SSE revision and ensure view-only interaction never writes.
  await expect(tab.locator("#conn")).toContainText(`revision ${rev}`);
  expect(server.revision).toBe(rev);
});

test("safe math and labels cannot execute HTML or create trusted links", async ({
  page,
}) => {
  await ready(page);
  server.update({
    equations: [
      {
        op: "add",
        label: '<img src=x onerror="window.pwned=1">',
        latex: "\\href{javascript:alert(1)}{click} \\htmlClass{evil}{x}",
      },
    ],
  });
  await expect(page.locator("#blackboard foreignObject")).toHaveCount(1);
  expect(await page.locator("#blackboard a, #blackboard img, #blackboard .evil").count()).toBe(0);
  expect(await page.evaluate(() => window.pwned)).toBeUndefined();
});

test("quiet controls stay hidden until hover and scene remains view-only", async ({ page }) => {
  await ready(page);
  // Park the pointer outside the viewport first: some headless builds (Linux CI) start it at
  // (0,0), which already counts as hovering the body and fades the controls in.
  await page.mouse.move(-1, -1);
  await expect(page.locator("nav")).toHaveCSS("opacity", "0");
  await page.locator("body").hover();
  await expect(page.locator("#btn-save")).toBeVisible();
  await expect(page.locator("nav")).toHaveCSS("opacity", "0.86");
  await page.mouse.move(-1, -1);
  await expect(page.locator("nav")).toHaveCSS("opacity", "0");
  server.update({ baseRevision: server.revision, title: "Changed remotely" });
  await expect(page.locator("#board-title")).toHaveText("Changed remotely");
});

test("step playback: rapid updates all animate, space replays, arrows step, End goes live", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  const hidden = () => page.evaluate(() => [...document.querySelectorAll("#blackboard > g[data-id]")].filter((g) => g.style.visibility === "hidden" || g.dataset.revealing).map((g) => g.dataset.id));
  const indicator = () => page.textContent("#step-indicator");
  for (let i = 0; i < 3; i++) {
    server.update({ scene: { mode: "append", shapes: [{ type: "line", id: `l${i}`, points: [[100, 100 + i * 150], [1000, 100 + i * 150]], width: 4, duration: 300 }] } });
    await page.waitForTimeout(80);
  }
  await expect.poll(hidden, { timeout: 5000 }).toEqual([]);
  expect(await indicator()).toBe("step 3 / 3");
  // Space after the live drawing replays the chapter (everything hidden then redrawn).
  await page.keyboard.press(" ");
  await expect.poll(async () => (await hidden()).length).toBeGreaterThan(0);
  await expect.poll(hidden, { timeout: 5000 }).toEqual([]);
  // Step back hides the last step; forward redraws it; End returns to live.
  await page.keyboard.press("ArrowLeft");
  expect(await hidden()).toEqual(["l2"]);
  expect(await indicator()).toContain("step 2 / 3");
  await page.keyboard.press("ArrowLeft");
  expect((await hidden()).sort()).toEqual(["l1", "l2"]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(hidden, { timeout: 3000 }).toEqual(["l2"]);
  // A new step arriving while stepped back waits; End shows everything.
  server.update({ scene: { mode: "append", shapes: [{ type: "text", id: "t", text: "new", x: 100, y: 700 }] } });
  await expect.poll(async () => (await hidden()).sort()).toEqual(["l2", "t"]);
  await page.keyboard.press("End");
  expect(await hidden()).toEqual([]);
  expect(await indicator()).toBe("step 4 / 4");
  // Clicking a nav button must not steal Space.
  await page.hover("nav");
  await page.click("#btn-overview");
  await page.keyboard.press(" ");
  await expect.poll(async () => (await hidden()).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

/** A two-step lesson in chapter ch1, fully drawn; returns the screen centre of eq1 and eq2. */
async function lesson(page) {
  await ready(page);
  server.update({
    chapters: [{ op: "add", id: "ch1", title: "Pythagoras", x: 0, y: 0 }],
    camera: { chapter: "ch1" },
    equations: [{ op: "add", id: "eq1", latex: "a^2 + b^2 = c^2", x: 100, y: 120, chapter: "ch1", duration: 200 }],
  });
  server.update({ baseRevision: server.revision, equations: [{ op: "add", id: "eq2", latex: "c = \\sqrt{a^2 + b^2}", x: 520, y: 420, chapter: "ch1", duration: 200 }] });
  await expect.poll(() => page.evaluate(() => {
    const groups = [...document.querySelectorAll("#blackboard > g[data-id]")];
    return groups.length === 2 && groups.every((g) => g.style.visibility !== "hidden" && !g.dataset.revealing);
  }), { timeout: 5000 }).toBe(true);
  const centre = async (id) => {
    const box = await page.locator(`#blackboard g[data-id="${id}"] .formula`).boundingBox();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  };
  return { eq1: await centre("eq1"), eq2: await centre("eq2") };
}

test("hovering an item shows its step, id and chapter; never during a drag", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { eq1, eq2 } = await lesson(page);
  const label = page.locator("#item-ref"), toast = page.locator("#toast");
  const rev = server.revision;
  await expect(label).toBeHidden();
  await page.mouse.move(eq2.x, eq2.y);
  await expect(label).toBeVisible();
  await expect(label).toHaveText("step 2 · eq2 · ch1");
  await expect(page.locator("#item-outline")).toBeVisible();
  // The label sits beside the item and ignores the pointer, so it cannot block pan/zoom.
  expect(await label.evaluate((el) => getComputedStyle(el).pointerEvents)).toBe("none");
  await page.mouse.move(eq1.x, eq1.y);
  await expect(label).toHaveText("step 1 · eq1 · ch1");
  await page.mouse.move(1300, 940); // empty board
  await expect(label).toBeHidden();
  // A drag that starts on an item pans the board: no label while dragging, no copy at the end.
  await page.mouse.move(eq2.x, eq2.y);
  await expect(label).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(eq2.x + 80, eq2.y + 50, { steps: 6 });
  await expect(label).toBeHidden();
  await page.mouse.up();
  await expect(label).toHaveText("step 2 · eq2 · ch1"); // the board moved with the pointer
  await page.waitForTimeout(600); // past the click-to-copy delay; a toast would still be showing
  expect(await toast.isVisible()).toBe(false);
  expect(server.revision).toBe(rev);
  expect(errors).toEqual([]);
});

test("clicking an item copies its reference with a toast; double-click still follows", async ({ page, context }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  const { eq1, eq2 } = await lesson(page);
  const toast = page.locator("#toast");
  const clipboard = () => page.evaluate(() => navigator.clipboard.readText());
  const rev = server.revision;
  await page.mouse.click(eq2.x, eq2.y);
  await expect(toast).toBeVisible();
  await expect(toast).toHaveText("Copied: step 2, eq2 (chapter ch1)");
  expect(await clipboard()).toBe("step 2, eq2 (chapter ch1)");
  await expect(toast).toBeHidden({ timeout: 4000 }); // fades after about two seconds
  // Clicking empty board copies nothing.
  await page.mouse.click(1300, 940);
  await page.waitForTimeout(600);
  expect(await toast.isVisible()).toBe(false);
  // Panning pauses following; a double-click on an item resumes it without copying.
  await page.mouse.move(eq1.x, eq1.y);
  await page.mouse.wheel(0, 40);
  await expect(page.locator("#btn-follow")).not.toHaveClass(/active/);
  const panned = await page.locator('#blackboard g[data-id="eq1"] .formula').boundingBox();
  const at = { x: panned.x + panned.width / 2, y: panned.y + panned.height / 2 };
  await page.mouse.move(at.x, at.y);
  await expect(page.locator("#item-ref")).toHaveText("step 1 · eq1 · ch1"); // the double-click lands on eq1
  await page.mouse.dblclick(at.x, at.y);
  await expect(page.locator("#btn-follow")).toHaveClass(/active/);
  await page.waitForTimeout(600);
  expect(await toast.isVisible()).toBe(false);
  expect(await clipboard()).toBe("step 2, eq2 (chapter ch1)");
  expect(server.revision).toBe(rev);
  expect(errors).toEqual([]);
});

test("without the async clipboard API a click still copies (textarea fallback)", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read"], { origin: new URL(server.url).origin });
  await page.addInitScript(() => {
    const real = navigator.clipboard;
    window.__readClipboard = () => real.readText();
    Object.defineProperty(Navigator.prototype, "clipboard", { configurable: true, get: () => undefined });
  });
  const { eq1 } = await lesson(page);
  expect(await page.evaluate(() => navigator.clipboard)).toBeUndefined();
  await page.mouse.click(eq1.x, eq1.y);
  await expect(page.locator("#toast")).toHaveText("Copied: step 1, eq1 (chapter ch1)");
  expect(await page.evaluate(() => window.__readClipboard())).toBe("step 1, eq1 (chapter ch1)");
});
