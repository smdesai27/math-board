/**
 * npm run build: bundle the browser app (browser/app.jsx) into public/, then write the files
 * generated from it and from tools.mjs:
 *   public/app.js, public/app.css, public/chunks/, public/assets/   the page (no CDN at runtime)
 *   public/vendor/<lib>-<hash>.js|css, public/vendor/manifest.json   libraries html artifacts can ask for
 *                                                                    (browser/vendor/*), one file each
 *   THIRD_PARTY_NOTICES.md   license texts of every bundled package (scripts/third-party-notices.mjs)
 *   mcp/schemas.json         the tools' input schemas for the MCP server (scripts/build-schemas.mjs)
 * All of them are committed; CI rebuilds and fails when they differ from the commit.
 *   node scripts/build.mjs --meta   also writes esbuild's metafile to build-meta.json (git-ignored)
 */
import { build } from "esbuild";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderNotices } from "./third-party-notices.mjs";
import { renderSchemas } from "./build-schemas.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await rm("public/assets", { recursive: true, force: true });
await rm("public/chunks", { recursive: true, force: true });
await rm("public/vendor", { recursive: true, force: true });
await mkdir("public/assets", { recursive: true });
const result = await build({
  entryPoints: { app: "browser/app.jsx" },
  outdir: "public",
  bundle: true,
  format: "esm",
  splitting: true,
  minify: true,
  metafile: true,
  define: { "process.env.NODE_ENV": '"production"' },
  conditions: ["production", "browser"],
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
  chunkNames: "chunks/[name]-[hash]",
  logLevel: "info",
});
// Libraries for html artifacts: one self-contained script per library (window globals), loaded
// only by the frames that list it. Hashed names, so the server can let browsers cache them.
const vendor = await build({
  entryPoints: (await readdir("browser/vendor")).sort().map((f) => ({ in: `browser/vendor/${f}`, out: `vendor/${f.replace(/\.(js|css)$/, "")}` })),
  outdir: "public",
  bundle: true,
  format: "iife",
  minify: true,
  metafile: true,
  entryNames: "[dir]/[name]-[hash]",
  define: { "process.env.NODE_ENV": '"production"' },
  loader: { ".woff2": "file", ".woff": "file", ".ttf": "file" },
  assetNames: "assets/[name]-[hash]",
  logLevel: "warning",
});
const manifest = {};
for (const [out, meta] of Object.entries(vendor.metafile.outputs)) {
  const m = /^public\/vendor\/(.+)-[A-Z0-9]+\.(js|css)$/.exec(out);
  if (m && meta.entryPoint) manifest[m[2] === "css" ? `${m[1]}.css` : m[1]] = out.slice("public/".length);
}
await writeFile("public/vendor/manifest.json", JSON.stringify(Object.fromEntries(Object.entries(manifest).sort()), null, 2) + "\n");
const metafile = { inputs: { ...result.metafile.inputs, ...vendor.metafile.inputs }, outputs: { ...result.metafile.outputs, ...vendor.metafile.outputs } };
await writeFile("THIRD_PARTY_NOTICES.md", renderNotices(metafile, root));
await writeFile("mcp/schemas.json", await renderSchemas(root));
if (process.argv.includes("--meta")) await writeFile("build-meta.json", JSON.stringify(metafile));
console.log("Built public/ (React, KaTeX, Mermaid, SmilesDrawer, CSS, fonts and chunks; no CDN), public/vendor/ (html artifact libraries), THIRD_PARTY_NOTICES.md and mcp/schemas.json.");
