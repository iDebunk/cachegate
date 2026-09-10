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
#      in sync by hand. EXCEPT the files named in this step's own
#      NEVER_MIRROR list - ROADMAP.md and OPEN_SOURCE_ROADMAP.md are
#      git-tracked right here but never copied: they're internal-only
#      planning docs (this monorepo's own name, account/strategy
#      discussion), and both already leaked into the public repo and the
#      npm tarball once, precisely because this step used to copy every
#      tracked file with no exceptions.
#   4. Commits in the TARGET repo (one new commit, normal history).
#      Does NOT push - pushing is a deliberate, separate, human/CI step.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

TARGET=""
NEW_VERSION=""
ALLOW_DELETIONS=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --version)
      NEW_VERSION="$2"
      shift 2
      ;;
    --allow-deletions)
      ALLOW_DELETIONS="1"
      shift
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
  echo "Usage: $0 <path-to-public-repo-checkout> [--version X.Y.Z] [--allow-deletions]" >&2
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
# Never mirrored, even though both are git-tracked right here: internal-
# only planning docs that chronicle THIS team's own decision-making (this
# private monorepo's own name, account/strategy discussion) - never meant
# to leave it. These leaked into the public repo and the npm tarball once
# already (cleaned up by hand there after the fact, 2026-09) because
# nothing stopped step 3 below from copying them like any other tracked
# file - this list is what stops that from silently happening again on
# the next sync.
NEVER_MIRROR=("ROADMAP.md" "OPEN_SOURCE_ROADMAP.md")
is_never_mirrored() {
  local candidate="$1"
  for excluded in "${NEVER_MIRROR[@]}"; do
    if [[ "$candidate" == "$excluded" ]]; then
      return 0
    fi
  done
  return 1
}


# ── Pre-flight: refuse to delete work that exists ONLY in the target ────────
# Everything below this point is a MIRROR, not a merge: the wipe deletes every
# target file this directory does not have. That is correct when this directory
# is genuinely ahead, and destructive when it is not - and "not" is invisible
# from the diff, because the missing files are missing on THIS side.
#
# Measured on 2026-09-10: the public repo held 17 tracked files this directory
# lacked (cascade.js, coalescing.js, guardrails.js, pii.js, tracing.js, the
# eval/ harness, seven test files, the release workflow) plus newer versions of
# cache.js, providers/openai.js and metrics.js. An unguarded run would have
# deleted all of it in one commit, silently, in the name of "publishing the OSS
# release" - and the work existed nowhere else.
#
# So list what only the target has and refuse, unless the operator says the
# deletion is intended (--allow-deletions). Same spirit as the .git check above.
TARGET_ONLY=()
while IFS= read -r f; do
  [[ -n "$f" ]] || continue
  is_never_mirrored "$f" && continue
  [[ -e "$f" ]] || TARGET_ONLY+=("$f")
done < <(git -C "$TARGET" ls-files)

if [[ "${#TARGET_ONLY[@]}" -gt 0 && "$ALLOW_DELETIONS" != "1" ]]; then
  echo "❌ Refusing to sync: ${#TARGET_ONLY[@]} tracked file(s) exist in the target and not here." >&2
  printf '   %s\n' "${TARGET_ONLY[@]}" >&2
  echo "   Syncing would DELETE them, because this script mirrors rather than merges." >&2
  echo "   Bring them into this directory first (that is the documented direction), or re-run" >&2
  echo "   with --allow-deletions if removing them from the public repo is really intended." >&2
  exit 1
fi

# Wipe the target's working tree except .git/, then copy this
# directory's tracked files in - guarantees the target ends up an
# EXACT mirror, not an accumulation of whatever used to be there.
find "$TARGET" -mindepth 1 -maxdepth 1 -not -name ".git" -exec rm -rf {} +

copied=0
while IFS= read -r -d '' file; do
  if is_never_mirrored "$file"; then
    continue
  fi
  dest="$TARGET/$file"
  mkdir -p "$(dirname "$dest")"
  cp "$file" "$dest"
  copied=$((copied + 1))
done < <(git ls-files -z)

echo "  ✅ Copied $copied tracked files (${#NEVER_MIRROR[@]} internal-only doc(s) deliberately excluded: ${NEVER_MIRROR[*]})."

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
