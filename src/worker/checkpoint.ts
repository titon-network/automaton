// Persistent checkpoint for the event-subscriber loop. Records the
// (lt, hash) of the last processed transaction for each contract we
// follow (registry + pool). On daemon restart, we resume from there
// so we don't reprocess every event since deploy.
//
// File format (atomic-write via src/util/atomic-write.ts):
//
//   ~/.titon/automaton/state.json
//   {
//     "version": 1,
//     "checkpoints": {
//       "<address-str>": { "lt": "12345", "hash": "<hex>" },
//       "<address-str>": null          // explicitly "no checkpoint yet"
//     }
//   }
//
// An absent file and an empty `checkpoints` map both mean "first run —
// start from latest". We persist via zod-validated JSON, same discipline
// as the config + keystore loaders, so a corrupt state.json surfaces with
// a clear error instead of silent replay from genesis.

import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { statePath } from '../config/paths';
import { atomicWriteFile } from '../util/atomic-write';

export const CHECKPOINT_STATE_VERSION = 1;

export const CheckpointEntrySchema = z.object({
    lt: z.string().regex(/^\d+$/, 'lt must be a decimal string'),
    hash: z.string().regex(/^[0-9a-f]+$/i, 'hash must be hex'),
});
export type CheckpointEntry = z.infer<typeof CheckpointEntrySchema>;

export const CheckpointStateSchema = z.object({
    version: z.literal(CHECKPOINT_STATE_VERSION),
    checkpoints: z.record(z.string(), CheckpointEntrySchema.nullable()),
});
export type CheckpointState = z.infer<typeof CheckpointStateSchema>;

export class CheckpointStateError extends Error {
    constructor(public readonly path: string, public readonly issues: string[]) {
        super(`state at ${path} is malformed:\n` + issues.map((i) => `  ${i}`).join('\n'));
        this.name = 'CheckpointStateError';
    }
}

export function emptyCheckpointState(): CheckpointState {
    return { version: CHECKPOINT_STATE_VERSION, checkpoints: {} };
}

/** Load state.json from disk. Returns an empty state if the file is absent. */
export function loadCheckpointState(path: string = statePath()): CheckpointState {
    if (!existsSync(path)) return emptyCheckpointState();
    let parsed: unknown;
    try {
        parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new CheckpointStateError(path, [`not valid JSON: ${msg}`]);
    }
    const result = CheckpointStateSchema.safeParse(parsed);
    if (!result.success) {
        const issues = result.error.issues.map((issue) => {
            const where = issue.path.length > 0 ? issue.path.join('.') : '<root>';
            return `${where}: ${issue.message}`;
        });
        throw new CheckpointStateError(path, issues);
    }
    return result.data;
}

export function saveCheckpointState(
    state: CheckpointState,
    path: string = statePath(),
): void {
    const validated = CheckpointStateSchema.parse(state);
    atomicWriteFile(path, JSON.stringify(validated, null, 2) + '\n', 0o600);
}

/** Pure helper: produce a new state with one entry updated. */
export function withCheckpoint(
    state: CheckpointState,
    address: string,
    entry: CheckpointEntry,
): CheckpointState {
    return {
        version: state.version,
        checkpoints: { ...state.checkpoints, [address]: entry },
    };
}

/** Pure helper: read a single address's checkpoint (null means "no point yet"). */
export function getCheckpoint(
    state: CheckpointState,
    address: string,
): CheckpointEntry | null {
    return state.checkpoints[address] ?? null;
}
