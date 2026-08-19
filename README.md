# Instagram MCP

Local TypeScript MCP server for the official Instagram API: approved publishing, owned-comment management, and analytics for allowlisted Professional accounts.

## Safety boundary

No likes, saves, shares, follows/unfollows, follower identity access, Highlights, scraping, private APIs, or browser automation are implemented. Every write requires `confirm: true`; publishing also requires `publish_intent: "public"` and an idempotency key.

## Configure

```sh
cp .env.example .env
# Export the values through your preferred secret manager; do not commit .env.
npm run build
```

Set `INSTAGRAM_ACCOUNT_IDS` and `INSTAGRAM_ACCESS_TOKEN`. The token is never exposed through an MCP tool or included in error messages. Use `npm start` for the stdio server.

## Tools

`instagram_get_analytics`, `instagram_list_media`, `instagram_list_comments`, `instagram_get_publish_status`, `instagram_publish_post`, `instagram_reply_to_comment`, and `instagram_moderate_comment`.

Publishing follows Meta's create-container, poll-status, publish sequence. The server retries transient reads only; it never automatically repeats writes after an uncertain outcome.
