# Contributing to cachegate

Thanks for considering it. This is a small, deliberately focused
project — read the scope note below before writing code, it'll save
you a round-trip.

## Scope — read this first

`README.md`'s "What this is NOT" section is the actual contract, not
just a marketing caveat: **no login, no billing, no multi-tenant key
custody, no hosted service** live in this repository, and a PR adding
any of those will be closed regardless of how well it's built — that
functionality belongs to a separate, closed product built on top of
this engine, not this engine itself. This isn't a licensing
restriction (MIT permits building any of that — see `LICENSE`); it's
that this repository specifically isn't going to grow into a hosted
competitor to its own paid product, so a PR heading that direction
gets closed here regardless of quality, not merged and then diverged
from later.

Everything else — routing strategies, cache behavior, provider
support, the dashboard, bug fixes — is fair game.

## Running it locally

```bash
git clone <this-repo-url>
cd cachegate
npm install
cp .env.example .env   # then fill in a real key for at least one provider
npm start
```

## Running the tests

```bash
npm test
```

This runs Node's built-in test runner (`node --test`) across every file
in `test/`. A few things worth knowing before you add to it:

- **No test here calls a real provider API.** That needs live keys and
  real spend, which isn't reasonable to require of a contributor or a
  CI run. Provider-facing logic (`providers/anthropic.js`,
  `providers/openai.js`) is tested by factoring the pure,
  non-network parts (see `applyStreamEvent`/`applyStreamChunk`) out
  into directly-testable functions with canned input — follow that
  pattern for new provider logic rather than trying to mock the HTTP
  layer.
- **Tests need to be genuinely isolated.** Several existing tests reset
  `METRICS_LOG_PATH` to a fresh temp file per test (see
  `router.test.js`'s `freshModules` helper) specifically because
  `metrics.js` reads its config once at require time. If your test
  writes metrics, don't assume a clean slate — either isolate it the
  same way, or place it deliberately last in its file if it needs to
  run after everything else that depends on a clean state (see
  `server.test.js`'s own comment on this for a worked example).
- All tests must pass before a PR is reviewed. If a test is failing for
  a reason unrelated to your change, say so explicitly in the PR rather
  than silently working around it — that's a real bug worth its own
  issue.

## Opening a PR

- Explain the *why*, not just the *what* — a one-line "fixes X" is
  fine for a trivial fix, but anything behavioral should say what
  problem it solves and how you verified the fix, the same standard
  this codebase's own commit history holds itself to.
- If you're touching `router.js`'s scoring logic, `failover.js`'s
  retry logic, or anything else with existing inline documentation
  explaining a past decision (search the file for "why" before
  changing something that looks arbitrary) — it's very likely not
  arbitrary. If you disagree with the reasoning, say so in the PR;
  don't just silently remove it.
- Small, focused PRs review faster than large ones bundling several
  unrelated changes.

**How merges actually work here, stated plainly:** this repository is
mirrored out from a private internal monorepo where day-to-day
development happens, rather than the other way around. Your PR gets
reviewed and, once approved, merged here on GitHub like normal — but
it's also manually reapplied on the internal side afterward, through
that project's own review process, rather than auto-syncing. In
practice this means a short delay between "merged here" and "in the
next internal release," not a rejection — you'll see it land in a
tagged release once that happens.

## Releasing (maintainers)

Publishing to npm, GHCR, and Docker Hub is automated by
`.github/workflows/release.yml` — bump `"version"` in `package.json`,
add the matching section to `CHANGELOG.md`, and push (or merge) to
`main`. The workflow diffs `package.json`'s version against what's
currently live on npm *before* doing anything else, so a push that
doesn't bump the version, or bumps it to a version already published,
is a safe no-op — nothing rebuilds or republishes. When it does detect
a real bump: the full test suite must pass, then it publishes to npm
and pushes `ghcr.io/idebunk/cachegate` + `docker.io/shipman/cachegate`
(both `latest` and the version tag), then best-effort tags the commit
and opens a GitHub Release with that version's `CHANGELOG.md` section
as the body.

There is no other release path — a manual `npm publish` or
`docker push` from a laptop is exactly how 1.3.1 ended up sitting
unreleased on `main` after 1.3.0 shipped (two real fixes, `#4` and
`#5`, live in every self-hosted deployment's source but not in what
`npm install cachegate` or `docker pull` actually served). Use the
workflow, not a local publish.

## Reporting a bug vs. reporting a security issue

Regular bugs: open a GitHub issue. Security vulnerabilities (anything
that could let a request bypass auth, leak another deployment's data,
or exhaust resources in a way rate limiting doesn't already cover): see
`SECURITY.md` instead — please don't file those as public issues.
