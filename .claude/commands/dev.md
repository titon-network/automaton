---
description: Run the automaton CLI via ts-node (no build needed) for fast iteration.
argument-hint: <cli-args> — e.g. "doctor" or "status --format json"
---

Run the CLI directly from TypeScript source with:

```bash
pnpm dev $ARGUMENTS
```

(Note: use `pnpm dev <args>` rather than `pnpm run dev -- <args>` — the `--` separator confuses commander's option parser.)

This invokes `ts-node --transpile-only src/cli/index.ts $ARGUMENTS`. Skips the `tsc` build; type-checks are deferred to `pnpm run verify`. Use this during development for sub-second iteration; use the built `dist/cli/index.js` for anything that needs type-checked output or matches production behaviour.

Report the output. If the command expects a TTY (`init`, `stake` password prompt), warn the user — `pnpm dev init` may fail with `NotInteractiveError` depending on the sandbox.
