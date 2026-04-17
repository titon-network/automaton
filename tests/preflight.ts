// Jest globalSetup — runs once before any test file. Catches the silent-
// failure traps that come from pnpm file: deps:
//
//   1. `node_modules/forgeton-sdk/dist/index.js` or `node_modules/kronos-sdk/dist/index.js`
//      is missing — this repo's pnpm snapshot of the sibling SDKs doesn't include a
//      built dist/ because it wasn't there at install time. Tests would load stale
//      or non-existent JS.
//
//   2. `../forgeton/sdk/node_modules/` or `../kronos/sdk/node_modules/` exists —
//      someone ran `pnpm install` inside a sibling SDK. That creates a duplicate
//      `@ton/core` which breaks `Address instanceof` checks across package
//      boundaries (opaque "Invalid address. Got EQ..." errors).
//
// Both fail here with a clear, actionable message instead of surfacing as
// cryptic runtime errors later.

import { existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');

export default function preflight(): void {
    const issues: string[] = [];

    const forgetonSdkDist = join(ROOT, 'node_modules/forgeton-sdk/dist/index.js');
    if (!existsSync(forgetonSdkDist)) {
        issues.push(
            `node_modules/forgeton-sdk/dist/index.js is missing — rebuild + re-snapshot:\n` +
                `    pnpm run sync:sdks\n` +
                `  Reason: pnpm file: deps copy forgeton-sdk at install time. If its dist/\n` +
                `  was empty when you installed, this repo has no compiled JS to import.`,
        );
    }

    const kronosSdkDist = join(ROOT, 'node_modules/kronos-sdk/dist/index.js');
    if (!existsSync(kronosSdkDist)) {
        issues.push(
            `node_modules/kronos-sdk/dist/index.js is missing — rebuild + re-snapshot:\n` +
                `    pnpm run sync:sdks\n` +
                `  Reason: same file:-dep snapshot hazard as forgeton-sdk.`,
        );
    }

    const forgetonSdkNodeModules = join(ROOT, '..', 'forgeton', 'sdk', 'node_modules');
    if (existsSync(forgetonSdkNodeModules)) {
        issues.push(
            `../forgeton/sdk/node_modules exists — remove it:\n` +
                `    rm -rf ../forgeton/sdk/node_modules\n` +
                `  Reason: a nested node_modules in the sibling SDK creates a duplicate\n` +
                `  @ton/core, breaking Address instanceof checks across package boundaries.`,
        );
    }

    const kronosSdkNodeModules = join(ROOT, '..', 'kronos', 'sdk', 'node_modules');
    if (existsSync(kronosSdkNodeModules)) {
        issues.push(
            `../kronos/sdk/node_modules exists — remove it:\n` +
                `    rm -rf ../kronos/sdk/node_modules\n` +
                `  Same duplicate @ton/core hazard as ../forgeton/sdk/node_modules.`,
        );
    }

    if (issues.length > 0) {
        const banner = '='.repeat(78);
        console.error(
            `\n${banner}\nPREFLIGHT FAILED — ${issues.length} issue${issues.length > 1 ? 's' : ''}:\n${banner}\n\n` +
                issues.map((msg, i) => `${i + 1}. ${msg}`).join('\n\n') +
                `\n\n${banner}\n`,
        );
        throw new Error('Preflight checks failed — see messages above.');
    }
}
