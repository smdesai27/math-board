# Security

The board is a local web page that a language model writes to. So the questions I care about are: can anything other than my tutor and my browser tab read or change the board, can model-written content run code in the page, and can the page make the model do something. This is what I did about each, and what I didn't.

## What I protect against

- Other websites open in the same browser, trying to read or write the board (cross-site requests, DNS rebinding).
- Other machines on the network.
- Model-written content (LaTeX, SVG, Mermaid, SMILES, plot expressions, text) running script, loading remote resources or escaping into the page.
- When I turn them on, model-written HTML and JavaScript (html artifacts) reaching the board page, its token, my browser's storage or the network, or making the board unusable.
- A board growing until the browser or the server stalls.
- Two writers (the tutor and the page, or two tool calls) silently overwriting each other, and lessons lost to a bad write or a corrupt file.

## How

**Network**

- The server listens on `127.0.0.1` only. Never `0.0.0.0`.
- The token is 32 random bytes, hex, made the first time a process starts a board. A board restarted in the same pi or MCP process (after `/reload` or `/board stop`) reuses that token and port, so a tab that's still open reconnects; a new process gets a new token.
- The token travels in the URL fragment (`#token=…`), which the browser never sends to a server. The page reads it and sends `Authorization: Bearer <token>` on every API call. The live update stream (`/api/events`) takes it as a query parameter instead, because `EventSource` can't set headers.
- The token reaches the model only when no browser could be opened, so the tutor can pass the URL on. Otherwise tool results name just `127.0.0.1:<port>`.
- The `Host` header must be exactly `127.0.0.1:<port>`, which stops DNS rebinding. An `Origin` header, when present, must be exactly `http://127.0.0.1:<port>`.
- The app's static files need no token. They come only from `public/`, only with an allowlisted extension, and every path segment must match a strict pattern, so `..` and encoded traversal get a 404. All board data needs the token.
- The page is served with a Content-Security-Policy (`default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-src 'none'`, or `'self'` when html artifacts are on, `frame-ancestors 'none'`, `base-uri 'none'`), `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff`.
- Nothing is fetched from the internet at runtime: no CDN, fonts are bundled, no telemetry. The MCP server's stdout carries JSON-RPC only.

**Input, limits and writes**

- Input is checked strictly. An unknown or misspelled field, a number given as a string, an empty text, an id over 64 characters or one another item already uses: the update is rejected with the reason (with a "did you mean" for a near miss) and nothing in it is applied.
- Request bodies: 512 KiB. A whole board: 6 MiB. 200 chapters, 1,000 equations, 5,000 shapes and artifacts in total, 2,000 shapes and 100 artifacts per update, 500 item operations per update, 4,000 points per stroke, 128 KiB per SVG, 12,000 characters per Mermaid diagram, 500 characters per SMILES string or plot expression.
- Every change carries the revision it was based on (`baseRevision`). A stale write is rejected (HTTP 409, or `isError` from a tool) instead of overwriting newer work.
- Saves and the autosave are written to a temporary file and renamed, so a crash can't leave half a file. The board creates its folders private (0700) and writes its files private (0600), and it keeps three older copies of the autosave. If a write fails, the next tool result and `/board status` say so.
- Loading a save, or restoring the autosave, re-validates everything. Whatever it can't use is skipped, never silently: the result says what was skipped and how many. A save from a newer format version is refused rather than misread. An autosave that can't be restored at all is moved aside as `autosave.corrupt-<time>.json` and reported, never overwritten.
- A `board.lock` file names the process that owns the data folder. Two boards on the same folder still work, but each warns about the other, since the last change wins the autosave.
- `/board export` runs only when I type it, and writes a new folder every time (`-2`, `-3`, …), never over an old one. Its files are private like the saves, and a `viz` that is a symbolic link is refused rather than followed.

**What the model can put on the page**

