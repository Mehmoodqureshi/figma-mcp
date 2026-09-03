// Demo of the Stage 7 paint-order check (no API key needed).
//   node example/paint-order-example.js
//
// Two failures that the pixel diff and the bbox IoU both miss, because every
// element is present and in exactly the right place:
//
//   1. WRONG STACKING — an overlay lifted in front of an element the design
//      stacks it behind. Nothing moves; only a few thousand pixels swap, so on
//      a large frame the diff ratio barely twitches.
//   2. OVER-CLIPPED — an element the design lets overhang the frame, cut off by
//      an ancestor that hides overflow. Its bounding box is unchanged, so IoU
//      still scores it a perfect match.
//
// The frame below is the smallest shape that reproduces both: three siblings,
// two of which overlap, and one that runs off the right edge.

import {
  renderHtmlWithBoxes,
  expectedPaintOrder,
  computePaintDiffs,
  buildPaintCorrection,
  closeBrowser,
} from '../src/index.js';
import { generateHtml } from '../src/codegen/index.js';

const viewport = { width: 400, height: 300, deviceScaleFactor: 1 };

/** Minimal IR node — absolute box, no layout, no text. */
const node = (id, name, box, style, children = []) => ({
  id,
  name,
  role: children.length ? 'container' : 'shape',
  box,
  layout: { mode: 'absolute', position: 'absolute', widthMode: 'fixed', heightMode: 'fixed' },
  style,
  text: null,
  tokens: {},
  component: null,
  asset: null,
  warnings: [],
  children,
});

// Figma lists children back-to-front: Photo is painted first, so Chain sits on
// top of it, and Overhang runs 100px past the frame's right edge — which the
// frame's own `overflow: hidden` is meant to trim to half.
const ir = node(
  '0:1',
  'Frame',
  { x: 0, y: 0, width: 400, height: 300 },
  { overflow: 'hidden', background: '#101010' },
  [
    node('0:2', 'Photo', { x: 40, y: 40, width: 200, height: 150 }, { background: '#3a6ea5' }),
    node('0:3', 'Chain', { x: 120, y: 90, width: 240, height: 60 }, { background: '#c8960c' }),
    node('0:4', 'Overhang', { x: 300, y: 210, width: 200, height: 60 }, { background: '#9b1c1c' }),
  ]
);

function report(title, findings) {
  console.log(`\n=== ${title} ===`);
  const text = buildPaintCorrection(findings);
  console.log(
    text
      ? text.split('\n').map((l) => '  ' + l).join('\n')
      : '  ok — paint order and clipping match the design'
  );
}

async function main() {
  const expected = expectedPaintOrder(ir);
  const ids = expected.order.map((n) => n.id);
  const html = generateHtml(ir);

  console.log('Design paint order (low index = furthest back):');
  for (const n of expected.order) {
    console.log(`  ${n.index}  ${n.label.padEnd(10)} visible ${Math.round(n.visible * 100)}%`);
  }

  // 1. Faithful render — the generator emits nodes in Figma's own order.
  const good = await renderHtmlWithBoxes(html, ids, ir.id, viewport);
  report('Correct generated HTML', computePaintDiffs(expected, good.paint));

  // 2. Photo lifted over Chain — the `z-index: 20` on a decorative overlay
  //    that the design has running underneath.
  const lifted = html.replace('data-ir-id="0:2"', 'data-ir-id="0:2" style="z-index:20"');
  report(
    'Photo given z-index:20 (design paints it under Chain)',
    computePaintDiffs(expected, (await renderHtmlWithBoxes(lifted, ids, ir.id, viewport)).paint)
  );

  // 3. Frame narrowed so Overhang is cut off entirely. The design shows half of
  //    it; the render shows none — and nothing moved, so IoU is still perfect.
  const cut = html.replace('width: 400px; height: 300px;', 'width: 300px; height: 300px;');
  report(
    'Frame narrowed to 300px (Overhang loses its overhang)',
    computePaintDiffs(expected, (await renderHtmlWithBoxes(cut, ids, ir.id, viewport)).paint)
  );

  await closeBrowser();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
