# @titon/automaton — production container image.
#
# Two-stage build:
#   1. node:22-alpine — tooling (pnpm + tsc) to build automaton's TS
#      sources AND the sibling SDKs (kronos-sdk, forgeton-sdk) which
#      are consumed via pnpm `file:` deps.
#   2. gcr.io/distroless/nodejs22-debian12 — minimal runtime (no shell,
#      no package manager, non-root by default). Smaller attack
#      surface; ~90 MB vs ~180 MB for alpine.
#
# Build context: MUST be the parent directory (..) so the sibling
# `kronos/sdks/typescript/` and `forgeton/sdks/typescript/` trees are visible.
#
#   docker buildx build \
#     --platform linux/amd64,linux/arm64 \
#     --tag titon/automaton:0.1.0 \
#     --tag titon/automaton:latest \
#     -f automaton/Dockerfile \
#     .
#
# Runtime:
#   Expects /home/nonroot/.titon to be a writable volume with an
#   already-initialised config + keystore (produced via
#   `automaton init` in a separate, interactive container). The daemon
#   will not prompt for a password — set AUTOMATON_PASSWORD in the env
#   (Docker secret or systemd credential).

# -----------------------------------------------------------------------------
# Stage 1 — builder
# -----------------------------------------------------------------------------
FROM node:22-alpine AS builder

# pnpm via corepack — matches the host tooling discipline (no npm-global
# install of pnpm in the image, no version drift).
RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /src

# Copy sibling SDK sources first. Order matters because automaton's
# pnpm install will resolve file: deps against whatever's on disk at
# that moment, AND because fortuna/sdks/typescript's devDeps file: forgeton +
# atlas — those must be built (dist/ populated) before fortuna's
# install runs.
COPY forgeton/sdks/typescript    ./forgeton/sdks/typescript
COPY atlas/sdks/typescript       ./atlas/sdks/typescript
COPY kronos/sdks/typescript      ./kronos/sdks/typescript
COPY fortuna/sdks/typescript     ./fortuna/sdks/typescript

# Build the SDKs so their dist/ is populated before automaton's install
# snapshots them. Order = the dependency graph: forgeton has no titon
# deps, atlas + kronos peer-dep on forgeton (resolved at automaton
# install-time, not here), fortuna devDeps file: forgeton + atlas so
# both must be built first.
#
# CRITICAL: strip each SDK's node_modules after the build. Leaving
# kronos/sdks/typescript/node_modules on disk causes pnpm to snapshot a second copy
# of @ton/core (the SDK's devDep resolution) alongside automaton's own
# prod copy. Two @ton/core instances in the final node_modules means
# `Address instanceof` checks fail across SDK boundaries — the exact
# hazard the host-side preflight (tests/preflight.ts) guards against.
# The SDK's artifacts/ and dist/ (what automaton actually consumes)
# survive the rm.
RUN cd forgeton/sdks/typescript && pnpm install --prefer-offline --ignore-scripts && pnpm run build && rm -rf node_modules
RUN cd atlas/sdks/typescript    && pnpm install --prefer-offline --ignore-scripts && pnpm run build && rm -rf node_modules
RUN cd kronos/sdks/typescript   && pnpm install --prefer-offline --ignore-scripts && pnpm run build && rm -rf node_modules
RUN cd fortuna/sdks/typescript  && pnpm install --prefer-offline --ignore-scripts && pnpm run build && rm -rf node_modules

# Now the automaton source.
COPY automaton/package.json automaton/pnpm-lock.yaml automaton/tsconfig.json ./automaton/
COPY automaton/src      ./automaton/src
COPY automaton/contrib  ./automaton/contrib

WORKDIR /src/automaton
RUN pnpm install --prefer-offline --frozen-lockfile --ignore-scripts
RUN pnpm run build
RUN chmod +x dist/cli/index.js

# Prune dev-deps so stage 2 only carries prod runtime.
RUN pnpm prune --prod --ignore-scripts

# Belt-and-suspenders: exactly one @ton/core must exist in the final
# tree. Fails the build loudly if a duplicate slipped in despite the
# node_modules-strip above.
RUN test "$(find node_modules -type d -path '*/@ton/core' | wc -l)" = "1" \
    || (echo 'FAIL: duplicate @ton/core in runtime node_modules' >&2; \
        find node_modules -type d -path '*/@ton/core' >&2; exit 1)

# -----------------------------------------------------------------------------
# Stage 2 — runtime
# -----------------------------------------------------------------------------
FROM gcr.io/distroless/nodejs22-debian12:nonroot

WORKDIR /app

# `nonroot` user is UID 65532 in the distroless image; stick to its
# home dir so TITON_HOME defaults land on a writable volume.
ENV TITON_HOME=/home/nonroot/.titon
ENV NODE_ENV=production

COPY --from=builder --chown=nonroot:nonroot /src/automaton/dist         ./dist
COPY --from=builder --chown=nonroot:nonroot /src/automaton/node_modules ./node_modules
COPY --from=builder --chown=nonroot:nonroot /src/automaton/contrib      ./contrib
COPY --from=builder --chown=nonroot:nonroot /src/automaton/package.json ./package.json

# Metrics + health port (default — override via config.metricsPort).
EXPOSE 9090

USER nonroot

ENTRYPOINT ["/nodejs/bin/node", "/app/dist/cli/index.js"]
CMD ["run"]
