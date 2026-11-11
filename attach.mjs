/**
 * One board per data folder, shared by every agent session on it.
 *
 * The first session that needs the board hosts it: a BoardServer in its own process, as before.
 * A session that finds a live host joins it instead of starting a second board: its model's tool
 * calls run in the host (POST /api/tool), so every session draws on, reads and saves the same
 * board. When the host goes away, the next call from a joined session finds no host and becomes
 * one; the board comes back from its autosave on the same port with the same token (session.json),
 * so an open tab reconnects by itself.
 *
 * BoardLink is what the adapters (index.ts, mcp/server.mjs, serve.mjs) hold. Like server.mjs and
 * tools.mjs it forwards its cache-busting query to its siblings (see index.ts).
 */

import { copyFile, mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";

const VERSION_QUERY = new URL(import.meta.url).search;
const sibling = (file) => new URL(`./${file}${VERSION_QUERY}`, import.meta.url).href;
const { BoardServer, readSession, dataDirOverride } = await import(sibling("server.mjs"));
const { handlers } = await import(sibling("tools.mjs"));

/** Tools that read no board: they never start or join one (once joined, the host answers, as it knows whether html is on). */
const BOARDLESS = new Set(["board_docs", "board_library"]);

/** A request to the host failed before an answer came: the host is gone (or going). */
const unreachable = (err) => err?.name !== "AbortError" && (err?.name === "TypeError" || /fetch failed|ECONNREFUSED|ECONNRESET|socket hang up|terminated/i.test(String(err?.message)));

/**
 * Before the board was shared, the MCP server kept its own in <dataDir>/mcp. Bring that along
 * once: its saves as mcp-<name> (never over an existing save), and its autosave when this folder
 * has none. Nothing in mcp/ is changed.
 */
export async function adoptMcpFolder(dataDir) {
  const old = path.join(dataDir, "mcp");
  const missing = (file) => stat(file).then(() => false, () => true);
  try {
    if (!(await missing(path.join(old, "autosave.json"))) && (await missing(path.join(dataDir, "autosave.json"))))
      await copyFile(path.join(old, "autosave.json"), path.join(dataDir, "autosave.json"));
    const names = (await readdir(path.join(old, "saves"))).filter((f) => f.endsWith(".json") && !f.startsWith("."));
    if (!names.length) return;
    await mkdir(path.join(dataDir, "saves"), { recursive: true, mode: 0o700 });
    for (const f of names) {
      const to = path.join(dataDir, "saves", `mcp-${f}`.slice(0, 69));
      if (await missing(to)) await copyFile(path.join(old, "saves", f), to);
    }
  } catch {
    // No old folder, or one that cannot be read: nothing to bring along.
  }
}

export class BoardLink {
  /**
   * `context`: { staleWarning(), openHint } for the tools that run in this process (see tools.mjs).
   * `title`: of a board this session starts empty.
   */
  constructor({ dataDir, title, context }) {
    Object.assign(this, { dataDir: path.resolve(dataDir), title, context });
    this.local = null; // the BoardServer this session hosts
    this.remote = null; // { port, token, pid } of the session that hosts it
    this.connecting = null;
  }

  /** True once this session hosts the board or has joined one. */
  get active() {
    return Boolean(this.local?.server || this.remote);
  }
  get hosting() {
    return Boolean(this.local?.server);
  }
  get port() {
    return this.local?.port ?? this.remote?.port ?? null;
  }
  get url() {
    return this.local?.url ?? (this.remote ? `http://127.0.0.1:${this.remote.port}/#token=${this.remote.token}` : null);
  }

  /** Host the board, or join the session that does. */
  ensure() {
    if (this.hosting || this.remote) return Promise.resolve(this);
    this.connecting ??= this.connect(true).finally(() => (this.connecting = null));
    return this.connecting;
  }

  /** Join a board another session hosts, without ever starting one. False when there is none. */
  async find() {
    if (this.active) return true;
    if (this.connecting) await this.connecting.catch(() => {});
    else await this.connect(false);
    return this.active;
  }

  async connect(host) {
    for (let tries = 0; tries < 4; tries++) {
      const s = new BoardServer({ dataDir: this.dataDir, title: this.title, exclusive: true });
      const owner = await s.liveOwner();
      if (!owner && !host) return this;
      try {
        if (owner) throw Object.assign(new Error("hosted"), { hosted: owner });
        if (!dataDirOverride()) await adoptMcpFolder(this.dataDir);
        await s.start();
      } catch (err) {
        if (!err?.hosted) throw err;
        const { token } = readSession(this.dataDir);
        if (!token) continue; // the host is between taking the lock and writing its session
        this.remote = { port: err.hosted.port, pid: err.hosted.pid, token };
        return this;
      }
      // For a joined session a tool that throws is an error result (the reason is the message).
      s.tools = (name, params, extra) => this.run(s, name, params, extra).catch((err) => ({ content: [{ type: "text", text: String(err?.message ?? err) }], isError: true }));
      this.local = s;
      return this;
    }
    throw new Error(`the board in ${this.dataDir} is held by another session that does not answer; try again in a moment`);
  }

  /** Run a model tool on the board this session hosts (it throws what the handler throws). */
  async run(s, name, params, { signal, openHint } = {}) {
    if (!Object.hasOwn(handlers, name)) throw new Error(`no such tool here: ${String(name).slice(0, 64)}`);
    return handlers[name]({ ...this.context, ...(openHint && { openHint }), server: async () => s, signal }, params);
  }

  async request(pathname, body, signal) {
    const { port, token } = this.remote;
    const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined && { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal,
    });
    const data = await res.json();
    if (!data.ok) throw Object.assign(new Error(data.error ?? `the board answered ${res.status}`), { conflict: res.status === 409 ? { currentRevision: data.revision } : undefined });
    return data;
  }

  /**
   * `local(server)` when this session hosts, `remote()` when it joined. A host that is gone is
   * replaced (this session hosts, or joins whoever got there first) and the call runs once more:
   * a board_update that did reach the old host is then refused by its baseRevision, not doubled.
   */
  async on(local, remote) {
    for (let again = false; ; again = true) {
      await this.ensure();
      if (this.hosting) return local(this.local);
      try {
        return await remote();
      } catch (err) {
        if (again || !unreachable(err)) throw err;
        this.remote = null;
      }
    }
  }

  /** A model tool call: { content, isError? } (and `details` when it ran in this process). */
  call(name, params, signal) {
    if (BOARDLESS.has(name) && !this.remote) return this.run(this.local, name, params, { signal });
    return this.on(
      (s) => this.run(s, name, params, { signal }),
      async () => (await this.request("/api/tool", { name, params, openHint: this.context?.openHint }, signal)).result,
    );
  }

  /** See BoardServer#status. `warm` also starts the headless browser, so the first layout check is quick. */
  status({ warm = false } = {}) {
    return this.on((s) => (warm && s.snapshots.warm(), s.status()), () => this.request(`/api/status${warm ? "?warm=1" : ""}`));
  }
  async state() {
    return this.on((s) => ({ revision: s.revision, board: s.getState() }), async () => { const d = await this.request("/api/state"); return { revision: d.revision, board: d.board }; });
  }
  /** Clear with compare-and-swap on the revision seen now; returns the new revision. */
  async clear(scopes = ["all"]) {
    return this.on((s) => s.clear(scopes), async () => (await this.request("/api/clear", { baseRevision: (await this.request("/api/status")).revision, scopes })).revision);
  }
  async save(name = "default") {
    return this.on((s) => s.save(name), async () => (await this.request("/api/save", { name })).saved);
  }
  /** Save the board under its title and date, then clear it: { saved: name | null, revision }. */
  async fresh() {
    return this.on((s) => s.fresh(), async () => this.request("/api/new", { baseRevision: (await this.request("/api/status")).revision }));
  }
  /** Load a named save over the board as it is now: { revision, skipped }. */
  async load(name = "default") {
    return this.on((s) => s.load(name, s.revision), async () => this.request("/api/load", { name, baseRevision: (await this.request("/api/status")).revision }));
  }
  /** PNG of a board region, as board_snapshot renders it. */
  async capture({ region, width }) {
    return this.on(async (s) => (await s.snapshots.capture({ region, width })).png, async () => Buffer.from((await this.request("/api/snapshot", { region, width })).png, "base64"));
  }

  /** Stop the board if this session hosts it. Returns false when another session does. */
  async stop() {
    const s = this.local;
    const joined = Boolean(this.remote);
    this.local = this.remote = null;
    if (s) await s.stop();
    return !joined;
  }
}
