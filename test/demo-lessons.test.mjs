/**
 * The demo lessons (scripts/demo-lessons-data.mjs) are realistic tutor input: every step must pass
 * the server's validation unchanged, and the fields the renderer relies on must survive it.
 * Layout warnings for these lessons are checked in the browser (test/browser/visual.spec.mjs).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BoardServer, sanitizeArtifact } from "../server.mjs";
import { LESSONS } from "../scripts/demo-lessons-data.mjs";

test("every demo lesson step is accepted as given, one lesson step per update", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "board-demo-"));
  try {
    const server = new BoardServer({ dataDir, autosave: false });
    const expected = { physics: ["fbd", "deriv"], mri: ["signal", "kspace", "fourier"], chem: ["asa", "heart"], cs: ["search", "states"], history: ["timeline", "press", "argument"] };
    assert.deepEqual(LESSONS.map((l) => l.slug), Object.keys(expected));
    for (const lesson of LESSONS) {
      server.update({ baseRevision: server.revision, clear: ["all"] });
      for (const [i, step] of lesson.steps.entries()) {
        server.update({ baseRevision: server.revision, ...step });
        assert.equal(server.getState().lastStep, i + 1, `${lesson.slug} step ${i + 1}`);
      }
      const board = server.getState();
      assert.equal(board.title, lesson.title);
      // Every shape, artifact and equation the steps add is on the board (strict validation
      // rejects instead of dropping, but a deleted or replaced item would show here too).
      const given = lesson.steps.flatMap((step) => [...(step.scene?.shapes ?? []), ...(step.scene?.artifacts ?? []), ...(step.equations ?? []).filter((e) => e.op === "add")]);
      const ids = new Set([...board.equations, ...board.scene.shapes, ...board.scene.artifacts].map((it) => it.id));
      assert.equal(ids.size, given.length, `${lesson.slug}: ${given.length} items given`);
      for (const it of given) if (it.id) assert.ok(ids.has(it.id), `${lesson.slug}: ${it.id} survived`);
      assert.deepEqual(board.chapters.map((c) => c.id), expected[lesson.slug]);
      const items = [...board.equations, ...board.scene.shapes, ...board.scene.artifacts];
      assert.ok(items.every((it) => it.chapter), `${lesson.slug}: every item belongs to a chapter`);
      // Chapters are placed left to right without overlapping (the overview depends on it).
      for (let i = 1; i < board.chapters.length; i++) assert.ok(board.chapters[i].x >= board.chapters[i - 1].x + board.chapters[i - 1].w);
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("plot marker labels and axis labels survive validation (the renderer draws them)", () => {
  const plot = sanitizeArtifact({
    type: "plot", x: 0, y: 0, width: 400, height: 300, functions: [{ expr: "sin(x)" }],
    vlines: [{ x: 1, label: "x = 1" }], hlines: [{ y: 0.5, label: "half", color: "#f2c14e" }], xLabel: "t (s)", yLabel: "S(t)",
  });
  assert.equal(plot.vlines[0].label, "x = 1");
  assert.deepEqual(plot.hlines[0], { y: 0.5, label: "half", color: "#f2c14e" });
  assert.equal(plot.xLabel, "t (s)");
  assert.equal(plot.yLabel, "S(t)");
});
