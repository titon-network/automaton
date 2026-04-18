---
description: Run the sibling-SDK preflight check and report findings.
---

Run `pnpm run preflight`. This invokes `scripts/preflight.mjs` which checks:

1. `node_modules/forgeton-sdk/dist/index.js` exists (sibling SDK was built before snapshot).
2. `node_modules/kronos-sdk/dist/index.js` exists (same).
3. `../forgeton/sdk/node_modules/` does NOT exist (a nested install duplicates `@ton/core`).
4. `../kronos/sdk/node_modules/` does NOT exist (same).

If the repo isn't inside the titon monorepo (no sibling directories), it exits 0 silently — the hazards are dev-only.

Report the outcome in one line. If any issue fires, the script's own message already includes the fix (usually `pnpm run sync:sdks` or `rm -rf ../<sdk>/sdk/node_modules`). Relay that fix to the user; don't run destructive commands unprompted.
