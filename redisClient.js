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

function isConnected() {
  return client.isOpen;
}

module.exports = { client, isConnected, ready };
