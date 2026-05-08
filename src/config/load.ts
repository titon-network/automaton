// Load + save + env overlay.
//
// Design decisions:
//
//   1. Typed errors. ConfigNotFoundError vs ConfigValidationError vs
//      ConfigEnvOverlayError are distinct classes so the CLI can print
//      different guidance for each ("run init" vs "fix the file" vs "fix the
//      shell export").
//
//   2. Env overlay is applied AFTER schema validation. So the file's invariant
//      must hold on disk; env vars just tweak runtime. (An env var that
//      violates the schema throws — same class of loud failure as a bad file.)

import { existsSync, readFileSync } from 'fs';
import { atomicWriteFile } from '../util/atomic-write';
import { configPath } from './paths';
import { ConfigSchema, LogLevelSchema, NetworkSchema, type Config } from './schema';

export class ConfigNotFoundError extends Error {
    constructor(public readonly path: string) {
        super(`config not found at ${path}\nRun \`automaton init\` to create one.`);
        this.name = 'ConfigNotFoundError';
    }
}

export class ConfigValidationError extends Error {
    constructor(public readonly path: string, public readonly issues: string[]) {
        super(`config at ${path} failed validation:\n` + issues.map((i) => `  ${i}`).join('\n'));
        this.name = 'ConfigValidationError';
    }
}

export class ConfigEnvOverlayError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'ConfigEnvOverlayError';
    }
}

export function loadConfig(path: string = configPath()): Config {
    if (!existsSync(path)) {
        throw new ConfigNotFoundError(path);
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new ConfigValidationError(path, [`not valid JSON: ${message}`]);
    }

    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${where}: ${issue.message}`;
        });
        throw new ConfigValidationError(path, issues);
    }

    return applyEnvOverlay(result.data);
}

export function saveConfig(config: Config, path: string = configPath()): void {
    const validated = ConfigSchema.parse(config);
    atomicWriteFile(path, JSON.stringify(validated, null, 2) + '\n', 0o600);
}

// Narrow allow-list of env overrides. Each override validates through the same
// schema shape as the file, so the final Config is uniformly typed.
export function applyEnvOverlay(config: Config): Config {
    const result = { ...config };

    const network = process.env.AUTOMATON_NETWORK;
    if (network !== undefined) {
        const parsed = NetworkSchema.safeParse(network);
        if (!parsed.success) {
            throw new ConfigEnvOverlayError(
                `AUTOMATON_NETWORK must be one of ${NetworkSchema.options.join(' | ')}, got: ${network}`,
            );
        }
        result.network = parsed.data;
    }

    const portRaw = process.env.AUTOMATON_METRICS_PORT;
    if (portRaw !== undefined) {
        const port = Number.parseInt(portRaw, 10);
        if (!Number.isFinite(port) || port <= 0 || port > 65535) {
            throw new ConfigEnvOverlayError(
                `AUTOMATON_METRICS_PORT must be 1-65535, got: ${portRaw}`,
            );
        }
        result.metricsPort = port;
    }

    const logLevel = process.env.AUTOMATON_LOG_LEVEL;
    if (logLevel !== undefined) {
        const parsed = LogLevelSchema.safeParse(logLevel);
        if (!parsed.success) {
            throw new ConfigEnvOverlayError(
                `AUTOMATON_LOG_LEVEL must be one of ${LogLevelSchema.options.join(' | ')}, got: ${logLevel}`,
            );
        }
        result.logLevel = parsed.data;
    }

    const atlasAddr = process.env.AUTOMATON_ATLAS_ADDRESS;
    const fortunaAddr = process.env.AUTOMATON_FORTUNA_ADDRESS;
    if (atlasAddr !== undefined || fortunaAddr !== undefined) {
        result.fortuna = {
            ...(result.fortuna ?? {}),
            ...(atlasAddr !== undefined ? { atlasAddress: atlasAddr } : {}),
            ...(fortunaAddr !== undefined ? { fortunaAddress: fortunaAddr } : {}),
        };
    }

    return result;
}
