#!/usr/bin/env bash
# Release helper for @titon/automaton.
#
# What it does (in order):
#   1. Verify working tree is clean + on the release branch.
#   2. Run `pnpm run test` (gated — refuses to tag a failing build).
#   3. Bump version in package.json (patch / minor / major / explicit).
#   4. Build + smoke-test (`pnpm run prepublishOnly` runs the real
#      pipeline; smoke check verifies `--version` matches).
#   5. Tag git + commit the version bump.
#   6. Print (not execute) the next steps:
#        - `pnpm publish` (npm publish)
#        - `docker buildx build ...` (docker multi-arch publish)
#        - `git push origin main --tags`
#
# DRY RUN IS THE DEFAULT. The script echoes every mutating command
# but does not execute them unless `--apply` is passed. This keeps
# the release process auditable — the maintainer reviews the plan
# before pulling the trigger.
#
# Usage:
#   ./scripts/release.sh patch
#   ./scripts/release.sh 0.2.0 --apply

set -euo pipefail

BUMP="${1:-}"
APPLY=false

for arg in "${@:2}"; do
    case "$arg" in
        --apply) APPLY=true ;;
        *) echo "unknown arg: $arg" >&2; exit 2 ;;
    esac
done

if [[ -z "$BUMP" ]]; then
    cat >&2 <<'USAGE'
usage: release.sh <bump> [--apply]

  <bump>       one of: patch | minor | major | <explicit-version>
  --apply      actually execute mutating commands (default: dry-run)

Examples:
  ./scripts/release.sh patch             # plan a patch release
  ./scripts/release.sh 0.2.0 --apply     # cut 0.2.0 for real
USAGE
    exit 2
fi

run() {
    if $APPLY; then
        echo "+ $*"
        "$@"
    else
        echo "[dry-run] $*"
    fi
}

cd "$(dirname "$0")/.."

# --- 1. clean tree ----------------------------------------------------------
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree is not clean" >&2
    git status --short >&2
    exit 1
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)
if [[ "$BRANCH" != "main" ]]; then
    echo "warning: on branch '$BRANCH' (expected 'main') — proceed with care"
fi

# --- 2. tests ---------------------------------------------------------------
echo "=== running test suite ==="
pnpm run test

# Tests may (shouldn't, but) write snapshot / fixture files; refuse to
# continue if the tree drifted during the run. Catches accidental
# leakage before we commit a noisy release.
if ! git diff --quiet || ! git diff --cached --quiet; then
    echo "error: working tree drifted during tests — investigate:" >&2
    git status --short >&2
    exit 1
fi

# --- 3. version bump --------------------------------------------------------
CURRENT=$(node -p "require('./package.json').version")
echo "=== current version: $CURRENT ==="

case "$BUMP" in
    patch|minor|major)
        NEW=$(node -e "const [M,m,p]=require('./package.json').version.split('.').map(Number);const b='$BUMP';process.stdout.write(b==='patch'?\`\${M}.\${m}.\${p+1}\`:b==='minor'?\`\${M}.\${m+1}.0\`:\`\${M+1}.0.0\`)")
        ;;
    *)
        NEW="$BUMP"
        if ! [[ "$NEW" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
            echo "error: '$NEW' is not a valid semver" >&2
            exit 1
        fi
        ;;
esac
echo "=== new version: $NEW ==="

# Preserve the file's existing indent so the diff only touches the
# version line — re-serialising with a hard-coded width would rewrite
# every line if the file happened to be 2-space indented.
run node -e "const fs=require('fs');const raw=fs.readFileSync('./package.json','utf8');const m=/\n(\s+)/.exec(raw);const indent=m?m[1]:'    ';const p=JSON.parse(raw);p.version='$NEW';fs.writeFileSync('./package.json',JSON.stringify(p,null,indent)+'\n')"

# --- 4. build + smoke -------------------------------------------------------
run pnpm run prepublishOnly
run pnpm run smoke

# --- 5. tag + commit --------------------------------------------------------
run git add package.json
run git commit -m "chore: release v$NEW"
run git tag -a "v$NEW" -m "v$NEW"

# --- 6. next steps ----------------------------------------------------------
cat <<NEXT

=== $([ "$APPLY" = true ] && echo "DONE — next steps" || echo "DRY RUN — next steps") ===

  # Publish to npm (requires the sibling SDKs to be published first
  # — see CLAUDE.md §"Distribution limitations"):
  pnpm publish --access=public

  # Build + push the multi-arch Docker image (build context = parent):
  cd .. && docker buildx build \\
    --platform linux/amd64,linux/arm64 \\
    --tag titon/automaton:$NEW \\
    --tag titon/automaton:latest \\
    -f automaton/Dockerfile \\
    --push .

  # Push the commit + tag:
  git push origin $BRANCH --tags

NEXT
