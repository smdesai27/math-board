/**
 * Lesson export behind `/board export [name]`. It runs only when the user types
 * that command: never on session_shutdown, never on autosave, never from a model
 * tool.
 *
 * Writes <cwd>/viz/board-<slug>-<YYYYMMDD-HHMM>/ (-2, -3, ... when that folder
 * exists; nothing is overwritten):
 *   board.json         the payload a named save writes, so it can be loaded back
 *   home.png           the home board, when it has items outside every chapter
 *                      and no chapter already covers it (the first auto-placed
 *                      chapter sits at (0,0), on top of home: its image shows them)
 *   chapter-<id>.png   one per chapter, in board order
 *   overview.png       the whole lesson, when there is more than one region
 *   lesson.md          a note with standard markdown image links (Obsidian and GitHub)
 *
 * The board, the PNG renderer and the clock are passed in, so this module needs
 * neither pi nor a browser (test/export.test.mjs stubs the renderer). index.ts
 * passes the board server's headless snapshotter, the capture board_snapshot uses.
 * When the renderer is unavailable, board.json and lesson.md are still written.
 *
 * Files are private (folders 0700, files 0600, like saves), and a viz/ that is a symbolic link is
 * refused rather than followed: the export writes only into a real folder under the cwd.
 */

import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";

/** Version of the save format; board.json is a named save's payload (server.mjs SCHEMA_VERSION). */
export const SCHEMA_VERSION = 1;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

/** The home board: items outside chapters use board coordinates, and home is (0,0)-(1200,800) (server.mjs CHAPTER). */
export const HOME_REGION = Object.freeze({ x: 0, y: 0, w: 1200, h: 800 });
/** PNG width of home and chapter images. */
export const EXPORT_WIDTH = 1600;
/** The overview spans several regions, so it gets the snapshot maximum. */
export const OVERVIEW_WIDTH = 2400;
export const SLUG_MAX = 48;

/**
 * Lowercase a-z, 0-9 and single hyphens, at most 48 characters, accents folded
 * ("Énergie" -> "energie"). Always a valid save name; "" when nothing is left.
 */
