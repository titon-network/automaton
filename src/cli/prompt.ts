// Plain-text interactive prompt helpers used by `automaton init`.
//
// Hidden-mode (password) prompting lives in `src/wallet/prompt.ts` because
// it has its own env-var fallback and validation. Everything here is for
// line-visible input: network choice, mnemonic paste, confirm Y/N, etc.
//
// Each helper refuses gracefully when stdin is not a TTY — CI / Docker
// users should either pass every flag (`--network`, `--import-mnemonic`,
// `--password-file`) so prompts are bypassed entirely, or pipe a canned
// response. We do NOT auto-accept defaults in non-TTY mode because that
// silently hides configuration mistakes.

import { createInterface } from 'readline/promises';

export class NotInteractiveError extends Error {
    constructor(message: string = 'stdin is not a TTY — cannot prompt interactively') {
        super(message);
        this.name = 'NotInteractiveError';
    }
}

async function readLineOnce(question: string): Promise<string> {
    if (!process.stdin.isTTY) throw new NotInteractiveError();
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
        return await rl.question(question);
    } finally {
        rl.close();
    }
}

export interface PromptTextOptions {
    default?: string;
    allowEmpty?: boolean;
}

export async function promptText(
    message: string,
    options: PromptTextOptions = {},
): Promise<string> {
    const suffix = options.default !== undefined ? ` [${options.default}]` : '';
    const question = `${message}${suffix}: `;
    while (true) {
        const raw = await readLineOnce(question);
        const trimmed = raw.trim();
        if (trimmed.length > 0) return trimmed;
        if (options.default !== undefined) return options.default;
        if (options.allowEmpty) return '';
        process.stdout.write('  Please enter a value.\n');
    }
}

export async function promptChoice<T extends string>(
    message: string,
    choices: readonly T[],
    options: { default?: T } = {},
): Promise<T> {
    const choiceList = choices.join(' / ');
    const label = `${message} (${choiceList})`;
    while (true) {
        const raw = await promptText(label, { default: options.default });
        const normalised = raw.trim().toLowerCase();
        const hit = choices.find((c) => c.toLowerCase() === normalised);
        if (hit !== undefined) return hit;
        process.stdout.write(`  Must be one of: ${choiceList}\n`);
    }
}

export async function promptConfirm(
    message: string,
    options: { default?: boolean } = {},
): Promise<boolean> {
    const hint = options.default === undefined ? 'y/n' : options.default ? 'Y/n' : 'y/N';
    while (true) {
        const raw = await promptText(`${message} [${hint}]`, { allowEmpty: true });
        const normalised = raw.trim().toLowerCase();
        if (normalised === '' && options.default !== undefined) return options.default;
        if (normalised === 'y' || normalised === 'yes') return true;
        if (normalised === 'n' || normalised === 'no') return false;
        process.stdout.write('  Please answer y or n.\n');
    }
}
