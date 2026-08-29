// model-router/metrics.js
//
// A shared record of what actually happened on every request: which
// provider handled it, how long it took, what it cost, whether it was
// a cache hit, and whether it errored. Two things depend on this data
// existing, so it's built once, here, rather than twice:
//
//   1. Routing (router.js) needs rolling latency/error-rate per
//      provider to make a "cheapest CAPABLE provider" decision - a
//      static price table alone can't tell you a provider is currently
//      slow or failing.
//   2. The cost dashboard needs historical data to show - there is
//      nothing to dashboard without a log.
//
// Storage is local, append-only JSONL, not a database - that keeps the
// self-hosted/lightweight positioning honest (no new infrastructure to
// run) while still being real persistence: every line is a complete,
// independent JSON record, so a crash mid-write loses at most the one
// in-flight line, and any tool that can read lines of JSON (jq, a
// script) can consume it directly.
//
// ROTATION: one file per UTC calendar day (metrics-YYYY-MM-DD.jsonl),
// not one file forever. This used to be a real, documented gap - a
// single ever-growing file that every read (a dashboard load, a /stats
// call, a routing-health check) re-read and re-parsed in FULL,
// regardless of how much data the caller actually needed. Splitting by
// day means readRecent() and rangeSummary() only open the files that
// could actually contain what they're looking for - a 14-day dashboard
// query reads at most 15 files, not the service's entire history.
// Old files are NOT deleted automatically - see pruneOlderThan() for
// the explicit, opt-in cleanup an operator can run; silently deleting
// someone's cost history without being asked is a worse default than
// disk slowly filling up, and this module doesn't get to make that
// retention call on its own.

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Pool } = require('pg');

// Postgres-backed persistence - OPT-IN, not a replacement. The JSONL
// file storage above/below stays the default for exactly the reason
// its own original comment gives: self-hosted/lightweight, zero new
// infrastructure required to run this router standalone in some other
// app. But the EMBEDDED deployment inside MemoCode specifically already
// has a real Postgres database (memocode-db, provisioned for its own
// user-account/library data regardless of this router) - reusing that
// costs nothing new (no extra service, no extra bill, no extra account)
// and, unlike the router's own container filesystem, genuinely survives
// a restart/redeploy. DATABASE_URL is Render's own standard convention
// for injecting a database's connection string (matches how
// 000_backend/db.mjs reads the exact same variable for the exact same
// reason) - set it and every function below transparently reads/writes
// Postgres instead of local files; leave it unset and nothing here
// changes at all.
function usingPostgres() {
  return Boolean(process.env.DATABASE_URL || process.env.MEMOCODE_ROUTER_DATABASE_URL);
}

let pgPool = null;
function getPool() {
  if (!pgPool) {
    const connectionString = process.env.MEMOCODE_ROUTER_DATABASE_URL || process.env.DATABASE_URL;
    pgPool = new Pool({
      connectionString,
      // Same rule db.mjs already uses: a real hosted Postgres (Render's
      // managed instance) needs SSL; a local one (dev, this module's
      // own tests) doesn't and would just fail the handshake if asked.
      ssl: connectionString && !/localhost|127\.0\.0\.1/.test(connectionString) ? { rejectUnauthorized: false } : false
    });
  }
  return pgPool;
}

// Idempotent - safe to call on every getPool() use (CREATE TABLE/INDEX
// IF NOT EXISTS), so a fresh deployment self-provisions its own schema
// on first write with no separate migration step to remember to run.
let schemaReady = null;
async function ensureSchema() {
  if (!schemaReady) {
    schemaReady = getPool().query(`
      CREATE TABLE IF NOT EXISTS router_metrics (
        id BIGSERIAL PRIMARY KEY,
        ts TIMESTAMPTZ NOT NULL DEFAULT now(),
        provider TEXT,
        model TEXT,
        requested_model TEXT,
        cache_hit BOOLEAN,
        cache_type TEXT,
        latency_ms INTEGER,
        cost_usd DOUBLE PRECISION,
        error TEXT,
        error_type TEXT
      );
      CREATE INDEX IF NOT EXISTS router_metrics_ts_idx ON router_metrics (ts DESC);
      CREATE INDEX IF NOT EXISTS router_metrics_provider_ts_idx ON router_metrics (provider, ts DESC);
    `);
  }
  return schemaReady;
}

