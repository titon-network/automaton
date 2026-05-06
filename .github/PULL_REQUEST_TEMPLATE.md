<!--
Thanks for the PR. A quick checklist to pre-empt common review comments.

If you're an AI assistant opening this PR, note that `.claude/commands/`
has task recipes that pre-populate the right files.
-->

## What changed

<!-- One or two sentences. Why, not what — the diff says what. -->

## How it was verified

- [ ] `pnpm run verify` passes locally
- [ ] If I added operator-facing metric names / config fields / exit codes, I updated `docs/` and/or `README.md` in the same commit (`tests/DocsSurface.spec.ts` is the drift guard)
- [ ] If I bumped `CONFIG_VERSION` / `KEYSTORE_VERSION` / `CHECKPOINT_STATE_VERSION`, the commit message names the migration path

## Scope

<!-- Delete what doesn't apply. -->

- [ ] Additive only (new command / flag / metric / handler)
- [ ] Bug fix
- [ ] Docs / DX hardening
- [ ] Breaking change (note the migration path in the commit message)

## Linked issue

<!-- #123 -->

