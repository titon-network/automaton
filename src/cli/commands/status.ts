// `automaton status` — one-shot snapshot of wallet + stake + assignment state.
//
// Implemented in D.6. Stub here so the help text is complete from D.1.

import { Command } from 'commander';

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description('Print one-shot snapshot: wallet balance, stake, assignment, recent executions.')
        .action(() => {
            process.stdout.write('status is not implemented yet (see Phase D.6).\n');
            process.exit(2);
        });
}
