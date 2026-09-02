// model-router/redisClient.js
//
// One shared Redis connection, used by both the exact-match cache
// (cache.js) and the semantic cache (semanticCache.js). Previously
// cache.js opened and owned this connection privately; pulled out here
// so the semantic cache doesn't open a second connection to the same
// Redis instance for the same purpose.

const { createClient } = require('redis');

const client = createClient({
  url: process.env.REDIS_URL || 'redis://localhost:6379'
});

client.on('error', (err) => {
  console.warn('⚠️ Redis client error:', err?.message || err?.code || String(err));
});

let readyResolve;
// Resolves once the initial connection attempt finishes, success or
// failure - tests await this instead of polling isConnected() in a
// loop. Normal request handling doesn't need it: get/set/find/store all
// already check isConnected() and degrade gracefully.
const ready = new Promise((resolve) => { readyResolve = resolve; });

(async () => {
  try {
    if (process.env.REDIS_URL && !client.isOpen) {
      await client.connect();
      console.log('✅ Model Router connected to Redis');
    } else if (!process.env.REDIS_URL) {
      console.warn('⚠️ REDIS_URL not set. Caching disabled.');
    }
  } catch (err) {
    console.warn('⚠️ Failed to connect to Redis:', err.message);
  } finally {
    readyResolve();
  }
})();

// node-redis v4: `isOpen` is true for the client's ENTIRE lifetime,
// including the automatic-reconnect loop after the socket dies - gating
// cache reads/writes on it lets every command queue on a dead socket and
// hang the request instead of failing open. `isReady` is true only when
// a command can actually execute right now. Live-verified in the
// Cachegate Cloud build (its PR #12 review): with isOpen, a stopped
// Redis hung /v1 requests for 2+ minutes; with isReady the same request
// returned in 11ms, correctly skipping the cache. This is the backport
// of that fix - the cloud vendored this engine and fixed its copy first;
// the engine and the public cachegate repo still shipped the bug.
function isConnected() {
  return client.isReady;
}

module.exports = { client, isConnected, ready };
