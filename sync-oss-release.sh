#!/usr/bin/env bash
#
# sync-oss-release.sh - mirrors THIS directory's git-tracked files into
# a checkout of the public cachegate repo, as ONE NEW COMMIT there.
#
# See OPEN_SOURCE_ROADMAP.md step 11 for why this direction (this
# monorepo directory is the source of truth, not the public repo) and
# step 1 for why the ONE-TIME initial extraction (step 16) uses fresh,
# curated history. This script is different from that: it's what runs
# on every sync AFTER the initial extraction, and it does NOT rewrite
# history - it adds a single normal commit on top of whatever the
# target repo already has, exactly like any other change to that repo.
# Rewriting history on every sync would break clones, forks, and
# in-flight PRs on the public side; that's not what this does.
#
# This is a MIRROR, not a merge: after syncing, the target's tracked
# files exactly match this directory's. A file that exists only in the
# target (added directly on GitHub, not here) gets REMOVED on sync.
# That's deliberate - if a file should persist in the public repo, add
# it here, in the monorepo, since this directory is the source of truth
# (see step 11). This script will refuse to run against a target that
# isn't a git repository, specifically so an accidental wipe of some
# unrelated directory can't happen by pointing this at the wrong path.
#
# Usage:
#   ./sync-oss-release.sh <path-to-public-repo-checkout> [--version X.Y.Z]
#
# What it does, in order:
#   1. Refuses to run if the secrets scan (same patterns as the manual
#      step-3 audit: API key shapes, email addresses) finds anything in
#      this directory's tracked files - loud failure, nothing touched,
#      rather than a quiet publish of a leak.
#   2. If --version is given, bumps THIS directory's own package.json
#      to that version first, so the synced copy carries it too. Omits
#      this by default - the script doesn't invent a version-bump
#      policy on its own (see step 6's deferred semver plan); a
#      no-flag run is a plain resync at whatever version is already
#      set (e.g. reapplying a cherry-picked external PR - see
#      CONTRIBUTING.md's note on that flow).
#   3. Mirrors every git-tracked file from this directory into the
#      target checkout (removes everything else from the target's
#      working tree first, except its own .git/) - a file removed here
#      also disappears there, never a manual, error-prone diff to keep
#      in sync by hand.
#   4. Commits in the TARGET repo (one new commit, normal history).
#      Does NOT push - pushing is a deliberate, separate, human/CI step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET=""
NEW_VERSION=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      NEW_VERSION="$2"
      shift 2
      ;;
    *)
      if [[ -z "$TARGET" ]]; then
        TARGET="$1"
        shift
      else
        echo "Unexpected extra argument: $1" >&2
        exit 1
      fi
      ;;
  esac
done

if [[ -z "$TARGET" ]]; then
  echo "Usage: $0 <path-to-public-repo-checkout> [--version X.Y.Z]" >&2
  exit 1
fi

if [[ ! -d "$TARGET/.git" ]]; then
  echo "❌ Refusing to run: $TARGET is not a git repository (no .git/ found)." >&2
  echo "   This is deliberate - pointing this at the wrong path would wipe it." >&2
  exit 1
fi

TARGET="$(cd "$TARGET" && pwd)"

echo "🔍 Step 1/4: scanning tracked files for secrets before touching anything..."
# Same shape of check as step 3's manual audit: API key patterns and
# email addresses, restricted to git-tracked files only (never
# node_modules, .env, data/ - those aren't tracked, so git ls-files
# already excludes them).
SECRET_HIT=0
while IFS= read -r -d '' file; do
  if grep -qE "sk-[a-zA-Z0-9_-]{20,}|AIza[0-9A-Za-z_-]{20,}|xai-[a-zA-Z0-9_-]{20,}" "$file" 2>/dev/null; then
    echo "  ❌ Possible API key in $file" >&2
    SECRET_HIT=1
  fi
  if grep -qE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}" "$file" 2>/dev/null; then
    # .env.example intentionally has no real emails; this still flags
    # anything matching the shape so a human confirms it's a placeholder.
    match=$(grep -oE "[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}" "$file" | grep -v -E "example\.com|your-|@anthropic\.com" || true)
    if [[ -n "$match" ]]; then
      echo "  ⚠️  Email-shaped string in $file: $match (confirm this is a placeholder, not real)" >&2
      SECRET_HIT=1
    fi
  fi
done < <(git ls-files -z)

if [[ "$SECRET_HIT" -eq 1 ]]; then
  echo "❌ Aborting sync - resolve the findings above first. Nothing was copied." >&2
  exit 1
fi
echo "  ✅ Clean."

if [[ -n "$NEW_VERSION" ]]; then
  echo "🔢 Step 2/4: bumping package.json to $NEW_VERSION..."
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
    pkg.version = process.argv[1];
    fs.writeFileSync('package.json', JSON.stringify(pkg, null, 2) + '\n');
  " "$NEW_VERSION"
  echo "  ✅ package.json now at $NEW_VERSION."
else
  echo "🔢 Step 2/4: no --version given, leaving package.json's version as-is."
fi

echo "📦 Step 3/4: mirroring tracked files into $TARGET..."
# Wipe the target's working tree except .git/, then copy this
# directory's tracked files in - guarantees the target ends up an
# EXACT mirror, not an accumulation of whatever used to be there.
find "$TARGET" -mindepth 1 -maxdepth 1 -not -name ".git" -exec rm -rf {} +

while IFS= read -r -d '' file; do
  dest="$TARGET/$file"
  mkdir -p "$(dirname "$dest")"
  cp "$file" "$dest"
done < <(git ls-files -z)

echo "  ✅ Copied $(git ls-files | wc -l | tr -d ' ') tracked files."

echo "💾 Step 4/4: committing in the target repo (not pushing)..."
SOURCE_SHA="$(git rev-parse --short HEAD)"
(
  cd "$TARGET"
  git add -A
  if git diff --cached --quiet; then
    echo "  ℹ️  Nothing changed - target already matches this directory. No commit made."
  else
    git commit -m "Sync from internal monorepo @ ${SOURCE_SHA}

Mirrors 210_apps/001_model_router/ as of that commit. This commit was
generated by sync-oss-release.sh, not written by hand - see
OPEN_SOURCE_ROADMAP.md step 11 in the source repo for why this
direction (monorepo -> public repo, not the reverse)."
    echo "  ✅ Committed. Review with 'git show' in $TARGET, then push when ready - this script never pushes."
  fi
)

echo "✅ Sync complete."
