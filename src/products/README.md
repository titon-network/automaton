# src/products/

The pluggable per-product registry. Every Titon protocol that wants operator-side action (Kronos, Fortuna, Themis, future Phoebe / Argus / …) implements `ProductModule` here. The orchestrator iterates `PRODUCTS` — `runDaemon`, `drainEvents`, `resolveDeployment`, `checkSchemaVersions`, `explainExitCode`, `doctor`, and `status` are all data-driven from this list.

| File | Purpose |
|---|---|
| `types.ts` | The `ProductModule` interface + `ProductWorker` + `ProductContext` types. Read this first before authoring a new product. |
| `index.ts` | `PRODUCTS` array (registration order = iteration order) + `enabledProducts(config)` filter. |
| `kronos.ts` | Poll-driven worker template. `KronosWorker` iterates the registry every tick, decides which jobs to execute, sends `Execute`. Use this as the base for products driven by polling on-chain state. |
| `fortuna.ts` | Event-driven worker template. `FortunaWorker` enqueues from `RequestCreated`, signs alpha with a BLS share, submits `FulfillRandomness` before the deadline. Use this as the base for products driven by inbound events. |
| `themis.ts` | Multi-chamber event-driven worker. `ThemisWorker` tracks per-chamber round + bid state from `RoundStarted` / `BidSubmitted` events; once the commit window closes, threshold-decrypts every cached bid (`D = sk · c1`), BLS-signs the reveal payload, submits `RevealRound`. Parent-child architecture: factory + chamber addresses live in the address bag (`atlas` / `factory` / `chamber:<addr>` keyed via `themisChamberAddrKey()`). v1 is solo-mode + static `config.themis.chambers`; auto-discovery + multi-op share-exchange are v1.1. |

See [`../../CLAUDE.md`](../../CLAUDE.md) §"Adding a new product" for the three-line addition guide and worked Phoebe / Argus examples. The orchestrator integration is documented in §"AI navigator" under "Wire a new consumer product".
