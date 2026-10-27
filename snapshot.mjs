/**
 * Headless board snapshots so the model can SEE the board it is drawing.
 *
 * One headless Chromium page stays open on the authenticated board URL and
 * follows live updates over SSE like any other viewer. A snapshot waits until
 * the page has committed the current revision and finished async rendering
 * (Mermaid, SVG image decoding, fonts), then captures a PNG and runs the
 * in-page layout lint (`window.__boardLint`). The browser is launched lazily
 * and closed after a period of inactivity or when the board server stops.
 *
 * Uses Playwright's bundled Chromium when installed, else the system Chrome.
 */

import { statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IDLE_MS = 5 * 60 * 1000;
const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "public");
const HIDE_CHROME = "header,nav,#conflict{display:none!important}";
/** Change stamp of the browser assets, so a rebuilt frontend reloads the headless page. */
function assetStamp() {
  return ["index.html", "app.js", "app.css", "style.css"]
    .map((f) => { try { return statSync(path.join(PUBLIC, f)).mtimeMs; } catch { return 0; } })
    .join(":");
}
const BOARD = { w: 1200, h: 800 };

export class Snapshotter {
  constructor(server) {
    this.server = server;
    this.browser = null;
    this.page = null;
    this.launching = null;
    this.idle = null;
    this.queue = Promise.resolve();
  }

  /** Run page work one call at a time (viewport/view changes are shared state). */
  serial(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }

  touch() {
    clearTimeout(this.idle);
    this.idle = setTimeout(() => this.close().catch(() => {}), IDLE_MS);
    this.idle.unref?.();
  }

  async ensurePage() {
    this.touch();
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
      if (this.pageStamp === assetStamp()) return this.page;
      // Frontend was rebuilt since this page loaded: reload so snapshots match the user's view.
      this.pageStamp = assetStamp();
      await this.page.reload({ waitUntil: "domcontentloaded" });
      await this.page.addStyleTag({ content: HIDE_CHROME });
      return this.page;
    }
    if (!this.launching) {
      this.launching = (async () => {
        const { chromium } = await import("playwright-core");
        if (!this.browser?.isConnected()) {
          try {
            this.browser = await chromium.launch({ headless: true });
          } catch (bundledError) {
            try {
              this.browser = await chromium.launch({ headless: true, channel: "chrome" });
            } catch {
              throw new Error(`no headless browser available (${String(bundledError.message).split("\n")[0]}). Run: npx playwright install chromium`);
            }
          }
        }
        this.pageStamp = assetStamp();
        const page = await this.browser.newPage({ viewport: { width: BOARD.w, height: BOARD.h }, deviceScaleFactor: 1 });
        // nofollow: snapshots choose their own region instead of following the lesson camera.
        await page.goto(`${this.server.url}&nofollow=1`, { waitUntil: "domcontentloaded" });
        // Snapshots show the board only, without the hover chrome.
        await page.addStyleTag({ content: HIDE_CHROME });
        this.page = page;
        return page;
      })().finally(() => { this.launching = null; });
    }
    return this.launching;
  }

  async waitReady(page, timeout = 10000) {
    const revision = this.server.revision;
    await page.waitForFunction(
      (rev) => window.__board && window.__board.revision >= rev && window.__board.pending === 0,
      revision,
      { timeout, polling: 50 },
    );
    await page.evaluate(async () => {
      await document.fonts.ready;
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    });
    // Rendering may have started more async work (e.g. a decode); settle again.
    await page.waitForFunction(() => window.__board.pending === 0, null, { timeout, polling: 50 });
  }

  /** Measured layout issues for the whole board. */
  lint(opts) { return this.serial(() => this._lint(opts)); }
  capture(opts) { return this.serial(() => this._capture(opts)); }

  async _lint({ timeout } = {}) {
    const page = await this.ensurePage();
    await this.waitReady(page, timeout);
    return page.evaluate((b) => window.__boardLint(b), { x: 0, y: 0, ...BOARD });
  }

  /**
   * Capture the board (or a board-space region, for zooming in on detail).
   * Returns { png: Buffer, lint, region }.
   */
  async _capture({ region, width } = {}) {
    const page = await this.ensurePage();
    await this.waitReady(page);
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
      if (region || w !== BOARD.w) {
        await page.setViewportSize({ width: BOARD.w, height: BOARD.h }).catch(() => {});
        if (region) await page.evaluate((b) => window.__setView(0, 0, b.w, b.h), BOARD).catch(() => {});
      }
    }
  }

  async close() {
    clearTimeout(this.idle);
    const browser = this.browser;
    this.browser = null;
    this.page = null;
    if (browser) await browser.close().catch(() => {});
  }
}
