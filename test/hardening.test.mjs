import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import { mkdtemp, rm, stat, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { BoardServer, emptyBoard, applyUpdate } from "../server.mjs";
import { sanitizeElements } from "../scene.mjs";
async function setup(t) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "board-hardening-"));
  const server = new BoardServer({ dataDir });
  await server.start();
  t.after(async () => {
    await server.stop();
    await rm(dataDir, { recursive: true, force: true });
  });
  const call = async (url, body, extra = {}) => {
    const r = await fetch(`http://127.0.0.1:${server.port}${url}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        Authorization: `Bearer ${server.token}`,
        "Content-Type": "application/json",
        ...extra,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, headers: r.headers, data: await r.json() };
  };
  return { server, dataDir, call };
}
test("malformed URL is contained; static files enforce Host and security headers", async (t) => {
  const { server, call } = await setup(t);
  assert.equal((await call("/%zz")).status, 400);
  const rawHost = (host, url) =>
    new Promise((resolve, reject) => {
      const req = http.get(
        {
          hostname: "127.0.0.1",
          port: server.port,
          path: url,
          headers: { Host: host },
        },
        (res) => {
          res.resume();
          res.on("end", () => resolve(res.statusCode));
        },
      );
      req.on("error", reject);
    });
  assert.equal(await rawHost("evil.test", "/"), 403);
  assert.equal(await rawHost("127.0.0.1:1", "/api/state"), 403);
  const response = await fetch(`http://127.0.0.1:${server.port}/`);
  assert.match(
    response.headers.get("content-security-policy"),
    /connect-src 'self'/,
  );
  assert.match(
    response.headers.get("content-security-policy"),
    /frame-ancestors 'none'/,
  );
  assert.equal(response.headers.get("referrer-policy"), "no-referrer");
  assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  for (const url of [
    "/server.mjs",
    "/package.json",
    "/.data/saves/default.json",
    "/assets/..%2F..%2Fserver.mjs",
  ])
    assert.equal((await call(url)).status, 404);
});
test("all POST bodies must be JSON objects; null and arrays never hang", async (t) => {
  const { call } = await setup(t);
  for (const body of [null, [], 3, "hello"])
    assert.equal((await call("/api/update", body)).status, 400);
  assert.equal(
    (await call("/api/update", {}, { "Content-Type": "text/plain" })).status,
    415,
  );
  for (const baseRevision of [null, "0", -1, 0.5])
    assert.equal(
      (await call("/api/update", { baseRevision, title: "bad" })).status,
      400,
    );
});
test("clear and load require CAS and reject stale state", async (t) => {
  const { server, call } = await setup(t);
  await server.save("x");
  server.update({ title: "new" });
  for (const route of ["clear", "load"]) {
    assert.equal((await call(`/api/${route}`, { name: "x" })).status, 400);
    assert.equal(
      (await call(`/api/${route}`, { name: "x", baseRevision: 0 })).status,
      409,
    );
    assert.equal(server.revision, 1);
  }
});
test("SSE hello + update; auth/origin restrictions and clean shutdown with active sockets", async (t) => {
  const { server, call } = await setup(t);
  assert.equal(
    (
      await call(`/api/events?token=${server.token}`, undefined, {
        Origin: "null",
      })
    ).status,
    403,
  );
  assert.equal((await call("/api/events?token=bad")).status, 401);
  const response = await fetch(
    `http://127.0.0.1:${server.port}/api/events?token=${server.token}`,
  );
  const reader = response.body.getReader();
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"type":"hello"/,
  );
  server.update({ title: "changed" });
  assert.match(
    new TextDecoder().decode((await reader.read()).value),
    /"revision":1/,
  );
  const socket = net.connect(server.port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  socket.write(
    `POST /api/update HTTP/1.1\r\nHost: 127.0.0.1:${server.port}\r\nContent-Length: 100\r\n`,
  );
  await server.stop();
  socket.destroy();
  assert.equal(server.clients.size, 0);
  await reader.cancel();
});
test("concurrent starts share a single listener", async (t) => {
  const { server } = await setup(t);
  await server.stop();
  const [a, b] = await Promise.all([server.start(), server.start()]);
  assert.equal(a, b);
  assert.equal(a.server, b.server);
});
test("concurrent saves are atomic, private and survive a fresh server", async (t) => {
  const { server, dataDir } = await setup(t);
  server.update({ title: "first", equations: [{ op: "add", latex: "x" }] });
  const a = server.save("same");
  server.update({ title: "second" });
  const b = server.save("same");
  await Promise.all([a, b]);
  const files = await readdir(path.join(dataDir, "saves"));
  assert.deepEqual(files, ["same.json"]);
  assert.equal(
    (await stat(path.join(dataDir, "saves/same.json"))).mode & 0o777,
    0o600,
  );
  const restored = new BoardServer({ dataDir });
  await restored.load("same");
  assert.equal(restored.getState().title, "second");
  assert.equal(restored.getState().equations[0].latex, "x");
});
test("async load cannot overwrite an intervening edit", async (t) => {
  const { server } = await setup(t);
  await server.save("x");
  const loading = server.load("x");
  server.update({ title: "intervening" });
  await assert.rejects(loading, /conflict/);
  assert.equal(server.getState().title, "intervening");
});
test("native scene round trip and unsafe elements are rejected", async (t) => {
  const { server } = await setup(t);
  const element = {
    id: "r",
    type: "rectangle",
    x: 1,
    y: 2,
    width: 50,
    height: 30,
    updated: Date.now(),
    link: "javascript:alert(1)",
  };
  server.update({ scene: { mode: "replace", elements: [element] } });
  await server.save("native");
  server.clear();
  await server.load("native");
  assert.equal(server.getState().scene.elements[0].link, null);
  for (const type of ["image", "embeddable", "iframe"])
    assert.throws(
      () => sanitizeElements([{ ...element, type }]),
      /unsupported/,
    );
  assert.throws(() => sanitizeElements([element, element]), /duplicate/);
  assert.throws(
    () => sanitizeElements([{ ...element, x: Infinity }]),
    /invalid/,
  );
  assert.throws(
    () =>
      sanitizeElements([
        { ...element, groupIds: JSON.parse('{"__proto__":{}}') },
      ]),
    /unsafe/,
  );
});
test("title and field validation, scene limit, duplicate ids, transaction rollback", () => {
  const board = emptyBoard();
  assert.equal(applyUpdate(board, { title: "new" }).title, "new");
  for (const update of [
    { unknown: true },
    { title: 3 },
    { equations: {} },
    { scene: { mode: "oops" } },
  ])
    assert.throws(() => applyUpdate(board, update));
  assert.throws(
    () =>
      applyUpdate(board, {
        equations: [
          { op: "add", id: "a", latex: "x" },
          { op: "add", id: "a", latex: "y" },
        ],
      }),
    /duplicate/,
  );
  assert.equal(board.equations.length, 0);
  const shapes = Array.from({ length: 5001 }, (_, i) => ({
    id: String(i),
    type: "rect",
    x: 0,
    y: 0,
    w: 1,
    h: 1,
  }));
  assert.throws(
    () => applyUpdate(board, { scene: { mode: "replace", shapes } }),
    /too many/,
  );
});
