import { test, expect } from "@playwright/test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer } from "../../server.mjs";
// The real headless check runs here (it decides which frames the learner's page may load).
test.setTimeout(60000);
let server, dataDir;
test.beforeEach(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "board-html-"));
  server = new BoardServer({ dataDir, html: true });
  await server.start();
});
test.afterEach(async () => {
  await server.stop();
  await rm(dataDir, { recursive: true, force: true });
});
async function open(page) {
  const errors = [], external = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("requestfinished", (r) => { if (!r.url().startsWith(`http://127.0.0.1:${server.port}/`)) external.push(r.url()); });
  await page.goto(server.url);
  await expect(page.locator("#conn")).toContainText("Connected");
  return { errors, external };
}
/** Board rect of an html artifact's slot vs. its frame, in screen px. */
const offsets = (page, id) => page.evaluate((id) => {
  const s = document.querySelector(`g[data-id="${id}"] .html-slot`).getBoundingClientRect(), f = document.querySelector(`[data-frame="${id}"]`).getBoundingClientRect();
  return [s.x - f.x, s.y - f.y, s.width - f.width, s.height - f.height].map((v) => Math.abs(Math.round(v)));
}, id);

test("a checked frame runs over its slot, follows pan, zoom and steps, and reports its errors", async ({ page, browserName }) => {
  const { errors, external } = await open(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "h", x: 100, y: 120, width: 400, height: 300, libs: ["d3"],
    source: '<svg id="s" width="400" height="300"></svg>\n<script>\nd3.select("#s").append("circle").attr("cx", 200).attr("cy", 150).attr("r", 80).attr("fill", board.colors.blue);\ndocument.body.dataset.ok = typeof d3.scaleLinear;\n</script>' }] } });
  const frame = page.locator('[data-frame="h"] iframe');
  await expect(frame).toHaveCount(1, { timeout: 15000 }); // after the headless check let it through
  await expect(page.frameLocator('[data-frame="h"] iframe').locator("circle")).toHaveCount(1);
  expect(await page.frameLocator('[data-frame="h"] iframe').locator("body").getAttribute("data-ok")).toBe("function");
  expect(await offsets(page, "h")).toEqual([0, 0, 0, 0]);
  // Pan and zoom the board: the frame stays on its slot.
  await page.mouse.move(700, 600);
  await page.mouse.wheel(120, 80);
  await page.keyboard.press("+");
  await page.waitForTimeout(100);
  expect(await offsets(page, "h")).toEqual([0, 0, 0, 0]);
  // Stepping back before the frame's step hides it with its item.
  await page.keyboard.press("ArrowLeft");
  await expect(page.locator('[data-frame="h"]')).toHaveCSS("visibility", "hidden");
  await page.keyboard.press("End");
  await expect(page.locator('[data-frame="h"]')).toHaveCSS("visibility", "visible");
  // A script error is reported with its line in the source, on the frame and in the layout check
  // (which runs in Chromium). Safari hides the details from a sandboxed frame and says so.
  server.update({ baseRevision: server.revision, scene: { mode: "append", artifacts: [{ type: "html", id: "bad", x: 600, y: 120, width: 300, height: 200, source: "<p>x</p>\n<script>\nnope();\n</script>" }] } });
  const message = browserName === "webkit" ? /a script error \(this browser hides the details; the tutor's layout check shows them\)/ : /nope is not defined \(line 3 of the source\)/;
  await expect(page.locator('[data-frame="bad"]')).toHaveAttribute("data-error", message, { timeout: 15000 });
  const lint = await page.evaluate(() => window.__boardLint());
  expect(lint.issues).toEqual([expect.stringMatching(new RegExp(`^artifact bad FAILED TO RENDER: .*${message.source}`))]);
  expect(lint.frames).toEqual({ h: "ready", bad: "error" });
  expect(errors.filter((e) => !/nope/.test(e))).toEqual([]);
  expect(external).toEqual([]);
});

