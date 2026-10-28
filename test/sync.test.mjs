import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardSync, LiveEvents } from "../public/sync.js";

const state = (revision, title = `r${revision}`) => ({
  ok: true,
  status: 200,
  revision,
  board: { title, equations: [], scene: { shapes: [], artifacts: [] } },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
/** A BoardSync whose page has already shown `revision`; `request` stands in for the server. */
function client(request, revision = 0) {
  const calls = [],
    renders = [],
    statuses = [];
  const sync = new BoardSync({
    request: (path, body) => {
      calls.push({ path, body });
      return request(path, body);
    },
    render: (data) => renders.push({ revision: data.revision, title: data.board.title }),
    status: (text) => statuses.push(text),
  });
  if (revision >= 0) sync.accept(state(revision));
  renders.length = 0;
  return { sync, calls, renders, statuses };
}

test("refresh shows the server's board and reports its revision", async () => {
  const { sync, renders, statuses } = client(async () => state(3), -1);
  await sync.refresh();
  assert.deepEqual(renders, [{ revision: 3, title: "r3" }]);
  assert.equal(sync.board.title, "r3");
  assert.equal(statuses.at(-1), "Connected · revision 3");
});

test("a newer revision event reads the board once; repeats and older revisions send nothing", async () => {
  const { sync, calls, renders } = client(async () => state(2), 1);
  await sync.remote(1); // the hello for the revision already on screen
  assert.equal(calls.length, 0);
  await sync.remote(2);
  await sync.remote(2);
  await sync.remote(1);
  assert.deepEqual(calls.map((c) => c.path), ["/api/state"]);
  assert.deepEqual(renders.map((r) => r.revision), [2]);
});

test("events arriving while a read is in flight collapse into one read of the newest board", async () => {
  const gate = deferred(),
    started = deferred();
  const { sync, calls, renders } = client(async () => {
    started.resolve();
    await gate.promise;
    return state(4);
  });
  const first = sync.remote(2);
  await started.promise;
  const later = [sync.remote(3), sync.remote(4)];
  gate.resolve();
  await Promise.all([first, ...later]);
  assert.equal(calls.length, 1);
  assert.deepEqual(renders.map((r) => r.revision), [4]);
  assert.equal(sync.revision, 4);
});

test("a read that returns an older board never replaces the newer one on screen", async () => {
  const { sync, renders } = client(async () => state(4), 5);
  await sync.remote(6);
  assert.equal(sync.revision, 5);
  assert.deepEqual(renders, []);
});

test("Clear sends the revision on screen and shows the board the server returns", async () => {
  const { sync, calls, renders } = client(async () => state(3, "cleared"), 2);
  const r = await sync.mutate("/api/update", { clear: ["all"] });
  assert.equal(r.ok, true);
  assert.deepEqual(calls[0], { path: "/api/update", body: { clear: ["all"], baseRevision: 2 } });
  assert.deepEqual(renders, [{ revision: 3, title: "cleared" }]);
});

test("a 409 shows the current board and keeps the page live (no frozen view, no draft)", async () => {
  const { sync, calls, renders } = client(async (path, body) => {
    if (path === "/api/state") return state(5);
    if (body.baseRevision !== 3) return { ok: false, status: 409, error: "conflict", revision: 3, board: state(3, "drawn meanwhile").board };
    return state(4, "cleared");
  }, 1);
  const r = await sync.mutate("/api/update", { clear: ["all"] });
  assert.deepEqual(r, { ok: false, conflict: true, revision: 3 });
  assert.deepEqual(renders, [{ revision: 3, title: "drawn meanwhile" }]);
  // Asked again, the learner confirms: the retry carries the revision now on screen.
  assert.equal((await sync.mutate("/api/update", { clear: ["all"] })).ok, true);
  assert.equal(calls.at(-1).body.baseRevision, 3);
  // Later model updates still reach the page.
  await sync.remote(5);
  assert.deepEqual(renders.map((x) => x.revision), [3, 4, 5]);
});

test("a 409 without a board in the reply re-reads the board", async () => {
  const { sync, calls, renders } = client(async (path) =>
    path === "/api/state" ? state(7) : { ok: false, status: 409, error: "conflict" },
  );
  const r = await sync.mutate("/api/save", { name: "default" });
  assert.deepEqual(r, { ok: false, conflict: true, revision: 7 });
  assert.deepEqual(calls.map((c) => c.path), ["/api/save", "/api/state"]);
  assert.deepEqual(renders.map((x) => x.revision), [7]);
});

test("other write failures reject with the server's message and later updates still show", async () => {
  const { sync, renders } = client(async (path) =>
    path === "/api/state" ? state(2) : { ok: false, status: 400, error: "too many equations" },
  );
  await assert.rejects(sync.mutate("/api/update", { clear: ["all"] }), /too many equations/);
  await sync.remote(2);
  assert.deepEqual(renders.map((x) => x.revision), [2]);
});

test("a failed read rejects, and the next event reads again", async () => {
  let fail = true;
  const { sync, renders } = client(async () => {
    if (fail) throw new Error("Cannot reach the board server");
    return state(2);
  });
  await assert.rejects(sync.remote(1), /Cannot reach/);
  fail = false;
  await sync.remote(2);
  assert.deepEqual(renders.map((x) => x.revision), [2]);
});

test("after the stream comes back, a restarted server's board shows even at a lower revision", async () => {
  let next = state(1, "restored");
  const { sync, renders } = client(async () => next, 9);
  await sync.resync(1);
  assert.deepEqual(renders, [{ revision: 1, title: "restored" }]);
  assert.equal(sync.revision, 1);
  next = state(2, "drawn after restart");
  await sync.remote(2);
  assert.deepEqual(renders.map((x) => x.title), ["restored", "drawn after restart"]);
});

/* ---------- event stream watchdog ---------- */
class FakeSource {
  constructor(list) {
    this.closed = false;
    list.push(this);
  }
  close() {
    this.closed = true;
  }
  open() {
    this.onopen?.();
  }
  send(data) {
    this.onmessage?.({ data: JSON.stringify(data) });
  }
  fail() {
    this.onerror?.();
  }
}
function watch(t, options = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const sources = [],
    states = [],
    events = [];
  const live = new LiveEvents({
    open: () => new FakeSource(sources),
    onEvent: (data, { resync }) => events.push({ revision: data.revision, resync }),
    onState: (s) => states.push(s),
    stoppedAfter: 10000,
    backoff: [500, 1000, 2000],
    ...options,
  }).start();
  return { live, sources, states, events };
}

test("a dropped stream reconnects with backoff; the server counts as stopped only after a sustained outage", (t) => {
  const { sources, states, events } = watch(t);
  sources[0].open();
  sources[0].send({ type: "hello", revision: 4 });
  assert.deepEqual(states, ["connected"]);
  assert.deepEqual(events, [{ revision: 4, resync: false }]);
  sources[0].fail();
  assert.equal(sources[0].closed, true);
  assert.deepEqual(states, ["connected", "reconnecting"]);
  // Retries at 500, +1000, then every 2000 ms; each fails (server down or a 401 from another server).
  let elapsed = 0;
  for (const wait of [500, 1000, 2000, 2000, 2000]) {
    const before = sources.length;
    t.mock.timers.tick(wait);
    elapsed += wait;
    assert.equal(sources.length, before + 1, `a retry after ${elapsed} ms`);
    sources.at(-1).fail();
  }
  assert.equal(elapsed, 7500);
  assert.equal(states.at(-1), "reconnecting");
  t.mock.timers.tick(2500); // 10 s without a connection
  assert.equal(states.at(-1), "stopped");
  // Retrying continues while stopped, and the same port and token coming back reconnects the tab.
  sources.at(-1).fail();
  const before = sources.length;
  t.mock.timers.tick(2000);
  assert.equal(sources.length, before + 1);
  const back = sources.at(-1);
  back.open();
  assert.equal(states.at(-1), "connected");
  back.send({ type: "hello", revision: 1 });
  back.send({ type: "revision", revision: 2 });
  assert.deepEqual(events.slice(1), [
    { revision: 1, resync: true },
    { revision: 2, resync: false },
  ]);
});

test("a short drop never reports the server as stopped", (t) => {
  const { sources, states } = watch(t);
  sources[0].open();
  sources[0].fail();
  t.mock.timers.tick(500);
  sources[1].open();
  t.mock.timers.tick(60000);
  assert.deepEqual(states, ["connected", "reconnecting", "connected"]);
  assert.equal(sources.length, 2);
});

test("events from a stream that already failed are ignored, and close stops all retries", (t) => {
  const { live, sources, states, events } = watch(t);
  sources[0].open();
  sources[0].fail();
  sources[0].send({ type: "revision", revision: 9 });
  assert.deepEqual(events, []);
  live.close();
  t.mock.timers.tick(60000);
  assert.equal(sources.length, 1);
  assert.deepEqual(states, ["connected", "reconnecting"]);
});

test("a page that cannot connect at all reports the server as stopped", (t) => {
  const { sources, states } = watch(t);
  for (let i = 0; i < 8; i++) {
    sources.at(-1).fail();
    t.mock.timers.tick(2000);
  }
  assert.deepEqual(states, ["reconnecting", "stopped"]);
});
