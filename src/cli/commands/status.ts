// `automaton status` — compact operator snapshot. Read-only; safe to run
// alongside a live daemon.
//
// Pulls in parallel:
//   - local state: config + keystore (address + network)
//   - chain state: wallet balance, automaton registration / stake / slash,
//     pool's active-automaton-count, registry's drift counters
//   - runtime state: lockfile presence (daemon running?)
//
// Every chain read is best-effort. If the RPC blows up, we print the
// error in the affected cell and keep going — status should never crash
// on a transient network blip when the operator is trying to diagnose
// exactly that.
//
// Two output formats: `--format human` (default; padded table) and
// `--format json` (machine-readable; stable shape for agents + CI).
// Both flow through the same collectStatusData() so the JSON stays in
// lockstep with what humans see.

import { existsSync } from 'fs';
import { Address, fromNano } from '@ton/core';
import { Command } from 'commander';
import { configPath, loadConfig, walletPath } from '../../config';
import type { Config } from '../../config/schema';
import { keystoreExists, loadKeystore } from '../../wallet';
import type { Keystore } from '../../wallet';
import {
    DeploymentNotAvailableError,
    buildChainRuntime,
    collectChainSnapshot,
    describeLock,
    type ChainRuntime,
    type ChainSnapshot,
} from '../../chain';
import { pkgVersion } from '../version';

export { type ChainSnapshot };

function formatRow(label: string, value: string): string {
    return `    ${label.padEnd(22, ' ')} ${value}\n`;
}

function capitalize(s: string): string {
    return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}

function formatLockStatus(): string {
    return describeLock().detail;
}

export function renderStatus(details: {
    config: Config;
    keystore: Keystore;
    runtime: ChainRuntime | undefined;
    deploymentUnavailable: string | undefined;
    snapshot: ChainSnapshot | undefined;
}): string {
    const { config, keystore, runtime, deploymentUnavailable, snapshot } = details;
    const out: string[] = [];
    out.push(`\nTiton Automaton — status\n\n`);

    out.push(`  Install\n`);
    out.push(formatRow('version:', pkgVersion()));
    out.push(formatRow('config:', configPath()));
    out.push(formatRow('keystore:', walletPath()));
    out.push('\n');

    out.push(`  Wallet\n`);
    out.push(formatRow('network:', keystore.network));
    out.push(formatRow('address:', keystore.address));
    out.push(
        formatRow(
            'balance:',
            snapshot?.balance !== undefined ? `${fromNano(snapshot.balance)} TON` : '(unavailable)',
        ),
    );
    out.push('\n');

    out.push(`  Automaton\n`);
    if (snapshot === undefined) {
        out.push(formatRow('status:', '(unavailable — no chain connection)'));
    } else if (snapshot.automaton === undefined) {
        out.push(formatRow('status:', '(unavailable)'));
    } else if (snapshot.automaton === null) {
        out.push(formatRow('status:', 'not registered — run `automaton stake register`'));
    } else {
        const info = snapshot.automaton;
        out.push(formatRow('status:', info.isActive ? 'active' : 'inactive'));
        out.push(formatRow('stake:', `${fromNano(info.stake)} TON`));
        out.push(formatRow('slashCount:', String(info.slashCount)));
        out.push(
            formatRow('registered at:', new Date(info.registeredAt * 1000).toISOString()),
        );
    }
    if (snapshot?.activeAutomatonCount !== undefined) {
        out.push(formatRow('pool active count:', String(snapshot.activeAutomatonCount)));
    }
    out.push('\n');

    if (runtime !== undefined) {
        // Per-product address blocks — iterate runtime.deployment.products
        // generically so adding Phoebe / Argus shows up automatically.
        for (const [productName, addresses] of Object.entries(runtime.deployment.products)) {
            const entries = Object.entries(addresses);
            if (entries.length === 0) continue;
            out.push(`  ${capitalize(productName)}\n`);
            for (const [key, addr] of entries) {
                out.push(formatRow(`${key}:`, addr.toString()));
            }
            // Kronos-specific health snapshot — read from the gauge-collected
            // ChainSnapshot. Other products contribute their own snapshot
            // fields if/when needed.
            if (productName === 'kronos') {
                if (snapshot?.registryStorageVersion !== undefined) {
                    out.push(formatRow('schema version:', `v${snapshot.registryStorageVersion}`));
                }
                if (snapshot?.jobCount !== undefined) {
                    out.push(formatRow('jobCount:', snapshot.jobCount.toString()));
                }
                if (snapshot?.accumulatedFees !== undefined) {
                    out.push(formatRow('accumulatedFees:', `${fromNano(snapshot.accumulatedFees)} TON`));
                }
                if (snapshot?.isPaused !== undefined) {
                    out.push(formatRow('paused:', snapshot.isPaused ? 'yes' : 'no'));
                }
            }
            out.push('\n');
        }

        out.push(`  Pool\n`);
        out.push(formatRow('address:', runtime.deployment.pool.toString()));
        if (snapshot?.poolStorageVersion !== undefined) {
            out.push(formatRow('schema version:', `v${snapshot.poolStorageVersion}`));
        }
        out.push('\n');
    }

    out.push(`  Endpoint\n`);
    if (runtime !== undefined) {
        out.push(formatRow('current:', runtime.client.currentEndpoint));
        const all = runtime.client.listEndpoints();
        if (all.length > 1) {
            out.push(formatRow('configured:', `${all.length} total (failover ring)`));
        }
    } else {
        for (const [i, ep] of config.endpoints.entries()) {
            out.push(formatRow(`[${i}]:`, ep.url));
        }
    }
    out.push('\n');

    out.push(`  Daemon\n`);
    out.push(formatRow('lockfile:', formatLockStatus()));
    out.push(formatRow('metrics port:', String(config.metricsPort)));
    out.push('\n');

    if (deploymentUnavailable !== undefined) {
        out.push(`  Note: ${deploymentUnavailable}\n\n`);
    }
    if (snapshot !== undefined && snapshot.errors.length > 0) {
        out.push(`  Chain read errors:\n`);
        for (const e of snapshot.errors) out.push(`    - ${e}\n`);
        out.push('\n');
    }

    return out.join('');
}

