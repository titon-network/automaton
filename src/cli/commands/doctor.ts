// `automaton doctor` — environment + install + runtime preflight.
//
// Layers (in order reported):
//
//   1. Install-scoped (always run): node version, SDK resolvability,
//      package version readable. Catches packaging / install breakage.
//   2. Config-scoped (skipped if no config.json): the config file loads,
//      the keystore loads, their networks agree.
//   3. Chain-scoped (skipped if config absent): RPC reachability per
//      endpoint, wallet balance vs config.minFreeBalance, on-chain schema
//      versions match the SDK, registry admitted as a consumer on the pool.
//   4. Runtime-scoped (skipped if no config): lockfile status — absent /
//      held-by-pid-X / stale.
//
// Each check reports ok / warn / fail / skip; doctor exits non-zero if
// any fail fires (warn + skip do not gate). Running doctor alongside a
// live daemon is safe: every check is a read; we never write, send, or
// sign anything.

import { existsSync } from 'fs';
import { Address, fromNano, toNano } from '@ton/core';
import { Command } from 'commander';
import { configPath, loadConfig, walletPath } from '../../config';
import type { Config } from '../../config/schema';
import { keystoreExists, loadKeystore } from '../../wallet';
import type { Keystore } from '../../wallet';
import {
    SchemaMismatchError,
    buildChainRuntime,
    checkSchemaVersions,
    describeLock,
    type ChainRuntime,
} from '../../chain';
import { pkgVersion } from '../version';
import { PRODUCTS } from '../../products';

type Status = 'ok' | 'warn' | 'fail' | 'skip';

interface CheckResult {
    status: Status;
    detail: string;
}

interface Check {
    name: string;
    run(): Promise<CheckResult> | CheckResult;
}

// ANSI colours only when stdout is a TTY (never when piping to a log or
// test harness — avoids cluttering logs with escape codes).
const COLOUR = process.stdout.isTTY;
const RESET = COLOUR ? '\x1b[0m' : '';
const GREEN = COLOUR ? '\x1b[32m' : '';
const YELLOW = COLOUR ? '\x1b[33m' : '';
const RED = COLOUR ? '\x1b[31m' : '';
const DIM = COLOUR ? '\x1b[90m' : '';

function renderCheck(status: Status, name: string, detail: string): string {
    const [firstLine, ...rest] = detail.split('\n');
    const head = `  ${labelFor(status)}  ${name} — ${firstLine}\n`;
    if (rest.length === 0) return head;
    // Indent continuation lines to line up under the detail column so the
    // SchemaMismatchError (and any future multi-line error) renders as a
    // coherent block rather than hard-wrapping over the label.
    return head + rest.map((line) => `         ${line}\n`).join('');
}

function labelFor(status: Status): string {
    switch (status) {
        case 'ok':
            return `${GREEN}ok  ${RESET}`;
        case 'warn':
            return `${YELLOW}warn${RESET}`;
        case 'fail':
            return `${RED}FAIL${RESET}`;
        case 'skip':
            return `${DIM}skip${RESET}`;
    }
}

function buildInstallChecks(): Check[] {
    const baselineSdkChecks: Check[] = [
        {
            name: '@titon-network/forgeton-sdk resolves',
            run: async () => sdkResolves('@titon-network/forgeton-sdk'),
        },
    ];
    // Per-product install checks come from each ProductModule's
    // `doctorInstallChecks()` — no hardcoded knowledge of which products
    // exist. Adding Phoebe / Argus contributes its SDK-resolves row here
    // automatically.
    const productSdkChecks: Check[] = PRODUCTS.flatMap((p) =>
        p.doctorInstallChecks().map((c) => ({
            name: c.name,
            run: async () => c.run(),
        })),
    );

    return [
        {
            name: 'node >= 22',
            run: () => {
                const [major] = process.versions.node.split('.').map(Number);
                if (major === undefined || major < 22) {
                    return {
                        status: 'fail',
                        detail: `node ${process.versions.node} < 22 — upgrade to Node 22+`,
                    };
                }
                return { status: 'ok', detail: `node ${process.versions.node}` };
            },
        },
        ...baselineSdkChecks,
        ...productSdkChecks,
        {
            name: 'package version readable',
            run: () => ({ status: 'ok', detail: pkgVersion() }),
        },
    ];
}

