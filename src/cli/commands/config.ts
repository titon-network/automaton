// `automaton config show [--format json]` — print the effective config
// (file + env overlay). Read-only; safe alongside a live daemon.
//
// Two use cases this solves:
//   - "Is my AUTOMATON_<VAR> env override actually applied?" — we diff
//     the on-disk baseline against the overlaid result and surface the
//     delta in an `envOverrides` block.
//   - Agent-driven debugging — `--format json` returns a stable payload
//     that's safe to feed into /explain-error or paste into an issue
//     (endpoint apiKeys are redacted).

import { existsSync } from 'fs';
import { spawnSync } from 'child_process';
import { Command } from 'commander';
import { applyEnvOverlay, configPath, loadConfig } from '../../config';
import type { Config } from '../../config/schema';
import { ConfigSchema } from '../../config/schema';
import { readFileSync } from 'fs';
import { promptConfirm, NotInteractiveError } from '../prompt';

type PrimitiveConfigValue = string | number | boolean | undefined;
type EnvOverrideKey = 'network' | 'metricsPort' | 'logLevel';

interface EnvOverride {
    key: EnvOverrideKey;
    envVar: string;
    baselineValue: PrimitiveConfigValue;
    effectiveValue: PrimitiveConfigValue;
}

interface ConfigView {
    path: string;
    baseline: Config;
    effective: Config;
    overrides: EnvOverride[];
}

function readBaseline(path: string): Config {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as unknown;
    return ConfigSchema.parse(raw);
}

function computeView(): ConfigView {
    const path = configPath();
    if (!existsSync(path)) {
        throw new Error(
            `no config at ${path}.\nRun \`automaton init\` first.`,
        );
    }
    const baseline = readBaseline(path);
    const effective = applyEnvOverlay(baseline);

    const overrides: EnvOverride[] = [];
    const candidates: ReadonlyArray<[EnvOverrideKey, string]> = [
        ['network', 'AUTOMATON_NETWORK'],
        ['metricsPort', 'AUTOMATON_METRICS_PORT'],
        ['logLevel', 'AUTOMATON_LOG_LEVEL'],
    ];
    for (const [key, envVar] of candidates) {
        if (process.env[envVar] === undefined) continue;
        const baselineValue = baseline[key];
        const effectiveValue = effective[key];
        if (baselineValue !== effectiveValue) {
            overrides.push({ key, envVar, baselineValue, effectiveValue });
        }
    }

    // Also flag no-op overrides (env set but matches file) so operators
    // can tell the env var is being read, just not changing anything.
    for (const [key, envVar] of candidates) {
        if (process.env[envVar] === undefined) continue;
        if (overrides.some((o) => o.key === key)) continue;
        overrides.push({
            key,
            envVar,
            baselineValue: baseline[key],
            effectiveValue: effective[key],
        });
    }

    return { path, baseline, effective, overrides };
}

/**
 * Redact tokens that commonly hide in URL path/query. Webhook URLs from
 * Slack / Discord / Telegram / Mattermost embed secret tokens in the
 * path (`https://hooks.slack.com/services/T0/B0/SECRET_TOKEN`); printing
 * them in `config show` output exposes the secret to anyone who screen-
 * shares or pastes the output. Strip everything past the host.
 */
function redactWebhookUrl(raw: string | undefined): string | undefined {
    if (raw === undefined) return undefined;
    try {
        const u = new URL(raw);
        return `${u.protocol}//${u.host}/[redacted]`;
    } catch {
        // Schema validation rejects malformed URLs at load time; if we
        // somehow got here with an unparseable string, redact wholesale.
        return '[redacted]';
    }
}

function redact(cfg: Config): Config {
    return {
        ...cfg,
        endpoints: cfg.endpoints.map((e) => ({ url: e.url })),
        ...(cfg.alertWebhookUrl !== undefined
            ? { alertWebhookUrl: redactWebhookUrl(cfg.alertWebhookUrl) }
            : {}),
    };
}

function pad(label: string, width = 26): string {
    return label.padEnd(width, ' ');
}

function fmtValue(v: unknown): string {
    if (v === undefined) return '(unset)';
    if (typeof v === 'boolean' || typeof v === 'number') return String(v);
    return String(v);
}

