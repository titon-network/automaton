---
description: Add a new Prometheus metric (counter / gauge / histogram) with bounded labels and docs drift-guard compliance.
argument-hint: <metric-name> — use snake_case, will be prefixed with `automaton_`
---

Add a new Prometheus metric for **$ARGUMENTS**.

Steps:

1. Read `src/daemon/metrics.ts` — every metric declaration lives here in `createDaemonMetrics()`. Note the existing shape (counters / gauges / histograms as fields of a returned bundle).
2. Ask the user (concisely, in one question) for:
   - metric type (`counter` | `gauge` | `histogram`)
   - what it measures (one sentence, becomes the `help` string)
   - label names if any — must be **bounded enums** (see `Decision['reason']` in `src/worker/decide.ts` for the pattern)
3. Add the declaration to `createDaemonMetrics()`:
   - Name: `automaton_<snake>[_total|_seconds|_ton|_at_seconds]`.
   - Suffix rules: `_total` for counters, `_seconds` for durations, `_ton` for amounts, bare for gauges, `_at_seconds` for Unix timestamps.
   - `labelNames: [...] as const`
   - `registers: [registry]`
4. Return it on the bundle's `counters` / `gauges` / `histogram` field so existing callers can reach it. If it needs to be incremented from a new call-site, wire the increment there.
5. Document the metric in `docs/ops.md` §"Metrics" table. If its label has a bounded domain, also document that under §"Label domains".
6. Add a test in `tests/metrics.spec.ts` that asserts the name + type + label set are exposed. The existing `DocsSurface.spec.ts` drift-guard will then fail if `docs/ops.md` cites the wrong name — that's the safety net.
7. `pnpm run verify`.

Do not add labels with unbounded cardinality (request URLs, exception messages, user IDs, etc.). That destroys Prometheus. If the user asks for one, push back with an alternative (e.g. bucket into a bounded enum).
