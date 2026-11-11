/**
 * One board per data folder (attach.mjs): the first session hosts it, later ones join and their
 * tool calls run in the host; a joined session takes over when the host is gone, on the same
 * port with the same token and revision. Plus what was brought along from the old mcp/ folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardLink, adoptMcpFolder } from "../attach.mjs";
import { BoardServer, readSession } from "../server.mjs";

const temps = [];
test.after(async () => {
  for (const dir of temps) await rm(dir, { recursive: true, force: true });
});
async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "math-board-attach-"));
  temps.push(dir);
  return dir;
}
const session = (dataDir, openHint) => new BoardLink({ dataDir, context: { staleWarning: () => "", openHint } });
const text = (r) => r.content.map((c) => c.text).join("\n");
const add = (link, id, baseRevision) => link.call("board_update", { baseRevision, equations: [{ op: "add", id, latex: "x" }], check: false });

test("the first session hosts the board; a second one joins it and draws on the same board", async (t) => {
  const dir = await tempDir();
  const a = session(dir, "board_open"), b = session(dir, "/board open");
  t.after(() => Promise.all([b.stop(), a.stop()]));
  assert.equal(await b.find(), false, "find never starts a board");
  assert.equal(b.active, false);
  await a.ensure();
  assert.equal(a.hosting, true);
  assert.equal(await b.find(), true);
  assert.equal(b.hosting, false);
  assert.equal(b.port, a.port);
  assert.equal(b.url, a.url, "the joined session opens the same address");
  assert.match(text(await add(a, "fromA", 0)), /revision 1 \(was 0\)/);
  const viaB = await add(b, "fromB", 1);
  assert.match(text(viaB), /revision 2 \(was 1\)/);
  assert.equal(viaB.details, undefined, "the host's board clone does not travel");
  // Nobody watches: the hint is the joined session's own way to open the board.
  assert.match(text(viaB), /No browser is showing the board; call \/board open\./);
  assert.match(text(await a.call("board_read", {})), /\[fromA\][\s\S]*\[fromB\]/);
  // A stale write through the joined session is a conflict, like any other.
  const stale = await add(b, "late", 1);
  assert.equal(stale.isError, true);
  assert.match(text(stale), /Conflict/);
  assert.deepEqual((await b.status()).revision, 2);
  assert.equal((await b.state()).board.equations.length, 2);
  assert.equal((await b.save("joined")).name, "joined");
  assert.equal(await b.clear(), 3);
  assert.equal((await b.load("joined")).revision, 4);
  assert.equal(a.local.revision, 4);
  // Leaving does not stop the host.
  assert.equal(await b.stop(), false);
  assert.equal(a.hosting, true);
});

test("when the host goes away, a joined session hosts the board again: same address, same revision", async (t) => {
  const dir = await tempDir();
  const a = session(dir), b = session(dir);
  t.after(() => Promise.all([b.stop(), a.stop()]));
  await a.ensure();
  await add(a, "kept", 0);
  await b.find();
  const { port, url } = b;
  assert.equal(await a.stop(), true);
  const read = await b.call("board_read", {});
  assert.equal(b.hosting, true);
  assert.match(text(read), /\[kept\]/);
  assert.match(text(read), /revision: 1/, "the tutor's next baseRevision still fits");
  assert.equal(b.port, port);
  assert.equal(b.url, url, "an open tab reconnects by itself");
  assert.match(text(await add(b, "next", 1)), /revision 2 \(was 1\)/);
});

test("an exclusive board refuses to start beside a live one; a lock whose owner is gone is taken", async () => {
  const dir = await tempDir();
  const a = new BoardServer({ dataDir: dir, exclusive: true });
  await a.start();
  const b = new BoardServer({ dataDir: dir, exclusive: true });
  await assert.rejects(b.start(), (err) => err.hosted?.port === a.port && err.hosted.pid === process.pid);
  assert.equal(b.server, null);
  assert.equal(JSON.parse(await readFile(path.join(dir, "board.lock"), "utf8")).instance, a.instance);
  await a.stop();
  // A lock left by a process that is gone (pid 2^22 is beyond any real one here), and one whose
  // pid is alive but is not a board on that port.
  for (const lock of [{ pid: 4194304, port: 1, instance: "gone" }, { pid: process.pid, port: 1, instance: "not-a-board" }]) {
    await writeFile(path.join(dir, "board.lock"), JSON.stringify(lock));
    const c = new BoardServer({ dataDir: dir, exclusive: true });
    await c.start();
    assert.equal(JSON.parse(await readFile(path.join(dir, "board.lock"), "utf8")).instance, c.instance);
    assert.equal(readSession(dir).token, a.token, "the folder keeps its token");
    await c.stop();
  }
});

test("tool calls over HTTP need the token, name a real tool, and may be larger than a page's writes", async (t) => {
  const dir = await tempDir();
  const a = session(dir);
  t.after(() => a.stop());
  await a.ensure();
  const post = (body, token = a.local.token) =>
    fetch(`http://127.0.0.1:${a.port}/api/tool`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) }).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.equal((await post({ name: "board_read", params: {} }, "0".repeat(64))).status, 401);
  const unknown = await post({ name: "constructor", params: {} });
  assert.equal(unknown.data.result.isError, true);
  assert.match(unknown.data.result.content[0].text, /no such tool/);
  // 600 KiB of points: over the page's 512 KiB limit, fine for a tool call.
  const points = Array.from({ length: 2000 }, (_, i) => [i % 1200, (i * 7) % 800]);
  const shapes = Array.from({ length: 20 }, (_, i) => ({ type: "stroke", id: `s${i}`, points }));
  const big = await post({ name: "board_update", params: { baseRevision: 0, scene: { mode: "append", shapes }, check: false } });
  assert.equal(big.status, 200);
  assert.match(big.data.result.content[0].text, /revision 1/);
  // A board with no tool runner (a bare BoardServer) has none to call.
  const bare = new BoardServer({ dataDir: await tempDir() });
  await bare.start();
  t.after(() => bare.stop());
  const r = await fetch(`http://127.0.0.1:${bare.port}/api/tool`, { method: "POST", headers: { authorization: `Bearer ${bare.token}`, "content-type": "application/json" }, body: "{\"name\":\"board_read\"}" });
  assert.equal(r.status, 400);
  // ping names the instance without the token; status needs it.
  assert.equal((await (await fetch(`http://127.0.0.1:${a.port}/api/ping`)).json()).instance, a.local.instance);
  assert.equal((await fetch(`http://127.0.0.1:${a.port}/api/status`)).status, 401);
});

test("the old mcp/ folder's saves and autosave are brought along once, never over existing files", async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, "mcp", "saves"), { recursive: true });
  await mkdir(path.join(dir, "saves"), { recursive: true });
  await writeFile(path.join(dir, "mcp", "autosave.json"), "old-autosave");
  await writeFile(path.join(dir, "mcp", "saves", "lesson.json"), "old-lesson");
  await writeFile(path.join(dir, "mcp", "saves", "taken.json"), "old-taken");
  await writeFile(path.join(dir, "saves", "mcp-taken.json"), "mine");
  await adoptMcpFolder(dir);
  await adoptMcpFolder(dir);
  assert.equal(await readFile(path.join(dir, "autosave.json"), "utf8"), "old-autosave");
  assert.equal(await readFile(path.join(dir, "saves", "mcp-lesson.json"), "utf8"), "old-lesson");
  assert.equal(await readFile(path.join(dir, "saves", "mcp-taken.json"), "utf8"), "mine");
  await writeFile(path.join(dir, "autosave.json"), "newer");
  await adoptMcpFolder(dir);
  assert.equal(await readFile(path.join(dir, "autosave.json"), "utf8"), "newer");
  await adoptMcpFolder(await tempDir()); // no mcp/ folder: nothing happens
});