async function sdkResolves(
    name: string,
): Promise<{ status: 'ok' | 'fail'; detail: string }> {
    const mod = (await import(name)) as Record<string, unknown>;
    const count = Object.keys(mod).length;
    if (count === 0) {
        return {
            status: 'fail',
            detail: `${name} has zero exports — run \`pnpm run sync:sdks\``,
        };
    }
    return { status: 'ok', detail: `${count} exports` };
}

function buildConfigChecks(
    ctx: { config?: Config; keystore?: Keystore; configLoadError?: string; keystoreLoadError?: string },
): Check[] {
    const out: Check[] = [];
    const cfgPath = configPath();
    if (ctx.configLoadError !== undefined) {
        out.push({
            name: 'config',
            run: () => ({ status: 'fail', detail: ctx.configLoadError! }),
        });
    } else if (ctx.config !== undefined) {
        const cfg = ctx.config;
        out.push({
            name: 'config',
            run: () => ({
                status: 'ok',
                detail: `${cfgPath} — network=${cfg.network}, endpoints=${cfg.endpoints.length}`,
            }),
        });
    } else {
        out.push({
            name: 'config',
            run: () => ({
                status: 'skip',
                detail: `absent at ${cfgPath} (run \`automaton init\`)`,
            }),
        });
    }

    const walPath = walletPath();
    if (ctx.keystoreLoadError !== undefined) {
        out.push({
            name: 'keystore',
            run: () => ({ status: 'fail', detail: ctx.keystoreLoadError! }),
        });
    } else if (ctx.keystore !== undefined) {
        const ks = ctx.keystore;
        out.push({
            name: 'keystore',
            run: () => ({
                status: 'ok',
                detail: `${walPath} — network=${ks.network}, address=${ks.address}`,
            }),
        });
    } else {
        out.push({
            name: 'keystore',
            run: () => ({
                status: 'skip',
                detail: `absent at ${walPath} (run \`automaton init\`)`,
            }),
        });
    }

    if (ctx.config !== undefined && ctx.keystore !== undefined) {
        out.push({
            name: 'config / keystore network agree',
            run: () => {
                if (ctx.config!.network === ctx.keystore!.network) {
                    return { status: 'ok', detail: ctx.config!.network };
                }
                return {
                    status: 'fail',
                    detail:
                        `config.network=${ctx.config!.network} but keystore.network=${ctx.keystore!.network}. ` +
                        `Same mnemonic produces different addresses per network; the keystore must be re-created after changing the config's network.`,
                };
            },
        });
    }

    // Endpoint-quality check. Public toncenter is rate-limited (~1 req/s)
    // without an apiKey — fine for testnet smoke, hostile in production
    // where the daemon polls every 10s and triggers fan-out reads. We
    // warn (not fail) so testnet users aren't blocked.
    if (ctx.config !== undefined) {
        out.push({
            name: 'endpoint quality',
            run: () => {
                const cfg = ctx.config!;
                const unkeyedPublic = cfg.endpoints.filter(
                    (e) => isPublicToncenter(e.url) && e.apiKey === undefined,
                );
                if (unkeyedPublic.length === cfg.endpoints.length) {
                    return {
                        status: 'warn',
                        detail:
                            `every configured endpoint is public toncenter without an apiKey (~1 req/s rate limit). ` +
                            `Add an apiKey or a private endpoint before running in production — get a free key at ` +
                            `https://t.me/tonapibot, then set { url, apiKey } in config.endpoints.`,
                    };
                }
                if (unkeyedPublic.length > 0) {
                    return {
                        status: 'warn',
                        detail:
                            `${unkeyedPublic.length} of ${cfg.endpoints.length} endpoint(s) are public toncenter ` +
                            `without an apiKey — failover will land on the rate-limited ones during outages`,
                    };
                }
                return {
                    status: 'ok',
                    detail: `${cfg.endpoints.length} endpoint(s); all keyed or private`,
                };
            },
        });
    }
    return out;
}

