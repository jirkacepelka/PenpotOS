# syntax=docker/dockerfile:1
FROM mcr.microsoft.com/playwright:v1.63.0-noble
WORKDIR /app
ENV NODE_ENV=production
# Install only this service's dependencies (npm workspaces need every workspace manifest).
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY services/core/package.json services/core/
COPY services/mcp/package.json services/mcp/
COPY services/discord/package.json services/discord/
RUN npm ci --omit=dev -w @penpotos/mcp && npm cache clean --force
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY services/mcp services/mcp
COPY vendor vendor
WORKDIR /app/services/mcp
# Browsers come with the Playwright base image.
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
USER pwuser
EXPOSE 4400
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD node -e "fetch('http://127.0.0.1:4400/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "--import", "tsx", "src/index.ts"]
