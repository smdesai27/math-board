# Connect an agent to Math Board

Math Board is a local teaching window. The Mac app displays the board; your agent runs its companion MCP server. Installing the window alone does not give an agent tools. No account or API key is needed for the board.

## For the person installing it

1. Download **Math-Board-macOS-universal.zip** from [the latest release](https://github.com/smdesai27/math-board/releases/latest).
2. Unzip and move **Math Board.app** to **Applications** (or `~/Applications`). Requires macOS 12 or later; supports Apple Silicon and Intel.
3. Open it. Choose **Help → Copy Agent Setup Prompt** and paste into your local agent. Or paste this:

> Connect yourself to Math Board on this Mac. Read https://github.com/smdesai27/math-board/blob/main/docs/agent-setup.md and follow its setup instructions for your client. Preserve my existing MCP configuration and boards. Then call board_open and board_read to verify the connection without clearing my board.

The download is ad-hoc signed, **not Apple-notarized**. If macOS blocks it, follow [Apple's instructions](https://support.apple.com/102445): after attempting to open the app, use **System Settings → Privacy & Security → Open Anyway** if you trust this project. Do not disable Gatekeeper. Managed Macs may require an administrator. You can also build from source with `npm run build:app -- --install` and Xcode Command Line Tools.

## For the agent doing the setup

These instructions are for an agent running on the **same Mac** as the app, with a client that supports **local stdio MCP servers**. A cloud-only chat or remote agent cannot reach this Mac's loopback server through this setup. Explain that limitation instead of opening a public port.

### 1. Inspect first

Find any existing `math-board` MCP entry or pi extension. Preserve its installation and data folder when it already works; do not silently replace it or start a separate board. Check `node --version` and `npm --version`. The server needs **Node 22.19 or later**. If missing, help install a supported Node release using the person's existing package manager or [nodejs.org](https://nodejs.org/). The app itself needs neither Node nor a compiler.

### 2. Install the companion server

For a new installation, use the versioned package on GitHub Releases (no unpublished npm package or source compilation required):

```sh
mkdir -p "$HOME/.local/share/math-board"
npm install --prefix "$HOME/.local/share/math-board" --omit=dev --omit=peer \
  https://github.com/smdesai27/math-board/releases/download/v0.4.0/pi-math-board-0.4.0.tgz
```

The entry point is now:

```text
/absolute/home/.local/share/math-board/node_modules/pi-math-board/mcp/server.mjs
```

Resolve the person's actual home and Node executable (`command -v node`). Do not put literal `~`, `$HOME`, or `/absolute/home` into JSON; most MCP clients do not expand them. Do not move the installed server after registering it.

### 3. Register it in this client

Use the client's supported MCP registration command or edit only its `math-board` entry, preserving other servers. Consult that client's current documentation rather than guessing a config path. The stdio definition is:

```json
{
  "mcpServers": {
    "math-board": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/home/.local/share/math-board/node_modules/pi-math-board/mcp/server.mjs"],
      "env": {
        "MATH_BOARD_DATA_DIR": "/absolute/home/Library/Application Support/math-board"
      }
    }
  }
}
```

All agents that share the board should use the **same** data folder. The app discovers this standard macOS folder automatically. If preserving an existing different folder, retain it; `board_open` tells the app where to connect. Never copy private tokens into chat, instructions, or version control.

For Claude Code, the equivalent is (replace `node` with its absolute path when registering for a GUI-launched client):

```sh
claude mcp add --scope user -e "MATH_BOARD_DATA_DIR=$HOME/Library/Application Support/math-board" \
  math-board -- node "$HOME/.local/share/math-board/node_modules/pi-math-board/mcp/server.mjs"
```

For **pi**, use the extension instead of an MCP entry:

```sh
pi install "$HOME/.local/share/math-board/node_modules/pi-math-board"
```

Use the same `MATH_BOARD_DATA_DIR` in pi's environment, then `/reload`. Avoid registering both adapters in the same client.

### 4. Verify without changing the lesson

Reload the client's MCP connections or restart the agent if required. Confirm `board_open`, `board_read`, `board_update`, `board_save`, `board_snapshot`, `board_library`, and `board_docs` are available. Call **board_open**, then **board_read**. Confirm Math Board.app displays the same board. Do not clear, replace, or add a test lesson to an existing board.

The layout check and screenshots require Chromium: system Chrome works, or install the pinned browser with:

```sh
npx -y playwright-core@1.64.1 install chromium
```

Call `board_snapshot` to verify rendering once a browser is available. If this client cannot reload its own tools mid-session, give the person the exact restart step and verify in the next session; do not claim tools are connected before testing them.

## Updating and removing

Quit the viewer before replacing it with a new release. Update the companion package in the same installation directory using the new release's `.tgz` URL, then restart the hosting agent so it loads the new server. Boards stay in `~/Library/Application Support/math-board`, separate from both app and package. Removing the app or its MCP entry should not remove that folder.
