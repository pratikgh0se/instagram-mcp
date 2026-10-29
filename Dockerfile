# instagram-mcp daemon image.
#
# Build:  docker build -t instagram-mcp .
# Run:    docker run -d --name instagram-mcp \
#           -v instagram-mcp-data:/data \
#           --env-file /path/to/instagram-mcp.env \
#           -p 127.0.0.1:8765:8765 -p 127.0.0.1:8766:8766 instagram-mcp
#
# INSTAGRAM_MCP_MASTER_KEY (base64 of 32 bytes, `openssl rand -base64 32`) MUST be generated ONCE and supplied
# persistently (a 0600 --env-file, or a Docker/Compose secret exported into the env). Never generate it per
# `docker run`: the encrypted secrets file in /data can only be decrypted with the same key, and a key passed
# with `-e` is visible in `docker inspect`. The image never generates or bakes in any secret. It runs as the
# non-root `node` user.
#
# Default command: `instagram-mcp daemon --http` (scheduler, webhooks, snapshots, token refresh, MCP over Streamable HTTP).
# The MCP endpoint needs a bearer token and a non-loopback bind inside the container. Either set the env var
#   -e INSTAGRAM_MCP_HTTP_HOST=0.0.0.0   (not baked into the image: it only works together with http.allow_remote)
# or put "host": "0.0.0.0" in the config. Either way the config must also allow it (the server refuses otherwise).
# Put this in /data/config.json (mode 600, owned by the node user):
#   { "secrets": { "backend": "encrypted-file" },   // or "env" with INSTAGRAM_MCP_TOKEN_<ALIAS> etc.
#     "http": { "allow_remote": true, "allowed_hosts": ["localhost:8765"] },   // "host:port" entries match the Host header exactly
#     "media_host": { "bind": "0.0.0.0", "allow_remote": true },   // the media host listens on 127.0.0.1 by default,
#                                                                   // which is unreachable through Docker's port mapping
#     "accounts": [ ... ] }
# and publish ports on 127.0.0.1 only (as above). Do not expose 8765 publicly without TLS and an authenticating
# proxy; expose only the `/m/` route of 8766 through your tunnel.
# Secrets: INSTAGRAM_MCP_MASTER_KEY for the encrypted-file backend, or the env backend variables
# (INSTAGRAM_MCP_TOKEN_<ALIAS>, INSTAGRAM_MCP_APP_SECRET, INSTAGRAM_MCP_HTTP_TOKEN, INSTAGRAM_MCP_WEBHOOK_VERIFY_TOKEN).
# Add tokens with: docker exec -i instagram-mcp node dist/cli.js auth set-token --account main   (token on stdin)

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-slim
ENV NODE_ENV=production \
    INSTAGRAM_MCP_HOME=/data
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json LICENSE README.md ./
RUN mkdir -p /data && chown -R node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8765 8766
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["daemon", "--http"]
