/**
 * Native dynamic import, kept in a plain .mjs file on purpose: Pi's extension
 * loader rewrites import() inside index.ts and drops query strings, but .mjs
 * files are loaded by Node itself. index.ts uses this to import server.mjs with
 * a version query so /reload picks up edited server code. Never edit-sensitive:
 * this file itself stays cached for the life of the process.
 */
export const nativeImport = (url) => import(url);
