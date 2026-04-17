// Load + save + env overlay.
//
// Design decisions:
//
//   1. Atomic writes. saveConfig writes to a .tmp sibling then renames. A
//      crash mid-write leaves the old config intact instead of a half-written
//      file the next load would reject.
//
//   2. 0600 perms. Not strictly sensitive (wallet lives elsewhere), but
//      "private to owner" is a good default for an operator-only file.
//
//   3. Typed errors. ConfigNotFoundError vs ConfigValidationError vs
//      environment-overlay errors are distinct classes so the CLI can print
//      different guidance for each ("run init" vs "fix the file" vs "fix the
//      shell export").
//
//   4. Env overlay is applied AFTER schema validation. So the file's invariant
//      must hold on disk; env vars just tweak runtime. (An env var that
//      violates the schema throws — same class of loud failure as a bad file.)

import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';
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

    mkdirSync(dirname(path), { recursive: true });

    // Atomic rename avoids half-written files if we crash mid-serialise.
    // `.pid` suffix prevents concurrent saves from two processes clobbering
    // each other's tmp — each writes to its own filename then renames.
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(validated, null, 2) + '\n', { mode: 0o600 });
    // writeFileSync's mode only applies at CREATE time AND is masked by umask.
    // Force 0600 post-hoc so operator-only perms hold regardless of umask.
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
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

    return result;
}
