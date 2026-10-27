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
  await expect(page.locator("nav")).toHaveCSS("opacity", "0");
  await page.locator("body").hover();
  await expect(page.locator("#btn-save")).toBeVisible();
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
