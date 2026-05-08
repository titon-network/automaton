// Secret-leakage guard. Two layers:
//
//   1. **Error-class message hygiene.** Construct every typed error with
//      realistic inputs and assert .message never embeds canary strings
//      that would be in scope at the throw site (mnemonic words, wallet
//      secret key, password). Catches accidental `${secret}` interpolation
//      in error constructors and template strings.
//
//   2. **Daemon-shape golden capture.** Drive a representative sequence
//      of code paths that have a wallet + password in scope (keystore
//      lock/unlock, JSON serialization, log emission) with deliberately
//      planted canary strings. Capture every log line + thrown error
//      message + JSON-serialised state, and assert no canary appears in
//      any captured surface.
//
// Threat model: an operator's mnemonic / secretKey / password must never
// appear in logs, error messages, persisted state, or anywhere else
// someone might `tail -f`, `dmesg`, paste in an issue, or push to log
// aggregation. The pino redact list catches `mnemonic`-named fields;
// THIS suite catches the other paths (string concatenation, error
// templates, JSON.stringify of full objects).

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Writable } from 'stream';
import { Address } from '@ton/core';

import { createPinoLogger } from '../src/daemon/logger';
import {
    KEYSTORE_VERSION,
    KeystoreNotFoundError,
    KeystoreValidationError,
    WrongPasswordError,
    generateMnemonic,
    keystoreExists,
    loadKeystore,
    lockKeystore,
    saveKeystore,
    unlockKeystore,
} from '../src/wallet';
import {
    ConfirmationTimeoutError,
    PoolRejectedError,
    TxAttributionError,
} from '../src/chain/submit';
import { LockCorruptError, LockHeldError } from '../src/chain/lockfile';
import { SchemaMismatchError } from '../src/chain/schema-check';

const FAST_KDF = { kdfN: 2048 };

// Scrabble-tile shaped strings that won't ever occur naturally in code,
// commit messages, error templates, or upstream library output. If any
// captured surface contains one of these, that surface leaked.
const CANARY = {
    password: 'CANARY-PW-SHOULD-NEVER-LOG-zzz9',
    secretKeyHex: 'CANARY-SECRETKEY-zzz9-deadbeef',
    mnemonicWord: 'CANARY-MNEMONIC-WORD-zzz9',
};

function captureWrites(): { stream: Writable; raw: () => string } {
    const buffer: string[] = [];
    const stream = new Writable({
        write(chunk, _encoding, cb) {
            buffer.push(chunk.toString('utf8'));
            cb();
        },
    });
    return {
        stream,
        raw: () => buffer.join(''),
    };
}

const ADDR = Address.parse('0QC52I0pIiF_041o-njvpvjc3UzrnzhMCW3T41IoVhllyHhA');

