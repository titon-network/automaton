# src/playground/

Fully-local simulation. Boots `@ton/sandbox` in-process, deploys the full Titon stack (ForgeTON + Kronos + Atlas + Fortuna by default), registers ONE demo automaton, and runs the real production tick path against it — the same operator earns from both Kronos jobs and Fortuna VRF fulfillments. Powers `automaton playground` (the "30-second test on your laptop" entry point) and the integration test suite.

| File | Purpose |
|---|---|
| `sandbox-runtime.ts` | `createSandboxHarness({ withFortuna })` — deploys ForgeTON + Kronos always; deploys Atlas + Fortuna and admits all three as pool consumers when `withFortuna: true`. Returns a `ChainRuntime` adapter + Fortuna helpers (`registerBlsShare` / `publishGroupKey` / `requestRandomness`). The `tests/helpers/chain.ts` re-exports from here so tests + the playground share one harness. |
| `demo.ts` | `runPlayground(opts)` — orchestrates Kronos always; for the Fortuna leg also generates an in-memory BLS keypair, registers the share at Atlas, owner publishes the group key, fires a `RequestRandomness` per tick, runs `FortunaWorker` against `automaton.getSender()`. Pretty TUI (default) or JSON-lines (`--format json`). |

The playground intentionally bypasses `ProductModule.bootstrapWorker` (production path resolves `KRONOS_TESTNET` / `FORTUNA_TESTNET` + real wallet sender, neither of which exists in sandbox) and hand-builds `KronosWorker` + `FortunaWorker` against the harness. Both workers expose explicit injection points (`submitExecute?` / `submitFulfill?` / `sender?`) that swap the I/O boundary while leaving pure orchestration logic intact. See the architecture note at the top of `demo.ts`.

> Themis is **not yet** in the playground — adding it would mean deploying the Themis factory, spawning a chamber per consumer, registering a sealed-AMM-style reference consumer, and driving a `SubmitCiphertext` → fast-forward → `RevealRound` cycle. Tracked as part of themis PLAN Phase 4 (the `SealedAMMConsumer.spec.ts` sandbox harness will likely become the playground integration). The `ThemisWorker` ships with the same `submitReveal?` / `sender?` injection points so it can drop in cleanly.

See [`../../CLAUDE.md`](../../CLAUDE.md) §AI navigator → "Change the playground / local sandbox demo". Drift guard: [`../../tests/cli-playground.spec.ts`](../../tests/cli-playground.spec.ts) (4 tests — Kronos-only, full-stack, JSON, abort).
