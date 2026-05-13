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

// forgeton + kronos are always required (Phase D surface); atlas + fortuna +
// themis are only required when a sibling repo is checked out — operators
// building from the npm tarball never see them and shouldn't fail on their
// absence.
const SDKS = [
    { name: '@titon-network/forgeton-sdk', sibling: '../forgeton/sdks/typescript', optional: false },
    { name: '@titon-network/kronos-sdk', sibling: '../kronos/sdks/typescript', optional: false },
    { name: '@titon-network/atlas-sdk', sibling: '../atlas/sdks/typescript', optional: true },
    { name: '@titon-network/fortuna-sdk', sibling: '../fortuna/sdks/typescript', optional: true },
    { name: '@titon-network/themis-sdk', sibling: '../themis/sdks/typescript', optional: true },
];

const issues = [];

for (const { name, sibling, optional } of SDKS) {
    // Optional SDKs (atlas, fortuna) skip the checks entirely when the
    // sibling repo isn't checked out — operators who haven't cloned those
    // repos don't need them for Kronos-only use.
    if (optional && !existsSync(join(ROOT, sibling))) {
        continue;
    }

    const dist = join(ROOT, 'node_modules', name, 'dist/index.js');
    if (!existsSync(dist)) {
        issues.push(
            `node_modules/${name}/dist/index.js is missing — rebuild + re-snapshot:\n` +
                `    pnpm run sync:sdks\n` +
                `  Reason: pnpm file: deps copy ${name} at install time. If its dist/\n` +
                `  was empty when you installed, this repo has no compiled JS to import.`,
        );
    }

    // What matters for correctness: the SNAPSHOTTED copy (inside our
    // node_modules) must not have nested @ton/* — duplicates break
    // `Address instanceof`. pnpm file: deps already strip nested
    // node_modules contents at snapshot time; a dangling copy here means
    // someone bypassed pnpm.
    //
    // For forgeton/kronos we additionally flag the sibling's own
    // node_modules as "probably pnpm install ran in the wrong directory"
    // — those repos aren't meant to have workspace packages. Atlas +
    // Fortuna legitimately have their own nested node_modules because
    // their `sdk/` is a workspace member of the parent repo (used for
    // SDK-local tests). Skip that check for them.
    const snapshotNested = join(ROOT, 'node_modules', name, 'node_modules/@ton');
    if (existsSync(snapshotNested)) {
        issues.push(
            `node_modules/${name}/node_modules/@ton exists — clean reinstall:\n` +
                `    rm -rf node_modules/${name} && pnpm install --force\n` +
                `  Reason: duplicate @ton/core in the SDK snapshot breaks Address\n` +
                `  instanceof checks across package boundaries.`,
        );
    }

    if (!optional) {
        const nested = join(ROOT, sibling, 'node_modules');
        if (existsSync(nested)) {
            issues.push(
                `${sibling}/node_modules exists — remove it:\n` +
                    `    rm -rf ${sibling}/node_modules\n` +
                    `  Reason: ${name} is not meant to be a workspace package; a\n` +
                    `  nested node_modules here usually means \`pnpm install\` ran in\n` +
                    `  the wrong directory.`,
            );
        }
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
