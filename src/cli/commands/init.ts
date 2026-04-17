// `automaton init` — interactive first-run setup.
//
// Full implementation lands in Phase D.5 (creates ~/.titon/automaton/,
// prompts for network + endpoints + wallet mnemonic, writes encrypted
// keystore + config). This stub exists so `automaton --help` lists every
// subcommand from day one (progress.md D.1 requirement).

import { Command } from 'commander';

export function registerInitCommand(program: Command): void {
    program
        .command('init')
        .description('Interactive first-run setup — creates ~/.titon/automaton/, wallet, config.')
        .action(() => {
            process.stdout.write('init is not implemented yet (see Phase D.5).\n');
            process.exit(2);
        });
}
