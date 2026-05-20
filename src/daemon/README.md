# src/daemon/

The long-lived process. Composes every prior-phase primitive in a strict order (see `orchestrator.ts` top-of-file for the 12-step composition).

| File | Purpose |
|---|---|
| `orchestrator.ts` | `runDaemon(opts)` — lockfile → unlock → runtime → schema-check → handlers → loop → graceful shutdown. `tickOnce` exported for tests. |
| `loop.ts` | Cancellable primitives: `abortableSleep`, `loopCycles` (exponential backoff), `waitForDrain`. AbortSignal-driven end-to-end. |
| `logger.ts` | `createPinoLogger` with structural redaction on `password`/`mnemonic`/`privateKey`/`seed`/`secretKey`. |
| `metrics.ts` | `createDaemonMetrics()` — prom-client `Registry` + `counters` + `gauges` + `cycleDuration` histogram. Every name has a `help` string; labels pinned to bounded enums. |
| `http.ts` | `startHealthServer` — `/metrics`, `/healthz` (staleness-gated), `/readyz` (sub-check array). |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator and §Key design decisions ("Daemon orchestration is layered, signal-safe, crash-clean", "Metrics + logs + health: one source of truth each").
