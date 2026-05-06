---
description: Run the local sandbox simulation — deploys ForgeTON + Kronos in-process, registers a demo automaton, executes recurring jobs.
argument-hint: optional flags — e.g. "--ticks 5" or "--ticks 3 --json"
---

Run the playground simulation with:

```bash
pnpm dev playground $ARGUMENTS
```

The default flags (`--ticks` omitted = run until Ctrl-C, `--tick-interval 500ms`, `--job-interval 60s`, 1 demo job) give a leisurely demo. For CI / smoke / fast verification pass `--ticks 3 --tick-interval 0` — completes in ~2 seconds with deterministic output.

What it does (no internet / faucet / wallet required):
1. Boots `@ton/sandbox` in-process.
2. Deploys ForgeTON + Kronos + Atlas + Fortuna (full stack by default; `--no-fortuna` skips the Atlas + Fortuna deploy + BLS bootstrap).
3. Registers ONE demo automaton with 10.07 TON stake — earns from both protocols.
4. For Fortuna: generates an in-memory BLS keypair, registers the pkShare at Atlas, owner publishes the solo group key.
5. Schedules a recurring Kronos job (default 60s interval).
6. Loops: advance sandbox clock → fire RequestRandomness if no pending → drain events → tick both workers (Kronos Execute + Fortuna FulfillRandomness) → settle.
7. Prints per-tick + per-execution + per-fulfillment lines, then a summary.

Use this when:
- You want to see the daemon work end-to-end without setting up a testnet wallet.
- You changed something on the worker / orchestrator / event drain path and want a fast, real-flow smoke check before running the full jest suite.
- You're showing the project to someone and want a 30-second demo.

Source: `src/playground/demo.ts`. Drift guard: `tests/cli-playground.spec.ts`.
