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
        out.push(`  Registry\n`);
        out.push(formatRow('address:', runtime.deployment.registry.toString()));
        if (snapshot?.registryStorageVersion !== undefined) {
            out.push(formatRow('schema version:', `v${snapshot.registryStorageVersion}`));
        }
        if (snapshot?.syncesReceived !== undefined) {
            out.push(formatRow('syncesReceived:', snapshot.syncesReceived.toString()));
        }
        if (snapshot?.slashesRequested !== undefined) {
            out.push(formatRow('slashesRequested:', snapshot.slashesRequested.toString()));
        }
        out.push('\n');

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

export async function runStatus(): Promise<string> {
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

    return renderStatus({ config, keystore, runtime, deploymentUnavailable, snapshot });
}

export function registerStatusCommand(program: Command): void {
    program
        .command('status')
        .description(
            'Print a compact operator snapshot: network, wallet balance, automaton registration, drift counters, endpoint ring, lockfile. Read-only.',
        )
        .action(async () => {
            const out = await runStatus();
            process.stdout.write(out);
        });
}
