# instagram-mcp daemon image.
#
# Build:  docker build -t instagram-mcp .
# Run:    docker run -d --name instagram-mcp \
#           -v instagram-mcp-data:/data \
#           -e INSTAGRAM_MCP_MASTER_KEY="$(openssl rand -base64 32)" \
#           -p 127.0.0.1:8765:8765 instagram-mcp
#
# Default command: `instagram-mcp daemon --http` (scheduler, webhooks, snapshots, token refresh, MCP over Streamable HTTP).
# The MCP endpoint needs a bearer token and a non-loopback bind inside the container. Put this in /data/config.json:
#   { "secrets": { "backend": "encrypted-file" },   // or "env" with INSTAGRAM_MCP_TOKEN_<ALIAS> etc.
#     "http": { "host": "0.0.0.0", "allow_remote": true, "allowed_hosts": ["localhost:8765"] },
#     "accounts": [ ... ] }
# and publish the port on 127.0.0.1 only (as above). Do not expose it publicly without TLS and an authenticating proxy.
# Secrets: INSTAGRAM_MCP_MASTER_KEY (base64 of 32 bytes) for the encrypted-file backend, or the env backend variables
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
