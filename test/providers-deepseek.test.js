// providers/deepseek.test.js - offline. No API key, no network: the SDK client
// is a stub with the same shape the real one has.
//
// The two things worth pinning down here are the ones a reviewer cannot check by
// reading: that the peak/off-peak window is evaluated in UTC exactly as the
// vendor documents it, and that cached input is billed at the HIT rate rather
// than being folded into the miss rate (a ~50x difference on Flash).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const deepseek = require('../providers/deepseek');

// 2026-09-10 is a Thursday, 2026-09-12 a Saturday.
const PEAK = new Date('2026-09-10T03:00:00Z');          // 03:00 UTC, weekday
const PEAK_EDGE = new Date('2026-09-10T09:59:00Z');     // inside 06:00-10:00
const OFF_PEAK = new Date('2026-09-10T12:00:00Z');      // weekday, off-peak hour
const WEEKEND = new Date('2026-09-12T03:00:00Z');       // Saturday, same hour

function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-12, `${message}: expected ${expected}, got ${actual}`);
}

test('isPeak is true inside both weekday windows and false elsewhere', () => {
  assert.equal(deepseek.isPeak(PEAK), true);
  assert.equal(deepseek.isPeak(PEAK_EDGE), true);
  assert.equal(deepseek.isPeak(OFF_PEAK), false);
});

test('isPeak is false on weekends even during the peak hours', () => {
  assert.equal(deepseek.isPeak(WEEKEND), false);
});

test('off-peak rates are exactly half of peak rates', () => {
  const peak = deepseek.rateFor('deepseek-flash', PEAK);
  const off = deepseek.rateFor('deepseek-flash', OFF_PEAK);
  close(off.miss, peak.miss / 2, 'miss rate halves');
  close(off.hit, peak.hit / 2, 'hit rate halves');
  close(off.output, peak.output / 2, 'output rate halves');
});

test('estimateCost prices a cache MISS at the missing rate', () => {
  close(deepseek.estimateCost('deepseek-flash', 1_000_000, 0, { now: PEAK }), 0.30, 'flash peak, 1M input all miss');
});

test('estimateCost prices cached input at the HIT rate, not the miss rate', () => {
  // 1M input, all of it a cache hit: $0.006, not $0.30. This is the difference
  // the review's "parse cached_tokens" advice would have silently lost.
  close(deepseek.estimateCost('deepseek-flash', 1_000_000, 0, { now: PEAK, cacheHitTokens: 1_000_000 }), 0.006, 'fully cached input');
  // Mixed: 800k hit + 200k miss + nothing out.
  close(
    deepseek.estimateCost('deepseek-flash', 1_000_000, 0, { now: PEAK, cacheHitTokens: 800_000 }),
    ((800_000 * 0.006) + (200_000 * 0.30)) / 1_000_000,
    'split input'
  );
});

test('estimateCost clamps a cache-hit count larger than the input', () => {
  // Defensive: a provider that reports hit > prompt_tokens must not produce a
  // negative miss count (which would subtract money from the dashboard).
  close(deepseek.estimateCost('deepseek-flash', 1000, 0, { now: PEAK, cacheHitTokens: 5000 }), (1000 * 0.006) / 1_000_000, 'clamped');
});

test('the 3-argument form prices everything as a miss (conservative direction)', () => {
  close(deepseek.estimateCost('deepseek-flash', 1_000_000, 0, { now: PEAK }), 0.30, 'no cache data available');
});

test('deepseek-v4-pro is priced above flash, and legacy names are billed as flash', () => {
  const pro = deepseek.estimateCost('deepseek-v4-pro', 1_000_000, 0, { now: PEAK });
  const flash = deepseek.estimateCost('deepseek-flash', 1_000_000, 0, { now: PEAK });
  assert.ok(pro > flash, 'pro must cost more than flash per the vendor table');
  // The vendor states the legacy ids are served by V4.1-Flash and billed at the
  // Flash price - so they must not fall through to a different default.
  for (const legacy of ['deepseek-v4-flash', 'deepseek-v4-flash-vision-exp']) {
    close(deepseek.estimateCost(legacy, 1_000_000, 0, { now: PEAK }), flash, `${legacy} bills as flash`);
  }
});

