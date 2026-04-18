// `automaton run` — long-running daemon.
//
// Thin CLI wrapper around `runDaemon` in `src/daemon/orchestrator.ts`.
// All composition logic lives there; this file just parses flags and
// forwards. The daemon exits 0 on graceful shutdown (SIGTERM/SIGINT
// + successful checkpoint flush) and 1 on crash.

import { Command } from 'commander';
import { LogLevelSchema } from '../../config/schema';
import { runDaemon, type LogFormat, type RunDaemonOptions } from '../../daemon';

interface RunOptions {
    logLevel?: string;
    logFormat?: string;
}

const LOG_FORMATS: readonly LogFormat[] = ['pretty', 'json', 'auto'];

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
        .option(
            '--log-format <fmt>',
            'pretty / json / auto (default: auto — pretty on TTY, json otherwise). Override to force JSON for testing on a terminal, or pretty when attached to a named pipe.',
        )
        .action(async (options: RunOptions) => {
            const runOptions: RunDaemonOptions = {};

            if (options.logLevel !== undefined) {
                const parsed = LogLevelSchema.safeParse(options.logLevel);
                if (!parsed.success) {
                    throw new Error(
                        `--log-level must be one of ${LogLevelSchema.options.join(' | ')}, got: ${options.logLevel}`,
                    );
                }
                runOptions.logLevel = parsed.data;
            }

            if (options.logFormat !== undefined) {
                if (!(LOG_FORMATS as readonly string[]).includes(options.logFormat)) {
                    throw new Error(
                        `--log-format must be one of ${LOG_FORMATS.join(' | ')}, got: ${options.logFormat}`,
                    );
                }
                runOptions.logFormat = options.logFormat as LogFormat;
            }

            const exitCode = await runDaemon(runOptions);
            process.exit(exitCode);
        });
}
