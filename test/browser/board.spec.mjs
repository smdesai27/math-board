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

test("the bar is a quiet pill until hovered; Save and Clear sit behind its menu", async ({ page }) => {
  await ready(page);
  // Park the pointer outside the viewport first: some headless builds (Linux CI) start it at
  // (0,0), which is near enough to the bar to count as hovering it.
  await page.mouse.move(-1, -1);
  // The width the bar is set to (it animates there).
  const width = () => page.locator("#bar").evaluate((el) => parseFloat(el.style.width));
  await expect(page.locator("#bar-top")).toBeVisible();
  await expect(page.locator("#btn-step-back")).toBeHidden();
  await expect(page.locator("#btn-save")).toBeHidden();
  // Connected and nothing to report: the closed pill shows no status text.
  await expect(page.locator("#bar")).toHaveAttribute("data-conn", "connected");
  await expect(page.locator("#conn")).toBeHidden();
  const closed = await width();
  await page.locator("#bar").hover();
  await expect(page.locator("#btn-step-back")).toBeVisible();
  await expect(page.locator("#btn-follow")).toBeVisible();
  await expect(page.locator("#conn")).toBeHidden(); // routine status: only in the menu
  await expect(page.locator("#btn-save")).toBeHidden();
  await expect.poll(width).toBeGreaterThan(closed + 40);
  await page.click("#btn-more");
  await expect(page.locator("#btn-more")).toHaveAttribute("aria-expanded", "true");
  await expect(page.locator("#btn-save")).toBeVisible();
  await expect(page.locator("#btn-clear")).toBeVisible();
  await expect(page.locator("#nav-hint")).toContainText("overview");
  await expect(page.locator("#conn")).toHaveText(`Connected · revision ${server.revision}`);
  await expect(page.locator("#conn")).toBeVisible();
  await page.mouse.move(-1, -1);
  await expect(page.locator("#btn-step-back")).toBeHidden();
  await expect(page.locator("#btn-more")).toHaveAttribute("aria-expanded", "false");
  await expect.poll(width).toBeLessThan(closed + 2);
  // The keyboard reaches the same menu: ? opens it, Escape closes it.
  await page.keyboard.press("?");
  await expect(page.locator("#btn-save")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#btn-save")).toBeHidden();
  server.update({ baseRevision: server.revision, title: "Changed remotely" });
  await expect(page.locator("#board-title")).toHaveText("Changed remotely");
  await expect.poll(width).toBeGreaterThan(closed);
});

test("on a touch screen a tap opens the bar and a tap on the board closes it", async ({ browser }) => {
  const context = await browser.newContext({ hasTouch: true });
  const page = await context.newPage();
  try {
    await ready(page);
    await expect(page.locator("#btn-step-back")).toBeHidden();
    await page.locator("#bar-top").tap();
    await expect(page.locator("#btn-step-back")).toBeVisible();
    await page.locator("#btn-overview").tap();
    await expect(page.locator("#btn-step-back")).toBeVisible(); // a control does not close it
    await page.touchscreen.tap(600, 600);
    await expect(page.locator("#btn-step-back")).toBeHidden();
  } finally {
    await context.close();
  }
});

/** Open the bar's menu and press one of its buttons (Save, Clear). */
async function menuClick(page, id) {
  await page.locator("#bar").hover();
  await page.click("#btn-more");
  await page.click(id);
}

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
  await page.locator("#bar").hover();
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

test("Clear asks again when the tutor drew while the question was open; the view stays live", async ({ page }) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await ready(page);
  server.update({ equations: [{ op: "add", id: "a", latex: "a = 1", x: 100, y: 100 }] });
  await expect(page.locator("#conn")).toContainText(`revision ${server.revision}`);
  const dialogs = [];
  page.on("dialog", async (d) => {
    dialogs.push(d.message());
    // The tutor draws while the learner reads the first question.
    if (dialogs.length === 1) server.update({ equations: [{ op: "add", id: "b", latex: "b = 2", x: 100, y: 300 }] });
    await d.accept();
  });
  await menuClick(page, "#btn-clear");
  await expect.poll(() => dialogs.length).toBe(2);
  expect(dialogs[0]).toBe("Clear the whole board? (Save first if you want to keep it.)");
  expect(dialogs[1]).toBe("The board changed in the meantime (it is now at revision 2). Clear the whole board as it is now?");
  await expect(page.locator("#blackboard .katex")).toHaveCount(0);
  expect(server.getState().equations).toEqual([]);
  // Not frozen: the next model update shows.
  server.update({ equations: [{ op: "add", id: "c", latex: "c = 3", x: 100, y: 100 }] });
  await expect(page.locator("#blackboard .katex")).toHaveCount(1);
  await expect(page.locator("#notice")).toBeHidden();
  expect(errors).toEqual([]);
});

test("declining the second Clear question keeps the board, and later updates still show", async ({ page }) => {
  await ready(page);
  server.update({ equations: [{ op: "add", id: "a", latex: "a = 1", x: 100, y: 100 }] });
  await expect(page.locator("#blackboard .katex")).toHaveCount(1);
  let asked = 0;
  page.on("dialog", async (d) => {
    if (++asked === 1) {
      server.update({ equations: [{ op: "add", id: "b", latex: "b = 2", x: 100, y: 300 }] });
      await d.accept();
    } else await d.dismiss();
  });
  await menuClick(page, "#btn-clear");
  await expect(page.locator("#conn")).toHaveText(`Not done: the board changed · revision ${server.revision}`);
  await expect(page.locator("#blackboard .katex")).toHaveCount(2); // the board the learner was asked about
  expect(server.getState().equations.map((e) => e.id)).toEqual(["a", "b"]);
  server.update({ title: "Still live" });
  await expect(page.locator("#board-title")).toHaveText("Still live");
});