// Maps one Postgres row back to the exact same shape record() writes to
// a JSONL line - so every function below this point (readRecent,
// providerStats, rangeSummary) can share its existing row-aggregation
// logic UNCHANGED regardless of which backend actually supplied the
// rows. Only the row-fetching prelude differs between the two backends;
// nothing downstream needs to know or care which one ran.
function rowFromPg(dbRow) {
  return {
    timestamp: dbRow.ts.toISOString(),
    provider: dbRow.provider || undefined,
    model: dbRow.model || undefined,
    requested_model: dbRow.requested_model || undefined,
    cache_hit: dbRow.cache_hit === null ? undefined : dbRow.cache_hit,
    cache_type: dbRow.cache_type || undefined,
    latency_ms: dbRow.latency_ms === null ? undefined : dbRow.latency_ms,
    cost_usd: dbRow.cost_usd === null ? undefined : dbRow.cost_usd,
    error: dbRow.error || undefined,
    error_type: dbRow.error_type || undefined
  };
}

async function recordToPostgres(entry) {
  try {
    await ensureSchema();
    await getPool().query(
      `INSERT INTO router_metrics
         (provider, model, requested_model, cache_hit, cache_type, latency_ms, cost_usd, error, error_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        entry.provider ?? null,
        entry.model ?? null,
        entry.requested_model ?? null,
        entry.cache_hit ?? null,
        entry.cache_type ?? null,
        entry.latency_ms ?? null,
        entry.cost_usd ?? null,
        entry.error ?? null,
        entry.error_type ?? null
      ]
    );
  } catch (err) {
    // Same fire-and-forget contract as the file backend's own record():
    // a metrics write must never be the reason a real request fails.
    console.warn('⚠️ Failed to record metric (Postgres):', err.message);
  }
}

async function readRecentFromPostgres(limit) {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM router_metrics ORDER BY ts DESC LIMIT $1`,
    [limit]
  );
  return result.rows.reverse().map(rowFromPg); // oldest-first, matching readRecent()'s own file-backed order
}

async function rowsSinceFromPostgres(cutoffMs) {
  await ensureSchema();
  const result = await getPool().query(
    `SELECT * FROM router_metrics WHERE ts >= $1 ORDER BY ts ASC`,
    [new Date(cutoffMs)]
  );
  return result.rows.map(rowFromPg);
}

async function pruneOlderThanPostgres(days) {
  await ensureSchema();
  const result = await getPool().query(
    `DELETE FROM router_metrics WHERE ts < now() - ($1::double precision * interval '1 day') RETURNING id`,
    [days]
  );
  return result.rows.map((r) => r.id);
}

// Turns a raw provider error message into one of a handful of stable,
// human-meaningful buckets - the difference between a dashboard that says
// "openai: 100% error rate" (true, but not actionable without opening a
// terminal and reading a stack trace) and one that says
// "openai: authentication_error" (tells you exactly what to go fix).
// Anthropic's and OpenAI's SDKs both format a thrown error's .message the
// same way: "<http status> <json error body>" - so this tries that shape
// first (checking BOTH `.error.type`/`.error.code` for OpenAI's nesting
// and bare `.type` for Anthropic's), and falls back to keyword matching
// on the raw text for anything that doesn't parse (a network error has no
// JSON body at all, for instance - "unknown" is still more honest than
// guessing). Exported so server.js's error handlers and this module's own
// tests can both use the exact same classification, never two versions
// that could drift apart.
function classifyErrorType(message) {
  if (!message) return 'unknown';
  const jsonStart = message.indexOf('{');
  if (jsonStart !== -1) {
    try {
      const body = JSON.parse(message.slice(jsonStart));
      const type = body?.error?.type || body?.type;
      const code = body?.error?.code;
      if (type === 'authentication_error' || code === 'invalid_api_key') return 'authentication_error';
      if (type === 'insufficient_quota' || code === 'insufficient_quota') return 'insufficient_quota';
      if (type === 'rate_limit_error' || code === 'rate_limit_exceeded') return 'rate_limit_error';
      if (type) return type; // whatever the provider itself called it - still more useful than "unknown"
    } catch {
      // Not JSON (or not shaped as expected) - fall through to keywords.
    }
  }
  const lower = message.toLowerCase();
  if (lower.includes('invalid') && lower.includes('key')) return 'authentication_error';
  if (lower.includes('quota') || lower.includes('insufficient')) return 'insufficient_quota';
  if (lower.includes('rate limit') || lower.includes('429')) return 'rate_limit_error';
  return 'unknown';
}

// Historical note: METRICS_LOG_PATH used to name the one-and-only log
// file directly. It's kept as the configuration knob for backward
// compatibility, but now names the DIRECTORY those per-day files live
// in (its dirname) - existing deployments/tests that set it to a file
// path like ".../data/metrics.jsonl" keep working unchanged, since
// that file's directory is exactly where rotation stores things now.
const DATA_DIR = process.env.METRICS_LOG_PATH
  ? path.dirname(process.env.METRICS_LOG_PATH)
  : path.join(__dirname, 'data');

fs.mkdirSync(DATA_DIR, { recursive: true });

const FILE_NAME_PATTERN = /^metrics-(\d{4}-\d{2}-\d{2})\.jsonl$/;

function dateStringFor(date) {
  return date.toISOString().slice(0, 10); // YYYY-MM-DD, UTC
}

function pathForDateString(dateStr) {
  return path.join(DATA_DIR, `metrics-${dateStr}.jsonl`);
}

/** Today's log file path, in UTC. Exposed for tests; not meant for app code to write to directly - use record(). */
function currentLogPath() {
  return pathForDateString(dateStringFor(new Date()));
}

/**
 * Every rotated log file present, ascending by date. A file that
 * doesn't match the naming pattern (stray file, .gitkeep, whatever) is
 * silently ignored rather than treated as a parse error.
 */
async function listLogFiles() {
  let names;
  try {
    names = await fs.promises.readdir(DATA_DIR);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const match = name.match(FILE_NAME_PATTERN);
      return match ? { date: match[1], path: path.join(DATA_DIR, name) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.date.localeCompare(b.date));
}

async function readFileRows(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = [];
  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity
  });
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // Skip a malformed line rather than aborting the whole read.
    }
  }
  return rows;
}