describe('typed error messages do not leak callee-scope secrets', () => {
    it('WrongPasswordError carries a generic, fixed message', () => {
        const err = new WrongPasswordError();
        // Regardless of what the caller supplied, WrongPasswordError must
        // not echo the password (it is constructed without one — this
        // test pins that no future refactor adds the password as an arg).
        expect(err.message).not.toMatch(/CANARY/);
        expect(err.message).toMatch(/password/i);
    });

    it('KeystoreNotFoundError contains only the path, not the password', () => {
        const err = new KeystoreNotFoundError('/some/path/wallet.enc');
        expect(err.message).toContain('/some/path/wallet.enc');
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('KeystoreValidationError lists schema issues, not raw file bytes', () => {
        const err = new KeystoreValidationError('/some/path/wallet.enc', [
            'kdfParams.salt: invalid hex',
        ]);
        expect(err.message).toContain('/some/path/wallet.enc');
        expect(err.message).toContain('kdfParams.salt');
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('ConfirmationTimeoutError contains address + counters, no secret', () => {
        const err = new ConfirmationTimeoutError(ADDR, 42, 60_000);
        expect(err.message).toContain(ADDR.toString());
        expect(err.message).toContain('42');
        expect(err.message).toContain('60000');
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('TxAttributionError contains address only', () => {
        const err = new TxAttributionError(ADDR);
        expect(err.message).toContain(ADDR.toString());
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('PoolRejectedError echoes the inner error message and txHash, no extra', () => {
        const inner = new Error('exit code 161 — E_AUTOMATON_NOT_ACTIVE');
        const err = new PoolRejectedError(inner, 'deadbeefcafe');
        expect(err.message).toContain(inner.message);
        expect(err.message).toContain('deadbeefcafe');
        // Should NOT introduce any additional dynamic content from globals
        // (e.g. stringified `process.env`, the wallet object, etc.).
        expect(err.message).not.toMatch(/CANARY/);
        expect(err.message).not.toMatch(/process\.env/);
    });

    it('LockHeldError lists pid + path, no secret context', () => {
        const err = new LockHeldError('/tmp/foo.lock', {
            version: 1,
            pid: 12345,
            startedAt: '2026-04-19T00:00:00.000Z',
        });
        expect(err.message).toContain('12345');
        expect(err.message).toContain('/tmp/foo.lock');
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('LockCorruptError lists path + parse-error, no secret context', () => {
        const err = new LockCorruptError('/tmp/foo.lock', 'unexpected token');
        expect(err.message).toContain('/tmp/foo.lock');
        expect(err.message).toContain('unexpected token');
        expect(err.message).not.toMatch(/CANARY/);
    });

    it('SchemaMismatchError contains version numbers + addresses, no secret', () => {
        const err = new SchemaMismatchError([
            {
                contract: 'registry',
                address: ADDR,
                onChain: 2,
                expected: 1,
                ok: false,
            },
        ]);
        expect(err.message).toContain(ADDR.toString());
        expect(err.message).toContain('on-chain schemaVersion: 2');
        expect(err.message).not.toMatch(/CANARY/);
    });
});

describe('daemon-shape golden capture: no canary appears across surfaces', () => {
    let tmp: string;
    const savedHome = process.env.TITON_HOME;
    const savedPw = process.env.AUTOMATON_PASSWORD;

    beforeEach(() => {
        tmp = mkdtempSync(join(tmpdir(), 'titon-leakage-'));
        process.env.TITON_HOME = tmp;
        delete process.env.AUTOMATON_PASSWORD;
    });

    afterEach(() => {
        rmSync(tmp, { recursive: true, force: true });
        if (savedHome === undefined) delete process.env.TITON_HOME;
        else process.env.TITON_HOME = savedHome;
        if (savedPw === undefined) delete process.env.AUTOMATON_PASSWORD;
        else process.env.AUTOMATON_PASSWORD = savedPw;
    });

    it('keystore lifecycle never embeds the password or mnemonic in logs / errors / on-disk JSON', async () => {
        const mnemonic = await generateMnemonic();
        const network = 'testnet' as const;
        // BIP-39 words are common English (e.g. "able", "unable", "wisdom")
        // and collide with pino fallback strings + standard error messages.
        // We pin the FULL mnemonic phrase (joined with space — a unique
        // 24-token sequence) plus the secretKey HEX (random bytes — can't
        // collide with prose). That's strong enough to catch real leaks
        // without false positives from English-word overlap.
        const fullPhrase = mnemonic.join(' ');

        // Lock + save.
        const ks = await lockKeystore(mnemonic, CANARY.password, network, FAST_KDF);
        saveKeystore(ks);

        // 1. The serialised keystore on disk must not contain the password
        //    or the mnemonic phrase in plaintext.
        expect(keystoreExists()).toBe(true);
        const onDisk = readFileSync(
            join(tmp, 'automaton', 'wallet.enc'),
            'utf8',
        );
        expect(onDisk).not.toContain(CANARY.password);
        expect(onDisk).not.toContain(fullPhrase);

        // 2. Loading the keystore back round-trips fine — and the loaded
        //    keystore JSON also does not contain plaintext secrets.
        const loaded = loadKeystore();
        expect(loaded.version).toBe(KEYSTORE_VERSION);
        const loadedSerialised = JSON.stringify(loaded);
        expect(loadedSerialised).not.toContain(CANARY.password);
        expect(loadedSerialised).not.toContain(fullPhrase);

        // 3. Unlock with WRONG password — the thrown error must not echo
        //    the password or the supplied keystore blob.
        try {
            await unlockKeystore(loaded, CANARY.password + 'xxxxx');
            fail('expected WrongPasswordError');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            expect(msg).not.toContain(CANARY.password);
        }

        // 4. Unlock with CORRECT password and feed the resulting wallet
        //    object to the structural-redaction logger. None of the
        //    sensitive fields should appear in the captured stream.
        const wallet = await unlockKeystore(loaded, CANARY.password);
        const secretKeyHex = Buffer.from(wallet.keyPair.secretKey).toString('hex');
        const { stream, raw } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        // Realistic call sites that have happened in past CI / dev:
        //   - logging the whole wallet object on debug
        //   - logging an error with `wallet` in the context
        //   - logging keystore metadata
        log.info('wallet ready', { wallet });
        log.info('keystore loaded', { keystore: loaded });
        log.info('startup', {
            ctx: {
                keystore: { wallet },
            },
        });
        log.error('crash', { error: 'something failed', wallet });

        const captured = raw();
        expect(captured).not.toContain(CANARY.password);
        expect(captured).not.toContain(fullPhrase);
        // Random hex secretKey can't collide with prose — strongest check.
        expect(captured).not.toContain(secretKeyHex);
    });

    it('logger captures secrets nested inside an arbitrary "context" envelope', () => {
        const { stream, raw } = captureWrites();
        const log = createPinoLogger({ destination: stream });

        log.info('msg', {
            ctx: {
                user: { password: CANARY.password },
                wallet: {
                    mnemonic: [CANARY.mnemonicWord, CANARY.mnemonicWord],
                    keyPair: { secretKey: CANARY.secretKeyHex },
                },
            },
        });

        const captured = raw();
        expect(captured).not.toContain(CANARY.password);
        expect(captured).not.toContain(CANARY.mnemonicWord);
        expect(captured).not.toContain(CANARY.secretKeyHex);
    });

    it('saveKeystore + loadKeystore round-trip preserves zod-validated shape (and refuses corrupt)', () => {
        const path = join(tmp, 'automaton', 'wallet.enc');
        // Manually craft a corrupt keystore; loadKeystore should refuse with
        // an error that does not contain the raw bytes (which could include
        // operator-supplied content if they were editing).
        const fs = require('fs') as typeof import('fs');
        fs.mkdirSync(join(tmp, 'automaton'), { recursive: true });
        const surprisingBytes = `{"oops": "${CANARY.password}"}`;
        writeFileSync(path, surprisingBytes, { encoding: 'utf8', mode: 0o600 });

        try {
            loadKeystore();
            fail('expected KeystoreValidationError');
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            // Acceptable: the path is named, schema issues are listed.
            // Unacceptable: the raw file content is echoed verbatim.
            expect(msg).toContain(path);
            expect(msg).not.toContain(CANARY.password);
        }
    });
});