function renderHuman(view: ConfigView): string {
    const { path, effective, overrides } = view;
    const out: string[] = [];

    out.push(`\nConfig: ${path}\n\n`);
    out.push(`  network:                   ${fmtValue(effective.network)}\n`);
    out.push(`  walletVersion:             ${fmtValue(effective.walletVersion)}\n`);
    out.push(`  metricsHost:               ${fmtValue(effective.metricsHost)}\n`);
    out.push(`  metricsPort:               ${fmtValue(effective.metricsPort)}\n`);
    out.push(`  pollIntervalMs:            ${fmtValue(effective.pollIntervalMs)}\n`);
    out.push(`  gaugeSnapshotEveryNTicks:  ${fmtValue(effective.gaugeSnapshotEveryNTicks)}\n`);
    out.push(`  maxGasPerExecute:          ${fmtValue(effective.maxGasPerExecute)} TON\n`);
    out.push(`  minFreeBalance:            ${fmtValue(effective.minFreeBalance)} TON\n`);
    out.push(`  logLevel:                  ${fmtValue(effective.logLevel)}\n`);
    out.push(`  alertWebhookUrl:           ${fmtValue(redactWebhookUrl(effective.alertWebhookUrl))}\n`);
    out.push(`  products.kronos:           ${fmtValue(effective.products.kronos)}\n`);
    out.push(`  products.fortuna:          ${fmtValue(effective.products.fortuna)}\n`);

    out.push(`\n  Endpoints (${effective.endpoints.length}):\n`);
    for (const [i, ep] of effective.endpoints.entries()) {
        const key = ep.apiKey !== undefined ? ' (apiKey set)' : '';
        out.push(`    [${i}] ${ep.url}${key}\n`);
    }

    if (overrides.length > 0) {
        out.push(`\n  Env overrides (${overrides.length}):\n`);
        for (const o of overrides) {
            const applied = o.baselineValue !== o.effectiveValue;
            const tag = applied ? 'applied' : 'no-op (matches file)';
            out.push(
                `    ${pad(o.envVar)} ${fmtValue(o.baselineValue)} → ${fmtValue(o.effectiveValue)}  [${tag}]\n`,
            );
        }
    }
    out.push('\n');
    return out.join('');
}

function renderJson(view: ConfigView): string {
    const payload = {
        path: view.path,
        effective: redact(view.effective),
        envOverrides: view.overrides.map((o) => ({
            key: o.key,
            envVar: o.envVar,
            baselineValue: o.baselineValue,
            effectiveValue: o.effectiveValue,
            applied: o.baselineValue !== o.effectiveValue,
        })),
    };
    return JSON.stringify(payload, null, 2) + '\n';
}

interface ValidateResult {
    path: string;
    ok: boolean;
    issues: string[];
    configVersion?: number;
    network?: string;
    endpointCount?: number;
}

/**
 * Dry-run config validation. Reads the given path (or default `configPath()`),
 * runs it through the zod schema without side-effects, and returns a
 * structured result. Used by `automaton config validate`; doesn't apply
 * env overlays — the goal is to validate the FILE, not the runtime.
 */
