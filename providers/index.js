// model-router/providers/index.js
//
// The provider registry. Before this file, "which provider serves this model?"
// was answered by an if/else chain repeated in eight places across server.js
// (detection, two dispatch forks, the streaming client + stream-function
// forks, the cascade grader, a second tier branch, and a metrics label). Every
// one of them knew exactly two providers, so adding a third meant finding and
// patching all eight - and missing one produced a weird failure far from the
// edit, not an error at the place that was forgotten.
//
// Adding a provider is now: write providers/<name>.js to the contract
// (buildClient/chat/chatStream/estimateCost), require it here, give it a model
// prefix and an env key. Everything else routes through this file.
const anthropic = require('./anthropic');
const openai = require('./openai');
const deepseek = require('./deepseek');
const openrouter = require('./openrouter');

const PROVIDERS = { anthropic, openai, deepseek, openrouter };

// The env var holding each provider's key. Used for both presence checks and
// the "not configured" error message, so those two can never disagree about
// which variable a provider actually needs.
const ENV_KEYS = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  openrouter: 'OPENROUTER_API_KEY'
};

/**
 * Which provider serves this model? Returns null when nothing claims it, which
 * callers turn into a 400 "Unsupported model" - the same answer as before for
 * anything unmatched.
 *
 * ORDER MATTERS: OpenRouter is checked first because its ids are
 * `vendor/model`, and `deepseek/deepseek-chat` must not be captured by the
 * direct DeepSeek prefix. (The direct DeepSeek ids are `deepseek-flash` /
 * `deepseek-v4-pro` - no slash - so the two never actually collide, but the
 * ordering is what guarantees that stays true if either vendor renames.)
 */
function detectProvider(model) {
  if (typeof model !== 'string' || !model) return null;
  if (openrouter.isOpenRouterModel(model)) return 'openrouter';
  if (model.startsWith('claude-')) return 'anthropic';
  if (model.startsWith('deepseek-')) return 'deepseek';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3')) return 'openai';
  return null;
}

function get(name) { return PROVIDERS[name] || null; }

function envKey(name) { return ENV_KEYS[name] || null; }

function names() { return Object.keys(PROVIDERS); }

/** Provider names that look usable given the current environment (presence only, never values). */
function configured(env = process.env) {
  return names().filter((n) => !!env[ENV_KEYS[n]]);
}

module.exports = { PROVIDERS, ENV_KEYS, detectProvider, get, envKey, names, configured };
