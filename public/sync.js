/**
 * Browser side of the board's sync. The page never draws: it shows the server's state, follows
 * revision events, and sends the only writes the page has (the Clear and Save buttons) with the
 * revision the learner is looking at. A 409 means the board moved on in the meantime: the current
 * board is shown, and the caller asks the learner again.
 */
export class BoardSync {
  constructor({ request, render, status }) {
    Object.assign(this, { request, render, status });
    this.revision = -1; // revision on screen
    this.board = null;
    this.remoteRevision = -1; // newest revision the server has announced
    this.queue = Promise.resolve();
  }
  /** Run jobs one at a time, in order; a failed job does not stop later ones. */
  enqueue(fn) {
    const job = this.queue.then(fn);
    this.queue = job.catch(() => {});
    return job;
  }
  /** Show a state from the server. Older revisions are ignored unless `force` (a restarted server). */
  accept(data, force = false) {
    if (!force && data.revision < this.revision) return false;
    this.revision = data.revision;
    this.board = data.board;
    this.render(data);
    this.status(`Connected · revision ${this.revision}`);
    return true;
  }
  async read(force = false) {
    if (!force && this.remoteRevision <= this.revision) return;
    const data = await this.request("/api/state");
    if (!data.ok) throw new Error(data.error || "Cannot read the board");
    this.accept(data, force);
  }
  /** Read and show the current board. */
  refresh() {
    return this.enqueue(() => this.read(true));
  }
  /** The server announced `revision`: read the board if it is newer than the one on screen. */
  remote(revision) {
    this.remoteRevision = Math.max(this.remoteRevision, revision);
    return this.enqueue(() => this.read());
  }
  /**
   * First event after the event stream came back. The server may have restarted (same port and
   * token) with a different board and a lower revision, so show whatever it has now.
   */
  resync(revision) {
    this.remoteRevision = revision;
    return this.enqueue(() => this.read(true));
  }
  /**
   * POST a write based on the revision on screen. Resolves { ok: true, data } on success, or
   * { ok: false, conflict: true, revision } after a 409, once the current board is on screen.
   * Other failures reject with the server's message.
   */
  mutate(path, body) {
    return this.enqueue(async () => {
      const data = await this.request(path, { ...body, baseRevision: this.revision });
      if (data.ok) {
        if (data.board && Number.isSafeInteger(data.revision)) this.accept(data);
        return { ok: true, data };
      }
      if (data.status === 409) {
        if (data.board && Number.isSafeInteger(data.revision)) this.accept(data);
        else await this.read(true);
        return { ok: false, conflict: true, revision: this.revision };
      }
      throw new Error(data.error || "Request failed");
    });
  }
}

/**
 * Keeps the page's event stream open. When it drops, the page retries with a short backoff; after
 * `stoppedAfter` ms without a connection it reports the board server as stopped (the page then
 * says how to reopen it) but keeps retrying, so a server that comes back on the same port with the
 * same token reconnects the tab by itself. States: connecting, connected, reconnecting, stopped.
 */
export class LiveEvents {
  constructor({ open, onEvent, onState, stoppedAfter = 10000, backoff = [500, 1000, 2000, 4000, 5000] }) {
    Object.assign(this, { open, onEvent, onState, stoppedAfter, backoff });
    this.state = "connecting";
    this.source = null;
    this.failures = 0;
    this.outage = false; // the stream failed since the last successful open
    this.fresh = false; // the next event is the first one after an outage
    this.retryTimer = 0;
    this.stopTimer = 0;
    this.closed = false;
  }
  start() {
    this.connect();
    return this;
  }
  set(state) {
    if (state === this.state) return;
    this.state = state;
    this.onState(state);
  }
  connect() {
    if (this.closed) return;
    let source;
    try {
      source = this.open();
    } catch {
      return this.failed(null);
    }
    this.source = source;
    source.onopen = () => {
      if (source !== this.source) return;
      clearTimeout(this.stopTimer);
      this.stopTimer = 0;
      this.failures = 0;
      this.fresh = this.outage;
      this.outage = false;
      this.set("connected");
    };
    source.onmessage = (e) => {
      if (source !== this.source) return;
      let data;
      try {
        data = JSON.parse(e.data);
      } catch {
        return;
      }
      const resync = this.fresh;
      this.fresh = false;
      this.onEvent(data, { resync });
    };
    // Retry on our own schedule: the browser gives up for good on an HTTP error (a new server on
    // this port with another token answers 401), and its own retries never report a long outage.
    source.onerror = () => {
      if (source === this.source) this.failed(source);
    };
  }
  failed(source) {
    source?.close();
    this.source = null;
    this.outage = true;
    if (this.closed) return;
    if (this.state !== "stopped") this.set("reconnecting");
    if (!this.stopTimer && this.state !== "stopped")
      this.stopTimer = setTimeout(() => {
        this.stopTimer = 0;
        this.set("stopped");
      }, this.stoppedAfter);
    const wait = this.backoff[Math.min(this.failures++, this.backoff.length - 1)];
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = 0;
      this.connect();
    }, wait);
  }
  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearTimeout(this.stopTimer);
    this.source?.close();
    this.source = null;
  }
}
