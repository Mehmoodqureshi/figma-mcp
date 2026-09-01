// Stage 6/7 — the refine LLM, backed by Google Gemini (a fast, cheap alternative
// to Claude for the verify loop).
//
// Same contract as createClaudeRefiner: verifyLoop hands this a `generate` callback
// the current code, a correction prompt, and three images (the Figma target, the
// current render, the pixel diff). Gemini — a vision model — SEES where the render
// diverges and returns corrected code. The loop re-renders and repeats.
//
// Uses the Generative Language REST API directly via `fetch`, so there is NO new
// npm dependency to install — a GEMINI_API_KEY (or GOOGLE_API_KEY) is all you need.
//
//   GEMINI_API_KEY=... node example/refine-example.js
//
// Default model is a Flash tier for speed/cost; override with `model` or GEMINI_MODEL.

const DEFAULT_CONVENTIONS =
  'Output a single self-contained HTML document with an inline <style> block (no external ' +
  'assets, no CDN links). Use flexbox for layout (not absolute positioning) wherever the ' +
  'design allows. Keep exact spacing, font-size, line-height, and colors.';

const DEFAULT_MODEL = 'gemini-2.5-flash';
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';

/** PNG Buffer → a Gemini inlineData part. */
function imagePart(png) {
  return { inlineData: { mimeType: 'image/png', data: png.toString('base64') } };
}

/** Pull the code out of Gemini's reply: concat text parts, strip a ```html fence. */
function extractCode(data) {
  const cand = data?.candidates?.[0];
  const text = (cand?.content?.parts || [])
    .map((p) => p.text || '')
    .join('');
  const fenced = text.match(/```(?:html)?\s*([\s\S]*?)```/i);
  return (fenced ? fenced[1] : text).trim();
}

/**
 * Build a `generate` function for verifyLoop, backed by Gemini.
 *
 * @param {Object} [options]
 * @param {string} [options.model]        Default 'gemini-2.5-flash' (or GEMINI_MODEL).
 * @param {number} [options.maxTokens=65536]
 * @param {string} [options.conventions]  Framework/style rules injected into the system prompt.
 * @param {string} [options.apiKey]       Default GEMINI_API_KEY || GOOGLE_API_KEY.
 * @param {Function} [options.fetch]      fetch implementation (injectable for tests).
 * @param {string} [options.baseUrl]      API base (default v1beta endpoint).
 * @returns {(args: {code, correction, iteration, referencePng, renderPng, diffPng}) => Promise<string>}
 */
export function createGeminiRefiner(options = {}) {
  const {
    model = process.env.GEMINI_MODEL || DEFAULT_MODEL,
    maxTokens = 65536,
    conventions = DEFAULT_CONVENTIONS,
    apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
    fetch = globalThis.fetch,
    baseUrl = API_BASE,
  } = options;

  if (!apiKey) {
    throw new Error(
      'createGeminiRefiner: no API key. Set GEMINI_API_KEY (or GOOGLE_API_KEY), or pass { apiKey }.'
    );
  }

  const system =
    'You are a pixel-perfect UI engineer. You receive: (1) the TARGET design image, ' +
    '(2) the CURRENT rendered output of the code, (3) a pixel-diff image where highlighted ' +
    'regions mark where the two differ, and (4) the current code. Correct the code so its ' +
    'render matches the target exactly. Change only what reduces the differences. ' +
    conventions +
    ' Respond with ONLY the corrected, complete code — no explanation, no commentary.';

  return async function generate({ code, correction, referencePng, renderPng, diffPng }) {
    const parts = [];
    if (referencePng) {
      parts.push({ text: 'TARGET design (match this):' }, imagePart(referencePng));
    }
    if (renderPng) {
      parts.push({ text: 'CURRENT render of your code:' }, imagePart(renderPng));
    }
    if (diffPng) {
      parts.push(
        { text: 'PIXEL DIFF (highlighted = differs from target):' },
        imagePart(diffPng)
      );
    }
    parts.push({
      text:
        `Current code:\n\n\`\`\`html\n${code}\n\`\`\`\n\n${correction}\n\n` +
        'Return ONLY the corrected, complete HTML document.',
    });

    const res = await fetch(`${baseUrl}/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts }],
        generationConfig: { maxOutputTokens: maxTokens, temperature: 0 },
      }),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Gemini API ${model} → ${res.status} ${res.statusText} ${detail}`.trim());
    }

    const data = await res.json();
    const finish = data?.candidates?.[0]?.finishReason;
    if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
      throw new Error(`Gemini stopped early (finishReason: ${finish}).`);
    }

    const out = extractCode(data);
    if (!out) throw new Error('Gemini returned no code (empty response).');
    return out;
  };
}
