# syntax=docker/dockerfile:1

###############################################################################
# Bottega container image — FULL mode (built React UI + REST/WS API, one process)
#
# Two stages:
#   builder  installs deps (compiling the native addons), then produces the
#            Vite production bundle (dist/). Tests are NOT run here — CI gates
#            that separately (see the NOTE above the vite build below).
#   runtime  ships source + node_modules + dist and launches
#            `tsx server/index.ts` directly. HEADLESS is left unset, so the
#            single Node process serves the built SPA *and* the REST/WS API
#            from one port (default 3001) — the production deployment shape.
###############################################################################

# Track the Node 22 LTS line (matches .nvmrc). Debian (trixie), NOT Alpine,
# because the native modules (better-sqlite3, node-pty, bcrypt, sharp, sqlite3)
# build against glibc — musl would force slow, fragile source rebuilds, and the
# .node files compiled here must stay ABI-compatible when copied into runtime.
ARG NODE_VERSION=22.23

# ---------------------------------------------------------------------------
# Stage 1 — builder: install, test, build the client bundle
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS builder
WORKDIR /app

# node-gyp toolchain for the native addons + git (some tests shell out to git
# for worktree/repo operations). The slim base omits build-essential (ubuntu CI
# runners ship it preinstalled, which is why this is only needed here).
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 make g++ git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Corepack provisions the exact pnpm pinned in package.json#packageManager.
RUN corepack enable

# Install deps first so this layer caches until the manifest/lockfile changes.
# pnpm-workspace.yaml is part of the install contract here — it carries the
# `allowBuilds` approvals that let the native modules run their build scripts.
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

# Application source (node_modules / dist excluded via .dockerignore so the
# host's copies never clobber what we just compiled for this image).
COPY . .

# NOTE: the image build does NOT run the test suite. CI runs the unit suite as a
# separate gating job (deploy needs it) before this image is built or pushed, so
# a red suite still blocks a deploy. If you build this image OUTSIDE CI, run
# `pnpm test:run` yourself first — the build won't catch a broken suite.

# Production client bundle -> dist/, served by the Node process at runtime.
RUN pnpm exec vite build

# ---------------------------------------------------------------------------
# Stage 2 — runtime: source + deps + built client, no toolchain
# ---------------------------------------------------------------------------
FROM node:${NODE_VERSION}-trixie-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3001 \
    DATABASE_PATH=/data/bottega.db

# Runtime system tooling the app spawns as subprocesses: git + GitHub CLI (gh)
# for repo / worktree / PR operations, and the Claude Code + Codex CLIs that the
# agent SDKs drive. Installed here (not the builder, which is discarded) and
# BEFORE the app COPY so this rarely-changing layer stays cached across source
# changes. gh comes from GitHub's official apt repo (binary keyring, signed-by).
RUN apt-get update \
 && apt-get install -y --no-install-recommends git curl ca-certificates \
 && install -m 0755 -d /etc/apt/keyrings \
 && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
 && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      > /etc/apt/sources.list.d/github-cli.list \
 && apt-get update \
 && apt-get install -y --no-install-recommends gh \
 && rm -rf /var/lib/apt/lists/*

# Agent CLIs installed globally so `claude` and `codex` resolve on PATH (the app
# defaults CLAUDE_CLI_PATH to "claude"). Pin to exact versions here if you need
# byte-reproducible images.
RUN npm install -g @anthropic-ai/claude-code @openai/codex \
 && npm cache clean --force

# Carry over the whole built app: source, node_modules (incl. the compiled
# native addons — same glibc base, so they're ABI-compatible) and dist/.
# devDependencies are intentionally kept: the server runs via `tsx`, which is a
# devDependency, so there is no separate "production-only" prune to do.
COPY --from=builder --chown=node:node /app ./

# SQLite (DATABASE_PATH) lives on a volume so data survives container replacement.
RUN mkdir -p /data && chown -R node:node /data
VOLUME ["/data"]

USER node
EXPOSE 3001

# Public, unauthenticated liveness probe (server/index.ts registers /health
# before the auth middleware). Uses Node's global fetch — no extra tooling.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The client bundle was already built in the builder stage, so just launch the
# server. Invoke the tsx binary directly so the runtime needs neither pnpm nor
# corepack. Serves SPA + API (HEADLESS unset); set HEADLESS=1 for API-only.
CMD ["node_modules/.bin/tsx", "server/index.ts"]