- Unless html artifacts are on (below), the model sends data, never code. My code never passes it to `eval`, `new Function` or `innerHTML`.
- Equations: KaTeX with `trust: false`, `strict: "error"`, `maxExpand: 200` and `maxSize: 20`. Labels and text marks are inserted as text, never as HTML.
- SVG is parsed with a real XML parser ([`@rgrove/parse-xml`](https://github.com/rgrove/parse-xml): no DTD processing, no custom entities), and everything after that works on the parsed tree, never on the raw text:
  - anything that isn't well-formed XML is rejected with the parser's message, and so are DOCTYPE, processing instructions, CDATA and undefined entities;
  - element and attribute names must be on the allowlist exactly, with no prefixes and no other namespaces. Scripts, `foreignObject`, `image`, `iframe`, `object`, `embed`, `a` and event attributes are named as unsafe;
  - attribute values and `<style>` text are checked after character references are decoded: `href` may only be `#id`, `url(…)` only `url(#id)`, no `javascript:`, `vbscript:` or `data:` URLs, no CSS escapes, no at-rules except `@keyframes` and `@media`, and no CSS functions except a fixed list of color, math and transform functions. SMIL may not animate `href`;
  - the SVG is then written back out from the tree, so what's stored and shown is exactly what was checked.
- Mermaid: sources with links, `click` or `call` callbacks, URLs, embedded tags or `%%{…}%%` directives are rejected before rendering (directives could change settings the board relies on). Mermaid then lays the diagram out itself with `securityLevel: "strict"` (which runs its own DOMPurify pass) and HTML labels off, and the finished SVG is shown as an image like everything else.
- SVG, Mermaid output, molecules and icons are all displayed through `<image>` elements. Browsers treat an SVG loaded as an image in secure static mode: no scripts, no external loads. That is the real control; the validator is the second layer.
- Molecules: SMILES strings may contain SMILES characters only.
- Plots: expressions are compiled by a small parser (`shared/expr.mjs`) that knows arithmetic, a fixed table of functions and the plot variables (`x`, or `t` for parametric curves). Any other name is an error.
- Icons: sanitized at build time with the same SVG validator the model's SVG goes through.

**html artifacts (off unless `MATH_BOARD_HTML=1`)**

With `MATH_BOARD_HTML=1` the model can send its own HTML and JavaScript (`type: "html"`), for 3D scenes and simulations the declarative formats can't express. That is model-written code running in my browser, so it is off by default and fenced in like this:

- **A sandboxed frame.** Each html artifact runs in an `<iframe sandbox="allow-scripts">` whose document the server builds and serves at `/frame/<mac>`. Without `allow-same-origin` the frame has an opaque origin: it can't read the board page, its token, cookies or storage, and the browser treats it as a different site. No forms, popups, downloads, modals or top-level navigation.
- **Its own policy.** The frame document has its own Content-Security-Policy (it is a separate document, so it doesn't inherit the page's): `default-src 'none'`, inline scripts and styles, scripts only from the board's own `/vendor/` libraries, fonts only from `/assets/`, images only `data:` and `blob:`, `connect-src 'none'`, `form-action 'none'`, `frame-ancestors` the board only, and the CSP `sandbox allow-scripts` directive, so it is sandboxed even if opened on its own. That blocks fetch, XHR, WebSockets, and scripts, styles, images, fonts and media from URLs; a blocked attempt is reported. CSP has no directive for WebRTC, so the bridge script removes `RTCPeerConnection` and its relatives before any other script runs, and the frame is served with `X-DNS-Prefetch-Control: off`.
- **No navigation.** The board page's `frame-src 'self'` stops a frame from navigating itself to another site. Inside the board's own origin there is nothing for it to open: every other response carries `frame-ancestors 'none'`, and another frame's document needs that frame's address. A frame that navigates is stopped and reported.
- **Unguessable, content-bound addresses.** `<mac>` is an HMAC of the artifact under the board's token. The page gets it from the authenticated board state; the frame can see it, but it opens nothing except that frame's own source, and it stops working when the content changes. The token is never in a frame's address.
- **Libraries are local and fixed.** `three`, `d3`, `matter`, `lil-gui`, `fft` and `katex` are bundled at build time into `public/vendor/` (hashed file names, a manifest) and are the only scripts a frame can load. The server answers the frame's opaque `Origin: null` only for `/vendor/` and `/assets/` files, never for the API or the app.
- **Checked before I see it.** A frame that never yields would freeze the whole board tab: Safari, and Chromium for frames from the same host, run sandboxed frames in the page's own process. So each new or changed html artifact is loaded first in the headless layout check, one at a time, and my page gets its address only after it was ready there within 8 seconds. One that wasn't is never sent to my browser, and the slot and the layout check say why. The check page loads frames only inside time-limited calls, throws the browser away when one stops responding, and hides its frames between calls so they don't use CPU.
- **Errors come back.** Script errors (with the line in the artifact's source), blocked requests and navigation reach the page by `postMessage` from a small bridge script, and the layout check reports them like a failed artifact. The page accepts only `ready` and `error` messages, matched to a frame by its window, and shows them as text.

What this doesn't cover:

- **The network is not fully closed.** Ordinary requests are blocked, but WebRTC isn't covered by CSP. The bridge removes it from the frame, and reaching into an empty nested frame fails (it gets its own opaque origin), but a nested `srcdoc` frame with its own script gets a fresh copy: in a test it sent STUN packets to a local listener. STUN/TURN traffic can carry data in the server name, port or username. DNS prefetch hints may also resolve names. So a prompt-injected html artifact could still leak what's in it, or what the model put into it, to a server it names. That's the main reason html artifacts are opt-in.
- A frame that passes the check and only loops later (on a click, say) can still freeze the tab in Safari. Reloading the tab and asking the tutor to fix or delete the artifact recovers it.
- A frame can draw anything inside its box, including something that looks like part of the board or a login form. It can't send what's typed anywhere.
- Without a headless browser (no Playwright Chromium or system Chrome), frames can't be checked and are shown unchecked.
- The frame shares the browser process with the board in Safari, so the boundary is the browser's sandbox and origin rules, like for any web page.
- Safari hides the details of script errors in sandboxed frames; the layout check, which runs in Chromium, still shows them to the tutor.

**The headless browser**

- The layout check and `board_snapshot` render the board in a headless Chromium that runs with its OS sandbox. Only where a sandboxed launch fails (some Linux containers) does it run without one, and then every result that used it says so.
- A page that crashes, or a browser that disconnects, is dropped and the call retries once on a fresh page. Every call has a time limit; on a timeout the browser is closed, so a stuck page can't block the calls after it.

**What the page can do**

- The page has no drawing tools. Its only writes are Clear and Save. Clear asks first, and asks again if the board changed in the meantime; both need the token like every API call, and Clear carries a `baseRevision` like any other change.
- Nothing the page does starts a model turn. The tutor only learns what changed when it calls `board_read`.

## Out of scope

- Other software running as my own user account. It can read the data folder and the browser's history (which keeps the URL with its token; the token works until the process that made it exits), and it doesn't need the board to do harm.
- Shared machines. Other local users can reach `127.0.0.1`, but not without the token. The token does appear for a moment in the command line of the `open` / `xdg-open` call that launches the browser, which other users can see in the process list. If you share a machine with people you don't trust, keep that in mind.
- Whatever the model says. The board limits what drawn content can do, not whether it is correct. A prompt injection can still make the tutor draw something wrong or misleading.
- The pi host and MCP clients themselves. They already run with your permissions.
- Upstream dependencies. Versions are pinned in `package-lock.json`, but I don't audit KaTeX, Mermaid, SmilesDrawer, React, Playwright, parse-xml, the MCP SDK or the html artifact libraries (three.js, d3, matter.js, lil-gui, fft.js) myself.

## Reporting a problem

Open an issue at <https://github.com/smdesai27/math-board/issues>. I don't have a security email. If the details shouldn't be public before there's a fix, open an issue that says you have a report and leave the details out, and I'll set up a private way to get them.

Only the latest release gets fixes.
