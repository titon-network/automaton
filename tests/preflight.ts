// Jest globalSetup — delegates to `scripts/preflight.mjs` so there's a
// single source of truth for the sibling-SDK landmine checks. The same
// script runs at postinstall time and via `pnpm run preflight`.
//
// Rationale for delegation (instead of re-implementing the checks here):
// drift across two copies of the same path list is exactly the kind of
// landmine preflight is supposed to catch in the first place.

import { spawnSync } from 'child_process';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'preflight.mjs');

export default function preflight(): void {
    const result = spawnSync('node', [SCRIPT], {
        cwd: ROOT,
        encoding: 'utf8',
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);

    if (result.error) {
        throw result.error;
    }
    if (result.status !== 0) {
        throw new Error(
            `Preflight checks failed — see messages above. ` +
                `(run \`pnpm run preflight\` for the same diagnostic.)`,
        );
    }
}