function isPublicToncenter(url: string): boolean {
    try {
        const u = new URL(url);
        return (
            u.hostname === 'toncenter.com' || u.hostname === 'testnet.toncenter.com'
        );
    } catch {
        return false;
    }
}

function buildChainChecks(ctx: {
    config: Config;
    keystore: Keystore;
    runtime: ChainRuntime;
}): Check[] {
    const walletAddr = Address.parse(ctx.keystore.address);
    const minFree = toNano(ctx.config.minFreeBalance);

    return [
        {
            name: 'rpc reachable',
            run: async () => {
                const start = Date.now();
                const info = await ctx.runtime.client.getMasterchainInfo();
                const ms = Date.now() - start;
                return {
                    status: 'ok',
                    detail: `${ctx.runtime.client.currentEndpoint} — seqno=${info.latestSeqno} (${ms}ms)`,
                };
            },
        },
        {
            name: 'wallet balance >= minFreeBalance',
            run: async () => {
                const balance = await ctx.runtime.client.getBalance(walletAddr);
                const balanceTon = fromNano(balance);
                const minTon = fromNano(minFree);
                if (balance >= minFree) {
                    return { status: 'ok', detail: `${balanceTon} TON (min ${minTon})` };
                }
                const fundHint =
                    ctx.config.network === 'testnet'
                        ? 'fund via https://t.me/testgiver_ton_bot'
                        : `send TON to ${ctx.keystore.address}`;
                return {
                    status: 'warn',
                    detail: `${balanceTon} TON < ${minTon} TON (minFreeBalance) — ${fundHint}`,
                };
            },
        },
        {
            name: 'on-chain schema versions match',
            run: async () => {
                try {
                    const results = await checkSchemaVersions({
                        config: ctx.config,
                        client: ctx.runtime.client,
                        deployment: ctx.runtime.deployment,
                        runtime: ctx.runtime,
                    });
                    const summary = results
                        .map((r) => `${r.contract}=v${r.onChain}`)
                        .join(', ');
                    return { status: 'ok', detail: summary };
                } catch (err) {
                    if (err instanceof SchemaMismatchError) {
                        return { status: 'fail', detail: err.message };
                    }
                    throw err;
                }
            },
        },
        {
            name: 'registry admitted on pool',
            run: async () => {
                // Skip when products.kronos is disabled (specialised operator
                // running e.g. Phoebe-only).
                const registry = ctx.runtime.deployment.products.kronos?.registry;
                if (registry === undefined) {
                    return { status: 'skip', detail: 'products.kronos is disabled' };
                }
                const consumer = await ctx.runtime.pool.getConsumer(registry);
                if (consumer === null) {
                    return {
                        status: 'fail',
                        detail:
                            `registry ${registry.toString()} is NOT admitted as a consumer on the pool. ` +
                            `Pool owner must call SetConsumer to wire them up — contact the deployer.`,
                    };
                }
                return { status: 'ok', detail: `consumer slot=${consumer.index}` };
            },
        },
    ];
}

function buildLockfileCheck(): Check {
    return {
        name: 'lockfile',
        run: () => {
            const desc = describeLock();
            switch (desc.kind) {
                case 'absent':
                case 'held-by-us':
                case 'held-alive':
                    return { status: 'ok', detail: desc.detail };
                case 'held-stale':
                    return { status: 'warn', detail: desc.detail };
                case 'corrupt':
                    return { status: 'fail', detail: desc.detail };
            }
        },
    };
}

