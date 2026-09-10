// providers-wiring.test.js - the REACHABILITY test for the provider registry.
//
// This is not "does providers/deepseek.js work" (that is providers-deepseek.test.js,
// which stubs the SDK client). This is "if a caller sends `deepseek-flash` to the
// running server, does the request actually come out of the other end as a
// DeepSeek call?" - the difference between code that exists and code that
// executes, which is the failure mode this repository has already been bitten
// by once (an entrypoint step, merged and reviewed, that could never run).
//
// Method: no live keys and no spend. Both new providers take their base URL from
// the environment, so a local stub HTTP server stands in for the vendor and the
// request travels the real path - express route -> tier/direct dispatch ->
// providerForModel -> registry -> provider module -> SDK -> HTTP.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

// Set BEFORE requiring ../server and ../providers/*: the provider modules read
// their base URL at load time, and server.js reads its internal key the same way.
process.env.MODEL_ROUTER_INTERNAL_KEY = 'test-internal-key';
process.env.METRICS_LOG_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wiring-test-')), 'metrics.jsonl');
process.env.OPENROUTER_SITE_URL = 'https://cachegate.test';
process.env.OPENROUTER_SITE_NAME = 'Cachegate Test';
// Point a tier at the stub too, so the ROUTED dispatch path (which goes through
// failover -> dispatchToProvider) is covered, not just direct model dispatch.
process.env.ROUTER_TIERS_JSON = JSON.stringify({ 'router:fast-cheap': [{ provider: 'deepseek', model: 'deepseek-flash' }] });
// OPENAI_API_KEY is deliberately left unset: one test asserts the registry's
// "which key is missing" message for a provider that has no key.

const INTERNAL = { 'Content-Type': 'application/json', Authorization: 'Bearer test-internal-key' };

let stub;
let app;
let routerPort;
const seen = [];   // every request the stub received

function stubReply() {
  return {
    id: 'stub-1',
    object: 'chat.completion',
    created: 1,
    model: 'stub-model',
    choices: [{ index: 0, message: { role: 'assistant', content: 'served-by-stub' }, finish_reason: 'stop' }],
    usage: {
      prompt_tokens: 11, completion_tokens: 4, total_tokens: 15,
      // DeepSeek's own cache fields (flat), present so the mapping is exercised
      prompt_cache_hit_tokens: 6, prompt_cache_miss_tokens: 5
    }
  };
}

before(async () => {
  stub = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      seen.push({ url: req.url, headers: req.headers, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(stubReply()));
    });
  });
  await new Promise((r) => stub.listen(0, '127.0.0.1', r));
  const port = stub.address().port;

  process.env.DEEPSEEK_API_KEY = 'test-deepseek-key';
  process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${port}`;
  process.env.OPENROUTER_API_KEY = 'test-openrouter-key';
  process.env.OPENROUTER_BASE_URL = `http://127.0.0.1:${port}/v1`;

  ({ app } = require('../server'));
  const router = http.createServer(app);
  await new Promise((r) => router.listen(0, '127.0.0.1', r));
  routerPort = router.address().port;
  app.locals.__router = router;
});

after(() => {
  if (app && app.locals.__router) app.locals.__router.close();
  if (stub) stub.close();
});

function post(body) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port: routerPort, path: '/v1/chat/completions', method: 'POST', headers: INTERNAL },
      (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => {
          let parsed; try { parsed = JSON.parse(data); } catch { parsed = data; }
          resolve({ status: res.statusCode, body: parsed });
        });
      }
    );
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

