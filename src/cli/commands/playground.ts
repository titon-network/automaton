// `automaton playground` — run a fully-local simulation of an automaton
// earning TON. Boots an in-process sandbox blockchain, deploys ForgeTON
// + Kronos, registers a demo automaton, schedules a recurring job, and
// runs the real production tick path against the simulation.
//
// Zero internet, zero faucet, zero wait — operators can verify "this
// works on my laptop" before committing real TON to a testnet stake.
//
// Honors SIGINT / SIGTERM so Ctrl-C cleanly aborts the loop and the
// summary line still prints. `--ticks N` makes the run finite (used by
// CI + the smoke test); omitted, the loop runs forever until the user
// hits Ctrl-C.

import { Command } from 'commander';
import { runPlayground } from '../../playground/demo';

interface PlaygroundOptions {
    ticks?: string;
    tickInterval?: string;
    jobInterval?: string;
    jobs?: string;
    json?: boolean;
    fortuna?: boolean;
}

export function registerPlaygroundCommand(program: Command): void {
    program
        .command('playground')
        .description(
            'Run a fully-local simulation — boots an in-process sandbox, deploys ForgeTON + Kronos, ' +
                'registers a demo automaton, and shows it executing jobs and earning TON. No real TON, ' +
                'no testnet, no faucet.',
        )
        .option(
            '--ticks <n>',
            'number of ticks to run before exiting (default: run until Ctrl-C)',
        )
        .option(
            '--tick-interval <ms>',
            'wall-clock pause between ticks in milliseconds (default: 500)',
        )
        .option(
            '--job-interval <s>',
            'sandbox time advanced per tick, in seconds (default: 5)',
        )
        .option('--jobs <n>', 'number of demo jobs to schedule (default: 1)')
        .option(
            '--no-fortuna',
            'skip the Fortuna VRF leg (Atlas + Fortuna deploy + BLS bootstrap, ~3s faster) — useful for the smoke gate or quick iteration',
        )
        .option('--json', 'emit one JSON event per line instead of pretty output')
        .action(async (options: PlaygroundOptions) => {
            const ac = new AbortController();
            const onSignal = (): void => ac.abort();
            process.on('SIGINT', onSignal);
            process.on('SIGTERM', onSignal);

            try {
                const result = await runPlayground({
                    ...(options.ticks !== undefined ? { ticks: parsePositiveInt('--ticks', options.ticks) } : {}),
                    ...(options.tickInterval !== undefined
                        ? { tickIntervalMs: parseNonNegativeInt('--tick-interval', options.tickInterval) }
                        : {}),
                    ...(options.jobInterval !== undefined
                        ? { jobIntervalSec: parsePositiveInt('--job-interval', options.jobInterval) }
                        : {}),
                    ...(options.jobs !== undefined ? { jobs: parsePositiveInt('--jobs', options.jobs) } : {}),
                    // Commander's `--no-foo` form sets `options.foo = false`;
                    // `--foo` (or omitted) leaves it `undefined`. Default = true,
                    // so omitted = full stack, `--no-fortuna` = Kronos only.
                    withFortuna: options.fortuna !== false,
                    signal: ac.signal,
                    format: options.json === true ? 'json' : 'pretty',
                });

                // Exit non-zero only when the simulation was supposed to run a
                // bounded number of ticks but produced zero executions — that's
                // a regression worth surfacing in CI. Aborted runs (Ctrl-C) and
                // unbounded runs always exit 0.
                if (options.ticks !== undefined && result.executions === 0 && !result.aborted) {
                    process.exitCode = 1;
                }
            } finally {
                process.off('SIGINT', onSignal);
                process.off('SIGTERM', onSignal);
            }
        });
}

function parsePositiveInt(flag: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n <= 0) {
        throw new Error(`${flag}: expected a positive integer, got "${raw}"`);
    }
    return n;
}

function parseNonNegativeInt(flag: string, raw: string): number {
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) {
        throw new Error(`${flag}: expected a non-negative integer, got "${raw}"`);
    }
    return n;
}