test("a frame stuck in a loop is held back by the check; the learner's page never loads it and stays responsive", async ({ page }) => {
  await open(page);
  const t0 = Date.now();
  server.update({ scene: { mode: "append", artifacts: [
    { type: "html", id: "loop", x: 60, y: 100, width: 300, height: 200, source: "<script>while (true) {}</script>" },
    { type: "html", id: "fine", x: 500, y: 100, width: 300, height: 200, source: "<p id=p>fine</p>" },
  ] } });
  await expect(page.locator('g[data-id="loop"] text')).toContainText("checking…");
  await expect(page.locator('g[data-id="loop"] [data-render-error]')).toHaveAttribute("data-render-error", /not shown: in the headless check it was not ready within 8 s/, { timeout: 30000 });
  expect(Date.now() - t0).toBeLessThan(25000);
  // The next frame is checked after it and loads.
  await expect(page.frameLocator('[data-frame="fine"] iframe').locator("#p")).toHaveText("fine", { timeout: 15000 });
  await expect(page.locator('[data-frame="loop"] iframe')).toHaveCount(0);
  expect(await page.evaluate(() => 1 + 1)).toBe(2);
});

test("the sandbox: no network, no access to the board page or storage, and the token is not in the frame's address", async ({ page }) => {
  const { external } = await open(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "probe", x: 60, y: 100, width: 700, height: 300, source: `<pre id="out"></pre><script>
const r = [];
try { r.push("parent:" + parent.document.title); } catch (e) { r.push("parent:" + e.name); }
try { r.push("storage:" + localStorage.length); } catch (e) { r.push("storage:" + e.name); }
try { r.push("cookie:" + document.cookie); } catch (e) { r.push("cookie:" + e.name); }
r.push("origin:" + origin);
r.push("token-in-url:" + /[a-f0-9]{64}/.test(location.href));
r.push("webrtc:" + typeof RTCPeerConnection + "/" + typeof webkitRTCPeerConnection);
fetch("https://example.com/").then(() => r.push("fetch:ok"), () => r.push("fetch:blocked")).finally(() => { document.getElementById("out").textContent = r.join("\\n"); board.ready(); });
board.wait();
</script>` }] } });
  const out = page.frameLocator('[data-frame="probe"] iframe').locator("#out");
  await expect(out).toContainText("fetch:blocked", { timeout: 15000 });
  const text = await out.textContent();
  expect(text).toContain("parent:SecurityError");
  expect(text).toContain("storage:SecurityError");
  expect(text).toContain("cookie:SecurityError");
  expect(text).toContain("origin:null");
  expect(text).toContain("token-in-url:false");
  expect(text).toContain("webrtc:undefined/undefined");
  expect(external).toEqual([]);
  await expect(page.locator('[data-frame="probe"]')).toHaveAttribute("data-error", /blocked by the sandbox: connect-src/);
});

test("a frame that freezes some seconds after it got ready does not stall the tutor's later checks", async () => {
  // No learner page here: in a browser tab this frame would freeze the tab (a documented limit).
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "late", x: 60, y: 100, width: 300, height: 200,
    source: "<p>fine at first</p><script>setTimeout(() => { for (;;) {} }, 2500);</script>" }] } });
  const first = await server.snapshots.lint();
  expect(first.frames.late).toBe("ready");
  await new Promise((r) => setTimeout(r, 3500)); // its loop would have started by now
  for (const call of [() => server.snapshots.lint(), () => server.snapshots.capture({})]) {
    const t0 = Date.now();
    const r = await call();
    expect(Date.now() - t0).toBeLessThan(2500);
    expect((r.lint ?? r).issues).toEqual([]);
  }
});

test("the check page loads frames again on every call: no false navigation, no stalled snapshot", async () => {
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "plain", x: 60, y: 100, width: 300, height: 200, source: "<p>just text</p>" }] } });
  const lint = () => server.snapshots.lint(), capture = () => server.snapshots.capture({});
  for (const [i, call] of [lint, capture, capture, lint, capture, capture].entries()) {
    const t0 = Date.now();
    const r = await call();
    const result = r.lint ?? r;
    expect(result.issues, `call ${i}`).toEqual([]);
    expect(result.frames.plain, `call ${i}`).not.toBe("error");
    expect(Date.now() - t0, `call ${i}`).toBeLessThan(5000);
  }
});