test('chat maps DeepSeek cache fields into usage and prices the split', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'hello', tool_calls: undefined } }],
          usage: { prompt_tokens: 1000, completion_tokens: 500, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200 }
        })
      }
    }
  };

  const result = await deepseek.chat(client, { model: 'deepseek-flash', messages: [{ role: 'user', content: 'hi' }] });

  assert.equal(result.provider, 'deepseek');
  assert.equal(result.content, 'hello');
  assert.equal(result.usage.input_tokens, 1000);
  assert.equal(result.usage.output_tokens, 500);
  assert.equal(result.usage.cache_hit_tokens, 800);
  assert.equal(result.usage.cache_miss_tokens, 200);
  // expected computed from the module's own window logic, so this test does not
  // pass or fail depending on what time of day the suite runs
  const rate = deepseek.rateFor('deepseek-flash');
  close(result.cost_usd, ((800 * rate.hit) + (200 * rate.miss) + (500 * rate.output)) / 1_000_000, 'cost split');
});

test('chat defaults a missing cache-miss count to input minus hits', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'x' } }],
          usage: { prompt_tokens: 100, completion_tokens: 10, prompt_cache_hit_tokens: 40 }
        })
      }
    }
  };
  const result = await deepseek.chat(client, { model: 'deepseek-flash', messages: [] });
  assert.equal(result.usage.cache_miss_tokens, 60);
});

test('chat passes thinking-mode reasoning through without polluting content', async () => {
  const client = {
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: 'the answer', reasoning_content: 'the chain' } }],
          usage: { prompt_tokens: 10, completion_tokens: 5 }
        })
      }
    }
  };
  const result = await deepseek.chat(client, { model: 'deepseek-flash', messages: [] });
  assert.equal(result.content, 'the answer');
  assert.equal(result.reasoning_content, 'the chain');
});

test('applyStreamChunk accumulates content, keeps reasoning, and captures the final usage chunk', () => {
  const deltas = [];
  const state = { content: '', inputTokens: 0, outputTokens: 0, cacheHitTokens: 0 };

  deepseek.applyStreamChunk(state, { choices: [{ delta: { content: 'he', reasoning_content: 'th' } }] }, (d) => deltas.push(d));
  deepseek.applyStreamChunk(state, { choices: [{ delta: { content: 'llo' } }] }, (d) => deltas.push(d));
  // OpenAI-compatible streams only carry usage on a final, choice-less chunk.
  deepseek.applyStreamChunk(state, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } }, () => {});

  assert.equal(state.content, 'hello');
  assert.deepEqual(deltas, ['he', 'llo']);
  assert.equal(state.reasoningContent, 'th');
  assert.equal(state.inputTokens, 100);
  assert.equal(state.outputTokens, 20);
  assert.equal(state.cacheHitTokens, 60);
  assert.equal(state.cacheMissTokens, 40);
});

test('chatStream asks for usage explicitly, because a streamed call has none otherwise', async () => {
  let seen = null;
  const client = {
    chat: {
      completions: {
        create: async (request) => {
          seen = request;
          return (async function* () {
            yield { choices: [{ delta: { content: 'ok' } }] };
            yield { choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, prompt_cache_hit_tokens: 2, prompt_cache_miss_tokens: 5 } };
          })();
        }
      }
    }
  };

  const result = await deepseek.chatStream(client, { model: 'deepseek-flash', messages: [] }, { onDelta: () => {} });

  assert.equal(seen.stream, true);
  assert.deepEqual(seen.stream_options, { include_usage: true });
  assert.equal(result.content, 'ok');
  assert.equal(result.usage.cache_hit_tokens, 2);
  assert.equal(result.usage.input_tokens, 7);
});
