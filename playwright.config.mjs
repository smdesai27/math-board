import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "test/browser",
  timeout: 30000,
  workers: 1,
  // WebKit too: Safari, and a WKWebView window, show the same page.
  projects: [{ name: "chromium", use: { browserName: "chromium" } }, { name: "webkit", use: { browserName: "webkit" } }],
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
  },
});
