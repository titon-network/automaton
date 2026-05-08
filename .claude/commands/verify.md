---
description: Run the full verification gate (build + test + smoke) and summarise the result.
---

Run `pnpm run verify` from the repo root. This executes:

1. `pnpm run build` — `tsc -p tsconfig.json`
2. `pnpm run test` — `jest --runInBand` (with `tests/preflight.ts` globalSetup)
3. `pnpm run smoke` — `automaton --version && automaton doctor`

Report the outcome concisely:

- If everything passes: one-line confirmation + the check count from `automaton doctor`.
- If anything fails: identify which stage broke (build / test / smoke), surface the first failing file or test, and suggest the narrowest fix. Don't summarise the full log — point at the signal.

If `pnpm run sync:sdks` might be relevant (preflight failure names a sibling SDK), propose it but don't run it unprompted.
