// `automaton explain-exit-code <code-or-message>` — look up a TVM exit code
// or an error string. Complements the `/explain-error` slash command for
// operators who don't have a Claude Code session open.
//
// Accepts either:
//   - a bare integer (e.g. `162`)
//   - an error message containing "exit code N" (`exit code 162 on
//     AutomatonAlreadyRegistered`)
// and prints the unified explanation via `explainExitCode` + `formatExplanation`.
//
// Exit codes:
//   0 — a known code (origin is kronos / forgeton / tvm)
//   1 — no code could be extracted from the input
//   2 — the code was extracted but its origin is 'unknown' (out of range)
//
// `--format json` emits the `Explanation` payload directly for agent-driven
// downstream processing.

import { Command } from 'commander';
import {
    explainExitCode,
    extractExitCode,
    formatExplanation,
    type Explanation,
} from '../../errors';

export function registerExplainCommand(program: Command): void {
    program
        .command('explain-exit-code <input>')
        .alias('explain')
        .description(
            'Resolve a TVM exit code (bare number or error message containing `exit code N`) ' +
                'to its SDK explanation. Mirrors the CLI top-level catch\'s lookup.',
        )
        .option(
            '--format <fmt>',
            'output format: "human" (default) or "json" (machine-readable)',
            'human',
        )
        .action((input: string, opts: { format: string }) => {
            if (opts.format !== 'human' && opts.format !== 'json') {
                process.stderr.write(
                    `error: --format must be "human" or "json" (got "${opts.format}")\n`,
                );
                process.exit(2);
            }

            const code = resolveCode(input);
            if (code === null) {
                process.stderr.write(
                    `error: could not extract an exit code from input. Pass a bare integer ` +
                        `(e.g. 162) or a message containing \"exit code N\".\n`,
                );
                process.exit(1);
            }

            const exp = explainExitCode(code);
            if (opts.format === 'json') {
                process.stdout.write(JSON.stringify(exp, null, 2) + '\n');
            } else {
                process.stdout.write(formatExplanation(exp) + '\n');
            }
            // Out-of-range codes get exit 2 so scripts can differentiate "no
            // code" (1) from "code but unknown to every SDK" (2).
            if (exp.origin === 'unknown') process.exit(2);
        });
}

function resolveCode(input: string): number | null {
    const trimmed = input.trim();
    if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
    return extractExitCode({ message: trimmed });
}

export { resolveCode };
export type { Explanation };
