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
// Each test pins ONE of these authoritative surfaces to the docs.

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

import { ConfigSchema } from '../src/config/schema';
import { createDaemonMetrics } from '../src/daemon/metrics';
import { EXIT_LOCK_HELD } from '../src/daemon/orchestrator';

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

        for (const docPath of docs) {
            const rel = docPath.replace(ROOT + '/', '');
            const src = stripCodeBlocksAndComments(readFileSync(docPath, 'utf8'));
            const matches = src.match(RE);
            if (matches === null || matches.length === 0) continue;

            // Skip references to identifiers that are NOT metric names (e.g.
            // `automaton_execute_attempts_total_mentioned_in_prose`). We scope
            // to the exact names registered or their histogram suffixes.
            const cited = new Set(matches);

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
});

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