test('registry: model names map to the intended provider, aggregator ids first', () => {
  const providers = require('../providers');
  assert.equal(providers.detectProvider('claude-sonnet-4-5-20250929'), 'anthropic');
  assert.equal(providers.detectProvider('gpt-4o-mini'), 'openai');
  assert.equal(providers.detectProvider('o3-mini'), 'openai');
  assert.equal(providers.detectProvider('deepseek-flash'), 'deepseek');
  assert.equal(providers.detectProvider('deepseek-v4-pro'), 'deepseek');
  // The trap this ordering exists for: a vendor/model id names DeepSeek, but it
  // is an OpenRouter call - it must not be captured by the deepseek-* prefix.
  assert.equal(providers.detectProvider('deepseek/deepseek-chat'), 'openrouter');
  assert.equal(providers.detectProvider('meta/llama-3-70b'), 'openrouter');
  assert.equal(providers.detectProvider('gemini-2.0-flash'), null);
  assert.equal(providers.detectProvider(undefined), null);
});

test('a deepseek-* request reaches providers/deepseek through the real server path', async () => {
  seen.length = 0;
  const res = await post({ model: 'deepseek-flash', messages: [{ role: 'user', content: 'hello' }] });

  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'deepseek', 'the router attributed the call to deepseek');
  assert.equal(res.body.choices[0].message.content, 'served-by-stub', 'the stub answered, so the call really left the process');

  assert.equal(seen.length, 1, 'exactly one upstream call');
  assert.ok(seen[0].url.endsWith('/chat/completions'), `unexpected upstream path ${seen[0].url}`);
  assert.equal(seen[0].body.model, 'deepseek-flash');
  // The registry's env key is the one used to build the client
  assert.equal(seen[0].headers.authorization, 'Bearer test-deepseek-key');

  // DeepSeek's flat cache fields survived the round trip into the router's
  // own usage object (the mapping the external review got wrong).
  assert.equal(res.body.usage.cache_hit_tokens, 6);
  assert.equal(res.body.usage.cache_miss_tokens, 5);
  assert.equal(res.body.usage.input_tokens, 11);
});

test('a vendor/model request reaches OpenRouter with attribution headers attached', async () => {
  seen.length = 0;
  const res = await post({ model: 'meta/llama-3-70b', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'openrouter');
  assert.equal(seen[0].body.model, 'meta/llama-3-70b', 'the vendor/model id is sent through unchanged');
  assert.equal(seen[0].headers.authorization, 'Bearer test-openrouter-key');
  // Configured attribution must actually be on the wire, not merely in a helper
  assert.equal(seen[0].headers['http-referer'], 'https://cachegate.test');
  assert.equal(seen[0].headers['x-title'], 'Cachegate Test');
  // No pricing table was loaded for this model, so cost is UNKNOWN - and it must
  // not have been flattened to 0, which cost-based routing would read as free.
  assert.equal(res.body.cost_usd, null);
});

test('the explicit openrouter/ prefix strips to the wire id', async () => {
  seen.length = 0;
  await post({ model: 'openrouter/deepseek/deepseek-chat', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(seen[0].body.model, 'deepseek/deepseek-chat');
});

test('a provider with no key configured fails with the registry-generated message', async () => {
  const res = await post({ model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 500);
  // Names the variable that provider actually needs - built from the registry,
  // so it cannot drift from the key resolution itself.
  assert.match(JSON.stringify(res.body), /OPENAI_API_KEY not configured/);
});

test('an unknown model is still a 400, exactly as before the registry', async () => {
  const res = await post({ model: 'gemini-2.0-flash', messages: [{ role: 'user', content: 'hi' }] });
  assert.equal(res.status, 400);
  assert.match(JSON.stringify(res.body), /Unsupported model/);
});

test('routed (tier) dispatch reaches the new provider through dispatchToProvider', async () => {
  // Direct dispatch and routed dispatch are two different code paths (the direct
  // branch selects by model prefix; the routed one goes through failover ->
  // dispatchToProvider). Both were rewired to the registry, so both are proven.
  seen.length = 0;
  const res = await post({ model: 'router:fast-cheap', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(res.status, 200);
  assert.equal(res.body.provider, 'deepseek', 'the tier resolved to the deepseek candidate');
  assert.equal(res.body.choices[0].message.content, 'served-by-stub');
  assert.equal(seen.length, 1);
  assert.equal(seen[0].body.model, 'deepseek-flash');
});