export interface StatusData {
    config: Config;
    keystore: Keystore;
    runtime: ChainRuntime | undefined;
    deploymentUnavailable: string | undefined;
    snapshot: ChainSnapshot | undefined;
}

export async function collectStatusData(): Promise<StatusData> {
    if (!existsSync(configPath())) {
        throw new Error(
            `no config at ${configPath()}.\nRun \`automaton init\` first.`,
        );
    }
    if (!keystoreExists()) {
        throw new Error(
            `no keystore at ${walletPath()}.\nRun \`automaton init\` first.`,
        );
    }

    const config = loadConfig();
    const keystore = loadKeystore();

    let runtime: ChainRuntime | undefined;
    let deploymentUnavailable: string | undefined;
    try {
        runtime = buildChainRuntime(config);
    } catch (err) {
        if (err instanceof DeploymentNotAvailableError) {
            deploymentUnavailable = err.message;
        } else {
            throw err;
        }
    }

    let snapshot: ChainSnapshot | undefined;
    if (runtime !== undefined) {
        const walletAddr = Address.parse(keystore.address);
        snapshot = await collectChainSnapshot(runtime, walletAddr, {
            includeSchema: true,
        });
    }

    return { config, keystore, runtime, deploymentUnavailable, snapshot };
}

export async function runStatus(): Promise<string> {
    return renderStatus(await collectStatusData());
}

/** TON amount encoded in two forms: exact nano (string-safe) + human-readable decimal TON. */
export interface TonAmountJson {
    nano: string;
    ton: string;
}

export type AutomatonState = 'active' | 'inactive' | 'not-registered' | 'unavailable';

export interface AutomatonJsonBody {
    state: AutomatonState;
    stake?: TonAmountJson;
    isActive?: boolean;
    slashCount?: number;
    registeredAt?: string;
}

/**
 * `automaton status --format json` payload. Stable shape for agents + CI:
 * - TON amounts encoded as `{ nano, ton }` (nano is ground truth).
 * - Counters encoded as base-10 strings (bigint-safe).
 * - Endpoint apiKeys stripped.
 * - `deploymentUnavailable` surfaces the mainnet "not yet live" note.
 */
export interface StatusJsonPayload {
    version: string;
    network: 'testnet' | 'mainnet';
    paths: { config: string; keystore: string };
    wallet: {
        address: string;
        publicKey: string;
        balance: TonAmountJson | null;
    };
    automaton: AutomatonJsonBody;
    pool:
        | {
              address: string;
              activeCount: string | null;
              schemaVersion: number | null;
          }
        | null;
    registry:
        | {
              address: string;
              schemaVersion: number | null;
              jobCount: string | null;
              accumulatedFees: TonAmountJson | null;
              isPaused: boolean | null;
          }
        | null;
    fortuna:
        | {
              address: string;
          }
        | null;
    /**
     * Generic per-product address map — `{ [productName]: { [contract]: address } }`.
     * Adding a new product (Phoebe / Argus / …) surfaces here automatically
     * without a JSON schema change. The typed `registry` / `fortuna`
     * fields above are kept for back-compat with existing consumers.
     */
    products: Record<string, Record<string, string>>;
    endpoints: {
        current: string | null;
        configured: { url: string }[];
    };
    daemon: {
        lockfile: { kind: string; detail: string };
        metricsPort: number;
        metricsHost: string;
    };
    errors: string[];
    deploymentUnavailable: string | null;
}

