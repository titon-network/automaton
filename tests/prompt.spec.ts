// Password prompt tests — env-var fallback + TTY-absent error paths.
//
// `promptPassword` itself writes raw bytes to a TTY; we don't simulate
// an interactive TTY here. What we DO cover:
//   - AUTOMATON_PASSWORD bypasses the prompt
//   - getPasswordWithConfirmation accepts an env value but rejects short ones
//   - Non-TTY stdin rejects with an actionable error
//   - allowEnv=false forces the prompt path even when env is set

import { getPassword, getPasswordWithConfirmation, promptPassword } from '../src/wallet/prompt';

describe('getPassword', () => {
    const saved = process.env.AUTOMATON_PASSWORD;
    afterEach(() => {
        if (saved === undefined) delete process.env.AUTOMATON_PASSWORD;
        else process.env.AUTOMATON_PASSWORD = saved;
    });

    it('returns AUTOMATON_PASSWORD when set', async () => {
        process.env.AUTOMATON_PASSWORD = 'hunter2-secret';
        const pw = await getPassword({ prompt: 'x' });
        expect(pw).toBe('hunter2-secret');
    });

    it('ignores empty AUTOMATON_PASSWORD (falls through to prompt)', async () => {
        process.env.AUTOMATON_PASSWORD = '';
        // stdin is not a TTY under jest — prompt path rejects. We only need
        // to confirm the env path did NOT short-circuit here.
        await expect(getPassword({ prompt: 'x' })).rejects.toThrow(/not a TTY/);
    });

    it('allowEnv=false forces the prompt path even if env is set', async () => {
        process.env.AUTOMATON_PASSWORD = 'still-set';
        await expect(getPassword({ prompt: 'x', allowEnv: false })).rejects.toThrow(/not a TTY/);
    });
});

describe('getPasswordWithConfirmation', () => {
    const saved = process.env.AUTOMATON_PASSWORD;
    afterEach(() => {
        if (saved === undefined) delete process.env.AUTOMATON_PASSWORD;
        else process.env.AUTOMATON_PASSWORD = saved;
    });

    it('bypasses the confirm prompt when env is set and meets length', async () => {
        process.env.AUTOMATON_PASSWORD = 'at-least-eight-chars';
        const pw = await getPasswordWithConfirmation('new', 'confirm');
        expect(pw).toBe('at-least-eight-chars');
    });

    it('rejects AUTOMATON_PASSWORD when it is too short', async () => {
        process.env.AUTOMATON_PASSWORD = 'x';
        await expect(getPasswordWithConfirmation('new', 'confirm')).rejects.toThrow(
            /at least 8 characters/,
        );
    });
});

describe('promptPassword', () => {
    it('rejects with a clear message when stdin is not a TTY', async () => {
        // jest's execution context pipes stdin → isTTY is false.
        await expect(promptPassword('pw: ')).rejects.toThrow(/not a TTY/);
    });
});
