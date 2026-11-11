/**
 * `pi-math-board serve`: host the board with no agent attached, until Ctrl-C. Agent sessions
 * (pi, MCP clients) on the same data folder then join this board instead of starting their own,
 * so it outlives each of them. If a session already hosts the board, this prints where and exits.
 */
import { defaultDataDir } from "./server.mjs";
import { staleFiles } from "./tools.mjs";
import { BoardLink } from "./attach.mjs";

export async function serve() {
  const staleWarning = () => {
    const stale = staleFiles().filter((f) => f !== "index.ts");
    return stale.length ? `WARNING: ${stale.join(", ")} changed on disk after the board server started. Ask the user to restart it (pi-math-board serve); new features may be missing.` : "";
  };
  const link = new BoardLink({ dataDir: defaultDataDir(), context: { staleWarning, openHint: "board_open" } });
  await link.ensure();
  if (!link.hosting) {
    console.log(`The board is already running on 127.0.0.1:${link.port} (process ${link.remote.pid}).\n${link.url}`);
    process.exit(0);
  }
  console.log(`Board: ${link.url}\n  data folder: ${link.dataDir}\n  Ctrl-C stops it.`);
  let stopping = false;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"])
    process.once(signal, async () => {
      if (stopping) return;
      stopping = true;
      setTimeout(() => process.exit(1), 5000).unref(); // never hang on a stuck browser
      await link.stop().catch(() => {});
      process.exit(0);
    });
  return new Promise(() => {});
}
