// Smoke test for the CLI binary. If these fail at scaffold time, something
// structural is broken (commander wiring, dist build, package.json bin entry).

import { execFileSync } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '..');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const PKG_VERSION = (require(join(ROOT, 'package.json')) as { version: string }).version;

function run(args: string[]): { stdout: string; status: number } {
    try {
        const stdout = execFileSync('node', [CLI, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
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

    it('stub subcommands exit non-zero with a "not implemented" message', () => {
        for (const cmd of ['init', 'status', 'run']) {
            const { stdout, status } = run([cmd]);
            expect(status).not.toBe(0);
            expect(stdout).toContain('not implemented yet');
        }
    });
});
