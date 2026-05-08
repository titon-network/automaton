// CheckpointState JSON round-trip: schema-version rejection, malformed JSON,
// null-entry preservation (explicitly "no checkpoint yet"), atomic-write
// file mode (0600), roundtrip through withCheckpoint / getCheckpoint.

import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
    CHECKPOINT_STATE_VERSION,
    CheckpointStateError,
    emptyCheckpointState,
    getCheckpoint,
    loadCheckpointState,
    saveCheckpointState,
    withCheckpoint,
} from '../src/worker/checkpoint';

describe('checkpoint state', () => {
    let dir: string;
    let path: string;

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'titon-checkpoint-'));
        path = join(dir, 'state.json');
    });

    afterEach(() => {
        rmSync(dir, { recursive: true, force: true });
    });

    it('returns an empty state when the file is absent', () => {
        const state = loadCheckpointState(path);
        expect(state.version).toBe(CHECKPOINT_STATE_VERSION);
        expect(state.checkpoints).toEqual({});
    });

    it('round-trips through save + load', () => {
        const before = emptyCheckpointState();
        const updated = withCheckpoint(before, 'EQC1', { lt: '42', hash: 'deadbeef' });

        saveCheckpointState(updated, path);
        const loaded = loadCheckpointState(path);

        expect(loaded).toEqual(updated);
    });

    it('writes with 0600 perms', () => {
        saveCheckpointState(emptyCheckpointState(), path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
    });

    it('preserves existing checkpoints when writing a new one', () => {
        let state = emptyCheckpointState();
        state = withCheckpoint(state, 'EQC1', { lt: '1', hash: 'aa' });
        state = withCheckpoint(state, 'EQC2', { lt: '2', hash: 'bb' });

        expect(state.checkpoints).toEqual({
            EQC1: { lt: '1', hash: 'aa' },
            EQC2: { lt: '2', hash: 'bb' },
        });
    });

    it('getCheckpoint returns null for an address we have not seen', () => {
        const state = emptyCheckpointState();
        expect(getCheckpoint(state, 'EQC-unknown')).toBeNull();
    });

    it('throws CheckpointStateError on malformed JSON', () => {
        writeFileSync(path, 'not json');
        expect(() => loadCheckpointState(path)).toThrow(CheckpointStateError);
    });

    it('throws CheckpointStateError on unexpected version', () => {
        writeFileSync(path, JSON.stringify({ version: 99, checkpoints: {} }));
        expect(() => loadCheckpointState(path)).toThrow(/Invalid literal value/);
    });

    it('throws CheckpointStateError on invalid checkpoint entry (non-decimal lt)', () => {
        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                checkpoints: { EQC1: { lt: 'not-a-number', hash: 'aa' } },
            }),
        );
        expect(() => loadCheckpointState(path)).toThrow(/lt must be a decimal string/);
    });

    it('throws CheckpointStateError on invalid hash (non-hex)', () => {
        writeFileSync(
            path,
            JSON.stringify({
                version: 1,
                checkpoints: { EQC1: { lt: '1', hash: 'not hex!' } },
            }),
        );
        expect(() => loadCheckpointState(path)).toThrow(/hash must be hex/);
    });

    it('accepts explicit null checkpoints', () => {
        writeFileSync(
            path,
            JSON.stringify({ version: 1, checkpoints: { EQC1: null } }),
        );
        const state = loadCheckpointState(path);
        expect(getCheckpoint(state, 'EQC1')).toBeNull();
    });

    it('withCheckpoint does not mutate the original state', () => {
        const before = emptyCheckpointState();
        const after = withCheckpoint(before, 'EQC1', { lt: '1', hash: 'aa' });
        expect(before.checkpoints).toEqual({});
        expect(after.checkpoints).toHaveProperty('EQC1');
    });
});
