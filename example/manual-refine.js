// Manual-refine harness — the keyless alternative to the automated API loop.
//
// It does the mechanical half of Stage 7 (render → diff → element-IoU) and leaves
// the "fix the code" half to whoever is driving: run it, look at the render, the
// diff and the per-element findings, edit the HTML, run it again. Repeat until
// the diff is small. An agent reading the images does this as well as a model
// with an API key, and costs nothing.
//
// Usage:
//   node example/manual-refine.js <html-file> <reference-png> [ir-json] [--scale N]
//
// Writes next to the html file:
//   <name>.render.png   what your code renders to
//   <name>.diff.png     highlighted pixels that differ from the design
// and prints the diff ratio, the worst regions, and per-element findings.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import {
  renderHtml,
  renderHtmlWithBoxes,
  diffImages,
  flattenExpectedBoxes,
  computeElementDiffs,
  buildElementCorrection,
  closeBrowser,
} from '../src/index.js';

function arg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : def;
}

const [htmlPath, referencePath, irPath] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const scale = Number(arg('--scale', '2'));

if (!htmlPath || !referencePath) {
  console.error('Usage: node example/manual-refine.js <html-file> <reference-png> [ir-json] [--scale N]');
  process.exit(1);
}

async function main() {
  const html = fs.readFileSync(htmlPath, 'utf8');
  const referencePng = fs.readFileSync(referencePath);

  // Infer the CSS viewport from the reference image dimensions and scale.
  const ref = PNG.sync.read(referencePng);
  const viewport = {
    width: Math.round(ref.width / scale),
    height: Math.round(ref.height / scale),
    deviceScaleFactor: scale,
  };

  const ir = irPath ? JSON.parse(fs.readFileSync(irPath, 'utf8')) : null;
  const expected = ir ? flattenExpectedBoxes(ir) : null;

  let renderPng, renderedBoxes = null;
  if (ir) {
    const r = await renderHtmlWithBoxes(html, expected.map((e) => e.id), ir.id, viewport);
    renderPng = r.png;
    renderedBoxes = r.boxes;
  } else {
    renderPng = await renderHtml(html, viewport);
  }
  await closeBrowser();

  const diff = diffImages(renderPng, referencePng);

  const base = htmlPath.replace(/\.html?$/, '');
  fs.writeFileSync(`${base}.render.png`, renderPng);
  fs.writeFileSync(`${base}.diff.png`, diff.diffPng);

  console.log(`\nOverall pixel diff: ${(diff.diffRatio * 100).toFixed(2)}%`);
  console.log('Worst regions:');
  for (const r of diff.regions.filter((r) => r.ratio > 0.02).slice(0, 4)) {
    console.log(`  (x:${r.box.x} y:${r.box.y} w:${r.box.w} h:${r.box.h}) — ${(r.ratio * 100).toFixed(0)}% differs`);
  }

  if (renderedBoxes) {
    const findings = computeElementDiffs(expected, renderedBoxes);
    const problems = findings.filter((f) => f.status !== 'ok' && f.id !== ir.id);
    console.log(`\nElement findings: ${problems.length ? '' : 'all elements matched ✓'}`);
    const text = buildElementCorrection(findings, { rootId: ir.id });
    if (text) console.log(text);
  }

  console.log(`\nWrote ${base}.render.png and ${base}.diff.png — open them (or I'll read them) to see what to fix.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
