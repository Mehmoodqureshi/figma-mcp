// Real end-to-end refine loop, driven by Gemini or Claude (whichever key is set).
//   GEMINI_API_KEY=... node example/refine-example.js
//   ANTHROPIC_API_KEY=sk-... node example/refine-example.js
//
// It renders a "target" card as the Figma reference, starts from a deliberately
// broken version, and lets the Claude refiner fix it using the target image, the
// current render, and the pixel diff — the same `generate` contract as your real
// Figma pipeline. This is the piece that makes real frames converge.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLoop, renderHtml, closeBrowser } from '../src/index.js';
import { createRefinerFromEnv } from '../src/refine/index.js';
import { loadCredentials } from '../src/config/credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

loadCredentials(); // pick up .gemini-key / .anthropic-key without env prefixes
const refiner = createRefinerFromEnv();
if (!refiner) {
  console.error(
    'Needs an LLM key. Set GEMINI_API_KEY=... (or ANTHROPIC_API_KEY=sk-...), then re-run.'
  );
  process.exit(1);
}

const viewport = { width: 480, height: 320, deviceScaleFactor: 2 };

const card = (o) => `<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { display:flex; align-items:center; justify-content:center; height:320px;
         background:#f3f4f6; font-family:-apple-system, Arial, sans-serif; }
  .card { width:320px; padding:${o.pad}px; background:#fff; border-radius:16px;
          box-shadow:0 4px 20px rgba(0,0,0,.08); }
  .badge { display:inline-block; padding:4px 10px; border-radius:999px;
           background:${o.badgeBg}; color:#fff; font-size:12px; font-weight:600; }
  h1 { font-size:${o.titleSize}px; margin:12px 0 8px; color:#111827; }
  p  { font-size:14px; line-height:1.5; color:#6b7280; }
  .btn { margin-top:16px; padding:10px 16px; border:none; border-radius:10px;
         background:${o.btnBg}; color:#fff; font-weight:600; ${o.showBtn ? '' : 'display:none;'} }
</style></head><body>
  <div class="card">
    <span class="badge">NEW</span>
    <h1>Pricing plan</h1>
    <p>Everything you need to ship design-accurate UI from Figma, verified pixel by pixel.</p>
    <button class="btn">Get started</button>
  </div>
</body></html>`;

const target = { pad: 24, badgeBg: '#6366f1', titleSize: 22, btnBg: '#6366f1', showBtn: true };
const broken = { pad: 8, badgeBg: '#9ca3af', titleSize: 15, btnBg: '#9ca3af', showBtn: false };

async function main() {
  console.log('Rendering the target (Figma reference)...');
  const referencePng = await renderHtml(card(target), viewport);
  fs.writeFileSync(path.join(outDir, 'refine-reference.png'), referencePng);

  console.log('Refining the broken version with Claude (render → diff → fix)...\n');
  const result = await verifyLoop({
    initialCode: card(broken),
    referencePng,
    viewport,
    threshold: 0.01,
    maxIterations: 4,
    autoCloseBrowser: false,
    generate: refiner, // ← Gemini or Claude, vision-driven
    onIteration: (e) => console.log(`  iter ${e.iteration}: diff = ${(e.diffRatio * 100).toFixed(2)}%`),
  });

  await closeBrowser();
  fs.writeFileSync(path.join(outDir, 'refine-best.html'), result.code);
  fs.writeFileSync(path.join(outDir, 'refine-best-diff.png'), result.bestDiffPng);

  console.log('\n=== RESULT ===');
  console.log(`converged: ${result.converged}`);
  console.log(`best diff: ${(result.diffRatio * 100).toFixed(2)}%`);
  console.log(`iterations: ${result.iterations}`);
  console.log(`artifacts in ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
