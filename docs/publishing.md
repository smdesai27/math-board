# Publishing

The steps I run to release math-board. There are two places to publish:

- **npm**, as `pi-math-board`. The pi package gallery reads npm: a package with the `pi-package` keyword is eligible for discovery there ([pi's packages.md](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md); the gallery is <https://pi.dev/packages>), and `npx -y pi-math-board` starts the MCP server from the same package.
- **The MCP registry**, as `io.github.smdesai27/math-board`. It only stores metadata (`server.json`) that points at the npm package, and it checks that the npm package's `package.json` has `"mcpName": "io.github.smdesai27/math-board"`. So npm always goes first.

Steps marked **(interactive)** need me at the keyboard or in a browser. Everything else can run unattended.

Checked against the registry docs on 2026-10-27: the [publishing quickstart](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/quickstart.mdx), [package types](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/package-types.mdx), [versioning](https://github.com/modelcontextprotocol/registry/blob/main/docs/modelcontextprotocol-io/versioning.mdx), the [CLI reference](https://github.com/modelcontextprotocol/registry/blob/main/docs/reference/cli/commands.md) and the `server.json` schema at <https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json>. The registry is still in preview, so these can change; read the quickstart again if a step fails.

## Once, before the first release

1. **(interactive)** Make the repository public: GitHub, Settings, General, Danger Zone, Change visibility. The registry entry, the npm page and the README's relative links all point at it.
2. Add the README screenshot at `docs/images/board.png`. Optionally add a gallery preview: pi reads `pi.image` and `pi.video` from `package.json` (not set yet).
3. **(interactive)** An npm account with two-factor authentication, and a GitHub login as `smdesai27` (the `io.github.smdesai27/` namespace comes from that login).
4. Install the registry's publisher CLI:

   ```sh
   brew install mcp-publisher
   mcp-publisher --help
   ```

   Without Homebrew, the quickstart has a `curl` line that downloads the release binary into `/usr/local/bin`.

## Every release

The version below is 0.3.0. For a later release, use the new number everywhere it appears.

1. Start clean and green:

   ```sh
   cd ~/math-board
   git switch main && git pull
   git status                      # nothing uncommitted
   npm ci
   npm run build                   # public/ is committed: commit it if this changed anything
   npm test && npm run test:browser && npm run test:load
   ```

2. Set the version in three places: `package.json` (with the lock file), and both `version` fields in `server.json`.

   ```sh
   npm version 0.3.0 --no-git-tag-version --allow-same-version   # package.json already says 0.3.0; later releases: npm version <new> --no-git-tag-version
   node -e 'const fs=require("fs"),s=JSON.parse(fs.readFileSync("server.json"));s.version=s.packages[0].version=process.argv[1];fs.writeFileSync("server.json",JSON.stringify(s,null,2)+"\n")' 0.3.0
   grep -n '"version"' package.json server.json   # all three say 0.3.0
   ```

   The registry rejects version ranges and never lets a version be published twice, so `server.json` must name the exact version that is on npm. Update the date on the `CHANGELOG.md` entry if it's not today.

3. Check the tarball:

   ```sh
   npm pack --dry-run
   ```

   It should report about 2,155 files, a package size of about 15 MB and about 55 MB unpacked (most of it the icon library), and no `.data/`, `test/`, `scripts/`, `build-meta.json` or `docs/publishing.md`.

4. Commit, tag and push:

   ```sh
   git commit -am "Release 0.3.0"
   git tag v0.3.0
   git push && git push --tags
   ```

5. **(interactive)** Log in to npm. It opens a browser, or asks for a username, password and one-time code.

   ```sh
   npm login
   npm whoami
   ```

6. **(interactive)** Publish. With two-factor authentication on, npm asks for a code or opens a browser.

   ```sh
   npm publish --access public
   ```

7. Check npm:

   ```sh
   npm view pi-math-board version mcpName bin
   # 0.3.0, io.github.smdesai27/math-board, { 'pi-math-board': 'mcp/server.mjs' }

   (printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'; sleep 3) \
     | MATH_BOARD_NO_BROWSER=1 npx -y pi-math-board@0.3.0
   # one JSON line with "serverInfo":{"name":"math-board","title":"Math board","version":"0.3.0"}
   ```

   Then in pi: `pi install npm:pi-math-board`, `/reload`, `/board`.

8. Check the pi gallery: <https://pi.dev/packages?name=pi-math-board>. The pi docs say only that the keyword makes the package eligible; they don't say how soon it shows up, so give it a while before worrying.

9. Validate `server.json` against the registry:

   ```sh
   mcp-publisher validate
   ```

10. **(interactive)** Log in to the registry with GitHub. It prints a code; open <https://github.com/login/device>, enter it, and authorize.

    ```sh
    mcp-publisher login github
    ```

11. Publish to the registry, from the repository root (it reads `./server.json`):

    ```sh
    mcp-publisher publish
    ```

    It should end with `✓ Server io.github.smdesai27/math-board version 0.3.0`.

12. Check the registry:

    ```sh
    curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.smdesai27/math-board"
    curl "https://registry.modelcontextprotocol.io/v0.1/servers/io.github.smdesai27%2Fmath-board/versions/latest"
    ```

## When something fails

- **"Registry validation failed for package"**: the npm package has no `mcpName`, or it doesn't match `server.json`'s `name`. `mcpName` is read from the published package, so fixing it means a new npm version.
- **"Invalid or expired Registry JWT token"**: run `mcp-publisher login github` again.
- **"You do not have permission to publish this server"**: the GitHub login isn't `smdesai27`, so it can't publish under `io.github.smdesai27/`.
- **A published version is wrong**: versions can't be changed or reused. Publish the next patch version to both npm and the registry. To flag a bad one: `mcp-publisher status --status deprecated --message "use 0.3.1" io.github.smdesai27/math-board 0.3.0`, and on npm `npm deprecate pi-math-board@0.3.0 "use 0.3.1"`.

## Later

The registry docs also describe publishing from GitHub Actions (`mcp-publisher login github-oidc`, no browser). I'm keeping releases manual for now: they're rare, and I want to look at each one before it goes out.
