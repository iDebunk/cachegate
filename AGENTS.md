# Working here as an agent — start here

If you are an LLM (any session, any platform) about to make your first commit to this repo: read this
first. It is short on purpose. `README.md` explains what the engine does; this explains how to change it
without breaking the things that are easy to break quietly.

This is a **public** repo. That single fact governs several rules below.

## The one-paragraph version

`main` is the only long-lived branch. One task per branch, one PR per task, and the owner merges — agents
do not. The repo is the coordination channel: whoever picks up a PR reads the branch and the comments, not
a status report. Commit messages carry the reasoning, because the next reader was not in the room.

## Branches, merges, and the one thing that looks broken but is not

- **One branch per task**, named for the task, cut from `main`.
- **This repo is squash-only.** Merge-commit and rebase are disabled at the repo level, and
  `delete_branch_on_merge` is on. Do not retire branches by hand; the merge does it.
- **A merged branch does not look merged.** After a squash the branch tip is *never* an ancestor of
  `main`, so **neither `git branch --merged` nor `git cherry` is a merge detector here.** They will tell
  you a merged branch is unmerged, and they will be wrong every time. Ask the system that owns the truth:

  ```bash
  gh api "repos/<owner>/<repo>/pulls?head=<owner>:<branch>" --jq '.[].state'
  ```

- **Never force-push `main`**, and never push directly to it.

## This is a public repo — three rules that are not negotiable

1. **No credentials, ever** — not in code, not in tests, not in fixtures, not "temporarily". A
   key-shaped *placeholder* is fine and often necessary (the PII tests use them deliberately); a real one
   is a rotation on the day it lands.
2. **No internal planning material.** Roadmaps, strategy, account details, pricing discussions and
   anything naming internal-only infrastructure belong elsewhere. Internal planning documents have leaked
   into this repo's npm tarball once already, which is why `package.json` carries an explicit `files`
   allowlist. **Treat that allowlist as a publication boundary: do not widen it, and do not delete it.**
   If a new file must ship, add it deliberately and say why in the commit.
3. **Write for a stranger.** Anything you add here is read by people with no context: no references to
   internal repos, task ids or private conversations.

## Changing the engine — the contracts

The cache is the part of this repo where a mistake is invisible until it is expensive.

- **The answer-shape fields live in ONE place** (`shapeFields()` in `cache.js`), and both the exact cache
  and `semanticCache.js` call it. They diverged once — the exact key learned about `response_format` and
  the semantic path never did, so a `json_object` caller could be served cached prose, fail to parse it,
  and read the failure as an outage. **Adding a field to one path and not the other is the failure mode;
  a shared definition is the fix.**
- **Matching by embedding is approximate about the prompt, never about the answer's shape.** A semantic
  hit may be a fuzzy text match; it may not be a different *kind* of answer. `tools` is excluded outright,
  and shape is a hard filter.
- **Key ORDER is part of the hash.** Reordering fields in `buildCacheKey` changes every key and flushes
  the live cache. That is sometimes the right thing to do — it is never an accident to have.
- **Security defaults fail CLOSED.** `TRUST_PROXY` defaults to `false` on purpose: with no proxy in front,
  trusting `X-Forwarded-For` lets any caller fake a fresh IP and defeat the per-IP limiter. A proxied
  deployment sets it explicitly. Unparseable values refuse to boot rather than guessing.
- **A cache miss is cheap; a wrong answer is not.** When choosing between the two, miss.

## How to verify — before you claim it works

1. **Exercise the failure path, not just the happy one.** A check that has never been seen to fail is not
   a check. When you fix something, make the test **fail against the old code first**, and say so.
2. **`npm test` must be green.** Tests that need infrastructure run their own (the semantic-cache tests
   start their own `redis-server`); do not skip them.
3. **State the limit of what you measured.** "Hit rate among requests that slot" is not the same claim as
   "hit rate if slotting were removed", and presenting the first as the second is how a number becomes a
   misleading one. Say which one you measured.
4. **Fix the generator, not the artifact.** Correcting a generated file and leaving the thing that
   generates it alone buys exactly one run.

## Reporting

- One PR per task, with the reasoning in the description: what was wrong, how it was measured, what you
  did **not** do and why.
- If a claim in a review, an issue or a previous commit turns out to be wrong — including your own from
  an hour ago — say so plainly with the command output that shows it. Being wrong out loud is cheap;
  being wrong silently is what these rules exist to prevent.
- Do not merge. The owner merges.
