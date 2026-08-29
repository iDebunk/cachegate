# Security Policy

## Reporting a vulnerability

**Please do not open a public GitHub issue for a security
vulnerability.** A public issue is a disclosure before a fix exists.

Instead, use GitHub's private vulnerability reporting:

1. Go to this repository's **Security** tab.
2. Click **Report a vulnerability**.
3. Describe the issue — what it is, how to reproduce it, and its
   likely impact (e.g. "bypasses auth," "leaks another deployment's
   cached data," "exhausts memory regardless of rate limiting").

This opens a private conversation with the maintainers, visible only to
you and them, and lets a fix be prepared and released before the
vulnerability is public.

*(Maintainer note, remove once live: this requires "Private vulnerability
reporting" to be turned on for the repository — Settings → Security →
Private vulnerability reporting — as part of step 15's repo setup.)*

## What counts as a security issue here

Concretely, for this project: anything that lets a request bypass
`MODEL_ROUTER_INTERNAL_KEY` auth, read or corrupt another deployment's
cached data or metrics, or exhaust CPU/memory/Redis storage in a way
`RATE_LIMIT_MAX`/`RATE_LIMIT_WINDOW_MS` doesn't already bound. A
provider returning an unexpected error, a routing decision you disagree
with, or a missing feature are regular bugs — open a normal issue for
those (see `CONTRIBUTING.md`).

## Supported versions

This project is pre-1.0 (see `OPEN_SOURCE_ROADMAP.md` on the version
plan) — security fixes go into the latest release only. Once a stable
1.0 line exists, this section will name which major versions still
receive fixes.
