/**
 * The headless snapshotter (snapshot.mjs) against a fake Chromium: sandbox first with a noted
 * fallback, a crashed page dropped and retried once, close() during a launch, the overall time
 * limit and the abort signal. No real browser needed.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Snapshotter, installHint, launchChromium } from "../snapshot.mjs";

const server = { url: "http://127.0.0.1:1/#token=x", revision: 0 };

/** A page that answers lint calls; `behavior` can make waitForFunction hang or the page crash. */
function fakePage(behavior = {}) {
  const page = new EventEmitter();
  let closed = false;
  page.headers = null;
  page.isClosed = () => closed;
  page.close = async () => {
    closed = true;
    page.emit("close");
  };
  page.setExtraHTTPHeaders = async (h) => (page.headers = h);
  page.goto = async () => {};
  page.addStyleTag = async () => {};
  page.reload = async () => {};
  page.waitForFunction = async () => {
    if (behavior.hang) return new Promise(() => {});
    if (behavior.crash && !page.crashed) {
      page.crashed = true;
      page.emit("crash");
      throw new Error("page.waitForFunction: Target crashed");
    }
  };
  page.evaluate = async () => ({ items: [], issues: ["lint ok"] });
  page.screenshot = async () => Buffer.from("png");
  page.setViewportSize = async () => {};
  return page;
}

function fakeChromium({ sandbox = true, page = () => fakePage(), launchDelay = 0 } = {}) {
  let pages = 0;
  const launches = [];
  const browsers = [];
  return {
    launches,
    browsers,
    async launch(opts) {
      launches.push(opts);
      if (launchDelay) await new Promise((r) => setTimeout(r, launchDelay));
      if (opts.chromiumSandbox && !sandbox) throw new Error("Failed to launch: No usable sandbox!\nmore");
      const browser = new EventEmitter();
      let connected = true;
      browser.pages = [];
      browser.isConnected = () => connected;
      browser.close = async () => {
        connected = false;
        browser.emit("disconnected");
      };
      browser.newPage = async () => {
        const p = page(pages++);
        browser.pages.push(p);
        return p;
      };
      browsers.push(browser);
      return browser;
    },
  };
}

test("Chromium launches with its sandbox; without one it falls back and says so", async () => {
  const sandboxed = fakeChromium();
  assert.equal((await launchChromium(sandboxed)).sandboxNote, null);
  assert.deepEqual(sandboxed.launches, [{ headless: true, chromiumSandbox: true }]);

  const noSandbox = fakeChromium({ sandbox: false });
  const { sandboxNote } = await launchChromium(noSandbox);
  assert.match(sandboxNote, /runs without Chromium's OS sandbox, which could not start here \(Failed to launch: No usable sandbox!\)/);
  assert.deepEqual(noSandbox.launches.map((o) => [o.channel ?? "bundled", o.chromiumSandbox]), [["bundled", true], ["chrome", true], ["bundled", false]]);

  const missing = { async launch() { throw new Error("browserType.launch: Executable doesn't exist at /x"); } };
  await assert.rejects(launchChromium(missing), /no headless browser available \(browserType\.launch: Executable doesn't exist at \/x\)\. Run: npx -y playwright-core@\d+\.\d+\.\d+ install chromium/);
  assert.match(installHint(), /playwright-core@\d/);
});

test("the headless page marks its requests and the sandbox note is kept for results", async () => {
  const chromium = fakeChromium({ sandbox: false });
  const snap = new Snapshotter(server, { chromium });
  assert.deepEqual(await snap.lint(), { items: [], issues: ["lint ok"] });
  assert.deepEqual(chromium.browsers[0].pages[0].headers, { "x-math-board-snapshot": "1" });
  assert.match(snap.sandboxNote, /without Chromium's OS sandbox/);
  assert.equal(snap.live, true);
  await snap.close();
  assert.equal(snap.live, false);
});

test("a crashed page is dropped and the call retries once on a fresh page", async () => {
  const chromium = fakeChromium({ page: (n) => fakePage({ crash: n === 0 }) });
  const snap = new Snapshotter(server, { chromium });
  assert.deepEqual((await snap.lint()).issues, ["lint ok"]);
  const [first, second] = chromium.browsers[0].pages;
  assert.equal(first.crashed, true);
  assert.equal(first.isClosed(), true, "the crashed page is closed");
  assert.equal(snap.page, second);
  // A page closed from outside is dropped too: the next call opens another.
  await second.close();
  assert.equal(snap.page, null);
  await snap.lint();
  assert.equal(chromium.browsers[0].pages.length, 3);
  // A disconnected browser is relaunched.
  await chromium.browsers[0].close();
  await snap.lint();
  assert.equal(chromium.browsers.length, 2);
  await snap.close();
});

test("close() during a launch closes the browser when the launch finishes", async () => {
  const chromium = fakeChromium({ launchDelay: 50 });
  const snap = new Snapshotter(server, { chromium });
  const pending = snap.lint();
  await new Promise((r) => setTimeout(r, 10));
  await snap.close();
  await assert.rejects(pending, /stopped while the headless browser was starting/);
  assert.equal(chromium.browsers[0].isConnected(), false, "no browser leaks");
  assert.equal(snap.browser, null);
});

test("calls have an overall time limit, and a timeout frees the next call", async () => {
  let hang = true;
  const chromium = fakeChromium({ page: () => fakePage({ hang }) });
  const snap = new Snapshotter(server, { chromium });
  const t0 = Date.now();
  await assert.rejects(snap.lint({ timeout: 150 }), /layout check timed out after 0 s/);
  assert.ok(Date.now() - t0 < 1000);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(chromium.browsers[0].isConnected(), false, "the stuck browser was closed");
  hang = false;
  assert.deepEqual((await snap.lint({ timeout: 2000 })).issues, ["lint ok"]);
  await snap.close();
});

test("an aborted signal cancels the call", async () => {
  const chromium = fakeChromium({ page: () => fakePage({ hang: true }) });
  const snap = new Snapshotter(server, { chromium });
  const controller = new AbortController();
  const pending = snap.lint({ timeout: 5000, signal: controller.signal });
  setTimeout(() => controller.abort(), 30);
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(snap.capture({ signal: AbortSignal.abort() }), { name: "AbortError" });
  await snap.close();
});
