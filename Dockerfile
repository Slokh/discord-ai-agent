FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json eslint.config.js vitest.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY skills ./skills
RUN npm run build

FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev && npm install -g @openai/codex@0.142.4
COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY skills ./skills
CMD ["node", "dist/src/index.js"]
