# Instagram MCP

MCP server for Instagram: read your account insights, media and comments, publish posts and moderate comments through the official Instagram API (`graph.instagram.com`).

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![CI](https://github.com/pratikgh0se/instagram-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/pratikgh0se/instagram-mcp/actions/workflows/ci.yml)

It is a local TypeScript server that talks to an MCP client over stdio. It only acts on Instagram Professional account IDs that you list in `INSTAGRAM_ACCOUNT_IDS`.

## What it does

| Tool | Read/write | What it does |
| --- | --- | --- |
| `instagram_get_analytics` | read | Read account or media insights for the metrics you name. |
| `instagram_list_media` | read | List media owned by the authorized account. |
| `instagram_list_comments` | read | List comments on owned media. |
| `instagram_get_publish_status` | read | Read the status of an asynchronous media container. |
| `instagram_publish_post` | write | Publish an image, reel, carousel or story. Requires confirmation. |
| `instagram_reply_to_comment` | write | Reply publicly to a comment on owned media. Requires confirmation. |
| `instagram_moderate_comment` | write | Hide, unhide or delete a comment. Requires confirmation. |

Publishing follows Meta's create-container, poll-status, publish sequence. The server retries transient reads only. It does not automatically repeat a write after an uncertain outcome. Idempotency keys are remembered in memory only, so they are forgotten when the server restarts.

## Safety

- Every write tool requires `confirm: true`. `instagram_publish_post` also requires `publish_intent: "public"` and an `idempotency_key` of at least 16 characters.
- These flags are set by the client, which is your AI assistant. They are not a human approval step. Use an MCP client that asks you before it runs tools, and review write calls before you approve them.
- Only account IDs listed in `INSTAGRAM_ACCOUNT_IDS` are accepted.
- There are no like, save, share, follow, unfollow or direct message tools. The server does not scrape or use private APIs.
- The access token is not exposed through any tool or included in error messages.

## Requirements

- Node.js 22 or later.
- A Meta developer app with Instagram API access.
- An Instagram professional account (Business or Creator).
- An access token for that account with the permissions for the tools you use.

The code does not request permission scopes itself. It uses a token you supply, and Instagram returns a permission error (`MISSING_PERMISSION`) if the token lacks one. Based on Meta's documentation for the Instagram API with Instagram Login, the relevant permissions are `instagram_business_basic` (media), `instagram_business_manage_insights` (analytics), `instagram_business_manage_comments` (comments), and `instagram_business_content_publish` (publishing). Check Meta's current documentation before you generate a token.

## Setup

Environment variables (see `.env.example`):

- `INSTAGRAM_ACCOUNT_IDS` (required): comma-separated allowlist of Instagram professional account IDs.
- `INSTAGRAM_ACCESS_TOKEN` (required): access token for the account.
- `INSTAGRAM_API_VERSION` (optional): Graph API version, default `v25.0`.
- `INSTAGRAM_API_BASE_URL` (optional): default `https://graph.instagram.com`.

Supply them through your shell, secret manager or MCP client configuration. Do not commit a real token.

```sh
npm ci
npm run build
npm start   # stdio server, runs dist/index.js
```

## Install in Claude Desktop or Claude Code

Build first, then point your client at `dist/index.js` using an absolute path.

Claude Desktop (`claude_desktop_config.json`):

```json
{
  "mcpServers": {
    "instagram": {
      "command": "node",
      "args": ["/absolute/path/to/instagram-mcp/dist/index.js"],
      "env": {
        "INSTAGRAM_ACCOUNT_IDS": "your-account-id",
        "INSTAGRAM_ACCESS_TOKEN": "your-token"
      }
    }
  }
}
```

Claude Code:

```sh
claude mcp add instagram \
  --env INSTAGRAM_ACCOUNT_IDS=your-account-id \
  --env INSTAGRAM_ACCESS_TOKEN=your-token \
  -- node /absolute/path/to/instagram-mcp/dist/index.js
```

## Development

```sh
npm ci
npm test          # node test runner via tsx
npm run check     # type-check only
npm run build     # compile to dist/
npm run dev       # run from source with tsx
```

## License

[MIT](LICENSE)