// A plain per-call fs.appendFile was tried here first and was wrong:
// concurrent calls to record() (real traffic under load, or even just a
// tight test loop) fire multiple appendFile operations at once with no
// guaranteed completion order, so lines could interleave or land out of
// order - a real, reproducible flake this project's own tests caught
// (roughly 1 run in 5). A single long-lived write stream serializes its
// writes internally even when called back-to-back without awaiting
// each one, which is what actually guarantees ordering. The only thing
// a persistent stream needs extra is handling day rollover - resolved
// by checking today's date on every write and swapping to a fresh
// stream the moment it changes, so a long-running process still rotates
// correctly without ever writing yesterday's line into today's file or
// vice versa.
let currentStream = null;
let currentStreamDate = null;

function ensureWriteStream() {
  const today = dateStringFor(new Date());
  if (currentStream && currentStreamDate === today) return currentStream;
  if (currentStream) currentStream.end();
  currentStreamDate = today;
  currentStream = fs.createWriteStream(pathForDateString(today), { flags: 'a' });
  currentStream.on('error', (err) => {
    console.warn('⚠️ Metrics log write error:', err.message);
  });
  return currentStream;
}

/**
 * Record one completed request, appended to TODAY's file. Fire-and-
 * forget by design - a metrics write must never be the reason a real
 * request fails or slows down.
 */
function record(entry) {
  if (usingPostgres()) {
    recordToPostgres(entry); // fire-and-forget - see its own comment
    return;
  }
  try {
    const line = JSON.stringify({ timestamp: new Date().toISOString(), ...entry }) + '\n';
    ensureWriteStream().write(line);
  } catch (err) {
    console.warn('⚠️ Failed to record metric:', err.message);
  }
}

/**
 * Read up to `limit` most recent records, scanning files newest-first
 * and stopping as soon as enough rows have been collected - bounded by
 * how many DAYS of data are needed to satisfy `limit`, not by the
 * service's entire lifetime.
 */
