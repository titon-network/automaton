// `automaton doctor` — environment + install + runtime preflight.
//
// Layers (in order reported):
//
//   1. Install-scoped (always run): node version, SDK resolvability,
//      package version readable. Catches packaging / install breakage.
//   2. Config-scoped (skipped if no config.json): the config file loads,
//      the keystore loads, their networks agree.
//   3. Chain-scoped (skipped if config absent OR network has no live
//      deployment): RPC reachability per endpoint, wallet balance vs
//      config.minFreeBalance, on-chain schema versions match the SDK,
//      registry admitted as a consumer on the pool.
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
    DeploymentNotAvailableError,
    SchemaMismatchError,
    buildChainRuntime,
    checkSchemaVersions,
    describeLock,
    type ChainRuntime,
} from '../../chain';
import { pkgVersion } from '../version';

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
        {
            name: 'forgeton-sdk resolves',
            run: async () => {
                const mod = (await import('forgeton-sdk')) as Record<string, unknown>;
                const count = Object.keys(mod).length;
                if (count === 0) {
                    return {
                        status: 'fail',
                        detail: 'forgeton-sdk has zero exports — run `pnpm run sync:sdks`',
                    };
                }
                return { status: 'ok', detail: `${count} exports` };
            },
        },
        {
            name: 'kronos-sdk resolves',
            run: async () => {
                const mod = (await import('kronos-sdk')) as Record<string, unknown>;
                const count = Object.keys(mod).length;
                if (count === 0) {
                    return {
                        status: 'fail',
                        detail: 'kronos-sdk has zero exports — run `pnpm run sync:sdks`',
                    };
                }
                return { status: 'ok', detail: `${count} exports` };
            },
        },
        {
            name: 'package version readable',
            run: () => ({ status: 'ok', detail: pkgVersion() }),
        },
    ];
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
    return out;
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
                const info = await ctx.runtime.client.call((c) => c.getMasterchainInfo());
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
                const balance = await ctx.runtime.client.call((c) => c.getBalance(walletAddr));
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
                        client: ctx.runtime.client,
                        registry: ctx.runtime.deployment.registry,
                        pool: ctx.runtime.deployment.pool,
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
                const consumer = await ctx.runtime.pool.getConsumer(ctx.runtime.deployment.registry);
                if (consumer === null) {
                    return {
                        status: 'fail',
                        detail:
                            `registry ${ctx.runtime.deployment.registry.toString()} is NOT admitted as a consumer on the pool. ` +
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

// List of chain-check names; used to emit a skip row per check when the
// deployment isn't available (mainnet today), so operators see what would
// have run instead of a single opaque "chain checks — skip" entry.
const CHAIN_CHECK_NAMES = [
    'rpc reachable',
    'wallet balance >= minFreeBalance',
    'on-chain schema versions match',
    'registry admitted on pool',
] as const;

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
        try {
            const runtime = buildChainRuntime(config);
            checks.push(...buildChainChecks({ config, keystore, runtime }));
        } catch (err) {
            if (err instanceof DeploymentNotAvailableError) {
                for (const name of CHAIN_CHECK_NAMES) {
                    checks.push({
                        name,
                        run: () => ({ status: 'skip', detail: err.message }),
                    });
                }
            } else {
                throw err;
            }
        }
    }

    checks.push(buildLockfileCheck());

    return checks;
}

export function registerDoctorCommand(program: Command): void {
    program
        .command('doctor')
        .description(
            'Run environment + install + runtime sanity checks. Read-only; safe alongside a live daemon. Exits non-zero on any failure.',
        )
        .action(async () => {
            const checks = await buildChecks();
            let failed = 0;
            let warned = 0;
            for (const check of checks) {
                let result: CheckResult;
                try {
                    result = await check.run();
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    result = { status: 'fail', detail: message };
                }
                if (result.status === 'fail') failed++;
                if (result.status === 'warn') warned++;
                process.stdout.write(renderCheck(result.status, check.name, result.detail));
            }
            const tail = warned > 0 ? ` (${warned} warning${warned === 1 ? '' : 's'})` : '';
            if (failed > 0) {
                process.stdout.write(`\n${failed} check(s) failed${tail}.\n`);
                process.exit(1);
            }
            process.stdout.write(`\nall ${checks.length} checks passed${tail}.\n`);
        });
}
