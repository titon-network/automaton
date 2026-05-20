// Docs-vs-code drift guard.
//
// The automaton is a CLI, not a publishable SDK, so the usual "verify every
// `import { X } from 'titon-automaton'` in docs resolves" pattern doesn't
// apply. What DOES drift silently here:
//
//   1. Prometheus metric names documented in ops.md / README.md.
//      Operators paste these into Grafana / alert expressions; if the
//      code renames one the docs still claim the old name and the
//      operator's dashboard silently goes blank.
//
//   2. Config field names documented in README.md's config-reference
//      table. If `gaugeSnapshotEveryNTicks` gets renamed and someone
//      follows the table, their hand-edited config.json will be rejected
//      by the zod loader with a confusing "unrecognized key" error.
//
//   3. Exit codes cited in docs/troubleshooting.md (EXIT_LOCK_HELD etc).
//      Systemd unit files in contrib/ depend on these — a silent rename
//      breaks the "Restart=on-failure except lock-held" wiring.
//
//   4. Slash-command catalog (.claude/commands/*.md vs. mentions in the
//      AI-friendly docs AGENTS.md / CLAUDE.md / docs/dx.md). New slash
//      commands or renames silently desync the catalogues.
//
//   5. Atlas error code citations in any .md file (e.g. "OperatorNotFound
//      (120)" in CLAUDE.md / AGENTS.md / deploy.md / troubleshooting.md).
//      The Fortuna onboarding docs depend on these names + numbers; a
//      contract-side rename silently invalidates the docs we just wrote.
//
//   6. `.unref()` regression guard on src/. CLAUDE.md §"Sleep ref-ness
//      matters" rules out `.unref()`-ed retry timers anywhere except the
//      single allowlisted webhook deadline. Catches drift before it
//      silently breaks one-shot CLI commands.
//
// Each test pins ONE of these authoritative surfaces to the docs.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { ConfigSchema } from '../src/config/schema';
import { createDaemonMetrics } from '../src/daemon/metrics';
import { EXIT_LOCK_HELD } from '../src/daemon/orchestrator';
import {
    explainError as explainAtlas,
    type ErrorOrigin as AtlasErrorOrigin,
} from '@titon-network/atlas-sdk';

const ROOT = join(__dirname, '..');

// Collect every .md file under the repo root (excluding deps + build output
// + source-tree / scripts / contrib — markdown there is dev-facing navigation,
// not operator-facing docs, and the operator-surface drift-guard doesn't apply).
function walkMarkdown(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
        if (entry.startsWith('.')) continue;
        const full = join(dir, entry);
        const stat = statSync(full);
        if (stat.isDirectory()) {
            if (
                entry === 'node_modules' ||
                entry === 'dist' ||
                entry === 'build' ||
                entry === 'artifacts' ||
                entry === 'src' ||
                entry === 'scripts' ||
                entry === 'contrib'
            ) {
                continue;
            }
            walkMarkdown(full, out);
        } else if (entry.endsWith('.md')) {
            out.push(full);
        }
    }
    return out;
}

