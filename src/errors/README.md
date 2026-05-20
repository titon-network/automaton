# src/errors/

Shared error primitives. Typed errors live next to their originating module (e.g. `PoolRejectedError` in `src/chain/submit.ts`); this directory owns the cross-cutting helpers.

| File | Purpose |
|---|---|
| `backoff.ts` | `jitteredBackoff` (equal-jitter exponential) + `defaultSleep` (ref-ed `setTimeout`). The retry loops live in their callers — `FailoverTonClient` (`src/chain/ton-client.ts`) and `sendAndConfirm` (`src/chain/submit.ts`) — and share these two helpers. |
| `explain.ts` | `explainExitCode(n)` → `{code, origin, name, message, hint?}` — picks the right SDK (kronos 100-119 / forgeton 160-182 / tvm 1-100). `extractExitCode(err)` pulls a code off SDK errors or parses `exit code N` from sandbox strings. `formatExplanation` renders for CLI surfaces. |
| `index.ts` | Barrel. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §Key design decisions ("Errors surface human text — not stack traces", "Backoff / retry is a shared primitive"). Every typed error class is catalogued in [`../../docs/troubleshooting.md`](../../docs/troubleshooting.md) §Typed error reference.
