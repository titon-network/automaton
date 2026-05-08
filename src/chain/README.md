# src/chain/

Everything that talks to TON. Transport, addresses, gas math, lifecycle primitives.

| File | Purpose |
|---|---|
| `ton-client.ts` | `FailoverTonClient` — endpoint ring with jittered backoff on transient errors. `.call(fn)` + `.open(contract)` inherit retry. |
| `deployment.ts` | `resolveDeployment(config)` → `{ pool, products }` per network — reads SDK-shipped testnet and mainnet constants. |
| `runtime.ts` | `buildChainRuntime(config)` — the canonical "start talking to chain" entry; gates on `config.products`. |
| `schema-check.ts` | `checkSchemaVersions` — startup gate against SDK `STORAGE_VERSION` constants; refuses on drift. |
| `submit.ts` | `senderFor` + `sendAndConfirm` (seqno-advance polling + post-state verify). `waitForSeqnoAdvance` is the testable core. |
| `stake-cost.ts` | Pool message-value calculators (mirror the on-chain floors in `handleRegisterAutomaton` etc). |
| `snapshot.ts` | `collectChainSnapshot` — best-effort read path shared by `status` + daemon gauges. |
| `lockfile.ts` | PID-based single-instance lock; `describeLock()` returns absent / held-alive / held-stale / corrupt. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator and §Key design decisions ("Failover is a property of the client", "Schema check gates startup").
