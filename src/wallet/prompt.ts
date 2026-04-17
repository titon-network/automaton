// Password prompt with AUTOMATON_PASSWORD env fallback.
//
// Node's readline doesn't natively hide input, so we read raw-mode bytes
// from stdin, display nothing, and build up the password in memory. This
// is standard practice for CLI password prompts (ssh-add, gpg-agent, etc).
//
// AUTOMATON_PASSWORD env var: documented for Docker/systemd contexts where
// a TTY isn't available. Passing a password on the CLI (via `--password`)
// is deliberately NOT supported — it would land in shell history.

// NIST SP 800-63B minimum. Not strong on its own — scrypt does the real work
// — but stops trivially bad inputs like "a" from making it to disk.
const MIN_PASSWORD_LEN = 8;

function assertPasswordLength(password: string, source: string): void {
    if (password.length < MIN_PASSWORD_LEN) {
        throw new Error(`${source} must be at least ${MIN_PASSWORD_LEN} characters`);
    }
}

export interface PromptOptions {
    prompt?: string;
    /** Set to false to force interactive prompting even if env var is set. */
    allowEnv?: boolean;
}

export async function getPassword(options: PromptOptions = {}): Promise<string> {
    const { prompt = 'Password: ', allowEnv = true } = options;

    if (allowEnv) {
        const fromEnv = process.env.AUTOMATON_PASSWORD;
        if (fromEnv !== undefined && fromEnv.length > 0) {
            return fromEnv;
        }
    }

    return promptPassword(prompt);
}

export async function getPasswordWithConfirmation(
    prompt = 'New password: ',
    confirmPrompt = 'Confirm password: ',
): Promise<string> {
    // Env var bypasses the confirmation prompt — callers using
    // AUTOMATON_PASSWORD have already pinned the value upstream (Docker
    // secret, systemd credential), so there's nothing to confirm.
    const fromEnv = process.env.AUTOMATON_PASSWORD;
    if (fromEnv !== undefined && fromEnv.length > 0) {
        assertPasswordLength(fromEnv, 'AUTOMATON_PASSWORD');
        return fromEnv;
    }

    const first = await promptPassword(prompt);
    assertPasswordLength(first, 'password');
    const second = await promptPassword(confirmPrompt);
    if (first !== second) {
        throw new Error('passwords do not match');
    }
    return first;
}

export function promptPassword(prompt: string): Promise<string> {
    return new Promise((resolve, reject) => {
        const stdin = process.stdin;
        const stdout = process.stdout;

        if (!stdin.isTTY) {
            reject(
                new Error(
                    'cannot prompt for password: stdin is not a TTY.\n' +
                        'Run in an interactive shell, or set AUTOMATON_PASSWORD.',
                ),
            );
            return;
        }

        stdout.write(prompt);
        stdin.setRawMode(true);
        stdin.resume();
        stdin.setEncoding('utf8');

        let password = '';

        const finish = () => {
            stdin.setRawMode(false);
            stdin.pause();
            stdin.removeListener('data', onData);
        };

        const onData = (chunk: string) => {
            // Pasted input can arrive as a multi-character string — iterate so
            // control chars mid-paste are still handled.
            for (const ch of chunk) {
                if (ch === '\n' || ch === '\r' || ch === '\u0004') {
                    finish();
                    stdout.write('\n');
                    resolve(password);
                    return;
                }
                if (ch === '\u0003') {
                    finish();
                    stdout.write('\n');
                    reject(new Error('password entry cancelled'));
                    return;
                }
                if (ch === '\u007f' || ch === '\b') {
                    password = password.slice(0, -1);
                    continue;
                }
                password += ch;
            }
        };

        stdin.on('data', onData);
    });
}
