#!/usr/bin/env node
// Preflight — catches the sibling-SDK snapshot landmines that are
// invisible at install time but explode as cryptic errors later.
//
// Runs in three places:
//
//   1. postinstall  — `pnpm install` triggers this automatically via
//                     the `postinstall` script in package.json. Passes
//                     `--warn-only` so a fresh clone (where sibling SDK
//                     dist/ hasn't been built yet) isn't bricked.
//
//   2. tests/       — jest globalSetup spawns us; exits non-zero if the
//                     SDK snapshot is stale, which fails fast before a
//                     single test runs.
//
//   3. ad-hoc       — `pnpm run preflight` for operators / CI gates.
//
// Checks:
//   - node_modules/{forgeton,kronos}-sdk/dist/index.js exists
//     (sibling SDK was built before we snapshotted it)
//   - ../{forgeton,kronos}/sdk/node_modules/ does NOT exist
//     (nested install would duplicate @ton/core and break
//      `Address instanceof` across package boundaries)
//
// If the working directory isn't part of the monorepo (i.e. installed
// from npm as a dependency), this exits 0 — the sibling-SDK hazards
// are dev-only. See package.json `files` for what ships.

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const warnOnly = process.argv.includes('--warn-only');

// "Are we inside the titon monorepo?" — if neither sibling exists we
// were installed standalone (npm, tarball) and these checks don't apply.
const siblingsPresent =
    existsSync(join(ROOT, '..', 'forgeton')) ||
    existsSync(join(ROOT, '..', 'kronos'));

if (!siblingsPresent) {
    process.exit(0);
}

const SDKS = [
    { name: 'forgeton-sdk', sibling: '../forgeton/sdk' },
    { name: 'kronos-sdk', sibling: '../kronos/sdk' },
];

const issues = [];

for (const { name, sibling } of SDKS) {
    const dist = join(ROOT, 'node_modules', name, 'dist/index.js');
    if (!existsSync(dist)) {
        issues.push(
            `node_modules/${name}/dist/index.js is missing — rebuild + re-snapshot:\n` +
                `    pnpm run sync:sdks\n` +
                `  Reason: pnpm file: deps copy ${name} at install time. If its dist/\n` +
                `  was empty when you installed, this repo has no compiled JS to import.`,
        );
    }

    const nested = join(ROOT, sibling, 'node_modules');
    if (existsSync(nested)) {
        issues.push(
            `${sibling}/node_modules exists — remove it:\n` +
                `    rm -rf ${sibling}/node_modules\n` +
                `  Reason: a nested node_modules in the sibling SDK creates a duplicate\n` +
                `  @ton/core, breaking Address instanceof checks across package boundaries.`,
        );
    }
}

if (issues.length === 0) {
    process.exit(0);
}

const banner = '='.repeat(78);
const label = warnOnly ? 'PREFLIGHT WARNING' : 'PREFLIGHT FAILED';
const stream = warnOnly ? process.stdout : process.stderr;

stream.write(
    `\n${banner}\n${label} — ${issues.length} issue${issues.length > 1 ? 's' : ''}:\n${banner}\n\n` +
        issues.map((msg, i) => `${i + 1}. ${msg}`).join('\n\n') +
        `\n\n${banner}\n`,
);

if (warnOnly) {
    stream.write(
        `\nThis is a post-install warning. Build + test will fail until resolved.\n` +
            `Run \`pnpm run sync:sdks\` (or the commands above) to fix.\n\n`,
    );
    process.exit(0);
}

process.exit(1);
