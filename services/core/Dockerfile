# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=production
# Install only this service's dependencies (npm workspaces need every workspace manifest).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/core/package.json services/core/
COPY services/mcp/package.json services/mcp/
COPY services/discord/package.json services/discord/
RUN npm ci --omit=dev -w @penpotos/core && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/core services/core
WORKDIR /app/services/core
USER node
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:8080/penpotos-health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
