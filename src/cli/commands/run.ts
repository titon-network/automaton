// `automaton run` — long-running daemon.
//
// Thin CLI wrapper around `runDaemon` in `src/daemon/orchestrator.ts`.
// All composition logic lives there; this file just parses flags and
// forwards. The daemon exits 0 on graceful shutdown (SIGTERM/SIGINT
// + successful checkpoint flush) and 1 on crash.

import { Command } from 'commander';
import { LogLevelSchema } from '../../config/schema';
import { createPinoLogger, runDaemon } from '../../daemon';

interface RunOptions {
    logLevel?: string;
}

export function registerRunCommand(program: Command): void {
    program
        .command('run')
        .description(
            'Run the automaton daemon — polls chain, executes due jobs, tails events, alerts on self-slash. ' +
                'Foreground; use systemd or Docker to daemonize. ' +
                'Signals: SIGTERM/SIGINT = graceful shutdown (drains in-flight txs, flushes state). ' +
                'SIGHUP is currently warn-and-ignore; restart the process to reload config.',
        )
        .option(
            '--log-level <level>',
            'trace / debug / info / warn / error (overrides config.logLevel and AUTOMATON_LOG_LEVEL env)',
        )
        .action(async (options: RunOptions) => {
            let level: ReturnType<typeof LogLevelSchema.parse> | undefined;
            if (options.logLevel !== undefined) {
                const parsed = LogLevelSchema.safeParse(options.logLevel);
                if (!parsed.success) {
                    throw new Error(
                        `--log-level must be one of ${LogLevelSchema.options.join(' | ')}, got: ${options.logLevel}`,
                    );
                }
                level = parsed.data;
            }
            const logger = level !== undefined ? createPinoLogger({ level }) : undefined;
            const exitCode = await runDaemon(logger !== undefined ? { logger } : {});
            process.exit(exitCode);
        });
}
