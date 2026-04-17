// `automaton stake ...` — stake lifecycle (register, increase, request-unstake, cancel, withdraw).
//
// Implemented in D.7. Stub subcommands here so help text is complete from D.1.

import { Command } from 'commander';

export function registerStakeCommand(program: Command): void {
    const stake = program
        .command('stake')
        .description('ForgeTON stake lifecycle — register, increase, request-unstake, cancel, withdraw.');

    stake
        .command('register')
        .description('Register + stake for the first time. One-time action.')
        .action(() => {
            process.stdout.write('stake register is not implemented yet (see Phase D.7).\n');
            process.exit(2);
        });

    stake
        .command('increase')
        .description('Add more stake to an already-registered automaton.')
        .action(() => {
            process.stdout.write('stake increase is not implemented yet (see Phase D.7).\n');
            process.exit(2);
        });

    stake
        .command('request-unstake')
        .description('Start the unstake timer. Stake unlocks after the configured delay.')
        .action(() => {
            process.stdout.write('stake request-unstake is not implemented yet (see Phase D.7).\n');
            process.exit(2);
        });

    stake
        .command('cancel-unstake')
        .description('Abort a pending unstake and stay active.')
        .action(() => {
            process.stdout.write('stake cancel-unstake is not implemented yet (see Phase D.7).\n');
            process.exit(2);
        });

    stake
        .command('withdraw')
        .description('Withdraw stake after the unstake timer has elapsed.')
        .action(() => {
            process.stdout.write('stake withdraw is not implemented yet (see Phase D.7).\n');
            process.exit(2);
        });
}
