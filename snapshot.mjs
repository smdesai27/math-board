/**
 * Headless board snapshots so the model can SEE the board it is drawing.
 *
 * One headless Chromium page stays open on the authenticated board URL and follows live updates
 * over SSE like any other viewer (its requests carry x-math-board-snapshot, so the server does not
 * count it as a learner's browser). A snapshot waits until the page has committed the current
 * revision and finished async rendering (Mermaid, SVG image decoding, fonts), then captures a PNG
 * and runs the in-page layout lint (`window.__boardLint`).
 *
 * Robustness:
 *  - Chromium runs with its OS sandbox. Only when a sandboxed launch fails does it fall back to
 *    running without one, and `sandboxNote` says so (the tools show it in their results).
 *  - A page that crashes or closes, or a browser that disconnects, is dropped; the call that hit
 *    it retries once on a fresh page.
 *  - Every call has an overall time limit (launch included) and honors an AbortSignal. On a
 *    timeout the browser is closed, so a stuck page never blocks later calls.
 *  - close() during a launch closes the browser as soon as the launch finishes.
 * The browser is launched lazily and closed after 5 idle minutes or when the board server stops.
 * Uses Playwright's bundled Chromium when installed, else the system Chrome.
 */

import { readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IDLE_MS = 5 * 60 * 1000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const HIDE_CHROME = "header,nav,#conflict{display:none!important}";
export const SNAPSHOT_HEADER = "x-math-board-snapshot";
export const LINT_TIMEOUT_MS = 20000;
export const CAPTURE_TIMEOUT_MS = 30000;
// How long a call that loads unchecked html artifacts waits for the page: frames get 5 s to
// report ready (browser side), so a page still busy after this is stuck in one of them.
export const FRAME_CHECK_READY_MS = 8000;
/** Change stamp of the browser assets, so a rebuilt frontend reloads the headless page. */
function assetStamp() {
  return ["index.html", "app.js", "app.css", "style.css"]
    .map((f) => { try { return statSync(path.join(PUBLIC, f)).mtimeMs; } catch { return 0; } })
    .join(":");
}
const BOARD = { w: 1200, h: 800 };
const firstLine = (err) => String(err?.message ?? err).split("\n")[0];

/** The command that installs the Chromium build this playwright-core version expects. */
export function installHint() {
  let version = "";
  try {
    version = createRequire(import.meta.url)("playwright-core/package.json").version;
  } catch {
    try { version = JSON.parse(readFileSync(path.join(PUBLIC, "..", "node_modules", "playwright-core", "package.json"), "utf8")).version; } catch {}
  }
  return `Run: npx -y playwright-core${version ? `@${version}` : ""} install chromium (or install Google Chrome, which is used when Playwright's Chromium is missing)`;
}

const isMissing = (err) => /Executable doesn't exist|executable.*not found|Chromium distribution.*is not found|looks like Playwright/i.test(String(err?.message));

/**
 * Launch headless Chromium with its sandbox: Playwright's bundled build, else the system Chrome.
 * Only if both sandboxed launches fail, and one of them failed for a reason other than a missing
 * browser, retry without the sandbox. Returns { browser, sandboxNote } (sandboxNote is null when
 * the sandbox is on).
 */
export async function launchChromium(chromium) {
  const errors = [];
  for (const channel of [undefined, "chrome"]) {
    try {
      return { browser: await chromium.launch({ headless: true, chromiumSandbox: true, ...(channel ? { channel } : {}) }), sandboxNote: null };
    } catch (err) {
      errors.push({ channel, err });
    }
  }
  const sandboxFailure = errors.find((e) => !isMissing(e.err));
  if (sandboxFailure) {
    try {
      const browser = await chromium.launch({ headless: true, chromiumSandbox: false, ...(sandboxFailure.channel ? { channel: sandboxFailure.channel } : {}) });
      return {
        browser,
        sandboxNote: `the headless browser runs without Chromium's OS sandbox, which could not start here (${firstLine(sandboxFailure.err)}). The board's content is still shown as images only.`,
      };
    } catch {}
  }
  throw new Error(`no headless browser available (${firstLine(errors[0].err)}). ${installHint()}`);
}

const abortError = () => Object.assign(new Error("cancelled"), { name: "AbortError" });
/** `promise`, or a TimeoutError after `ms` (for page calls a busy page would never answer). */
function withLimit(promise, ms) {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timeout ${ms}ms exceeded`), { name: "TimeoutError" })), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
const pageGone = (err) => /Target crashed|crash|has been closed|Target closed|browser has disconnected|Page closed|context or browser has been closed/i.test(String(err?.message));

export class Snapshotter {
  /** `chromium` replaces playwright-core's (tests pass a fake). */
  constructor(server, { chromium } = {}) {
    this.server = server;
    this.chromium = chromium ?? null;
    this.browser = null;
    this.page = null;
    this.launching = null;
    this.idle = null;
    this.queue = Promise.resolve();
    this.generation = 0; // bumped by close(): a launch from an older generation is discarded
    this.sandboxNote = null;
  }

  /** True while the headless page is open (crashed or closed pages are dropped). */
  get live() {
    return Boolean(this.page && !this.page.isClosed?.() && this.browser?.isConnected?.());
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close().catch(() => {}), IDLE_MS);
    this.idle.unref?.();
  }

  dropPage(page = this.page) {
    if (page && this.page === page) this.page = null;
    page?.close?.().catch?.(() => {});
  }

  async ensurePage() {
    this.touch();
    if (this.live) {
      if (this.pageStamp === assetStamp()) return this.page;
      // Frontend was rebuilt since this page loaded: reload so snapshots match the user's view.
      this.pageStamp = assetStamp();
      await this.page.reload({ waitUntil: "domcontentloaded" });
      await this.page.addStyleTag({ content: HIDE_CHROME });
      return this.page;
    }
    this.page = null;
    if (!this.launching) {
      const generation = this.generation;
      this.launching = (async () => {
        const chromium = this.chromium ?? (await import("playwright-core")).chromium;
        if (!this.browser?.isConnected()) {
          const { browser, sandboxNote } = await launchChromium(chromium);
          if (generation !== this.generation) {
            await browser.close().catch(() => {});
            throw new Error("the board server stopped while the headless browser was starting");
          }
          this.browser = browser;
          this.sandboxNote = sandboxNote;
          browser.on?.("disconnected", () => {
            if (this.browser === browser) {
              this.browser = null;
              this.page = null;
            }
          });
        }
        this.pageStamp = assetStamp();
        const page = await this.browser.newPage({ viewport: { width: BOARD.w, height: BOARD.h }, deviceScaleFactor: 1 });
        page.on?.("crash", () => this.dropPage(page));
        page.on?.("close", () => {
          if (this.page === page) this.page = null;
        });
        // Marks this page's requests (its SSE connection too), so it never counts as a viewer.
        await page.setExtraHTTPHeaders?.({ [SNAPSHOT_HEADER]: "1" });
        // nofollow: snapshots choose their own region instead of following the lesson camera.
        await page.goto(`${this.server.url}&nofollow=1`, { waitUntil: "domcontentloaded" });
        // Snapshots show the board only, without the hover chrome.
        await page.addStyleTag({ content: HIDE_CHROME });
        if (generation !== this.generation) {
          await page.close().catch(() => {});
          throw new Error("the board server stopped while the headless browser was starting");
        }
        this.page = page;
        return page;
      })().finally(() => {
        this.launching = null;
      });
    }
    return this.launching;
  }

  /** Wait for the page to show the current revision, with its async rendering done (and `frame`, an html artifact being checked, loaded or failed). */
  async waitReady(page, timeout = 10000, frame = null) {
    const revision = this.server.revision;
    const wait = page.waitForFunction(
      ([rev, id]) => window.__board && window.__board.revision >= rev && window.__board.pending === 0 && (!id || window.__board.frameSettled?.(id)),
      [revision, frame],
      { timeout, polling: 50 },
    );
    if (!frame) await wait;
    else {
      // The frame to check may have been chosen after the page last read the board: read it now.
      // Playwright's own time limit runs inside the page, which a frame stuck in a loop blocks, so
      // the limit is enforced here too.
      wait.catch(() => {});
      await withLimit(page.evaluate(() => window.__board?.refresh?.()).then(() => wait), timeout);
    }
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // Rendering may have started more async work (e.g. a decode); settle again.
    await page.waitForFunction(() => window.__board.pending === 0, null, { timeout, polling: 50 });
  }

  /**
   * Run page work one call at a time (viewport and view changes are shared state). The caller
   * gets an answer within `timeout`, counted from the call (waiting for earlier calls and the
   * launch included). The work itself gets `timeout` from when it starts; past that the browser
   * is closed, so a stuck page never blocks the calls after it. A call whose page crashed or
   * closed under it retries once on a fresh page.
   */
  run(work, { timeout, signal, label }) {
    if (signal?.aborted) return Promise.reject(abortError());
    let gaveUp = false;
    let free;
    const freed = new Promise((resolve) => (free = resolve));
    const job = this.queue.then(async () => {
      if (gaveUp || signal?.aborted) throw abortError();
      const guard = setTimeout(() => {
        this.discard();
        free();
      }, timeout);
      // Not unref'd: the guard is bounded by the call's own time limit and must fire even when
      // nothing else keeps the event loop alive (Node 22 otherwise tears the loop down mid-call).
      try {
        try {
          return await work();
        } catch (err) {
          if (!pageGone(err) || gaveUp) throw err;
          this.dropPage();
          return await work();
        }
      } finally {
        clearTimeout(guard);
      }
    });
    this.queue = Promise.race([job.then(() => {}, () => {}), freed]);
    let timer, onAbort;
    const limit = new Promise((_, reject) => {
      timer = setTimeout(() => {
        gaveUp = true;
        reject(new Error(`${label} timed out after ${Math.round(timeout / 1000)} s`));
      }, timeout);
      onAbort = () => {
        gaveUp = true;
        reject(abortError());
      };
      signal?.addEventListener?.("abort", onAbort, { once: true });
    });
    return Promise.race([job, limit]).finally(() => {
      clearTimeout(timer);
      signal?.removeEventListener?.("abort", onAbort);
    });
  }

  /** Measured layout issues for the whole board. */
  lint({ timeout = LINT_TIMEOUT_MS, signal } = {}) {
    const checking = this.server.uncheckedFrames?.() ?? [];
    const ready = checking.length ? FRAME_CHECK_READY_MS : Math.min(10000, timeout);
    return this.checkFrames(checking, this.run(() => this._lint(ready, checking[0]?.id), { timeout, signal, label: "layout check" }), (r) => r.frames);
  }
  capture({ region, width, timeout = CAPTURE_TIMEOUT_MS, signal } = {}) {
    const checking = this.server.uncheckedFrames?.() ?? [];
    const ready = checking.length ? FRAME_CHECK_READY_MS : undefined;
    return this.checkFrames(checking, this.run(() => this._capture({ region, width, ready, frame: checking[0]?.id }), { timeout, signal, label: "snapshot" }), (r) => r.lint?.frames);
  }
  /**
   * A call that loads html artifacts not checked yet is their check: the server learns which
   * frames loaded (or that the page stopped responding: then the page is thrown away, so the
   * next call starts clean and never loads that frame again).
   */
  checkFrames(checking, call, framesOf) {
    if (!checking.length) return call;
    return call.then(
      (result) => { this.server.frameChecked(checking, framesOf(result)); return result; },
      (err) => {
        if (/timed? ?out|Timeout \d+ms exceeded/i.test(String(err?.message))) this.discard();
        this.server.frameChecked(checking, null, err);
        throw err;
      },
    );
  }

  async _lint(readyTimeout, frame) {
    const page = await this.ensurePage();
    await this.pauseFrames(page, false);
    try {
      await this.waitReady(page, readyTimeout, frame);
      return await page.evaluate((b) => window.__boardLint(b), { x: 0, y: 0, ...BOARD });
    } finally {
      await this.pauseFrames(page, true);
    }
  }
  /**
   * Between calls the page keeps html artifacts' frames loaded but not rendered (display: none
   * stops their animation loops), so an idle headless browser costs no CPU.
   */
  async pauseFrames(page, paused) {
    if (!this.server.html || page.isClosed?.()) return;
    await withLimit(page.evaluate((p) => window.__board?.pauseFrames?.(p), paused), 2000).catch(() => {});
  }

  /**
   * Capture the board (or a board-space region, for zooming in on detail).
   * Returns { png: Buffer, lint, region }.
   */
  async _capture({ region, width, ready, frame } = {}) {
    const page = await this.ensurePage();
    await this.pauseFrames(page, false);
    await this.waitReady(page, ready, frame);
    const r = region ?? { x: 0, y: 0, ...BOARD };
    const w = Math.round(Math.max(200, Math.min(2400, width ?? BOARD.w)));
    const h = Math.round(Math.max(100, Math.min(2400, (w * r.h) / r.w)));
    try {
      if (region) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((v) => window.__setView(v.x, v.y, v.w, v.h), r);
        await this.waitReady(page);
      } else if (w !== BOARD.w) {
        await page.setViewportSize({ width: w, height: h });
      }
      const png = await page.screenshot({ type: "png" });
      const lint = await page.evaluate((b) => window.__boardLint(b), { x: 0, y: 0, ...BOARD });
      return { png, lint, region: r };
    } finally {
      await this.pauseFrames(page, true);
      if (!page.isClosed() && (region || w !== BOARD.w)) {
        await page.setViewportSize({ width: BOARD.w, height: BOARD.h }).catch(() => {});
        if (region) await page.evaluate((b) => window.__setView(0, 0, b.w, b.h), BOARD).catch(() => {});
      }
    }
  }

  /** Close the browser but keep working: the next call launches a new one. */
  discard() {
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    this.generation++;
    browser?.close().catch(() => {});
  }

  async close() {
    clearTimeout(this.idle);
    this.generation++; // a launch in progress closes its browser when it finishes
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
  }
}
