# Contributing

Issues and pull requests are welcome. It has a narrow focus, so I may say no to things that pull it somewhere else, but I'd rather hear the idea than not.

- **Run the suites before you open a PR.** `npm test`, `npm run test:browser` and `npm run test:load` (see [Build and tests](README.md#build-and-tests)). CI runs the same three.
- **Tests before features.** Write the test that fails first, then the change. A bug fix comes with the test that would have caught it.
- **Keep Eero's conventions.** This board sits next to Eero Alvar's [learn](https://github.com/amosblomqvist/learn) setup and never modifies it. It's a separate extension, it follows the same one-concept-at-a-time, question-based rhythm, and anything new is added beside his tools, not patched into them.
- **Keep the safety rules.** The page stays view-only. The server stays on loopback with the token, Host and Origin checks. Model input stays data, never code: no `eval`, no `innerHTML`, SVG through the allowlist and `<image>`, KaTeX with `trust: false`, Mermaid strict. Export stays manual. Nothing goes to the network. If a change needs to bend one of these, say so in the PR and why. [SECURITY.md](SECURITY.md) has the full list.
- **One implementation.** Tool schemas, descriptions and handlers live in `tools.mjs`. `index.ts` (pi) and `mcp/server.mjs` (MCP) stay thin adapters, and the tests check that both sides send the model the same thing.

The reasons behind most of this are in [docs/design.md](docs/design.md).
