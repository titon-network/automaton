#!/usr/bin/env node
// Entry point for the `automaton` binary.
//
// This file is intentionally thin: it wires commander, registers every
// subcommand, and dispatches. The actual work lives in src/cli/commands/*.
// Exit-code translation (explainExitCode) happens here so every CLI
// failure surfaces a human-readable explanation alongside the raw message.

import { Command } from 'commander';
import { registerBlsCommand } from './commands/bls';
import { registerCompletionCommand } from './commands/completion';
import { registerConfigCommand } from './commands/config';
import { registerDoctorCommand } from './commands/doctor';
import { registerExplainCommand } from './commands/explain';
import { registerInitCommand } from './commands/init';
import { registerPlaygroundCommand } from './commands/playground';
import { registerRunCommand } from './commands/run';
import { registerStakeCommand } from './commands/stake';
import { registerStatusCommand } from './commands/status';
import {
    explainExitCode,
    extractExitCode,
    extractExplainHint,
    formatExplanation,
} from '../errors';
import { pkgVersion } from './version';

function buildProgram(): Command {
    const program = new Command();

    program
        .name('automaton')
        .description(
            'Titon automaton node — stake once with ForgeTON, earn across every admitted consumer product (Kronos, Fortuna, …).',
        )
        .version(pkgVersion(), '-v, --version', 'print version and exit');

    registerInitCommand(program);
    registerPlaygroundCommand(program);
    registerStatusCommand(program);
    registerDoctorCommand(program);
    registerStakeCommand(program);
    registerBlsCommand(program);
    registerRunCommand(program);
    registerConfigCommand(program);
    registerCompletionCommand(program);
    registerExplainCommand(program);

    return program;
}

async function main(): Promise<void> {
    const program = buildProgram();
    await program.parseAsync(process.argv);
}

main().catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`error: ${message}\n`);

    // If the error surface carries a TVM exit code (contract revert),
    // surface the SDK's human-readable explanation underneath. Operators
    // see "exit 160 (forgeton) E_NOT_REGISTERED: …" instead of guessing.
    // The hint walker disambiguates cross-SDK code overlaps — code 120
    // means three different things in kronos / fortuna / atlas, and
    // PoolRejectedError carries the right hint via SendAndConfirmOptions.origin.
    const code = extractExitCode(err);
    if (code !== null) {
        const hint = extractExplainHint(err);
        process.stderr.write(formatExplanation(explainExitCode(code, hint)) + '\n');
    }

    process.exit(1);
});
