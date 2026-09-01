// Demo of Stage 7 element-bbox IoU (no API key needed).
//   node example/element-diff-example.js
//
// 1. Correct generated HTML → every element matches (high IoU).
// 2. A tampered copy (one element removed, one shifted) → detected as
//    MISSING / MISPLACED, the way real layout drift would be.

import {
  renderHtmlWithBoxes,
  flattenExpectedBoxes,
  computeElementDiffs,
  buildElementCorrection,
  closeBrowser,
} from '../src/index.js';
import { figmaToIR } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';
import { raw, variableMap, componentMap } from './fixture.js';

const viewport = { width: 520, height: 360, deviceScaleFactor: 2 };

function report(title, findings, rootId) {
  console.log(`\n=== ${title} ===`);
  for (const f of findings) {
    const tag = f.status === 'ok' ? 'ok      ' : f.status === 'missing' ? 'MISSING ' : 'MISPLACED';
    console.log(`  ${tag}  ${f.label.padEnd(24)} IoU ${(f.iou * 100).toFixed(0).padStart(3)}%`);
  }
  const text = buildElementCorrection(findings, { rootId });
  if (text) console.log('\n  → correction the model receives:\n' + text.split('\n').map((l) => '    ' + l).join('\n'));
}

async function main() {
  const ir = figmaToIR(raw, { variableMap, componentMap });
  const expected = flattenExpectedBoxes(ir);
  const ids = expected.map((e) => e.id);
  const html = generateHtml(ir);

  // 1. Correct render — should all match.
  const good = await renderHtmlWithBoxes(html, ids, ir.id, viewport);
  report('Correct generated HTML', computeElementDiffs(expected, good.boxes), ir.id);

  // 2. Tamper: remove the Label (id 1:8) and shove the Badge (id 1:3) 60px down/right.
  const broken = html
    .replace(/<p [^>]*data-ir-id="1:8"[^>]*>.*?<\/p>/, '')
    .replace('data-ir-id="1:3"', 'data-ir-id="1:3" style="position:relative;left:60px;top:60px"');
  const bad = await renderHtmlWithBoxes(broken, ids, ir.id, viewport);
  report('Tampered HTML (Label removed, Badge shifted)', computeElementDiffs(expected, bad.boxes), ir.id);

  await closeBrowser();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