async function buildChecks(): Promise<Check[]> {
    const checks: Check[] = buildInstallChecks();

    let config: Config | undefined;
    let configLoadError: string | undefined;
    if (existsSync(configPath())) {
        try {
            config = loadConfig();
        } catch (err) {
            configLoadError = err instanceof Error ? err.message : String(err);
        }
    }

    let keystore: Keystore | undefined;
    let keystoreLoadError: string | undefined;
    if (keystoreExists()) {
        try {
            keystore = loadKeystore();
        } catch (err) {
            keystoreLoadError = err instanceof Error ? err.message : String(err);
        }
    }

    checks.push(...buildConfigChecks({ config, keystore, configLoadError, keystoreLoadError }));

    if (config !== undefined && keystore !== undefined) {
        const runtime = buildChainRuntime(config);
        checks.push(...buildChainChecks({ config, keystore, runtime }));
    }

    checks.push(buildLockfileCheck());

    return checks;
}

/** One check's resolved result, keyed by name. Part of {@link DoctorJsonPayload}. */
export interface NamedCheckResult extends CheckResult {
    name: string;
}

/** Tally by status. Part of {@link DoctorJsonPayload}. */
export interface DoctorSummary {
    total: number;
    ok: number;
    warn: number;
    fail: number;
    skip: number;
}

/**
 * `automaton doctor --format json` payload. Stable shape; consumers can
 * import the type directly. `process.exit(1)` fires iff `summary.fail > 0`.
 */
export interface DoctorJsonPayload {
    version: string;
    summary: DoctorSummary;
    checks: NamedCheckResult[];
}

async function runChecks(): Promise<NamedCheckResult[]> {
    const checks = await buildChecks();
    const out: NamedCheckResult[] = [];
    for (const check of checks) {
        let result: CheckResult;
        try {
            result = await check.run();
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            result = { status: 'fail', detail: message };
        }
        out.push({ name: check.name, status: result.status, detail: result.detail });
    }
    return out;
}

function summarise(results: NamedCheckResult[]): DoctorSummary {
    const s: DoctorSummary = { total: results.length, ok: 0, warn: 0, fail: 0, skip: 0 };
    for (const r of results) s[r.status]++;
    return s;
}

function buildDoctorPayload(results: NamedCheckResult[]): DoctorJsonPayload {
    return { version: pkgVersion(), summary: summarise(results), checks: results };
}

export { runChecks, summarise, buildDoctorPayload };

export function registerDoctorCommand(program: Command): void {
    program
        .command('doctor')
        .description(
            'Run environment + install + runtime sanity checks. Read-only; safe alongside a live daemon. Exits non-zero on any failure.',
        )
        .option(
            '--format <fmt>',
            'output format: "human" (default, colour-coded table) or "json" (machine-readable)',
            'human',
        )
        .action(async (opts: { format: string }) => {
            if (opts.format !== 'human' && opts.format !== 'json') {
                process.stderr.write(`error: --format must be "human" or "json" (got "${opts.format}")\n`);
                process.exit(2);
            }

            const results = await runChecks();
            const payload = buildDoctorPayload(results);
            const { summary } = payload;

            if (opts.format === 'json') {
                process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
            } else {
                for (const r of results) {
                    process.stdout.write(renderCheck(r.status, r.name, r.detail));
                }
                const tail =
                    summary.warn > 0
                        ? ` (${summary.warn} warning${summary.warn === 1 ? '' : 's'})`
                        : '';
                if (summary.fail > 0) {
                    process.stdout.write(`\n${summary.fail} check(s) failed${tail}.\n`);
                } else {
                    process.stdout.write(`\nall ${summary.total} checks passed${tail}.\n`);
                }
            }

            if (summary.fail > 0) process.exit(1);
        });
}
