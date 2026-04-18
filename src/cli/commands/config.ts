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
import { Command } from 'commander';
import { applyEnvOverlay, configPath, loadConfig } from '../../config';
import type { Config } from '../../config/schema';
import { ConfigSchema } from '../../config/schema';
import { readFileSync } from 'fs';

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

function redact(cfg: Config): Config {
    return {
        ...cfg,
        endpoints: cfg.endpoints.map((e) => ({ url: e.url })),
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
    out.push(`  alertWebhookUrl:           ${fmtValue(effective.alertWebhookUrl)}\n`);
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

export function registerConfigCommand(program: Command): void {
    const cfg = program
        .command('config')
        .description('Inspect the effective config (file + env overlay).');

    cfg.command('show')
        .description('Print the effective config. Read-only.')
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
}

// Exported for tests.
export { computeView, renderHuman as renderConfigShowHuman, renderJson as renderConfigShowJson };
export type { ConfigView, EnvOverride };
