import { test } from "node:test";
import assert from "node:assert/strict";
import { BoardSync } from "../public/sync.js";
const state = (revision) => ({
  ok: true,
  revision,
  board: {
    title: `r${revision}`,
    equations: [],
    scene: { shapes: [], elements: [] },
  },
});
const deferred = () => {
  let resolve;
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
function client(request) {
  const renders = [],
    conflicts = [];
  const sync = new BoardSync({
    request,
    render: (data, scene) => renders.push({ revision: data.revision, scene }),
    status() {},
    conflict: (msg) => conflicts.push(msg),
    delay: 60000,
  });
  sync.accept(state(0), true);
  return { sync, renders, conflicts };
}
test("own SSE echo causes no GET and no scene installation", async () => {
  const calls = [];
  const { sync, renders } = client(async (path, body) => {
    calls.push({ path, body });
    return state(1);
  });
  sync.changed([{ id: "a" }]);
  await sync.flush();
  await sync.remote(1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].body.baseRevision, 0);
  assert.deepEqual(renders, [
    { revision: 0, scene: true },
    { revision: 1, scene: false },
  ]);
});
test("new drawing during in-flight save survives ACK and is sent with new revision", async () => {
  const gate = deferred(),
    started = deferred(),
    calls = [];
  const { sync } = client(async (path, body) => {
    calls.push(body);
    if (calls.length === 1) {
      started.resolve();
      await gate.promise;
    }
    return state(calls.length);
  });
  sync.changed([{ id: "a" }]);
  const first = sync.flush();
  await started.promise;
  sync.changed([{ id: "a" }, { id: "b" }]);
  gate.resolve();
  await first;
  assert.equal(sync.draft.length, 2);
  await sync.flush();
  assert.equal(calls[1].baseRevision, 1);
  assert.equal(calls[1].scene.elements.length, 2);
  assert.equal(sync.draft, null);
});
test("remote GET completing after drawing starts cannot erase the local draft", async () => {
  const gate = deferred(),
    started = deferred();
  const { sync, renders } = client(async () => {
    started.resolve();
    return gate.promise;
  });
  const pull = sync.remote(1);
  await started.promise;
  sync.changed([{ id: "local" }]);
  gate.resolve(state(1));
  await pull;
  clearTimeout(sync.timer);
  assert.equal(sync.revision, 0);
  assert.equal(sync.draft[0].id, "local");
  assert.equal(renders.length, 1);
});
test("409 freezes writes and retains draft until explicit reload", async () => {
  let calls = 0;
  const { sync, conflicts } = client(async (path) => {
    calls++;
    return path === "/api/state"
      ? state(2)
      : { ...state(2), ok: false, status: 409 };
  });
  sync.changed([{ id: "local" }]);
  await sync.flush();
  assert.equal(sync.blocked, true);
  assert.equal(sync.draft[0].id, "local");
  assert.equal(conflicts.length, 1);
  await sync.remote(2);
  await sync.flush();
  assert.equal(calls, 1);
  await sync.reload();
  assert.equal(sync.blocked, false);
  assert.equal(sync.draft, null);
  assert.equal(sync.revision, 2);
});
test("network errors block unsafe automatic retries but preserve draft", async () => {
  const { sync } = client(async () => {
    throw new Error("offline");
  });
  sync.changed([{ id: "local" }]);
  await assert.rejects(sync.flush(), /offline/);
  await sync.queue;
  assert.equal(sync.blocked, true);
  assert.equal(sync.draft.length, 1);
});
test("reconnect hello catches revisions missed while offline", async () => {
  const { sync, renders } = client(async () => state(4));
  await sync.remote(4);
  assert.equal(sync.revision, 4);
  assert.equal(renders.at(-1).scene, true);
  await sync.remote(2);
  assert.equal(sync.revision, 4);
  assert.equal(renders.length, 2);
});
test("scene replacement while local drawing starts is flagged rather than replayed", async () => {
  const gate = deferred(),
    started = deferred();
  const { sync } = client(async () => {
    started.resolve();
    return gate.promise;
  });
  const job = sync.mutate("/api/update", { clear: ["scene"] });
  await started.promise;
  sync.changed([{ id: "drawing" }]);
  gate.resolve(state(1));
  await job;
  clearTimeout(sync.timer);
  assert.equal(sync.blocked, true);
  assert.equal(sync.draft[0].id, "drawing");
});
