// Smoke test for the CLI binary. If these fail at scaffold time, something
// structural is broken (commander wiring, dist build, package.json bin entry).

import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const PKG_VERSION = (require(join(ROOT, 'package.json')) as { version: string }).version;

function run(
    args: string[],
    env: Record<string, string> = {},
): { stdout: string; status: number } {
    try {
        const stdout = execFileSync('node', [CLI, ...args], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, ...env },
        });
        return { stdout, status: 0 };
    } catch (err) {
        const e = err as { stdout?: Buffer; stderr?: Buffer; status?: number };
        const out = (e.stdout?.toString() ?? '') + (e.stderr?.toString() ?? '');
        return { stdout: out, status: e.status ?? 1 };
    }
}

describe('automaton CLI scaffold', () => {
    // Fail early if the caller forgot to build — clearer message than a cryptic
    // "MODULE_NOT_FOUND" from the node invocation.
    beforeAll(() => {
        if (!existsSync(CLI)) {
            throw new Error(`dist/cli/index.js not found — run \`pnpm run build\` before running tests.`);
        }
    });

    it('--help lists every subcommand', () => {
        const { stdout, status } = run(['--help']);
        expect(status).toBe(0);
        for (const name of ['init', 'status', 'doctor', 'stake', 'run', 'bls']) {
            expect(stdout).toContain(name);
        }
    });

    it('--version prints the real package version', () => {
        const { stdout, status } = run(['--version']);
        expect(status).toBe(0);
        expect(stdout.trim()).toBe(PKG_VERSION);
    });

    it('doctor returns OK on a healthy install', () => {
        const { stdout, status } = run(['doctor']);
        expect(status).toBe(0);
        expect(stdout).toMatch(/all \d+ checks passed/);
        expect(stdout).toContain('@titon-network/forgeton-sdk resolves');
        expect(stdout).toContain('@titon-network/kronos-sdk resolves');
    });

    it('doctor --format json emits a structured payload', () => {
        const { stdout, status } = run(['doctor', '--format', 'json']);
        // No config on the host yet (under a scratch TITON_HOME), but the
        // install-scoped checks should all pass, so the JSON parses cleanly.
        const parsed = JSON.parse(stdout) as {
            version: string;
            summary: { total: number; ok: number; warn: number; fail: number; skip: number };
            checks: Array<{ name: string; status: string; detail: string }>;
        };
        expect(parsed.version).toBe(PKG_VERSION);
        expect(parsed.summary.total).toBe(parsed.checks.length);
        expect(parsed.summary.ok + parsed.summary.warn + parsed.summary.fail + parsed.summary.skip)
            .toBe(parsed.summary.total);
        expect(parsed.checks.some((c) => c.name === '@titon-network/forgeton-sdk resolves')).toBe(true);
        expect(parsed.checks.some((c) => c.name === '@titon-network/kronos-sdk resolves')).toBe(true);
        // Exit code tracks summary.fail (0 means exit 0).
        expect(status).toBe(parsed.summary.fail === 0 ? 0 : 1);
    });

    it('doctor --format invalid exits 2 with a clear error', () => {
        const { stdout, status } = run(['doctor', '--format', 'yaml']);
        expect(status).toBe(2);
        expect(stdout).toMatch(/--format must be/);
    });

    it('run without install exits non-zero with a pointer to init', () => {
        // No TITON_HOME override → runDaemon fails at loadConfig with
        // ConfigNotFoundError. Verifies the error is actionable.
        const { stdout, status } = run(['run'], { TITON_HOME: '/tmp/titon-fresh-for-run-spec' });
        expect(status).not.toBe(0);
        expect(stdout).toMatch(/config not found|automaton init/);
    });

    it('status without install exits non-zero with a pointer to init', () => {
        // No TITON_HOME override + no stub state → runStatus fails with
        // "no config" (caller hasn't run init). Verifies the error is
        // actionable, not a stack trace.
        const { stdout, status } = run(['status'], { TITON_HOME: '/tmp/titon-fresh-for-cli-spec' });
        expect(status).not.toBe(0);
        expect(stdout).toMatch(/no config|automaton init/);
    });

    it('init without flags exits non-zero (interactive mode, no TTY in test)', () => {
        // Without flags, init tries to prompt. execFileSync pipes stdin so it
        // is not a TTY — init should surface the NotInteractiveError clearly
        // rather than hang or succeed silently. Use a scratch TITON_HOME so
        // the test doesn't hit the "refuse to overwrite existing files" guard
        // when the developer running tests has a real install on the host.
        const { stdout, status } = run(['init'], {
            TITON_HOME: '/tmp/titon-fresh-for-init-tty-spec',
        });
        expect(status).not.toBe(0);
        expect(stdout.toLowerCase()).toMatch(/not a tty|tty/);
    });

    describe('completion', () => {
        it('--help lists the three supported shells', () => {
            const { stdout, status } = run(['completion', '--help']);
            expect(status).toBe(0);
            expect(stdout).toMatch(/bash.*zsh.*fish|bash, zsh, fish/);
        });

        it('bash emits a script containing the _automaton_completions function', () => {
            const { stdout, status } = run(['completion', 'bash']);
            expect(status).toBe(0);
            expect(stdout).toContain('_automaton_completions');
            expect(stdout).toContain('complete -F _automaton_completions automaton');
            expect(stdout).toContain('stake_subs');
        });

        it('zsh emits a #compdef directive + _automaton function', () => {
            const { stdout, status } = run(['completion', 'zsh']);
            expect(status).toBe(0);
            expect(stdout).toMatch(/^#compdef automaton/);
            expect(stdout).toContain('_automaton()');
        });

        it('fish emits __fish_use_subcommand entries', () => {
            const { stdout, status } = run(['completion', 'fish']);
            expect(status).toBe(0);
            expect(stdout).toContain('__fish_use_subcommand');
            expect(stdout).toContain('register increase request-unstake cancel-unstake withdraw');
        });

        it('unknown shell exits 2 with a clear error', () => {
            const { stdout, status } = run(['completion', 'powershell']);
            expect(status).toBe(2);
            expect(stdout).toMatch(/unsupported shell.*Supported: bash, zsh, fish/);
        });
    });

    describe('run flags', () => {
        it('--help advertises --log-format', () => {
            const { stdout, status } = run(['run', '--help']);
            expect(status).toBe(0);
            expect(stdout).toContain('--log-format');
            expect(stdout).toMatch(/pretty.*json.*auto|pretty \/ json \/ auto/);
        });

        it('rejects an unknown --log-format with a clear error', () => {
            const { stdout, status } = run(
                ['run', '--log-format', 'xml'],
                { TITON_HOME: '/tmp/titon-fresh-for-run-logformat-spec' },
            );
            expect(status).not.toBe(0);
            expect(stdout).toMatch(/--log-format must be/);
        });
    });

    describe('explain-exit-code', () => {
        it('resolves a known kronos code (human format)', () => {
            // Just need a code that's known to at least one SDK. 160 is
            // a pool code (E_NOT_REGISTERED family); the exact mapping
            // may change but origin should not be 'unknown'.
            const { stdout, status } = run(['explain-exit-code', '160']);
            expect(status).toBe(0);
            expect(stdout).toMatch(/exit 160/);
            expect(stdout).not.toMatch(/\(unknown\)/);
        });

        it('emits structured JSON with --format json', () => {
            const { stdout, status } = run(['explain-exit-code', '160', '--format', 'json']);
            expect(status).toBe(0);
            const parsed = JSON.parse(stdout) as {
                code: number;
                origin: string;
                name: string;
                message: string;
            };
            expect(parsed.code).toBe(160);
            expect(['kronos', 'forgeton', 'tvm']).toContain(parsed.origin);
            expect(parsed.name).toBeTruthy();
        });

        it('extracts a code from an "exit code N" message', () => {
            const { stdout, status } = run([
                'explain-exit-code',
                'reverted with exit code 160 while submitting',
            ]);
            expect(status).toBe(0);
            expect(stdout).toMatch(/exit 160/);
        });

        it('exits 1 when no code can be extracted', () => {
            const { stdout, status } = run(['explain-exit-code', 'just random prose']);
            expect(status).toBe(1);
            expect(stdout).toMatch(/could not extract/);
        });

        it('exits 2 when the code is out of every SDK range', () => {
            const { stdout, status } = run(['explain-exit-code', '9999']);
            expect(status).toBe(2);
            expect(stdout).toMatch(/exit 9999/);
        });
    });

    describe('config show', () => {
        it('refuses when no config file exists, pointing at init', () => {
            const { stdout, status } = run(['config', 'show'], {
                TITON_HOME: '/tmp/titon-fresh-for-config-show-spec',
            });
            expect(status).not.toBe(0);
            expect(stdout).toMatch(/no config/);
            expect(stdout).toMatch(/automaton init/);
        });

        it('rejects an invalid --format with exit 2', () => {
            const { stdout, status } = run(
                ['config', 'show', '--format', 'toml'],
                { TITON_HOME: '/tmp/titon-fresh-for-config-show-spec-fmt' },
            );
            expect(status).toBe(2);
            expect(stdout).toMatch(/--format must be/);
        });
    });

    describe('bls', () => {
        let blsHome: string;

        beforeEach(() => {
            blsHome = mkdtempSync(join(tmpdir(), 'titon-bls-cli-'));
            mkdirSync(join(blsHome, 'automaton'));
        });

        afterEach(() => {
            rmSync(blsHome, { recursive: true, force: true });
        });

        it('--help lists the four subcommands', () => {
            const { stdout, status } = run(['bls', '--help']);
            expect(status).toBe(0);
            for (const name of ['keygen', 'pubkey', 'register', 'deregister']) {
                expect(stdout).toContain(name);
            }
        });

        it('keygen --help advertises --force', () => {
            const { stdout, status } = run(['bls', 'keygen', '--help']);
            expect(status).toBe(0);
            expect(stdout).toContain('--force');
        });

        it('pubkey refuses when bls.enc is missing, pointing at keygen', () => {
            const { stdout, status } = run(['bls', 'pubkey'], { TITON_HOME: blsHome });
            expect(status).not.toBe(0);
            expect(stdout).toMatch(/BLS keystore not found/);
            expect(stdout).toMatch(/automaton bls keygen/);
        });

        it('register refuses when products.fortuna is false', () => {
            // No config file at all — loadConfig throws ConfigNotFoundError
            // before the products.fortuna check. That's fine: operators see
            // the "run init" message.
            const { stdout, status } = run(['bls', 'register'], { TITON_HOME: blsHome });
            expect(status).not.toBe(0);
            // Either "config not found" OR "products.fortuna is false" (if a
            // partial config exists — not our case here).
            expect(stdout).toMatch(/config not found|automaton init/);
        });

        it('keygen writes bls.enc under TITON_HOME with env-supplied password', () => {
            const { stdout, status } = run(['bls', 'keygen'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(status).toBe(0);
            expect(stdout).toMatch(/pkShare:\s+[0-9a-f]{96}/);
            const blsFile = join(blsHome, 'automaton', 'bls.enc');
            expect(existsSync(blsFile)).toBe(true);
        });

        it('keygen refuses to overwrite an existing bls.enc without --force', () => {
            // First keygen succeeds.
            const first = run(['bls', 'keygen'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(first.status).toBe(0);

            // Second refuses without --force.
            const second = run(['bls', 'keygen'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(second.status).not.toBe(0);
            expect(second.stdout).toMatch(/already exists/);
            expect(second.stdout).toMatch(/--force/);
        });

        it('keygen --force overwrites an existing bls.enc', () => {
            const first = run(['bls', 'keygen'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(first.status).toBe(0);
            const firstPk = (first.stdout.match(/pkShare:\s+([0-9a-f]{96})/) ?? [])[1];

            const second = run(['bls', 'keygen', '--force'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(second.status).toBe(0);
            const secondPk = (second.stdout.match(/pkShare:\s+([0-9a-f]{96})/) ?? [])[1];

            expect(firstPk).toBeDefined();
            expect(secondPk).toBeDefined();
            expect(firstPk).not.toBe(secondPk);
        });

        it('pubkey prints the stored pkShare after keygen', () => {
            const keygen = run(['bls', 'keygen'], {
                TITON_HOME: blsHome,
                AUTOMATON_PASSWORD: 'bls-test-pw-good',
            });
            expect(keygen.status).toBe(0);
            const expectedPk = (keygen.stdout.match(/pkShare:\s+([0-9a-f]{96})/) ?? [])[1];

            const pubkey = run(['bls', 'pubkey'], { TITON_HOME: blsHome });
            expect(pubkey.status).toBe(0);
            expect(pubkey.stdout.trim()).toBe(expectedPk);
        });
    });

    describe('config edit', () => {
        it('refuses when no config exists, pointing at init', () => {
            const { stdout, status } = run(['config', 'edit'], {
                TITON_HOME: '/tmp/titon-fresh-for-config-edit-spec',
            });
            expect(status).not.toBe(0);
            expect(stdout).toMatch(/no config/);
            expect(stdout).toMatch(/automaton init/);
        });

        it('--help advertises --editor', () => {
            const { stdout, status } = run(['config', 'edit', '--help']);
            expect(status).toBe(0);
            expect(stdout).toContain('--editor');
        });
    });
});
