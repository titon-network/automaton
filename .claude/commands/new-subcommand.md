---
description: Scaffold a new `automaton` CLI subcommand end-to-end.
argument-hint: <command-name> — e.g. "watch" or "verify-stake"
---

Add a new CLI subcommand named **$ARGUMENTS** to the automaton binary.

Steps (do them in this order):

1. Read the existing patterns in `src/cli/commands/doctor.ts` and `src/cli/commands/status.ts` — both are single-file commands that register via `registerXCommand(program)`.
2. Ask the user for the command's purpose + any arguments/flags if not obvious. Don't invent semantics.
3. Create `src/cli/commands/<name>.ts` exporting `registerXCommand(program: Command): void`. Follow the existing format:
   - Top-of-file doc comment explaining the command's purpose + side-effects.
   - Commander builder with `.description(...)` and `.action(async () => { ... })`.
   - If interactive: throw `NotInteractiveError` from `src/cli/prompt.ts` on non-TTY, with a flag escape hatch for CI.
   - If chain-facing: `buildChainRuntime(config)` + wrap chain calls so errors bubble as typed errors (see `src/chain/submit.ts`).
4. Wire the command into `src/cli/index.ts::buildProgram()` — add an import and a `registerXCommand(program)` line.
5. Add a smoke test: extend `tests/cli.spec.ts` to assert `--help` lists the new subcommand and `<name> --help` exits 0.
6. Run `pnpm run verify`.

Stop before step 6 and ask for confirmation if the command has destructive side-effects (writes to disk, sends a tx, modifies config).
