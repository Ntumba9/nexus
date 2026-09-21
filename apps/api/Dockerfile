# syntax=docker/dockerfile:1
# Build context is the repository root:  docker build -f apps/api/Dockerfile .
#
# Deliberately single-stage: the runtime image keeps the built workspace (including the Prisma CLI
# needed for migrations). Slimming to a pruned production image is a Phase 12 task.
FROM node:25-bookworm-slim

# pnpm is pinned by "packageManager" in package.json. Cache it at build time in a shared location
# so the unprivileged runtime user never needs network access to run `pnpm`.
ENV COREPACK_HOME=/opt/corepack
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && corepack enable \
    && corepack prepare pnpm@10.30.0 --activate

WORKDIR /repo
COPY . .
RUN pnpm install --frozen-lockfile --filter "@nexus/api..." \
    && pnpm --filter "@nexus/api..." build

# Set after install/build so pnpm still installs the devDependencies needed to build.
ENV NODE_ENV=production
USER node
CMD ["node", "apps/api/dist/main.js"]
