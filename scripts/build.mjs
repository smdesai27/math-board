/**
 * npm run build: bundle the browser app (browser/app.jsx) into public/, then write the files
 * generated from it and from tools.mjs:
 *   public/app.js, public/app.css, public/chunks/, public/assets/   the page (no CDN at runtime)
 *   THIRD_PARTY_NOTICES.md   license texts of every bundled package (scripts/third-party-notices.mjs)
 *   mcp/schemas.json         the tools' input schemas for the MCP server (scripts/build-schemas.mjs)
 * All of them are committed; CI rebuilds and fails when they differ from the commit.
 *   node scripts/build.mjs --meta   also writes esbuild's metafile to build-meta.json (git-ignored)
 */
import { build } from "esbuild";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { renderNotices } from "./third-party-notices.mjs";
import { renderSchemas } from "./build-schemas.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
process.chdir(root);
await rm("public/assets", { recursive: true, force: true });
await rm("public/chunks", { recursive: true, force: true });
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
await writeFile("THIRD_PARTY_NOTICES.md", renderNotices(result.metafile, root));
await writeFile("mcp/schemas.json", await renderSchemas(root));
if (process.argv.includes("--meta")) await writeFile("build-meta.json", JSON.stringify(result.metafile));
console.log("Built public/ (React, KaTeX, Mermaid, SmilesDrawer, CSS, fonts and chunks; no CDN), THIRD_PARTY_NOTICES.md and mcp/schemas.json.");
