// src/wallet/prompt.ts — password entry surface.
//
// Coverage gap pinned: the env-var fast-path is exercised in
// wallet.spec.ts, but the failure modes are not — specifically:
//   - getPasswordWithConfirmation rejects too-short passwords
//   - getPasswordWithConfirmation rejects too-short AUTOMATON_PASSWORD
//   - promptPassword throws NotInteractive when stdin is not a TTY
//     AND AUTOMATON_PASSWORD is unset (the Docker/systemd failure)
//
// A regression here would silently accept empty or 1-char passwords,
// weakening every keystore created from that point forward.

import { getPassword, getPasswordWithConfirmation, promptPassword } from '../src/wallet/prompt';

const savedEnv = process.env.AUTOMATON_PASSWORD;

afterEach(() => {
    if (savedEnv === undefined) delete process.env.AUTOMATON_PASSWORD;
    else process.env.AUTOMATON_PASSWORD = savedEnv;
});

describe('getPassword (env fast-path)', () => {
    it('returns AUTOMATON_PASSWORD when set', async () => {
        process.env.AUTOMATON_PASSWORD = 'longenough';
        await expect(getPassword()).resolves.toBe('longenough');
    });

    it('honors allowEnv: false (forces prompt → NotInteractiveError on non-TTY)', async () => {
        process.env.AUTOMATON_PASSWORD = 'longenough';
        // stdin in jest is NOT a TTY; with allowEnv:false the env is
        // ignored and we fall through to promptPassword which rejects.
        await expect(getPassword({ allowEnv: false })).rejects.toThrow(/not a TTY/);
    });
});

describe('getPasswordWithConfirmation (length + env validation)', () => {
    it('rejects AUTOMATON_PASSWORD shorter than 8 chars', async () => {
        process.env.AUTOMATON_PASSWORD = '1234567'; // 7 chars
        await expect(getPasswordWithConfirmation()).rejects.toThrow(
            /AUTOMATON_PASSWORD must be at least 8 characters/,
        );
    });

    it('accepts AUTOMATON_PASSWORD at exactly the 8-char boundary', async () => {
        process.env.AUTOMATON_PASSWORD = '12345678'; // 8 chars
        await expect(getPasswordWithConfirmation()).resolves.toBe('12345678');
    });
});

describe('promptPassword (TTY guard)', () => {
    it('throws NotInteractive when stdin is not a TTY (jest env)', async () => {
        // process.stdin.isTTY is undefined under jest by default — this
        // is the same shape Docker/systemd produces. The error message
        // is the operator-facing breadcrumb: "set AUTOMATON_PASSWORD".
        await expect(promptPassword('Password: ')).rejects.toThrow(
            /cannot prompt for password: stdin is not a TTY/,
        );
    });
});
