/**
 * Math Board server tests (node:test, no external deps).
 * Run: node --test test/
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BoardServer,
  applyUpdate,
  sanitizeShape,
  sanitizeEquation,
  MAX_BODY_BYTES,
  sanitizeArtifact,
} from "../server.mjs";

test("artifact validation permits safe SVG and bounded declarative models only", () => {
  const source = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><circle cx="5" cy="5" r="3" fill="#fff"/></svg>';
  assert.equal(sanitizeArtifact({ type: "svg", source, x: 1, y: 2 }).source, source);
  assert.throws(() => sanitizeArtifact({ type: "svg", source: '<svg><script>alert(1)</script></svg>' }), /unsafe SVG/);
  assert.throws(() => sanitizeArtifact({ type: "svg", source: '<svg><circle onload="alert(1)"/></svg>' }), /unsafe SVG/);
  assert.throws(() => sanitizeArtifact({ type: "mermaid", source: 'click A "https://evil"' }), /invalid Mermaid/);
  assert.throws(() => sanitizeArtifact({ type: "parabola", a: 1, tangent: 1 }), /invalid artifact type/);
  // Class-diagram arrows contain "<"; links, callbacks and embedded markup do not pass.
  assert.equal(sanitizeArtifact({ type: "mermaid", source: "classDiagram\n  Animal <|-- Dog" }).type, "mermaid");
  assert.throws(() => sanitizeArtifact({ type: "mermaid", source: "graph TD\n A[<img src=x>]" }), /<img/);
  // Scheme checks look at markup, not visible text.
  sanitizeArtifact({ type: "svg", source: '<svg viewBox="0 0 9 9"><text>data: 5, javascript: no</text></svg>' });
  assert.throws(() => sanitizeArtifact({ type: "svg", source: '<svg><style>.a{background:url(data:x)}</style></svg>' }), /unsafe/);
});

test("SVG allowlist supports real diagrams and names what it rejects", () => {
  const svg = (inner) => `<svg viewBox="0 0 10 10">${inner}</svg>`;
  const ok = (inner) => sanitizeArtifact({ type: "svg", source: svg(inner) }).source;
  // <line> coordinates, font-style, and '=' inside text content are fine.
  assert.match(ok('<line x1="0" y1="0" x2="5" y2="5"/><text font-style="italic">sum = 5</text>'), /xmlns="http:\/\/www.w3.org\/2000\/svg"/);
  // Markers, gradients, symbols/use, CSS and SMIL with internal references only.
  ok('<defs><marker id="m" refX="5" refY="5" orient="auto"><path d="M0 0L5 5"/></marker><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><path d="M0 0L9 9" marker-end="url(#m)" fill="url(#g)"/><use href="#m"/>');
  ok('<style>.a{fill:red}</style><circle class="a" r="2"><animate attributeName="r" from="1" to="3" dur="1s" repeatCount="indefinite"/></circle>');
  const bad = (inner, re) => assert.throws(() => sanitizeArtifact({ type: "svg", source: svg(inner) }), re);
  bad('<rect foo="1"/>', /"foo" on <rect>/);
  bad('<blink/>', /<blink>/);
  bad('<rect fill="url(http://x/y)"/>', /url\(/);
  bad('<use href="http://x#y"/>', /#id/);
  bad('<style>@import "http://x";</style>', /@import/);
  bad('<set attributeName="href" to="#x"/>', /animation/);
  bad('<image href="#x"/>', /unsafe/);
});

let dataDir;
let s;
let base;
const headers = (extra = {}) => ({
  Authorization: `Bearer ${s.token}`,
  ...extra,
});

async function req(
  method,
  pathname,
  { body, headers: h, host, raw, omitRevision = false } = {},
) {
  if (
    !omitRevision &&
    !raw &&
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    ["/api/update", "/api/clear", "/api/load"].includes(pathname)
  )
    body = { baseRevision: s.revision, ...body };
  const res = await fetch(`http://127.0.0.1:${s.port}${pathname}`, {
    method,
    headers:
      h ??
      (body !== undefined
        ? { ...headers(), "Content-Type": "application/json" }
        : headers()),
    body: body !== undefined ? (raw ? body : JSON.stringify(body)) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {}
  return { status: res.status, json, text, headers: res.headers };
}

// Raw request with arbitrary Host header (fetch forbids overriding Host).
function rawRequest({
  method = "GET",
  pathname = "/",
  host,
  headers: extra = {},
  body,
  waitEnd = false,
}) {
  return new Promise((resolve, reject) => {
    const r = http.request(
      // Connection: close — raw tests never reuse sockets: a request that
      // declares Content-Length without a body would otherwise leave a
      // dangling request stream on the server and poison the next request.
      {
        host: "127.0.0.1",
        port: s.port,
        path: pathname,
        method,
        headers: { Host: host, Connection: "close", ...extra },
      },
      (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => resolve({ status: res.statusCode, body: data }));
      },
    );
    r.on("error", (err) => {
      if (waitEnd) resolve({ status: 0, body: String(err) });
      else reject(err);
    });
    if (body === undefined) r.end();
    else {
      if (typeof body === "string" || Buffer.isBuffer(body)) r.write(body);
      else for (const chunk of body) r.write(chunk);
      r.end();
    }
  });
}

before(async () => {
  dataDir = await mkdtemp(path.join(tmpdir(), "math-board-test-"));
  s = new BoardServer({ dataDir });
  await s.start();
  base = `http://127.0.0.1:${s.port}`;
});

after(async () => {
  await s.stop();
  await rm(dataDir, { recursive: true, force: true });
});

describe("auth", () => {
  test("rejects missing bearer token with 401", async () => {
    const r = await req("GET", "/api/state", { headers: {} });
    assert.equal(r.status, 401);
  });

  test("rejects wrong bearer token with 401", async () => {
    const r = await req("GET", "/api/state", {
      headers: { Authorization: "Bearer nope" },
    });
    assert.equal(r.status, 401);
  });

  test("accepts the correct token", async () => {
    const r = await req("GET", "/api/state");
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.equal(r.json.revision, 0);
  });

  test("rejects non-loopback Host header with 403", async () => {
    const r = await rawRequest({
      pathname: "/api/state",
      host: "evil.example.com",
    });
    assert.equal(r.status, 403);
  });

  test("rejects foreign Origin with 403 even with valid token", async () => {
    const r = await req("GET", "/api/state", {
      headers: headers({ Origin: "http://evil.example.com" }),
    });
    assert.equal(r.status, 403);
  });

  test("accepts matching loopback Origin", async () => {
    const r = await req("GET", "/api/state", {
      headers: headers({ Origin: `http://127.0.0.1:${s.port}` }),
    });
    assert.equal(r.status, 200);
  });

  test("SSE endpoint requires token (query), rejects without", async () => {
    const r = await rawRequest({
      pathname: "/api/events",
      host: `127.0.0.1:${s.port}`,
    });
    assert.ok(r.status === 401 || r.status === 400);
  });
});

describe("static app", () => {
  test("GET / serves the app HTML", async () => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Pi Blackboard/);
    assert.match(html, /app\.css/);
    assert.doesNotMatch(html, /https?:\/\/(?!127\.0\.0\.1)/); // no CDN
  });

  test("serves app.js and style.css", async () => {
    const js = await fetch(`${base}/app.js`);
    assert.equal(js.status, 200);
    assert.match(js.headers.get("content-type"), /javascript/);
    const css = await fetch(`${base}/style.css`);
    assert.equal(css.status, 200);
    assert.match(css.headers.get("content-type"), /css/);
  });

  test("serves bundled styles and local Excalidraw fonts", async () => {
    const r = await fetch(`${base}/app.css`);
    assert.equal(r.status, 200);
    assert.match(await r.text(), /katex/i);
    const font = await fetch(
      `${base}/assets/fonts/Assistant/Assistant-Regular.woff2`,
    );
    assert.equal(font.status, 200);
    assert.equal(font.headers.get("content-type"), "font/woff2");
  });

  test("no path traversal on font route", async () => {
    const r = await fetch(`${base}/vendor/fonts/..%2F..%2Fpackage.json`);
    assert.ok(
      r.status === 404 || r.status === 400,
      `expected 404/400, got ${r.status}`,
    );
  });
});

describe("updates & conflicts", () => {
  test("add equation, revision bumps, appears in state", async () => {
    const rev0 = (await req("GET", "/api/state")).json.revision;
    const r = await req("POST", "/api/update", {
      body: {
        baseRevision: rev0,
        equations: [{ op: "add", latex: "a^2+b^2=c^2", label: "Pythagoras" }],
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.revision, rev0 + 1);
    const st = await req("GET", "/api/state");
    assert.equal(st.json.board.equations.length, 1);
    assert.equal(st.json.board.equations[0].latex, "a^2+b^2=c^2");
    assert.ok(st.json.board.equations[0].id);
  });

  test("stale baseRevision conflicts with 409 and fresh state", async () => {
    const rev0 = (await req("GET", "/api/state")).json.revision;
    const ok = await req("POST", "/api/update", {
      body: { baseRevision: rev0, equations: [{ op: "add", latex: "1" }] },
    });
    assert.equal(ok.status, 200);
    const stale = await req("POST", "/api/update", {
      body: { baseRevision: rev0, equations: [{ op: "add", latex: "2" }] },
    });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.revision, rev0 + 1);
    assert.ok(stale.json.board);
  });

  test("HTTP update requires baseRevision", async () => {
    const rev = s.revision;
    const r = await req("POST", "/api/update", {
      omitRevision: true,
      body: { title: "unsafe" },
    });
    assert.equal(r.status, 400);
    assert.equal(s.revision, rev);
  });

  test("invalid shapes are sanitized away", async () => {
    const r = await req("POST", "/api/update", {
      body: {
        scene: {
          mode: "replace",
          shapes: [
            { type: "bomb", code: "x" },
            { type: "text", text: "hi", x: 1, y: 1 },
          ],
        },
      },
    });
    assert.equal(r.status, 200);
    assert.equal(r.json.board.scene.shapes.length, 1);
    assert.equal(r.json.board.scene.shapes[0].type, "text");
  });

  test("unknown equation id errors 400", async () => {
    const r = await req("POST", "/api/update", {
      body: { equations: [{ op: "delete", id: "ghost" }] },
    });
    assert.equal(r.status, 400);
  });

  test("clear scopes", async () => {
    await req("POST", "/api/update", {
      body: {
        equations: [{ op: "add", latex: "e" }],
        scene: {
          mode: "append",
          shapes: [{ type: "rect", x: 0, y: 0, w: 1, h: 1 }],
        },
      },
    });
    const r = await req("POST", "/api/clear", { body: { scopes: ["scene"] } });
    assert.equal(r.status, 200);
    assert.equal(r.json.board.scene.shapes.length, 0);
    assert.ok(r.json.board.equations.length > 0);
  });

  test("bad JSON body -> 400", async () => {
    const r = await req("POST", "/api/update", { body: "{oops", raw: true });
    assert.equal(r.status, 400);
  });
});

describe("payload bounds", () => {
  test("oversized declared Content-Length -> 413", async () => {
    // A raw request because fetch recomputes Content-Length itself.
    const r = await rawRequest({
      method: "POST",
      pathname: "/api/update",
      host: `127.0.0.1:${s.port}`,
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Length": String(MAX_BODY_BYTES + 1),
      },
    });
    assert.equal(r.status, 413);
  });

  test("oversized streamed body -> 413", async () => {
    const big = JSON.stringify({
      scene: {
        mode: "replace",
        shapes: [
          { type: "text", text: "x".repeat(MAX_BODY_BYTES), x: 0, y: 0 },
        ],
      },
    });
    const r = await rawRequest({
      method: "POST",
      pathname: "/api/update",
      host: `127.0.0.1:${s.port}`,
      headers: {
        Authorization: `Bearer ${s.token}`,
        "Content-Type": "application/json",
      },
      body: big,
    });
    assert.equal(r.status, 413);
  });
});

describe("persistence", () => {
  test("save + list + load round trip", async () => {
    await req("POST", "/api/clear", { body: { scopes: ["all"] } });
    await req("POST", "/api/update", {
      body: { equations: [{ op: "add", latex: "\\pi", label: "pi" }] },
    });
    const saved = await req("POST", "/api/save", {
      body: { name: "roundtrip" },
    });
    assert.equal(saved.status, 200);

    await req("POST", "/api/clear", { body: { scopes: ["all"] } });
    assert.equal(
      (await req("GET", "/api/state")).json.board.equations.length,
      0,
    );

    const names = await req("GET", "/api/saves");
    assert.ok(names.json.saves.includes("roundtrip"));

    const loaded = await req("POST", "/api/load", {
      body: { name: "roundtrip" },
    });
    assert.equal(loaded.status, 200);
    assert.equal(loaded.json.board.equations[0].latex, "\\pi");
  });

  test("load unknown save -> 404; bad save name rejected", async () => {
    assert.equal(
      (await req("POST", "/api/load", { body: { name: "ghost" } })).status,
      404,
    );
    assert.equal(
      (await req("POST", "/api/save", { body: { name: "../evil" } })).status,
      400,
    );
  });

  test("corrupt save file is rejected after re-sanitization", async () => {
    const dir = path.join(dataDir, "saves");
    await writeFile(
      path.join(dir, "corrupt.json"),
      JSON.stringify({
        board: {
          scene: { shapes: [{ type: "stroke", points: "nope" }] },
          equations: [{ latex: "<script>x</script>" }],
        },
      }),
    );
    const r = await req("POST", "/api/load", { body: { name: "corrupt" } });
    assert.equal(r.status, 200);
    // The bogus stroke was dropped; equation latex stays data (rendered as text, never HTML).
    assert.equal(r.json.board.scene.shapes.length, 0);
    assert.equal(r.json.board.equations[0].latex, "<script>x</script>");
  });
});

describe("pure update logic", () => {
  test("applyUpdate add/update/delete", () => {
    let board = {
      title: "t",
      equations: [],
      scene: { shapes: [] },
      updatedAt: "",
    };
    board = applyUpdate(board, { equations: [{ op: "add", latex: "x" }] });
    const id = board.equations[0].id;
    board = applyUpdate(board, {
      equations: [{ op: "update", id, latex: "y" }],
    });
    assert.equal(board.equations[0].latex, "y");
    board = applyUpdate(board, { equations: [{ op: "delete", id }] });
    assert.equal(board.equations.length, 0);
  });

  test("applyUpdate enforces limits", () => {
    const many = Array.from({ length: 1001 }, (_, i) => ({
      op: "add",
      latex: `x_{${i}}`,
    }));
    assert.throws(
      () =>
        applyUpdate(
          { title: "", equations: [], scene: { shapes: [] } },
          { equations: many },
        ),
      /too many equations/,
    );
  });

  test("sanitize helpers", () => {
    assert.equal(
      sanitizeShape({
        type: "stroke",
        points: [
          [0, 0],
          [1, 1],
        ],
      }).points.length,
      2,
    );
    assert.equal(sanitizeShape({ type: "stroke", points: "nope" }), null);
    assert.equal(sanitizeEquation({ latex: "" }), null);
    assert.ok(sanitizeEquation({ latex: "1+1" }).id);
  });
});

describe("server lifecycle", () => {
  test("stop is idempotent and frees the port", async () => {
    const s2 = new BoardServer({ dataDir });
    await s2.start();
    const { port } = s2;
    await s2.stop();
    await s2.stop();
    // The port should be free again: binding 0 should not throw, and a
    // fresh server can pick any port (possibly the same one).
    const s3 = new BoardServer({ dataDir });
    await s3.start();
    await s3.stop();
  });

  test("url carries the token in the fragment", async () => {
    const s2 = new BoardServer({ dataDir });
    await s2.start();
    assert.match(s2.url, /http:\/\/127\.0\.0\.1:\d+\/#token=[0-9a-f]{64}/);
    await s2.stop();
  });
});

test("item ops update, move and delete any item kind and re-validate", async () => {
  const { applyUpdate, emptyBoard } = await import("../server.mjs");
  let b = applyUpdate(emptyBoard(), {
    equations: [{ op: "add", id: "e", latex: "x" }],
    scene: { mode: "append", shapes: [{ type: "line", id: "l", points: [[0, 0], [1, 1]] }, { type: "text", id: "t", text: "hi", x: 1, y: 2, font: "sans", anchor: "middle", bold: true, z: 2 }],
      artifacts: [{ type: "svg", id: "a", source: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', x: 5, y: 5 }] },
  });
  assert.equal(b.scene.shapes[1].font, "sans");
  assert.equal(b.scene.shapes[1].z, 2);
  b = applyUpdate(b, { items: [
    { op: "move", id: "l", dx: 10, dy: 5 },
    { op: "move", id: "e", dx: 2, dy: 3 },
    { op: "move", id: "a", dx: 1, dy: 1 },
    { op: "update", id: "t", color: "#f2c14e", font: "comic" },
    { op: "delete", id: "a" },
  ] });
  assert.deepEqual(b.scene.shapes[0].points, [[10, 5], [11, 6]]);
  assert.deepEqual([b.equations[0].x, b.equations[0].y], [90, 95]);
  assert.equal(b.scene.shapes[1].color, "#f2c14e");
  assert.equal(b.scene.shapes[1].font, undefined, "invalid enum dropped on re-validation");
  assert.equal(b.scene.artifacts.length, 0);
  assert.throws(() => applyUpdate(b, { items: [{ op: "move", id: "nope", dx: 1, dy: 1 }] }), /unknown item id/);
  assert.throws(() => applyUpdate(b, { items: [{ op: "update", id: "l", points: [] }] }), /invalid/);
});

test("audit fixes: text may mention url(), unquoted attributes rejected, artifact opacity kept", () => {
  const ok = (inner) => sanitizeArtifact({ type: "svg", source: `<svg viewBox="0 0 9 9">${inner}</svg>` });
  ok("<text>resolved via url(example) and curl(x); @import is just a word</text>");
  assert.throws(() => ok('<rect fill="url(http://x)"/>'), /url\(/);
  assert.throws(() => ok("<style>@import 'x';</style>"), /@import/);
  assert.throws(() => ok('<path onload=alert(1) d="M0 0"/>'), /unquoted/);
  assert.equal(sanitizeArtifact({ type: "svg", source: '<svg viewBox="0 0 1 1"><rect width="1" height="1"/></svg>', opacity: 0.4 }).opacity, 0.4);
});

test("chapters: auto-placement, relative items, camera, delete cascades", async () => {
  const { applyUpdate, emptyBoard, cameraRect } = await import("../server.mjs");
  let b = applyUpdate(emptyBoard(), {
    chapters: [{ op: "add", id: "c1", title: "Intro" }, { op: "add", id: "c2", title: "Forces" }],
    equations: [{ op: "add", id: "e", latex: "x", chapter: "c2", x: 10, y: 20 }],
    scene: { mode: "append", shapes: [{ type: "text", id: "t", text: "hi", x: 1, y: 2, chapter: "c2" }] },
    camera: { chapter: "c2" },
  });
  assert.deepEqual(b.chapters.map((c) => [c.x, c.y, c.w, c.h]), [[0, 0, 1200, 800], [1440, 0, 1200, 800]]);
  assert.deepEqual(cameraRect(b), { x: 1440, y: 0, w: 1200, h: 800 });
  assert.throws(() => applyUpdate(b, { scene: { mode: "append", shapes: [{ type: "text", text: "x", x: 0, y: 0, chapter: "nope" }] } }), /unknown chapter/);
  assert.throws(() => applyUpdate(b, { camera: { chapter: "nope" } }), /unknown chapter/);
  b = applyUpdate(b, { items: [{ op: "update", id: "t", chapter: "c1" }] });
  assert.equal(b.scene.shapes[0].chapter, "c1");
  b = applyUpdate(b, { chapters: [{ op: "delete", id: "c2" }] });
  assert.equal(b.equations.length, 0, "chapter delete removes its items");
  assert.equal(b.camera, null, "camera on a deleted chapter falls back home");
  b = applyUpdate(b, { chapters: [{ op: "delete", id: "c1", keepItems: true }] });
  assert.equal(b.scene.shapes.length, 1);
  assert.equal(b.scene.shapes[0].chapter, undefined);
});

test("autosave persists every change and a fresh server restores it", async () => {
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const pathMod = (await import("node:path")).default;
  const dir = await mkdtemp(pathMod.join(tmpdir(), "board-autosave-"));
  try {
    const a = new BoardServer({ dataDir: dir });
    await a.start();
    a.update({ title: "Lesson", chapters: [{ op: "add", id: "c1", title: "One" }], equations: [{ op: "add", latex: "E=mc^2", chapter: "c1" }], camera: { chapter: "c1" } });
    await a.stop(); // flushes the pending autosave
    const b = new BoardServer({ dataDir: dir });
    await b.start();
    const st = b.getState();
    assert.equal(st.title, "Lesson");
    assert.equal(st.equations[0].chapter, "c1");
    assert.deepEqual(st.camera, { chapter: "c1" });
    assert.ok(b.restoredFrom);
    await b.stop();
    const c = new BoardServer({ dataDir: dir, autosave: false });
    await c.start();
    assert.equal(c.getState().equations.length, 0, "autosave:false neither restores nor writes");
    await c.stop();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("steps: one per update by default, explicit steps kept, restore preserves them", async () => {
  const { applyUpdate, emptyBoard } = await import("../server.mjs");
  let b = applyUpdate(emptyBoard(), { scene: { mode: "append", shapes: [{ type: "line", id: "a", points: [[0, 0], [1, 1]] }] } });
  assert.equal(b.scene.shapes[0].step, 1);
  b = applyUpdate(b, { equations: [{ op: "add", id: "e", latex: "x" }], scene: { mode: "append", shapes: [{ type: "text", id: "t", text: "hi", x: 0, y: 0, reveal: "fade", duration: 300 }, { type: "text", id: "t2", text: "later", x: 0, y: 0, step: 3 }] } });
  assert.deepEqual([b.equations[0].step, b.scene.shapes[1].step, b.scene.shapes[2].step], [2, 2, 3]);
  assert.equal(b.scene.shapes[1].reveal, "fade");
  assert.equal(b.lastStep, 3);
  b = applyUpdate(b, { title: "no items added" });
  assert.equal(b.lastStep, 3, "updates without new items do not create steps");
  b = applyUpdate(b, { items: [{ op: "update", id: "a", color: "#f00" }] });
  assert.equal(b.scene.shapes[0].step, 1, "editing an item keeps its step");
  b = applyUpdate(b, { clear: ["all"] });
  assert.equal(b.lastStep, 0);
});

test("phase 4 artifacts: plots validate expressions, molecules validate SMILES, icons must exist", async () => {
  const { sanitizeArtifact, searchIcons, iconIndex } = await import("../server.mjs");
  const { compileExpr } = await import("../shared/expr.mjs");
  assert.equal(compileExpr("2x^2 + 3(x-1)", ["x"])({ x: 2 }), 11);
  assert.equal(compileExpr("-x^2", ["x"])({ x: 3 }), -9);
  for (const bad of ["constructor", "alert(1)", "x;1", "process.exit()", "__proto__", "sin x"]) assert.throws(() => compileExpr(bad, ["x"]));
  const plot = sanitizeArtifact({ type: "plot", x: 0, y: 0, width: 400, height: 300, functions: [{ expr: "sin(x)", label: "sin" }], areas: [{ expr: "x", from: 0, to: 1 }] });
  assert.deepEqual(plot.xRange, [-10, 10]);
  assert.throws(() => sanitizeArtifact({ type: "plot", functions: [{ expr: "eval(1)" }] }), /unknown function/);
  assert.throws(() => sanitizeArtifact({ type: "plot", parametric: [{ x: "cos(t)", y: "x" }] }), /unknown name "x"/);
  assert.equal(sanitizeArtifact({ type: "molecule", smiles: "CC(=O)Oc1ccccc1C(=O)O" }).smiles, "CC(=O)Oc1ccccc1C(=O)O");
  assert.throws(() => sanitizeArtifact({ type: "molecule", smiles: "<script>" }), /SMILES/);
  if (iconIndex().size) {
    const [hit] = searchIcons("heart");
    assert.ok(hit, "search finds heart icons");
    const icon = sanitizeArtifact({ type: "icon", icon: hit.id, width: 200 });
    assert.ok(Math.abs(icon.height - (200 * hit.h) / hit.w) < 1 || icon.height === 60 || icon.height === 800, "height follows aspect");
    assert.throws(() => sanitizeArtifact({ type: "icon", icon: "../../etc/passwd" }), /unknown icon/);
  }
});
