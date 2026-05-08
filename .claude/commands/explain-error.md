---
description: Explain a TVM exit code, typed error, or raw log line from automaton output.
argument-hint: <exit-code-or-error-message>
---

Explain: **$ARGUMENTS**

Resolution order:

1. If the input is a bare number (e.g. `162`) or contains `exit code N`, look it up via `explainExitCode(n)` — the source tables are in `@titon-network/kronos-sdk` (codes 100-119), `@titon-network/forgeton-sdk` (160-182), and `@ton/core`-equivalent TVM (1-100). Read `src/errors/explain.ts` for the dispatch logic.
2. If the input contains a typed error name (e.g. `PoolRejectedError`, `LockHeldError`), look it up in `docs/troubleshooting.md` §"Typed error reference" — every class has a source file + symptom + fix.
3. If the input is a log line, extract the error substring and retry step 1/2 on it.
4. If none of the above matches, surface that honestly — don't invent an explanation.

Output format:
- One-line summary: `<origin> <code-or-class> <name>: <plain-english>`
- One-line fix hint: what the operator should check or run.
- Pointer to the source file / docs section where the authoritative explanation lives.

Keep under 120 words.
