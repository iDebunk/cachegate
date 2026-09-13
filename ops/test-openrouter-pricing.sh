#!/usr/bin/env bash
# test-openrouter-pricing.sh - is OpenRouter's pricing wired to boot/interval?
#
# Bug (claude review): providers/openrouter.js estimateCost() reads pricingTable, which only
# refreshPricing() populates - and refreshPricing() was never called in production, so OpenRouter
# candidates could never win a router:cost comparison (they only sort last as "unknown"). This
# asserts the wiring exists in the caller (server.js) and that the interval shares the provider's
# own TTL constant rather than a second hardcoded number.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SRV="${HERE}/../server.js"
OR="${HERE}/../providers/openrouter.js"
FAILED=0
pass(){ printf '  PASS  %s\n' "$1"; }
fail(){ printf '  FAIL  %s\n' "$1"; FAILED=1; }

[ -f "$SRV" ] || { echo "server.js not found" >&2; exit 2; }
[ -f "$OR" ] || { echo "providers/openrouter.js not found" >&2; exit 2; }

# 1. The caller refreshes pricing at boot + on an interval.
grep -q 'refreshPricing().catch' "$SRV" && pass "server.js calls refreshPricing at boot/interval" \
  || fail "server.js never calls refreshPricing (OpenRouter cost routing stays null)"
# 2. The interval constant is the provider's own, not a duplicated number.
grep -q 'PRICING_TTL_MS' "$OR" && grep -q 'openrouterMod.PRICING_TTL_MS' "$SRV" \
  && pass "the interval uses the provider's PRICING_TTL_MS (one authority)" \
  || fail "PRICING_TTL_MS is not shared between openrouter.js and server.js"

exit "$FAILED"
