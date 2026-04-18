---
description: Run jest for a single spec file (or an `it` name filter) for focused iteration.
argument-hint: <spec-file-or-pattern> [-t <test-name>]
---

Run the automaton test suite scoped to **$ARGUMENTS**.

Invocation:

```bash
pnpm test -- $ARGUMENTS
```

Examples:
- `/test-one tests/decide.spec.ts` — just the decision-tree suite
- `/test-one tests/cli.spec.ts -t explain-exit-code` — only the explain-exit-code describe block
- `/test-one stake` — jest's fuzzy filename match picks up `tests/stake*.spec.ts`

If the run is green, say so in one line + the test count. If red, identify:
1. Which test failed (file + describe + `it` name).
2. What it expected vs. what it got (the first meaningful diff line).
3. The narrowest likely cause — point at a specific `src/` file and line if you can.

If the preflight globalSetup fires (missing sibling-SDK snapshot), propose `pnpm run sync:sdks`; don't run it unprompted.
