FROM node:22-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json eslint.config.js vitest.config.ts vite.console.config.ts ./
COPY src ./src
COPY scripts ./scripts
COPY migrations ./migrations
COPY skills ./skills
RUN npm run build

FROM node:22-trixie-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/cache/discord-ai-agent \
  && chown -R node:node /app /var/cache/discord-ai-agent
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && rm -f package-lock.json
COPY --chown=node:node --from=build /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node skills ./skills
USER node
CMD ["node", "dist/src/index.js"]

FROM runtime AS codegen
USER root
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep \
  && mkdir -p -m 755 /etc/apt/keyrings \
  && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
  && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list \
  && apt-get update \
  && apt-get install -y --no-install-recommends gh \
  && rm -rf /var/lib/apt/lists/*
RUN npm install -g @openai/codex@0.142.4 opencode-ai@1.17.13 \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node

FROM runtime AS final
USER root
RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
