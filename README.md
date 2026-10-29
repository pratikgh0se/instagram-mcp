# Instagram MCP

**v1 in progress (1.0.0-rc.1).** A self-hosted MCP server for Instagram built only on Meta's official Instagram Platform API.

The v1 design is in `docs/superpowers/specs/2026-10-29-instagram-mcp-v1-design.md` and the behaviour contract in `docs/CONTRACT.md`. This branch currently ships the foundation (config, secrets, auth, Graph client, storage, approval ledger, transports, CLI) and the account/ops tools; the remaining tool domains are being added.

```sh
npm ci && npm run build
node dist/cli.js doctor
node dist/cli.js serve          # stdio MCP server
```

Full README, setup guide and tool reference come with the docs unit.