function validateConfigAt(path: string): ValidateResult {
    if (!existsSync(path)) {
        return { path, ok: false, issues: [`file does not exist: ${path}`] };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { path, ok: false, issues: [`not valid JSON: ${message}`] };
    }

    const result = ConfigSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${where}: ${issue.message}`;
        });
        return { path, ok: false, issues };
    }

    return {
        path,
        ok: true,
        issues: [],
        configVersion: result.data.configVersion,
        network: result.data.network,
        endpointCount: result.data.endpoints.length,
    };
}

/**
 * Resolve the editor command. `--editor` flag wins over `$VISUAL` over
 * `$EDITOR` over a sensible per-platform fallback. We split on whitespace
 * so operators can pass `code --wait` or `nvim -p` etc.
 */
function resolveEditor(flag: string | undefined): { cmd: string; args: string[] } {
    const raw =
        flag ??
        process.env.VISUAL ??
        process.env.EDITOR ??
        (process.platform === 'win32' ? 'notepad' : 'vi');
    const parts = raw.trim().split(/\s+/);
    return { cmd: parts[0]!, args: parts.slice(1) };
}

interface EditOutcome {
    /** ok: file is valid; quit: user gave up; retry: file is invalid, try again */
    kind: 'ok' | 'quit' | 'retry';
    issues: string[];
}

async function runEditOnce(
    path: string,
    editor: { cmd: string; args: string[] },
): Promise<EditOutcome> {
    if (!process.stdout.isTTY) {
        // Editor needs a TTY to render; refuse loudly rather than spawn a
        // doomed child that hangs on stdin.
        throw new NotInteractiveError(
            'cannot launch an editor: stdout is not a TTY. ' +
                'Edit the file directly and re-run `automaton config validate`.',
        );
    }
    const result = spawnSync(editor.cmd, [...editor.args, path], {
        stdio: 'inherit',
    });
    if (result.error !== undefined) {
        throw new Error(
            `failed to launch editor "${editor.cmd}": ${result.error.message}\n` +
                `Set $EDITOR or pass --editor=<cmd>.`,
        );
    }
    if (result.status !== 0) {
        // Editor exited non-zero — most editors do this on :q! / unsaved
        // exit. Skip validation; the operator chose to bail.
        return { kind: 'quit', issues: [] };
    }
    const validated = validateConfigAt(path);
    if (validated.ok) return { kind: 'ok', issues: [] };
    return { kind: 'retry', issues: validated.issues };
}

export function registerConfigCommand(program: Command): void {
    const cfg = program
        .command('config')
        .description('Inspect or validate the effective config.');

    cfg.command('show')
        .description('Print the effective config (file + env overlay). Read-only.')
        .option(
            '--format <fmt>',
            'output format: "human" (default) or "json" (machine-readable; apiKeys redacted)',
            'human',
        )
        .action((opts: { format: string }) => {
            if (opts.format !== 'human' && opts.format !== 'json') {
                process.stderr.write(
                    `error: --format must be "human" or "json" (got "${opts.format}")\n`,
                );
                process.exit(2);
            }
            const view = computeView();
            const out = opts.format === 'json' ? renderJson(view) : renderHuman(view);
            process.stdout.write(out);
        });

    cfg.command('validate [path]')
        .description(
            'Dry-run validate a config file against the zod schema. Does NOT apply env overlays — validates the FILE, not the runtime. Exits 0 on success, 1 on any issue. Useful before restarting the daemon with a hand-edited config.',
        )
        .option(
            '--format <fmt>',
            'output format: "human" (default) or "json"',
            'human',
        )
        .action((pathArg: string | undefined, opts: { format: string }) => {
            if (opts.format !== 'human' && opts.format !== 'json') {
                process.stderr.write(
                    `error: --format must be "human" or "json" (got "${opts.format}")\n`,
                );
                process.exit(2);
            }

            const path = pathArg ?? configPath();
            const result = validateConfigAt(path);

            if (opts.format === 'json') {
                process.stdout.write(JSON.stringify(result, null, 2) + '\n');
            } else if (result.ok) {
                process.stdout.write(
                    `ok  ${result.path}\n` +
                        `    configVersion=${result.configVersion}, ` +
                        `network=${result.network}, endpoints=${result.endpointCount}\n`,
                );
            } else {
                process.stdout.write(`FAIL ${result.path}\n`);
                for (const issue of result.issues) {
                    process.stdout.write(`     - ${issue}\n`);
                }
            }

            if (!result.ok) process.exit(1);
        });

    cfg.command('edit')
        .description(
            'Open the config in $EDITOR (or --editor), then re-validate on save. ' +
                'Refuses if no config file exists; refuses if stdout is not a TTY.',
        )
        .option(
            '--editor <cmd>',
            'override $EDITOR (e.g. "code --wait", "nvim", "nano")',
        )
        .action(async (opts: { editor?: string }) => {
            const path = configPath();
            if (!existsSync(path)) {
                process.stderr.write(
                    `error: no config at ${path}.\nRun \`automaton init\` first.\n`,
                );
                process.exit(1);
            }
            const editor = resolveEditor(opts.editor);
            try {
                while (true) {
                    const outcome = await runEditOnce(path, editor);
                    if (outcome.kind === 'ok') {
                        process.stdout.write(`ok  ${path} — config is valid\n`);
                        return;
                    }
                    if (outcome.kind === 'quit') {
                        process.stdout.write(
                            `editor exited non-zero — leaving ${path} as-is\n`,
                        );
                        process.exit(1);
                    }
                    // retry: validation failed; show issues, prompt to re-edit
                    process.stderr.write(`\nFAIL ${path}\n`);
                    for (const issue of outcome.issues) {
                        process.stderr.write(`     - ${issue}\n`);
                    }
                    const again = await promptConfirm('Re-open editor to fix?', {
                        default: true,
                    });
                    if (!again) {
                        process.stderr.write(
                            'aborting — config is invalid; daemon will refuse to start\n',
                        );
                        process.exit(1);
                    }
                }
            } catch (err) {
                if (err instanceof NotInteractiveError) {
                    process.stderr.write(`error: ${err.message}\n`);
                    process.exit(1);
                }
                throw err;
            }
        });
}

export { validateConfigAt, resolveEditor };
export type { ValidateResult };

// Exported for tests.
export { computeView, renderHuman as renderConfigShowHuman, renderJson as renderConfigShowJson };
export type { ConfigView, EnvOverride };
