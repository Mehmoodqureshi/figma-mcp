// Demo of Stage 8: exact-first codegen → responsive codegen.
//   node example/responsive-example.js
//
// Shows how fixed px sizing (exact, but rigid) is relaxed into flex/relative
// units using each node's Figma sizing mode (FIXED / HUG / FILL), then renders
// the responsive output at three widths to prove it adapts.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { figmaToIR } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';
import { renderHtml, closeBrowser } from '../src/index.js';
import { raw, variableMap, componentMap } from './fixture.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

// Pull one class rule out of the generated <style> for side-by-side comparison.
function rule(html, cls) {
  const m = html.match(new RegExp(`\\.${cls}-\\d+\\{([^}]*)\\}`));
  return m ? m[1].trim() : '(not found)';
}

async function main() {
  const ir = figmaToIR(raw, { variableMap, componentMap });
  const exact = generateHtml(ir, { title: 'exact' });
  const responsive = generateHtml(ir, { title: 'responsive', responsive: true });
  fs.writeFileSync(path.join(outDir, 'responsive.html'), responsive);

  console.log('Sizing mode per node (from Figma FIXED/HUG/FILL):');
  const walk = (n, d = 0) =>
    (console.log(`  ${'  '.repeat(d)}${n.name}: w=${n.layout.widthMode} h=${n.layout.heightMode}`),
    n.children.forEach((c) => walk(c, d + 1)));
  walk(ir);

  console.log('\nExact px  →  Responsive:');
  for (const cls of ['pricingcard', 'title', 'label', 'checkicon']) {
    console.log(`\n  .${cls}`);
    console.log(`    exact:      ${rule(exact, cls)}`);
    console.log(`    responsive: ${rule(responsive, cls)}`);
  }

  console.log('\nRendering responsive output at 3 widths...');
  for (const width of [360, 768, 1200]) {
    const png = await renderHtml(responsive, { width, height: 300, deviceScaleFactor: 1 });
    fs.writeFileSync(path.join(outDir, `responsive-${width}.png`), png);
    console.log(`  ${width}px → responsive-${width}.png`);
  }
  await closeBrowser();
  console.log(`\nArtifacts in ${outDir}. The card caps at its 320px design width and stays centered;`);
  console.log('the title and feature row FILL the card, the badge HUGs its text — no hardcoded widths.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
