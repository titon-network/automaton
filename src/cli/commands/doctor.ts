// `automaton doctor` — environment + installation sanity check.
//
// D.1 version: reports the pieces we *can* verify at scaffold time — Node
// version meets the >=22 engines constraint, both SDKs resolve and load
// without throwing, and the package's own version is readable. D.6 will
// expand this to cover config validity, wallet unlock, TON endpoint
// reachability, and wallet balance.
//
// Design note: we want doctor to stay useful even when config is missing
// (that's what `init` is for). So this command does NOT load config; it
// only checks the static install. A failing doctor here means "your
// install is broken" — which is a different class of problem from "your
// config says X but chain says Y".

import { existsSync } from 'fs';
import { Command } from 'commander';
import { configPath, loadConfig, walletPath } from '../../config';
import { keystoreExists, loadKeystore } from '../../wallet';
import { pkgVersion } from '../version';

interface Check {
    name: string;
    run(): Promise<string> | string;
}

const checks: Check[] = [
    {
        name: 'node >= 22',
        run: () => {
            const [major] = process.versions.node.split('.').map(Number);
            if (major === undefined || major < 22) {
                throw new Error(`node ${process.versions.node} < 22 — upgrade to Node 22+`);
            }
            return `node ${process.versions.node}`;
        },
    },
    {
        name: 'forgeton-sdk resolves',
        run: async () => {
            const mod = (await import('forgeton-sdk')) as Record<string, unknown>;
            const exportCount = Object.keys(mod).length;
            if (exportCount === 0) {
                throw new Error('forgeton-sdk has zero exports — run `pnpm run sync:sdks`');
            }
            return `${exportCount} exports`;
        },
    },
    {
        name: 'kronos-sdk resolves',
        run: async () => {
            const mod = (await import('kronos-sdk')) as Record<string, unknown>;
            const exportCount = Object.keys(mod).length;
            if (exportCount === 0) {
                throw new Error('kronos-sdk has zero exports — run `pnpm run sync:sdks`');
            }
            return `${exportCount} exports`;
        },
    },
    {
        name: 'package version readable',
        run: () => pkgVersion(),
    },
    {
        name: 'config',
        run: () => {
            const path = configPath();
            if (!existsSync(path)) {
                // Not an error at this stage — `automaton init` creates one.
                // Report as "absent" so operator knows where doctor looked.
                return `absent at ${path} (run \`automaton init\`)`;
            }
            const cfg = loadConfig(path);
            return `${path} — network=${cfg.network}, endpoints=${cfg.endpoints.length}`;
        },
    },
    {
        name: 'keystore',
        run: () => {
            const path = walletPath();
            if (!keystoreExists(path)) {
                return `absent at ${path} (run \`automaton init\`)`;
            }
            // Address + network are stored plaintext in the keystore, so we
            // can surface them without prompting for a password.
            const blob = loadKeystore(path);
            return `${path} — network=${blob.network}, address=${blob.address}`;
        },
    },
];

export function registerDoctorCommand(program: Command): void {
    program
        .command('doctor')
        .description('Run environment + install sanity checks. Exits non-zero on failure.')
        .action(async () => {
            let failed = 0;
            for (const check of checks) {
                try {
                    const detail = await check.run();
                    process.stdout.write(`  ok    ${check.name} — ${detail}\n`);
                } catch (err) {
                    failed += 1;
                    const message = err instanceof Error ? err.message : String(err);
                    process.stdout.write(`  FAIL  ${check.name} — ${message}\n`);
                }
            }
            if (failed > 0) {
                process.stdout.write(`\n${failed} check(s) failed.\n`);
                process.exit(1);
            }
            process.stdout.write(`\nall ${checks.length} checks passed.\n`);
        });
}
