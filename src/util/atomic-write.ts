// Atomic file write — open a `.<pid>.tmp` sibling with `O_EXCL`+`O_CREAT`
// (so a pre-existing tmp file or symlink fails the open instead of being
// followed), write the data, fchmod the open fd to bypass umask, close,
// then rename. rename(2) is atomic on POSIX within a filesystem, so
// readers see either the old file or the new one, never a partial one.
//
// Why O_EXCL: prior versions used `writeFileSync(tmp, ...)`, which opens
// without O_EXCL. If an attacker pre-created `${path}.${pid}.tmp` as a
// symlink to (e.g.) /etc/passwd, the write would follow the symlink and
// scribble on the target, and the subsequent chmod would chmod the
// target. With `wx` (= O_WRONLY | O_CREAT | O_EXCL), the open atomically
// fails with EEXIST on any pre-existing file or symlink at that path.
//
// Why fchmod (not chmodSync): chmodSync follows symlinks too. By the
// time we'd reach a path-based chmod, an attacker who replaced our file
// could redirect the chmod to an arbitrary target. fchmod operates on
// the open fd, so it's bound to the inode we created.
//
// Parent-dir mode: `mkdirSync(..., { recursive: true })` defaults to
// 0o777 & ~umask (typically 0o755). The keystore lives here; tighten
// to 0o700 so the directory itself is operator-only.

import { closeSync, fchmodSync, mkdirSync, openSync, renameSync, writeSync } from 'fs';
import { dirname } from 'path';

export function atomicWriteFile(path: string, data: string, mode = 0o600): void {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    // O_EXCL via 'wx' — fails on existing file or symlink. Mode here is
    // umask-masked, so we fchmod below to enforce the requested mode.
    const fd = openSync(tmp, 'wx', mode);
    try {
        fchmodSync(fd, mode);
        writeSync(fd, data);
    } finally {
        closeSync(fd);
    }
    renameSync(tmp, path);
}
