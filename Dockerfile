# Kerf in one container: the web app and the optional Kerf server.
# Build:  docker build -t kerf .
# Run:    see server/README.md. Data lives in /data; mount a volume there.

FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
# the desktop app's Electron download is not needed to build the web app and server
ENV ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:server

FROM node:22-slim
ENV NODE_ENV=production \
    PORT=8080 \
    KERF_DATA_DIR=/data \
    KERF_STATIC_DIR=/app/dist
WORKDIR /app
# the server is bundled, so the image needs no node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server/dist ./server/dist
COPY deploy/entrypoint.sh /usr/local/bin/kerf-entrypoint
COPY deploy/kerf-admin /usr/local/bin/kerf-admin
RUN chmod 755 /usr/local/bin/kerf-entrypoint /usr/local/bin/kerf-admin && mkdir -p /data && chown node:node /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 8080) + '/api/health').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
ENTRYPOINT ["kerf-entrypoint"]
CMD ["node", "server/dist/index.js"]