export function slugify(text) {
  if (typeof text !== "string") return "";
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

/** Board-space rect of a chapter: the region board_snapshot captures for `chapter`. */
export function chapterRegion(c) {
  return { x: c.x, y: c.y, w: c.w, h: c.h };
}

/** Padded bounding box of board rects: the region board_snapshot captures for `overview`. */
export function overviewRegion(rects) {
  if (!rects?.length) return null;
  const x0 = Math.min(...rects.map((r) => r.x)) - 60, y0 = Math.min(...rects.map((r) => r.y)) - 80;
  const x1 = Math.max(...rects.map((r) => r.x + r.w)) + 60, y1 = Math.max(...rects.map((r) => r.y + r.h)) + 60;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Items on the home board: no chapter, or a chapter that no longer exists (the
 * viewer draws those in board coordinates as well).
 */
export function homeItemCount(board) {
  const chapters = new Set((board?.chapters ?? []).map((c) => c.id));
  const items = [
    ...(board?.equations ?? []),
    ...(board?.scene?.shapes ?? []),
    ...(board?.scene?.artifacts ?? []),
  ];
  return items.filter((it) => !it?.chapter || !chapters.has(it.chapter)).length;
}

/** True when a chapter's rect contains the whole home board, so that chapter's image shows home items. */
function homeCovered(chapters) {
  const h = HOME_REGION;
  return chapters.some((c) => c.x <= h.x && c.y <= h.y && c.x + c.w >= h.x + h.w && c.y + c.h >= h.y + h.h);
}

const pad = (n) => String(n).padStart(2, "0");

/** Local time as YYYYMMDD-HHMM, for the folder name. */
export function folderStamp(date) {
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}

function displayTime(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * One line of literal text for markdown. Titles and ids come from the model, so
 * markup characters are escaped: in Obsidian `$` starts math, `#` a tag, `<` HTML.
 */
export function mdText(text) {
  return String(text ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_[\]<>#|$]/g, "\\$&");
}

/**
 * chapter-<id>.png. Chapter ids are free-form strings (up to 64 characters), so
 * anything outside [A-Za-z0-9_-] becomes "-" (no separators, no "..").
 * Names are compared case-insensitively, as macOS folders are by default.
 */
function chapterFile(id, taken) {
  const base = String(id).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "chapter";
  let file = `chapter-${base}.png`;
  for (let n = 2; taken.has(file.toLowerCase()); n++) file = `chapter-${base}-${n}.png`;
  taken.add(file.toLowerCase());
  return file;
}

/** <cwd>/viz as a real folder: created when missing, refused when it is a symbolic link or not a folder. */
async function vizFolder(cwd) {
  const viz = path.join(cwd, "viz");
  let info = await lstat(viz).catch((error) => (error?.code === "ENOENT" ? null : Promise.reject(error)));
  if (!info) {
    await mkdir(viz, { recursive: true, mode: DIR_MODE });
    info = await lstat(viz);
  }
  if (info.isSymbolicLink()) {
    const target = await realpath(viz).catch(() => "a missing target");
    throw new Error(`${viz} is a symbolic link (to ${target}); /board export writes only into a real folder. Replace the link with a folder, or run the export from the folder it points to.`);
  }
  if (!info.isDirectory()) throw new Error(`${viz} exists and is not a folder`);
  return viz;
}

/** Create a new folder under parent, never reusing one: base, then base-2, base-3, ... */
async function claimFolder(parent, base) {
  for (let n = 1; n <= 1000; n++) {
    const dir = path.join(parent, n === 1 ? base : `${base}-${n}`);
    try {
      await mkdir(dir, { mode: DIR_MODE });
      return dir;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  throw new Error(`too many exports named ${base} in ${parent}`);
}

const firstLine = (error) => String(error?.message ?? error).split("\n")[0].trim() || "unknown error";

/**
 * Export a board. `snapshot({region, width})` returns PNG bytes for a board-space
 * region; `now()` returns the export time. Returns what was written:
 * { dir, folder, slug, revision, exportedAt, files, images, skipped, imageError, empty }.
 */
export async function exportLesson({
  board,
  revision,
  name,
  cwd,
  snapshot,
  now = () => new Date(),
  width = EXPORT_WIDTH,
  overviewWidth = OVERVIEW_WIDTH,
}) {
  if (!board || typeof board !== "object") throw new Error("no board to export");
  if (typeof cwd !== "string" || !cwd) throw new Error("no folder to export into");
  const date = now();
  const slug = slugify(name) || slugify(board.title) || "board";
  const dir = await claimFolder(await vizFolder(cwd), `board-${slug}-${folderStamp(date)}`);

  // board.json is a named save's payload ({name, revision, savedAt, board}, see
  // BoardServer.save) plus exportedAt. Compact like a save, so a 6 MiB board still
  // fits the load limit: copy it to saves/<name>.json and `/board load <name>`.
  const exportedAt = date.toISOString();
  await writeFile(path.join(dir, "board.json"), JSON.stringify({ schemaVersion: SCHEMA_VERSION, name: slug, revision, savedAt: exportedAt, exportedAt, board }), { mode: FILE_MODE });

  // Images in note order: home first, then chapters in board order, the overview last.
  const chapters = Array.isArray(board.chapters) ? board.chapters : [];
  const shots = [];
  if (homeItemCount(board) > 0 && !homeCovered(chapters))
    shots.push({ file: "home.png", heading: "Home", alt: "home", region: { ...HOME_REGION }, width });
  const taken = new Set();
  for (const c of chapters) {
    const title = typeof c.title === "string" && c.title.trim() ? c.title : c.id;
    shots.push({ file: chapterFile(c.id, taken), heading: title, alt: `chapter ${c.id}`, region: chapterRegion(c), width });
  }
  if (shots.length > 1)
    shots.push({ file: "overview.png", heading: "Overview", alt: "overview", region: overviewRegion(shots.map((s) => s.region)), width: overviewWidth });

  const images = [];
  const skipped = [];
  let imageError = typeof snapshot === "function" ? null : "no renderer available";
  for (const shot of shots) {
    if (imageError) {
      shot.error = imageError;
      skipped.push({ file: shot.file, reason: imageError });
      continue;
    }
    try {
      const png = await snapshot({ region: shot.region, width: shot.width });
      if (!png?.length) throw new Error("the renderer returned an empty image");
      await writeFile(path.join(dir, shot.file), png, { mode: FILE_MODE });
      images.push(shot.file);
      shot.written = true;
    } catch (error) {
      shot.error = firstLine(error);
      skipped.push({ file: shot.file, reason: shot.error });
      // A failure before anything rendered means no renderer (no headless browser):
      // skip the rest instead of trying to launch it once per image.
      if (!images.length) imageError = shot.error;
    }
  }

  const steps = Number.isInteger(board.lastStep) ? board.lastStep : 0;
  const lines = [
    `# ${mdText(board.title) || "Board"}`,
    "",
    `Exported ${displayTime(date)} · board revision ${revision} · ${steps} step${steps === 1 ? "" : "s"}`,
  ];
  if (!shots.length) lines.push("", "The board is empty: there was nothing to draw.");
  else if (imageError) lines.push("", `Images were not rendered: ${mdText(imageError)}`);
  for (const shot of shots) {
    lines.push("", `## ${mdText(shot.heading)}`, "");
    if (shot.written) lines.push(`![${mdText(shot.alt)}](${shot.file})`);
    else lines.push(shot.error === imageError ? "_Image not rendered._" : `_Image not rendered: ${mdText(shot.error)}_`);
  }
  await writeFile(path.join(dir, "lesson.md"), lines.join("\n") + "\n", { mode: FILE_MODE });

  return {
    dir,
    folder: path.basename(dir),
    slug,
    revision,
    exportedAt,
    files: ["board.json", ...images, "lesson.md"],
    images,
    skipped,
    imageError,
    empty: shots.length === 0,
  };
}

/** The /board export notice: where it went, how many images, and anything skipped. */
export function exportNotice(result) {
  const n = result.images.length;
  const lines = [
    `Lesson exported to ${result.dir}`,
    `  ${n} image${n === 1 ? "" : "s"}${n ? ` (${result.images.join(", ")})` : ""}, board.json, lesson.md`,
  ];
  if (result.empty) lines.push("  The board is empty, so there were no images to render.");
  else if (result.imageError) lines.push(`  Images not rendered: ${result.imageError}`);
  else for (const s of result.skipped) lines.push(`  Skipped ${s.file}: ${s.reason}`);
  return lines.join("\n");
}