test("Save writes the board the learner sees and says so", async ({ page }) => {
  await ready(page);
  server.update({ title: "To keep", equations: [{ op: "add", id: "a", latex: "a = 1", x: 100, y: 100 }] });
  await expect(page.locator("#board-title")).toHaveText("To keep");
  await menuClick(page, "#btn-save");
  await expect(page.locator("#conn")).toHaveText(`Saved · revision ${server.revision}`);
  expect((await server.listSaves()).map((s) => s.name ?? s)).toContain("default");
});

test("a stopped board server is reported after a sustained outage; the tab reconnects when it comes back", async ({ page }) => {
  await page.clock.install();
  await ready(page);
  // Stop serving (as when pi reloads the extension), then come back on the same port and token.
  const http = server.server, port = server.port;
  await new Promise((resolve) => { http.close(resolve); http.closeAllConnections(); });
  await expect(page.locator("#conn")).toHaveText("Connection lost · reconnecting…");
  await expect(page.locator("#notice")).toBeHidden();
  server.update({ title: "Drawn while the tab was away" }); // nobody is watching
  await page.clock.fastForward(12000);
  await expect(page.locator("#notice")).toBeVisible();
  await expect(page.locator("#notice")).toHaveText("The board server stopped; reopen it with /board (or board_open).");
  await expect(page.locator("#conn")).toHaveText("Board server stopped");
  await new Promise((resolve) => http.listen(port, "127.0.0.1", resolve));
  await page.clock.fastForward(6000);
  await expect(page.locator("#notice")).toBeHidden();
  await expect(page.locator("#board-title")).toHaveText("Drawn while the tab was away");
  await expect(page.locator("#conn")).toHaveText(`Connected · revision ${server.revision}`);
  server.update({ baseRevision: server.revision, title: "And after" });
  await expect(page.locator("#board-title")).toHaveText("And after");
});

/** Serve the page a board whose equations are `equations()` (the real server's revision and the rest of its state). */
async function craftEquations(page, equations) {
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    const json = await response.json();
    json.board.chapters = [
      { id: "ch1", title: "One", x: 0, y: 0, w: 1200, h: 800 },
      { id: "ch2", title: "Two", x: 1400, y: 0, w: 1200, h: 800 },
    ];
    json.board.equations = equations();
    await route.fulfill({ response, json });
  });
}

test("equations sit where the state puts them; ones without x,y stack inside their own chapter", async ({ page }) => {
  let list = [
    { id: "e1", latex: "a", chapter: "ch1" },
    { id: "e2", latex: "b", chapter: "ch1" },
    { id: "e3", latex: "c", chapter: "ch2" },
    { id: "e4", latex: "d", chapter: "ch2", x: 300, y: 500 },
  ];
  await craftEquations(page, () => list);
  await page.goto(`${server.url}&nofollow=1`);
  await expect(page.locator("#blackboard .katex")).toHaveCount(4);
  const at = (id) => page.locator(`#blackboard g[data-id="${id}"] foreignObject`).evaluate((f) => [f.getAttribute("x"), f.getAttribute("y")].map(Number));
  expect(await at("e1")).toEqual([88, 92]);
  expect(await at("e2")).toEqual([88, 207]);
  expect(await at("e3")).toEqual([88, 92]); // top of chapter 2, not third on the board
  expect(await at("e4")).toEqual([300, 500]);
  const { issues } = await page.evaluate(() => window.__boardLint());
  expect(issues.filter((i) => /outside chapter/.test(i))).toEqual([]);
  // Deleting an equation in chapter 1 does not move chapter 2's.
  list = list.filter((e) => e.id !== "e1");
  server.update({ title: "after delete" });
  await expect(page.locator("#blackboard .katex")).toHaveCount(3);
  expect(await at("e2")).toEqual([88, 92]);
  expect(await at("e3")).toEqual([88, 92]);
  expect(await at("e4")).toEqual([300, 500]);
});

test("a new revision does not re-typeset unchanged equations", async ({ page }) => {
  await ready(page);
  server.update({
    equations: [
      { op: "add", id: "keep", latex: "\\int_0^1 x^2\\,dx = \\tfrac13", x: 100, y: 100 },
      { op: "add", id: "edit", latex: "y = 1", x: 100, y: 300 },
    ],
  });
  await expect(page.locator("#blackboard .katex")).toHaveCount(2);
  // Tag the typeset nodes (KaTeX replaces them when it runs), then change the board around them.
  await page.evaluate(() => {
    for (const id of ["keep", "edit"]) document.querySelector(`#blackboard g[data-id="${id}"] .katex`).dataset.tag = "old";
  });
  server.update({
    baseRevision: server.revision,
    title: "Changed around them",
    items: [{ op: "update", id: "edit", latex: "y = 2" }],
    equations: [{ op: "add", id: "same", latex: "\\int_0^1 x^2\\,dx = \\tfrac13", x: 100, y: 500 }],
  });
  await expect(page.locator("#blackboard .katex")).toHaveCount(3);
  await expect(page.locator('#blackboard g[data-id="edit"] .katex')).toContainText("2");
  const tags = await page.evaluate(() => ["keep", "edit", "same"].map((id) => document.querySelector(`#blackboard g[data-id="${id}"] [data-tag]`)?.dataset.tag ?? null));
  expect(tags).toEqual(["old", null, null]); // only the edited equation was typeset again
  // The same LaTeX typesets to the same markup (served from the cache for "same").
  const html = await page.evaluate(() => ["keep", "same"].map((id) => document.querySelector(`#blackboard g[data-id="${id}"] .eq-math`).innerHTML.replace(/ data-tag="old"/, "")));
  expect(html[1]).toBe(html[0]);
});
