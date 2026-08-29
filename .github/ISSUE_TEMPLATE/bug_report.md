---
name: Bug report
about: Something isn't working the way it should
title: ''
labels: bug
assignees: ''
---

**What happened**
A clear description of the actual behavior.

**What you expected instead**

**Steps to reproduce**
1.
2.
3.

**Environment**
- cachegate version:
- Node version:
- Deployment: standalone / embedded in another app / Docker
- Redis: version, and whether it's configured at all (some features
  degrade cleanly without it — see README's "Features")

**Relevant config**
Which env vars are set (names only — **never paste real API keys, the
internal key, or a database URL here**): e.g. `ROUTER_STRATEGY=cost`,
`SEMANTIC_CACHE_ENABLED=true`, `DATABASE_URL` set (Postgres) vs. unset
(JSONL).

**Logs**
Relevant server console output, with any secret values redacted.
