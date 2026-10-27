import { build } from "esbuild";
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
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
await cp(
  "node_modules/@excalidraw/excalidraw/dist/prod/fonts",
  "public/assets/fonts",
  { recursive: true },
);
await writeFile("build-meta.json", JSON.stringify(result.metafile));
console.log(
  "Built local Excalidraw, React, KaTeX, CSS, dynamic chunks and fonts. No CDN required.",
);
