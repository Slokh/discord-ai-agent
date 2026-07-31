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

FROM rust:1.97-trixie AS nanocodex-build
WORKDIR /build
COPY native/nanocodex-runtime /discord-agent-nanocodex-runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends build-essential cmake git libssl-dev pkg-config \
  && rm -rf /var/lib/apt/lists/*
RUN cargo build --locked --release --manifest-path /discord-agent-nanocodex-runtime/Cargo.toml \
  && cp /discord-agent-nanocodex-runtime/target/release/discord-agent-nanocodex-runtime /discord-agent-nanocodex-runtime-bin

FROM node:22-trixie-slim AS runtime-base
WORKDIR /app
ENV NODE_ENV=production
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && mkdir -p /var/cache/discord-ai-agent \
  && chown -R node:node /app /var/cache/discord-ai-agent

FROM runtime-base AS runtime
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev \
  && rm -f package-lock.json
COPY --chown=node:node --from=build /app/dist ./dist
COPY --from=nanocodex-build /discord-agent-nanocodex-runtime-bin /usr/local/bin/discord-agent-nanocodex-runtime
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
RUN test -x /usr/local/bin/discord-agent-nanocodex-runtime
USER node

FROM runtime AS final
USER root
RUN rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx
USER node
