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
// The error a page wait gets when a page with html frames stops answering within its time limit.
export const FRAME_TIMEOUT = "FrameTimeout";
/** `promise`, or an error named `name` after `ms` (for page calls a busy page would never answer). */
function withLimit(promise, ms, name = "TimeoutError") {
  let timer;
  const limit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(`Timeout ${ms}ms exceeded`), { name })), ms);
  });
  promise.catch?.(() => {});
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}
/**
 * What a failed headless call says about the html frame it was checking: { failed: reason } (the
 * frame stalled or crashed the page), { unchecked: true } (no headless browser to check with),
 * { error, aborted? } (nothing about the frame: cancelled, or the browser was closed under it).
 */
export function frameVerdict(err, discarded = false) {
  const message = String(err?.message ?? err);
  if (err?.name === "AbortError") return { error: message, aborted: true };
  if (/no headless browser/i.test(message)) return { unchecked: true };
  if (err?.name === FRAME_TIMEOUT) return { failed: "in the headless check it was not ready within 8 s (an endless loop, a long computation, or board.wait() without board.ready()?)" };
  if (!discarded && pageGone(err)) return { failed: "it crashed the headless check page (out of memory?)" };
  return { error: message };
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

  /**
   * Wait for the page to show the current revision with its async rendering done. html frames
   * are not loaded at this point (see waitFrames), so Playwright's own time limits work. With
   * `refresh`, the page reads the board first (a frame to check may have been chosen since).
   */
  async waitReady(page, timeout = 10000, refresh = false) {
    const revision = this.server.revision;
    if (refresh) await page.evaluate(() => window.__board?.refresh?.());
    await page.waitForFunction((rev) => window.__board && window.__board.revision >= rev && window.__board.pending === 0, revision, { timeout, polling: 50 });
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // Rendering may have started more async work (e.g. a decode); settle again.
    await page.waitForFunction(() => window.__board.pending === 0, null, { timeout, polling: 50 });
  }
  /**
   * Load html frames (`load`: ids, or null for all) and wait until they are settled, `settle`
   * (ids) included, within FRAME_CHECK_READY_MS from now. The limit is enforced here: Playwright's
   * runs inside the page, which a frame stuck in a loop blocks. That error is FRAME_TIMEOUT.
   */
  async waitFrames(page, load, settle = []) {
    if (!this.server.html) return;
    const steps = async () => {
      await page.evaluate(([ids]) => window.__board?.pauseFrames?.(false, ids), [load]);
      await page.waitForFunction((ids) => window.__board.pending === 0 && ids.every((id) => window.__board.frameSettled?.(id)), settle, { timeout: FRAME_CHECK_READY_MS, polling: 50 });
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
    };
    await withLimit(steps(), FRAME_CHECK_READY_MS, FRAME_TIMEOUT);
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

  /**
   * Measured layout issues for the whole board. It also checks the html frames not checked yet,
   * one after another while the call has time, so an update that adds several gets a result that
   * names each one.
   */
  lint({ timeout = LINT_TIMEOUT_MS, signal } = {}) {
    const work = (frame) => this._lint(Math.min(10000, timeout), frame);
    return this.run(async () => {
      const started = Date.now();
      let result = await this.checking(work, (r) => r.frames);
      const seen = new Set();
      for (let next = this.server.frameToCheck?.(); next && !seen.has(next.mac) && Date.now() - started < timeout / 2 && !signal?.aborted; next = this.server.frameToCheck?.()) {
        seen.add(next.mac);
        result = await this.checking(work, (r) => r.frames);
      }
      return result;
    }, { timeout, signal, label: "layout check" });
  }
  capture({ region, width, timeout = CAPTURE_TIMEOUT_MS, signal } = {}) {
    const work = (frame) => this._capture({ region, width, frame });
    return this.run(() => this.checking(work, (r) => r.lint?.frames), { timeout, signal, label: "snapshot" });
  }
  /**
   * Page work that is also the check of the next unchecked html frame, if there is one. The frame
   * is chosen here, inside the queue, so it is the one the page loads, and the server learns what
   * the work showed about it. A frame that stalls or crashes the page is held back and the work
   * runs once more without it, so the caller still gets its layout result. A page stuck in a frame
   * is thrown away either way, so the next call starts clean.
   */
  async checking(work, framesOf) {
    const list = this.server.startFrameCheck?.() ?? [];
    const generation = this.generation;
    let result;
    try {
      result = await work(list[0]?.id ?? null);
    } catch (err) {
      if (!list.length) {
        if (err?.name === FRAME_TIMEOUT) this.discard();
        throw err;
      }
      const verdict = frameVerdict(err, generation !== this.generation);
      this.server.frameChecked(list, verdict);
      if (!verdict.failed) throw err;
      this.discard();
      return await work(null);
    }
    if (list.length) this.server.frameChecked(list, { states: framesOf(result) });
    return result;
  }

  async _lint(readyTimeout, frame) {
    const page = await this.ensurePage();
    try {
      await this.waitReady(page, readyTimeout, Boolean(frame));
      // A layout check loads only the frame it checks: the others' slots are measured in the SVG.
      if (frame) await this.waitFrames(page, [frame], [frame]);
      return await page.evaluate((b) => window.__boardLint(b), { x: 0, y: 0, ...BOARD });
    } finally {
      await this.pauseFrames(page, true);
    }
  }
  /**
   * html frames load in the page only during a call (waitFrames): a layout check loads just the
   * frame it checks, a snapshot all of them. After each call they are unloaded again, so no model
   * code runs (or stalls the page) while the headless browser waits.
   */
  async pauseFrames(page, paused) {
    if (!this.server.html || page.isClosed?.()) return;
    await withLimit(page.evaluate((p) => window.__board?.pauseFrames?.(p), paused), 2000).catch(() => {});
  }

  /**
   * Capture the board (or a board-space region, for zooming in on detail).
   * Returns { png: Buffer, lint, region }.
   */
  async _capture({ region, width, frame } = {}) {
    const page = await this.ensurePage();
    const r = region ?? { x: 0, y: 0, ...BOARD };
    const w = Math.round(Math.max(200, Math.min(2400, width ?? BOARD.w)));
    const h = Math.round(Math.max(100, Math.min(2400, (w * r.h) / r.w)));
    let stalled = false;
    try {
      await this.waitReady(page, 10000, Boolean(frame));
      if (region) {
        await page.setViewportSize({ width: w, height: h });
        await page.evaluate((v) => window.__setView(v.x, v.y, v.w, v.h), r);
        await this.waitReady(page);
      } else if (w !== BOARD.w) {
        await page.setViewportSize({ width: w, height: h });
      }
      // A snapshot shows every frame: load them all now, with their own time limit.
      await this.waitFrames(page, null, frame ? [frame] : []).catch((err) => { stalled = err?.name === FRAME_TIMEOUT; throw err; });
      const png = await page.screenshot({ type: "png" });
      const lint = await page.evaluate((b) => window.__boardLint(b), { x: 0, y: 0, ...BOARD });
      return { png, lint, region: r };
    } finally {
      // A page a frame has stalled is thrown away by the caller; don't wait on it here.
      if (!stalled) await this.pauseFrames(page, true);
      if (!stalled && !page.isClosed() && (region || w !== BOARD.w)) {
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
