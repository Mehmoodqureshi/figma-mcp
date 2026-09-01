// Demo of Stage 6: IR → code, then render it to prove it round-trips.
// Full deterministic path: raw Figma → IR → HTML → rendered PNG.
// Run: node example/codegen-example.js

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { figmaToIR } from '../src/ir/index.js';
import { generateHtml, generateReact } from '../src/codegen/index.js';
import { renderHtml, closeBrowser } from '../src/index.js';
import { raw, variableMap, componentMap } from './fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

async function main() {
  // Stages 1–4: raw Figma tree → IR.
  const ir = figmaToIR(raw, { variableMap, componentMap });

  // Stage 6: IR → code.
  const html = generateHtml(ir, { title: 'PricingCard' });
  const jsx = generateReact(ir);
  fs.writeFileSync(path.join(outDir, 'generated.html'), html);
  fs.writeFileSync(path.join(outDir, 'generated.jsx'), jsx);

  console.log('=== Generated HTML ===\n');
  console.log(html.replace('</style>', '</style>\n').replace(/></g, '>\n<'));
  console.log('\n=== Generated React ===\n');
  console.log(jsx);

  // Prove it renders (this HTML is exactly what feeds the Stage 7 verify loop).
  console.log('\nRendering generated HTML to confirm it is valid...');
  const png = await renderHtml(html, { width: 520, height: 360, deviceScaleFactor: 2 });
  fs.writeFileSync(path.join(outDir, 'generated.png'), png);
  await closeBrowser();

  console.log(`Rendered OK → ${path.join(outDir, 'generated.png')} (${png.length} bytes)`);
  console.log('\nThis generated.html is the `initialCode` you hand to verifyLoop().');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
