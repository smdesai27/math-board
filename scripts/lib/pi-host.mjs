/**
 * Shared setup for the scripts that load the extension through pi's real loader
 * (verify-import, verify-reload, e2e-snapshot, demo-lessons).
 *
 *   piHostRoot()          the installed @earendil-works/pi-coding-agent package to load:
 *                         $PI_HOST_ROOT, else this checkout's devDependency, else the global install
 *   isolateDataDir(name)  point the board at a fresh temporary data directory unless
 *                         MATH_BOARD_DATA_DIR (or its alias PI_MATH_BOARD_DATA_DIR) is already set,
 *                         so a script never reads or overwrites real saves
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const PACKAGE = "@earendil-works/pi-coding-agent";

export function piHostRoot() {
  if (process.env.PI_HOST_ROOT) return process.env.PI_HOST_ROOT;
  const local = path.join(ROOT, "node_modules", PACKAGE);
  if (existsSync(path.join(local, "dist/core/extensions/loader.js"))) return local;
  return path.join(execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim(), PACKAGE);
}

export function isolateDataDir(prefix = "math-board-test-") {
  if (!process.env.MATH_BOARD_DATA_DIR && !process.env.PI_MATH_BOARD_DATA_DIR)
    process.env.MATH_BOARD_DATA_DIR = mkdtempSync(path.join(tmpdir(), prefix));
  return process.env.MATH_BOARD_DATA_DIR || process.env.PI_MATH_BOARD_DATA_DIR;
}
