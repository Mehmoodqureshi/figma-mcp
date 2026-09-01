// Runnable demo of the Stage 7 verify loop — no LLM/API key needed.
//
// It fabricates a "Figma reference" by rendering a target card, then starts the
// loop from a deliberately-wrong version. The `generate` callback here is a
// SCRIPTED stand-in for your LLM: it returns progressively-corrected versions so
// you can watch the diff ratio fall and the loop converge.
//
// Run:  npm install  (installs Playwright + downloads Chromium)  then  npm run example

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyLoop, renderHtml, closeBrowser } from '../src/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

const viewport = { width: 480, height: 320, deviceScaleFactor: 1 };

const card = (opts) => `<!doctype html><html><head><style>
  * { margin: 0; box-sizing: border-box; }
  body { display: flex; align-items: center; justify-content: center; height: 320px;
         background: #f3f4f6; font-family: -apple-system, Arial, sans-serif; }
  .card { width: 320px; padding: ${opts.pad}px; background: #fff; border-radius: 16px;
          box-shadow: 0 4px 20px rgba(0,0,0,.08); }
  .badge { display: inline-block; padding: 4px 10px; border-radius: 999px;
           background: ${opts.badgeBg}; color: #fff; font-size: 12px; font-weight: 600; }
  h1 { font-size: ${opts.titleSize}px; margin: 12px 0 8px; color: #111827; }
  p  { font-size: 14px; line-height: 1.5; color: #6b7280; }
  .btn { margin-top: 16px; padding: 10px 16px; border: none; border-radius: 10px;
         background: ${opts.btnBg}; color: #fff; font-weight: 600; ${opts.showBtn ? '' : 'display:none;'} }
</style></head><body>
  <div class="card">
    <span class="badge">NEW</span>
    <h1>Pricing plan</h1>
    <p>Everything you need to ship design-accurate UI from Figma, verified pixel by pixel.</p>
    <button class="btn">Get started</button>
  </div>
</body></html>`;

// The TARGET the reference is rendered from (this is our "Figma design").
const target = { pad: 24, badgeBg: '#6366f1', titleSize: 22, btnBg: '#6366f1', showBtn: true };

// Scripted "LLM" outputs: start wrong, then fix one thing per iteration.
const steps = [
  { pad: 8, badgeBg: '#9ca3af', titleSize: 16, btnBg: '#9ca3af', showBtn: false }, // initial (bad)
  { pad: 8, badgeBg: '#6366f1', titleSize: 16, btnBg: '#9ca3af', showBtn: false }, // fix badge color
  { pad: 24, badgeBg: '#6366f1', titleSize: 16, btnBg: '#9ca3af', showBtn: true }, // fix padding + add button
  { pad: 24, badgeBg: '#6366f1', titleSize: 22, btnBg: '#6366f1', showBtn: true }, // fix title size + button color
];

async function main() {
  console.log('Rendering the Figma reference screenshot...');
  const referencePng = await renderHtml(card(target), viewport);
  fs.writeFileSync(path.join(outDir, 'reference.png'), referencePng);

  let stepIndex = 0;
  const result = await verifyLoop({
    initialCode: card(steps[0]),
    referencePng,
    viewport,
    threshold: 0.01,
    maxIterations: 5,
    autoCloseBrowser: false, // we render the reference ourselves; close at the end
    generate: async ({ correction, iteration }) => {
      console.log(`\n--- correction for iteration ${iteration} ---`);
      console.log(correction.split('\n').slice(0, 8).join('\n') + '\n...');
      stepIndex = Math.min(stepIndex + 1, steps.length - 1);
      return card(steps[stepIndex]);
    },
    onIteration: (e) => {
      console.log(`iter ${e.iteration}: diff = ${(e.diffRatio * 100).toFixed(2)}%`);
      // These are the DIFF images (highlighted = mismatched), not the renders —
      // they were written as `render-N.png` for a while, which made a converged
      // run look like it had rendered a blank page.
      fs.writeFileSync(path.join(outDir, `diff-${e.iteration}.png`), e.diff.diffPng);
      fs.writeFileSync(path.join(outDir, `render-${e.iteration}.png`), e.renderPng ?? e.diff.diffPng);
    },
  });

  await closeBrowser();

  fs.writeFileSync(path.join(outDir, 'best.html'), result.code);
  fs.writeFileSync(path.join(outDir, 'best-diff.png'), result.bestDiffPng);

  console.log('\n=== RESULT ===');
  console.log(`converged: ${result.converged}`);
  console.log(`best diff: ${(result.diffRatio * 100).toFixed(2)}%`);
  console.log(`iterations: ${result.iterations}`);
  console.log(`artifacts written to: ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