// Operator-facing docs ONLY. README.md + docs/ are the source of truth
// for running the daemon in production; drift there breaks dashboards /
// config-hand-edits. AGENTS.md + CLAUDE.md are developer-facing narratives
// with placeholder code blocks (e.g. `name: 'automaton_my_thing_total'`)
// that would trip a naive regex scan — they're excluded by design.
const OPERATOR_FACING_PATTERNS = [/\/README\.md$/, /\/docs\//];

describe('Docs surface', () => {
    const allDocs = walkMarkdown(ROOT);
    const docs = allDocs.filter((p) => OPERATOR_FACING_PATTERNS.some((re) => re.test(p)));

    describe('metric names', () => {
        // Authoritative set: names the Registry actually knows about. Histograms
        // expand into `_bucket`, `_sum`, `_count` at scrape time; the NAME we
        // register is the bare one, so docs should cite that.
        const metrics = createDaemonMetrics();
        const registered = new Set<string>(
            metrics.registry.getMetricsAsArray().map((m) => m.name),
        );

        // Grafana dashboards reference histogram-derived series (_sum, _count,
        // _bucket). Strip these IF the bare name isn't already registered —
        // `automaton_slash_count` is a gauge, not a histogram's _count series,
        // so we must prefer the direct match.
        const HISTOGRAM_SUFFIXES = ['_bucket', '_sum', '_count'];
        function resolve(name: string): string {
            if (registered.has(name)) return name;
            for (const s of HISTOGRAM_SUFFIXES) {
                if (name.endsWith(s)) {
                    const stripped = name.slice(0, -s.length);
                    if (registered.has(stripped)) return stripped;
                }
            }
            return name;
        }

        // Pull `automaton_<snake>[_total|_seconds|_ton|_at_seconds|_count|_bucket|_sum]`-
        // style identifiers out of docs. We match bare words up to the label
        // start (`{`) so metrics with labels still register under the bare
        // name. Also stop at whitespace, backticks, pipes, periods, commas,
        // closing parens — standard markdown/MD-table punctuation.
        const RE = /automaton_[a-z][a-z0-9_]*/g;

        // Known non-metric identifiers that happen to match the regex. Add
        // here when a new Terraform variable / config field / external
        // identifier shares the `automaton_*` prefix — the alternative is
        // renaming the offending identifier, which costs more than this
        // line. Each entry should be justified inline.
        const NOT_METRICS = new Set<string>([
            // Terraform variable in `contrib/aws/ec2/variables.tf` — pins
            // the docker image tag. Referenced in README + docs/deploy.md.
            'automaton_image',
        ]);

        for (const docPath of docs) {
            const rel = docPath.replace(ROOT + '/', '');
            const src = stripCodeBlocksAndComments(readFileSync(docPath, 'utf8'));
            const matches = src.match(RE);
            if (matches === null || matches.length === 0) continue;

            // Skip references to identifiers that are NOT metric names (e.g.
            // `automaton_execute_attempts_total_mentioned_in_prose`). We scope
            // to the exact names registered or their histogram suffixes.
            const cited = new Set(matches.filter((m) => !NOT_METRICS.has(m)));

            it(`${rel}: every cited metric name is registered`, () => {
                const missing: string[] = [];
                for (const name of cited) {
                    if (!registered.has(resolve(name))) {
                        missing.push(name);
                    }
                }
                if (missing.length > 0) {
                    throw new Error(
                        `${rel} references metric names that are NOT registered by createDaemonMetrics():\n` +
                            missing.map((n) => `  - ${n}`).join('\n') +
                            `\n\nFix: update the doc, or add/rename the metric in src/daemon/metrics.ts. ` +
                            `Registered names: ${[...registered].sort().join(', ')}`,
                    );
                }
            });
        }
    });

    describe('config field names', () => {
        // Authoritative set: field names in the zod object schema.
        const configKeys = new Set(Object.keys(ConfigSchema.shape));

        // Rows of the form `| \`<fieldName>\` | type | default | description |`
        // in a README/docs table. We parse per-file and check each claimed key.
        // Nested keys are dotted (`products.kronos`) so we strip anything past
        // the first `.` for top-level membership.
        const ROW_RE = /^\|\s*`([a-zA-Z][a-zA-Z0-9_.]*)`\s*\|/gm;

        for (const docPath of docs) {
            const rel = docPath.replace(ROOT + '/', '');
            const src = readFileSync(docPath, 'utf8');
            // Narrow to the "Configuration" section — other tables in the
            // same file might cite CLI commands or metric names that look
            // identifier-y but aren't config fields.
            const configSection = extractConfigSection(src);
            if (configSection === null) continue;

            const claimed = new Set<string>();
            let m: RegExpExecArray | null;
            while ((m = ROW_RE.exec(configSection)) !== null) {
                const full = m[1]!;
                const top = full.split('.')[0]!;
                claimed.add(top);
            }

            // Only fire a test if the file has at least ONE plausible row —
            // otherwise its "Configuration" might be prose, not a table.
            if (claimed.size === 0) continue;

            it(`${rel}: config table fields exist in ConfigSchema.shape`, () => {
                const missing: string[] = [];
                for (const name of claimed) {
                    if (!configKeys.has(name)) {
                        missing.push(name);
                    }
                }
                if (missing.length > 0) {
                    throw new Error(
                        `${rel} claims config fields that are not in ConfigSchema.shape:\n` +
                            missing.map((n) => `  - ${n}`).join('\n') +
                            `\n\nFix: update the table, or add the field to src/config/schema.ts. ` +
                            `Actual keys: ${[...configKeys].sort().join(', ')}`,
                    );
                }
            });
        }
    });

    describe('exit codes', () => {
        const troubleshooting = docs.find((p) => p.endsWith('/troubleshooting.md'));
        if (troubleshooting === undefined) {
            it.skip('troubleshooting.md exit codes', () => {});
            return;
        }
        const src = readFileSync(troubleshooting, 'utf8');

        it('EXIT_LOCK_HELD constant is consistent with ops docs', () => {
            // systemd unit ships with EXIT_LOCK_HELD=75 expectation. If the
            // constant ever drifts, the unit's Restart= wiring breaks
            // silently — the daemon crashes and systemd respawns it into
            // the same lockfile.
            expect(EXIT_LOCK_HELD).toBe(75);
            // Prose must mention the number so operators can google for it.
            expect(src).toMatch(/\b75\b/);
        });
    });

    describe('slash-command catalog', () => {
        // Authoritative set: filenames under .claude/commands/. The slug
        // (basename without .md) is the slash command operators type.
        const COMMANDS_DIR = join(ROOT, '.claude', 'commands');
        let registered: Set<string> = new Set();
        try {
            registered = new Set(
                readdirSync(COMMANDS_DIR)
                    .filter((f) => f.endsWith('.md'))
                    .map((f) => f.slice(0, -3)),
            );
        } catch {
            // Directory missing in some build configs; the test skips below.
        }

        // The docs claim coverage of these commands; if a new file is added
        // without updating the docs, the AI navigator + DX catalog silently
        // omit it. Targets are the dev-facing docs (AGENTS / CLAUDE / dx)
        // because the operator README intentionally focuses on subcommands.
        const TARGET_DOCS: Array<{ rel: string; abs: string }> = [
            { rel: 'AGENTS.md', abs: join(ROOT, 'AGENTS.md') },
            { rel: 'CLAUDE.md', abs: join(ROOT, 'CLAUDE.md') },
            { rel: 'docs/dx.md', abs: join(ROOT, 'docs', 'dx.md') },
        ];

        if (registered.size === 0) {
            it.skip('slash command catalog', () => {});
            return;
        }

        it('every .claude/commands/*.md is mentioned in at least one of AGENTS/CLAUDE/dx', () => {
            const docTexts = TARGET_DOCS.map((d) => {
                try { return readFileSync(d.abs, 'utf8'); } catch { return ''; }
            });
            const missing: string[] = [];
            for (const slug of registered) {
                // Match `/<slug>` as a token boundary — `/<slug>-foo` doesn't
                // count, neither does `/foo<slug>`.
                const re = new RegExp(`(^|[\\s\`(\\[])/${slug}(?:[\\s\`)\\]<,.]|$)`, 'm');
                if (!docTexts.some((t) => re.test(t))) {
                    missing.push(slug);
                }
            }
            if (missing.length > 0) {
                throw new Error(
                    `Slash commands defined under .claude/commands/ but not mentioned in any of ${TARGET_DOCS.map((d) => d.rel).join(' / ')}:\n` +
                        missing.map((s) => `  - /${s}`).join('\n') +
                        `\n\nFix: add the command to AGENTS.md §Slash commands, CLAUDE.md, or docs/dx.md §Slash commands. ` +
                        `Alternatively, delete .claude/commands/<slug>.md if the command is retired.`,
                );
            }
        });
    });

    describe('Atlas error-code citations', () => {
        // Pattern: prose like "OperatorNotFound (120)" or "OperatorNotFound / 120".
        // We pull these out of EVERY .md file (operator + dev docs) and
        // assert (a) the named error exists in atlas-sdk, (b) its code matches.
        // Catches the precise drift that bit us this session: an audit
        // subagent invented `E_NOT_REGISTERED (164)` and we propagated it
        // through 13 places before verifying against the SDK.
        const RE = /`([A-Z][A-Za-z0-9]+)`\s*[/(]\s*(\d{2,3})\)?/g;

        // Don't scan THIS file (the regex sample inside this very describe()
        // block would self-trigger). Don't scan node_modules/dist/.git either.
        const allMd = walkAllMarkdown(ROOT);
        const SCAN_PATTERNS_TO_SKIP = [/\/tests\/DocsSurface\.spec\.ts$/];

        for (const docPath of allMd) {
            if (SCAN_PATTERNS_TO_SKIP.some((re) => re.test(docPath))) continue;
            const rel = docPath.replace(ROOT + '/', '');
            const src = readFileSync(docPath, 'utf8');

            const cited = new Map<string, number>(); // name → claimed code
            let m: RegExpExecArray | null;
            while ((m = RE.exec(src)) !== null) {
                const [, name, codeStr] = m;
                if (name === undefined || codeStr === undefined) continue;
                const code = Number(codeStr);
                // Skip non-Atlas-shaped citations: Atlas error codes live in
                // 100-249. We can't filter by name (could be any product's
                // error), but the code range is enough to reject the obvious
                // false positives (e.g. `EXIT_LOCK_HELD (75)`).
                if (code < 100 || code > 249) continue;
                cited.set(name, code);
            }
            if (cited.size === 0) continue;

            it(`${rel}: cited error names + codes match an SDK explainer`, () => {
                const mismatched: string[] = [];
                for (const [name, code] of cited) {
                    const atlas = explainAtlas(code);
                    // We only flag when the cited code is NAMED in atlas-sdk
                    // AND the doc's name disagrees. A doc citing a code from
                    // a different SDK (forgeton/kronos/fortuna) won't match
                    // Atlas's table — `origin === 'unknown'` — and we skip
                    // it. This keeps the test focused on Atlas drift without
                    // false-positiving on every cross-SDK code mention.
                    const origin = atlas.origin as AtlasErrorOrigin;
                    if (origin === 'unknown') continue;
                    if (atlas.name !== name) {
                        mismatched.push(
                            `  - claims \`${name}\` for code ${code}, but atlas-sdk explainError(${code}) returns \`${atlas.name}\``,
                        );
                    }
                }
                if (mismatched.length > 0) {
                    throw new Error(
                        `${rel} cites Atlas error names that don't match @titon-network/atlas-sdk:\n` +
                            mismatched.join('\n') +
                            `\n\nFix: update the doc to match atlas-sdk's actual explainError() output, ` +
                            `or update the SDK if a name was renamed contract-side.`,
                    );
                }
            });
        }
    });

    describe('sendAndConfirm callers pass `origin`', () => {
        // Every `sendAndConfirm(...)` call site in src/ must include
        // `origin: '<sdk>'` in the options block. Without it, the CLI's
        // top-level explainer can't disambiguate cross-SDK exit-code
        // overlaps (e.g. 120 → kronos / fortuna / atlas with different
        // meanings) and the verify-failure bounce-trace inspection
        // doesn't fire — so a revert surfaces as opaque wrapper text
        // instead of an explanation. See AGENTS.md §"Send a tx through
        // sendAndConfirm" for the convention.
        const ALLOWLIST: RegExp[] = [
            // The shared submit helper itself, which DEFINES sendAndConfirm.
            /\/src\/chain\/submit\.ts$/,
            // Re-exports / barrels — they reference the symbol but don't call it.
            /\/src\/chain\/index\.ts$/,
            /\/src\/worker\/index\.ts$/,
        ];

        it('every src/ call to sendAndConfirm includes an `origin` option', () => {
            const offenders: string[] = [];
            walkSourceTs(join(ROOT, 'src')).forEach((f) => {
                if (ALLOWLIST.some((re) => re.test(f))) return;
                const txt = readFileSync(f, 'utf8');
                if (!/\bsendAndConfirm\s*\(/.test(txt)) return;
                // Slice from the call to the closing paren — crude but
                // matches the actual argument list (multi-line allowed).
                const re = /\bsendAndConfirm\s*\(/g;
                let m: RegExpExecArray | null;
                while ((m = re.exec(txt)) !== null) {
                    const start = m.index;
                    // Find matching ')' considering nested parens.
                    let depth = 0;
                    let end = -1;
                    for (let i = start + m[0].length - 1; i < txt.length; i++) {
                        const ch = txt[i];
                        if (ch === '(') depth++;
                        else if (ch === ')') {
                            depth--;
                            if (depth === 0) { end = i; break; }
                        }
                    }
                    if (end < 0) continue;
                    const body = txt.slice(start, end + 1);
                    if (!/\borigin\s*:/.test(body)) {
                        const lineNo = txt.slice(0, start).split('\n').length;
                        offenders.push(`${f.replace(ROOT + '/', '')}:${lineNo}`);
                    }
                }
            });
            if (offenders.length > 0) {
                throw new Error(
                    `\`sendAndConfirm(...)\` calls in src/ are missing the \`origin\` option:\n` +
                        offenders.map((o) => `  - ${o}`).join('\n') +
                        `\n\nFix: add \`origin: '<sdk>'\` to the options block — one of ` +
                        `'kronos' / 'forgeton' / 'atlas' / 'fortuna' (or any registered ProductModule). ` +
                        `See AGENTS.md §"Send a tx through sendAndConfirm" for context.`,
                );
            }
        });
    });

    describe('source-tree `.unref()` guard', () => {
        // CLAUDE.md §"Sleep ref-ness matters" rules out unref'd retry/poll
        // timers anywhere except the documented webhook deadline. A drift
        // here lets one-shot CLI commands exit mid-await with no output —
        // the silent-success-zero-exit-code footgun the rule was written
        // to prevent. Pinning here is cheap (regex scan).
        const ALLOWLIST: RegExp[] = [
            // Webhook deadline timer in selfSlashHandler — fire-and-forget,
            // documented at the call site. Holding the loop open here would
            // block graceful shutdown on a hung webhook, which is its own bug.
            /\/src\/worker\/handlers\.ts$/,
        ];

        it('no .unref() in src/ outside the allowlist', () => {
            const offenders: string[] = [];
            walkSourceTs(join(ROOT, 'src')).forEach((f) => {
                if (ALLOWLIST.some((re) => re.test(f))) return;
                const txt = readFileSync(f, 'utf8');
                // Match `.unref()` token-boundary; ignore strings and comments
                // by stripping fenced literals + line comments first.
                const stripped = txt
                    .replace(/\/\/[^\n]*/g, '')
                    .replace(/\/\*[\s\S]*?\*\//g, '')
                    .replace(/`[\s\S]*?`/g, '')
                    .replace(/'[^']*'/g, '')
                    .replace(/"[^"]*"/g, '');
                const re = /\.unref\s*\(\s*\)/g;
                const matches = stripped.match(re);
                if (matches !== null) {
                    offenders.push(`${f.replace(ROOT + '/', '')} (${matches.length} occurrence${matches.length > 1 ? 's' : ''})`);
                }
            });
            if (offenders.length > 0) {
                throw new Error(
                    `\`.unref()\` found in src/ outside the documented allowlist:\n` +
                        offenders.map((o) => `  - ${o}`).join('\n') +
                        `\n\nFix: replace with \`defaultSleep\` from src/errors/backoff.ts (a ref-ed sleep), ` +
                        `or extend the ALLOWLIST in tests/DocsSurface.spec.ts with a justification comment. ` +
                        `See CLAUDE.md §"Sleep ref-ness matters" for the rule.`,
                );
            }
        });
    });
});

// Walk EVERY .md file (used by the Atlas error-code drift guard, which
// applies to dev docs too — not just the operator-facing ones the metric/
// config-name guards focus on).
function walkAllMarkdown(dir: string): string[] {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const entry of readdirSync(cur)) {
            if (entry.startsWith('.') && entry !== '.claude' && entry !== '.github') continue;
            const full = join(cur, entry);
            const stat = statSync(full);
            if (stat.isDirectory()) {
                if (
                    entry === 'node_modules' ||
                    entry === 'dist' ||
                    entry === 'build' ||
                    entry === 'artifacts' ||
                    entry === 'coverage'
                ) continue;
                stack.push(full);
            } else if (entry.endsWith('.md')) {
                out.push(full);
            }
        }
    }
    return out;
}

// Walk every .ts file under src/ — used by the .unref() guard.
function walkSourceTs(dir: string): string[] {
    const out: string[] = [];
    const stack: string[] = [dir];
    while (stack.length > 0) {
        const cur = stack.pop()!;
        for (const entry of readdirSync(cur)) {
            if (entry.startsWith('.')) continue;
            const full = join(cur, entry);
            const stat = statSync(full);
            if (stat.isDirectory()) stack.push(full);
            else if (entry.endsWith('.ts') && !entry.endsWith('.d.ts')) out.push(full);
        }
    }
    return out;
}

/**
 * Strip fenced code blocks (``` … ```) and HTML comments (<!-- … -->) so the
 * metric-name scanner doesn't flag example identifiers inside doc samples.
 * Operator-facing prose lives outside fences; that's the surface we're pinning.
 */
function stripCodeBlocksAndComments(src: string): string {
    return src
        .replace(/```[\s\S]*?```/g, '')
        .replace(/<!--[\s\S]*?-->/g, '');
}

function extractConfigSection(src: string): string | null {
    // Headings that mark a config-reference table. Tolerant of level (## / ###)
    // and wording.
    const headerRe = /^(#{2,4})\s+(?:Configuration|Config Reference|Config|Config fields?)\b/im;
    const header = src.search(headerRe);
    if (header < 0) return null;
    const tail = src.slice(header);
    // Stop at the next heading of the same level OR end-of-file.
    const nextHeader = tail.slice(1).search(/^#{1,4}\s/m);
    return nextHeader < 0 ? tail : tail.slice(0, nextHeader + 1);
}
