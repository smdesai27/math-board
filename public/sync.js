/** Single-writer browser sync. Remote state never replaces an unsent local draft. */
export class BoardSync {
  constructor({ request, render, status, conflict, delay = 250 }) {
    Object.assign(this, { request, render, status, conflict, delay });
    this.revision = -1;
    this.board = null;
    this.draft = null;
    this.blocked = false;
    this.queue = Promise.resolve();
    this.remoteRevision = -1;
    this.timer = null;
    this.generation = 0;
  }
  enqueue(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch((error) => {
      this.block(error.message);
    });
    return job;
  }
  block(message) {
    this.blocked = true;
    this.status(message);
    this.conflict(message);
  }
  accept(data, installScene) {
    if (data.revision < this.revision) return;
    this.revision = data.revision;
    this.board = data.board;
    this.render(data, installScene);
    this.status(`Connected · revision ${this.revision}`);
  }
  changed(elements) {
    this.draft = structuredClone(elements);
    this.generation++;
    this.status(
      this.blocked
        ? "Local draft retained — resolve conflict"
        : "Unsaved changes…",
    );
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.flush().catch(() => {}), this.delay);
  }
  async send(path, body) {
    const data = await this.request(path, {
      ...body,
      baseRevision: this.revision,
    });
    if (!data.ok) {
      this.block(
        data.status === 409
          ? "Board changed elsewhere. Your local draft is retained; download it before reloading."
          : data.error || "Request failed",
      );
      return null;
    }
    return data;
  }
  async flushInside() {
    if (this.blocked || this.draft === null) return;
    const sent = this.draft;
    const generation = this.generation;
    const data = await this.send("/api/update", {
      scene: { mode: "replace", elements: sent, shapes: [] },
    });
    if (!data) return;
    if (generation === this.generation) this.draft = null;
    // Do NOT reinstall an acknowledged scene. Excalidraw owns local selection,
    // undo history and any edits made while this request was in flight.
    this.accept(data, false);
  }
  flush() {
    clearTimeout(this.timer);
    return this.enqueue(async () => {
      await this.flushInside();
      await this.refreshInside();
    });
  }
  mutate(path, body) {
    return this.enqueue(async () => {
      await this.flushInside();
      if (this.blocked) return false;
      const destructive =
        path === "/api/load" ||
        body.scene ||
        body.clear?.some((s) => s === "all" || s === "scene");
      if (destructive && this.draft !== null) {
        this.status("Finish drawing before replacing the scene");
        return false;
      }
      const generation = this.generation;
      const data = await this.send(path, body);
      if (!data) return false;
      // A user may draw while an equation/save-slot operation is in flight.
      if (this.generation !== generation && destructive) {
        this.block(
          "Board replaced while you were drawing. Download the local draft, then reload.",
        );
        return false;
      }
      if (data.board) this.accept(data, this.draft === null);
      await this.refreshInside();
      return true;
    });
  }
  async refreshInside(force = false) {
    if (
      !force &&
      (this.blocked ||
        this.draft !== null ||
        this.remoteRevision <= this.revision)
    )
      return;
    const generation = this.generation;
    const data = await this.request("/api/state");
    if (!data.ok) throw new Error(data.error || "Cannot read board");
    if (generation !== this.generation || this.draft !== null) return;
    this.accept(data, true);
  }
  refresh() {
    return this.enqueue(() => this.refreshInside(true));
  }
  remote(revision) {
    this.remoteRevision = Math.max(this.remoteRevision, revision);
    return this.enqueue(() => this.refreshInside());
  }
  reload() {
    return this.enqueue(async () => {
      clearTimeout(this.timer);
      this.draft = null;
      this.blocked = false;
      this.generation++;
      await this.refreshInside(true);
    });
  }
}