test("one update with two html artifacts: the tool result names the one that failed, and board_read too", async () => {
  const { handlers } = await import("../../tools.mjs");
  const ctx = { server: async () => server, staleWarning: () => "", openHint: "board_open" };
  const text = (r) => r.content.map((c) => c.text).join("\n");
  const r = await handlers.board_update(ctx, { baseRevision: server.revision, scene: { mode: "append", artifacts: [
    { type: "html", id: "fine", x: 60, y: 100, width: 300, height: 200, source: "<p>fine</p>" },
    { type: "html", id: "loop", x: 500, y: 100, width: 300, height: 200, source: "<script>while (true) {}</script>" },
  ] } });
  const out = text(r);
  expect(out).toMatch(/layout warnings \(1\):\n {2}- artifact loop FAILED TO RENDER: not shown: in the headless check it was not ready within 8 s/);
  expect(out).not.toMatch(/older warning/);
  expect(out).toMatch(/\[loop\] html at \(500,100\) 300x200 .*\[not shown: in the headless check/);
  expect(out).not.toMatch(/\[fine\].*\[(checking|not shown)/);
  expect(text(await handlers.board_read(ctx, {}))).toMatch(/\[loop\] html .*\[not shown:/);
});

test("a frame may not write the learner's clipboard", async ({ page, context, browserName }) => {
  // Playwright's WebKit can't grant clipboard permissions: there the frame's own report is checked.
  const readable = browserName === "chromium";
  if (readable) await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(server.url).origin });
  await open(page);
  if (readable) await page.evaluate(() => navigator.clipboard.writeText("the learner's own"));
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "clip", x: 60, y: 100, width: 400, height: 200, source:
    '<button id="b">copy</button><pre id="o"></pre><script>document.getElementById("b").onclick = () => { const t = document.createElement("textarea"); t.value = "PASTED-BY-FRAME"; document.body.append(t); t.select(); const ok = document.execCommand("copy"); document.getElementById("o").textContent = ok + "/" + typeof navigator.clipboard; };</script>' }] } });
  const frame = page.frameLocator('[data-frame="clip"] iframe');
  await frame.locator("#b").click({ timeout: 15000 });
  await expect(frame.locator("#o")).toHaveText("false/undefined");
  if (readable) expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("the learner's own");
  await expect(page.locator('[data-frame="clip"]')).toHaveAttribute("data-error", /html artifacts may not write the clipboard/);
});

test("a frame that takes 6 s to get ready passes the check and is not stopped in the learner's tab", async ({ page }) => {
  test.setTimeout(90000);
  await open(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "slow", x: 60, y: 100, width: 300, height: 200,
    source: '<p id="p">loading</p><script>board.wait(); setTimeout(() => { document.getElementById("p").textContent = "ready"; board.ready(); }, 6000);</script>' }] } });
  await expect(page.frameLocator('[data-frame="slow"] iframe').locator("#p")).toHaveText("ready", { timeout: 30000 });
  await page.waitForTimeout(500);
  expect(await page.locator('[data-frame="slow"]').getAttribute("data-error")).toBeNull();
  await expect(page.locator('[data-frame="slow"] iframe')).toHaveCount(1);
});

test("a changed artifact shows checking… until its check passes; #html=off loads no frame in that tab", async ({ page, context }) => {
  await open(page);
  server.update({ scene: { mode: "append", artifacts: [{ type: "html", id: "h", x: 60, y: 100, width: 300, height: 200, source: "<p>one</p>" }] } });
  await expect(page.locator('[data-frame="h"] iframe')).toHaveCount(1, { timeout: 15000 });
  server.update({ baseRevision: server.revision, items: [{ op: "update", id: "h", fields: { source: '<p id="p">two</p><script>board.wait(); setTimeout(() => board.ready(), 2000);</script>' } }] });
  await expect(page.locator('g[data-id="h"] text')).toHaveText("checking…");
  await expect(page.frameLocator('[data-frame="h"] iframe').locator("#p")).toHaveText("two", { timeout: 15000 });
  await expect(page.locator('g[data-id="h"] text')).toHaveCount(0);
  const off = await context.newPage();
  await off.goto(`${server.url}&html=off`);
  await expect(off.locator('g[data-id="h"] text')).toHaveText("html is off in this tab (#html=off)");
  await off.waitForTimeout(500);
  await expect(off.locator('[data-frame="h"] iframe')).toHaveCount(0);
});
