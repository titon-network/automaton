// Smoke test for the CLI binary. If these fail at scaffold time, something
// structural is broken (commander wiring, dist build, package.json bin entry).

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
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
        for (const name of ['init', 'status', 'doctor', 'stake', 'run']) {
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
        expect(stdout).toContain('forgeton-sdk resolves');
        expect(stdout).toContain('kronos-sdk resolves');
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
        expect(parsed.checks.some((c) => c.name === 'forgeton-sdk resolves')).toBe(true);
        expect(parsed.checks.some((c) => c.name === 'kronos-sdk resolves')).toBe(true);
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
        // rather than hang or succeed silently.
        const { stdout, status } = run(['init']);
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
});