/**
 * Build the `StatusJsonPayload` from a gathered `StatusData`. Exported
 * separately from the serialiser so agents can consume the typed object
 * without re-parsing the JSON string.
 */
export function buildStatusPayload(details: StatusData): StatusJsonPayload {
    const { config, keystore, runtime, deploymentUnavailable, snapshot } = details;

    const walletBalance: TonAmountJson | null =
        snapshot?.balance !== undefined
            ? { nano: snapshot.balance.toString(), ton: fromNano(snapshot.balance) }
            : null;

    let automatonState: AutomatonState;
    if (snapshot === undefined || snapshot.automaton === undefined) automatonState = 'unavailable';
    else if (snapshot.automaton === null) automatonState = 'not-registered';
    else automatonState = snapshot.automaton.isActive ? 'active' : 'inactive';

    const info = snapshot?.automaton ?? null;
    const automatonBody: AutomatonJsonBody =
        info !== null && info !== undefined
            ? {
                  state: automatonState,
                  stake: { nano: info.stake.toString(), ton: fromNano(info.stake) },
                  isActive: info.isActive,
                  slashCount: info.slashCount,
                  registeredAt: new Date(info.registeredAt * 1000).toISOString(),
              }
            : { state: automatonState };

    const lock = describeLock();

    return {
        version: pkgVersion(),
        network: config.network,
        paths: {
            config: configPath(),
            keystore: walletPath(),
        },
        wallet: {
            address: keystore.address,
            publicKey: keystore.publicKey,
            balance: walletBalance,
        },
        automaton: automatonBody,
        pool:
            runtime !== undefined
                ? {
                      address: runtime.deployment.pool.toString(),
                      activeCount:
                          snapshot?.activeAutomatonCount !== undefined
                              ? snapshot.activeAutomatonCount.toString()
                              : null,
                      schemaVersion: snapshot?.poolStorageVersion ?? null,
                  }
                : null,
        registry:
            runtime?.deployment.products.kronos?.registry !== undefined
                ? {
                      address: runtime.deployment.products.kronos.registry.toString(),
                      schemaVersion: snapshot?.registryStorageVersion ?? null,
                      jobCount: snapshot?.jobCount?.toString() ?? null,
                      accumulatedFees:
                          snapshot?.accumulatedFees !== undefined
                              ? {
                                    nano: snapshot.accumulatedFees.toString(),
                                    ton: fromNano(snapshot.accumulatedFees),
                                }
                              : null,
                      isPaused: snapshot?.isPaused ?? null,
                  }
                : null,
        fortuna:
            runtime?.deployment.products.fortuna?.fortuna !== undefined
                ? { address: runtime.deployment.products.fortuna?.fortuna.toString() }
                : null,
        products: buildProductsPayload(runtime),
        endpoints: {
            current: runtime?.client.currentEndpoint ?? null,
            configured: config.endpoints.map((e) => ({ url: e.url })),
        },
        daemon: {
            lockfile: { kind: lock.kind, detail: lock.detail },
            metricsPort: config.metricsPort,
            metricsHost: config.metricsHost,
        },
        errors: snapshot?.errors ?? [],
        deploymentUnavailable: deploymentUnavailable ?? null,
    };
}

function buildProductsPayload(
    runtime: ChainRuntime | undefined,
): Record<string, Record<string, string>> {
    if (runtime === undefined) return {};
    const out: Record<string, Record<string, string>> = {};
    for (const [name, addresses] of Object.entries(runtime.deployment.products)) {
        const entries = Object.entries(addresses);
        if (entries.length === 0) continue;
        out[name] = Object.fromEntries(entries.map(([k, addr]) => [k, addr.toString()]));
    }
    return out;
}

/**
 * Machine-readable counterpart to `renderStatus`. Serialises the payload
 * built by {@link buildStatusPayload}. Safe to paste into an issue —
 * endpoint apiKeys are redacted.
 */
export function renderStatusJson(details: StatusData): string {
    return JSON.stringify(buildStatusPayload(details), null, 2) + '\n';
}

export async function runStatusJson(): Promise<string> {
    return renderStatusJson(await collectStatusData());
}

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description(
            'Print a compact operator snapshot: network, wallet balance, automaton registration, drift counters, endpoint ring, lockfile. Read-only.',
        )
        .option(
            '--format <fmt>',
            'output format: "human" (default, padded table) or "json" (machine-readable; stable for agents)',
            'human',
        )
        .action(async (opts: { format: string }) => {
            if (opts.format !== 'human' && opts.format !== 'json') {
                process.stderr.write(
                    `error: --format must be "human" or "json" (got "${opts.format}")\n`,
                );
                process.exit(2);
            }
            const data = await collectStatusData();
            const out = opts.format === 'json' ? renderStatusJson(data) : renderStatus(data);
            process.stdout.write(out);
        });
}
