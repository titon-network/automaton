---
description: Map a task description to the exact file(s) to open, using the CLAUDE.md AI navigator.
argument-hint: <what you want to do>
---

The user wants to: **$ARGUMENTS**

Resolve this to concrete file paths in the automaton codebase. If the user's intent is unclear, fall back to [`docs/dx.md`](../../docs/dx.md) which catalogues every DX surface.

1. Read [`CLAUDE.md`](../../CLAUDE.md) §"AI navigator — I want to X, where do I look?" table.
2. Match the user's intent against the task column. If it's a debugging question, also consult the §"Debugging symptoms" table.
3. For a single-file change, cite the exact path with `file:line` when possible.
4. For multi-file work, list the files in the order you'd edit them (schema → loader → docs → test is typical for config changes).
5. If the task isn't in the navigator, say so explicitly and suggest the closest analogue — don't invent file paths.

Keep the response under 150 words. End with a one-line next action the user can take or approve.