async function readRecent(limit = 500) {
  if (usingPostgres()) return readRecentFromPostgres(limit);
  const files = await listLogFiles();
  const collected = [];
  for (let i = files.length - 1; i >= 0 && collected.length < limit; i--) {
    const rows = await readFileRows(files[i].path);
    collected.unshift(...rows);
  }
  return collected.slice(-limit);
}

/**
 * Rolling per-provider stats from the most recent `windowSize` requests
 * to that provider: average latency and error rate. This is the signal
 * router.js uses alongside the static cost table - a provider that is
 * currently slow or failing shouldn't be picked just because its list
 * price is lowest.
 */
async function providerStats(windowSize = 50) {
  const rows = await readRecent(2000);
  const byProvider = {};

  for (const row of rows) {
    if (!row.provider) continue;
    if (!byProvider[row.provider]) byProvider[row.provider] = [];
    byProvider[row.provider].push(row);
  }

  const stats = {};
  for (const [provider, entries] of Object.entries(byProvider)) {
    const recent = entries.slice(-windowSize);
    const errorEntries = recent.filter((e) => e.error);
    const latencies = recent.filter((e) => !e.error && typeof e.latency_ms === 'number');
    const avgLatencyMs = latencies.length
      ? latencies.reduce((sum, e) => sum + e.latency_ms, 0) / latencies.length
      : null;
    // The MOST RECENT error only, not a tally of every type seen in the
    // window - an alert should reflect "what's wrong right now," not a
    // mix that might include something already fixed earlier in the
    // window. Falls back to classifying on the fly for an older record
    // written before error_type existed (see server.js) instead of
    // silently going blank.
    const lastError = errorEntries.length ? errorEntries[errorEntries.length - 1] : null;

    stats[provider] = {
      sampleSize: recent.length,
      errorRate: recent.length ? errorEntries.length / recent.length : 0,
      avgLatencyMs,
      lastErrorType: lastError ? lastError.error_type || classifyErrorType(lastError.error) : null,
      lastErrorAt: lastError ? lastError.timestamp : null
    };
  }
  return stats;
}

/**
 * Everything the cost dashboard needs for a calendar window, computed
 * in one pass so the KPI numbers and the daily chart data are
 * guaranteed to agree - they're two views of the exact same filtered
 * rows, never two separate queries that could drift apart.
 *
 * Only the files whose OWN date falls inside [cutoff, today] are read
 * at all - a 14-day query never opens a file from three months ago.
 * The per-row timestamp filter still runs afterward (a file's date is
 * an inclusion bound, not a correctness guarantee - see
 * listLogFiles()'s "only matches the naming pattern" note).
 *
 * A "miss" bucket is anything dispatched to a provider that WASN'T a
 * cache hit, successful or not - the error count is tracked alongside
 * it per day for the table view and tooltip, but deliberately isn't
 * its own stacked-chart series (see the dashboard page: three clean
 * outcome series read better than four, and error rate has its own,
 * more precise, KPI tile and per-provider breakdown instead).
 *
 * by_provider here is intentionally a different shape than
 * providerStats() above: that one is a ROLLING window for routing
 * health (router.js), this one is a CALENDAR window for reporting
 * (the dashboard) and also carries request count and cost. Same
 * underlying log, two different questions - not accidentally
 * duplicated logic.
 */
