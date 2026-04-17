// Atomic file write — write to a `.<pid>.tmp` sibling, chmod explicitly
// (since writeFileSync's `mode` arg is masked by umask), then rename.
// rename(2) is atomic on POSIX within a filesystem, so readers see either
// the old file or the new one, never a partial one. The `.pid` suffix
// keeps two concurrent writers from the same host off each other's tmp.

import { chmodSync, mkdirSync, renameSync, writeFileSync } from 'fs';
import { dirname } from 'path';

export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, data, { mode });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
}
