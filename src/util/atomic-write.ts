// Atomic file write — used for config + keystore + any other "must not be
// half-written after a crash" file the automaton persists.
//
// Technique: write to a `.<pid>.tmp` sibling, chmod it explicitly (since
// writeFileSync's `mode` arg is masked by umask), then rename over the
// target. rename(2) is atomic on POSIX within the same filesystem, so
// readers either see the old file or the new one — never a partial one.
//
// The `.pid` suffix in the tmp name stops two concurrent writers from the
// same host stomping each other's tmp. Cross-host concurrent writes to the
// same mount aren't supported — that's a distributed-systems problem and
// the automaton is single-instance by design (see src/chain/lockfile.ts
// when it lands).

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
}