async function rangeSummary(days = 14) {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Row-fetching prelude only - everything from here down (the actual
  // daily/provider/hit-rate aggregation) is identical regardless of
  // which backend supplied `rows`, so it's written once, below, shared
  // by both.
  let rows;
  if (usingPostgres()) {
    rows = await rowsSinceFromPostgres(cutoff); // already filtered server-side
  } else {
    const files = await listLogFiles();
    const relevantFiles = files.filter((f) => {
      // A file's own day spans [dayStart, dayStart + 24h) UTC; keep it if
      // any part of that day could be on or after the cutoff.
      const dayStart = Date.parse(`${f.date}T00:00:00.000Z`);
      return dayStart + 24 * 60 * 60 * 1000 > cutoff;
    });
    rows = [];
    for (const f of relevantFiles) {
      rows = rows.concat(await readFileRows(f.path));
    }
  }
  const inRange = rows.filter((r) => r.timestamp && Date.parse(r.timestamp) >= cutoff);

  const dailyByDate = new Map();
  const byProvider = {};
  let totalCostUsd = 0;
  let exactHits = 0;
  let semanticHits = 0;
  let misses = 0;
  let errors = 0;

  for (const row of inRange) {
    const date = row.timestamp.slice(0, 10); // YYYY-MM-DD (UTC, from toISOString())
    if (!dailyByDate.has(date)) {
      dailyByDate.set(date, { date, requests: 0, cost_usd: 0, exact_hits: 0, semantic_hits: 0, misses: 0, errors: 0 });
    }
    const bucket = dailyByDate.get(date);
    bucket.requests += 1;
    bucket.cost_usd += row.cost_usd || 0;
    totalCostUsd += row.cost_usd || 0;

    if (row.provider) {
      if (!byProvider[row.provider]) {
        byProvider[row.provider] = { requests: 0, cost_usd: 0, errorCount: 0, latencies: [] };
      }
      const p = byProvider[row.provider];
      p.requests += 1;
      p.cost_usd += row.cost_usd || 0;
      if (row.error) p.errorCount += 1;
      else if (typeof row.latency_ms === 'number') p.latencies.push(row.latency_ms);
    }

    if (row.error) {
      errors += 1;
      bucket.errors += 1;
    } else if (row.cache_hit && row.cache_type === 'semantic') {
      semanticHits += 1;
      bucket.semantic_hits += 1;
    } else if (row.cache_hit) {
      exactHits += 1;
      bucket.exact_hits += 1;
    } else {
      misses += 1;
      bucket.misses += 1;
    }
  }

  const providerSummary = {};
  for (const [name, p] of Object.entries(byProvider)) {
    providerSummary[name] = {
      requests: p.requests,
      cost_usd: p.cost_usd,
      errorRate: p.requests ? p.errorCount / p.requests : 0,
      avgLatencyMs: p.latencies.length ? p.latencies.reduce((sum, v) => sum + v, 0) / p.latencies.length : null
    };
  }

  return {
    days,
    sample_size: inRange.length,
    total_cost_usd: totalCostUsd,
    cache_hit_rate: {
      exact: inRange.length ? exactHits / inRange.length : 0,
      semantic: inRange.length ? semanticHits / inRange.length : 0,
      combined: inRange.length ? (exactHits + semanticHits) / inRange.length : 0
    },
    error_rate: inRange.length ? errors / inRange.length : 0,
    by_provider: providerSummary,
    daily: [...dailyByDate.values()].sort((a, b) => a.date.localeCompare(b.date))
  };
}

/**
 * Explicit, opt-in cleanup: permanently deletes records older than
 * `days`. NOT called automatically anywhere in this module - deleting
 * cost/audit history is a retention-policy decision an operator makes
 * on purpose (a cron job, a manual run), never something this module
 * decides silently on their behalf. Returns the list of deleted file
 * paths (file backend) or deleted row ids (Postgres backend) - the two
 * backends' units of deletion genuinely differ, so the return value's
 * shape does too; nothing in this codebase inspects the contents today,
 * only that pruning happened and what it removed.
 */
async function pruneOlderThan(days) {
  if (usingPostgres()) return pruneOlderThanPostgres(days);
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const files = await listLogFiles();
  const deleted = [];
  for (const f of files) {
    const dayStart = Date.parse(`${f.date}T00:00:00.000Z`);
    if (dayStart + 24 * 60 * 60 * 1000 <= cutoff) {
      await fs.promises.unlink(f.path);
      deleted.push(f.path);
    }
  }
  return deleted;
}

// Test-only: closes the cached pool (if one was ever opened) so a test
// run doesn't hang on an open connection, and so the NEXT test that
// re-requires this module with a different DATABASE_URL gets a fresh
// pool/schema-ready state instead of reusing this one's.
async function closePostgresPoolForTests() {
  if (pgPool) {
    await pgPool.end();
    pgPool = null;
    schemaReady = null;
  }
}

module.exports = {
  record,
  readRecent,
  providerStats,
  rangeSummary,
  pruneOlderThan,
  currentLogPath,
  listLogFiles,
  classifyErrorType,
  usingPostgres,
  closePostgresPoolForTests,
  DATA_DIR
};
