// `automaton run` — long-running daemon. Polls chain, executes due jobs, syncs
// mirror, reacts to slash events, exposes metrics + health endpoints.
//
// Implemented in D.10. Stub here so help text is complete from D.1.

import { Command } from 'commander';

export function registerRunCommand(program: Command): void {
    program
        .command('run')
        .description('Run the automaton daemon (poll chain, execute due jobs, expose metrics).')
        .action(() => {
            process.stdout.write('run is not implemented yet (see Phase D.10).\n');
            process.exit(2);
        });
}
