// Stage 6/7 — refine LLM public API.
//
// Kept in its own module so the core pipeline doesn't depend on the Anthropic SDK
// unless you actually use the refiner.
//
//   import { createClaudeRefiner } from './src/refine/index.js';
//   import { verifyLoop } from './src/index.js';
//
//   const out = await verifyLoop({
//     initialCode: html,
//     referencePng,
//     generate: createClaudeRefiner(),   // ← your model, wired to the loop
//   });

export { createClaudeRefiner } from './llm.js';
export { createGeminiRefiner } from './gemini.js';

import { createClaudeRefiner } from './llm.js';
import { createGeminiRefiner } from './gemini.js';

/**
 * Pick a refiner from whatever credentials are present — Gemini first (cheaper/faster),
 * then Claude. Lets the same pipeline run with either key, no code change.
 *
 *   generate: createRefinerFromEnv()   // GEMINI_API_KEY → Gemini, else ANTHROPIC_API_KEY → Claude
 *
 * @param {Object} [options]  Forwarded to the chosen refiner (e.g. { conventions, model }).
 * @param {'gemini'|'claude'} [options.provider]  Force a provider (else auto-detect from env).
 * @returns {Function|null}  A verifyLoop `generate` callback, or null if no creds are set.
 */
export function createRefinerFromEnv(options = {}) {
  const { provider, ...rest } = options;
  const hasGemini = !!(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
  const hasClaude = !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

  const choice = provider || (hasGemini ? 'gemini' : hasClaude ? 'claude' : null);
  if (choice === 'gemini') return createGeminiRefiner(rest);
  if (choice === 'claude') return createClaudeRefiner(rest);
  return null;
}
