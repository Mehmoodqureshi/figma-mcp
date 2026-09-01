// Deterministic convert + asset export + dump everything the manual-refine loop needs.
//   FIGMA_TOKEN=$(cat .figma-token) node example/convert.js "<figma-url>" [outDir]
//
// Writes: <outDir>/generated.html, reference.png, ir.json  and prints a summary.
// No Anthropic key required — refinement is done afterward with manual-refine.js.

import fs from 'node:fs';
import path from 'node:path';
import { FigmaRestSource, loadFrame, parseFigmaUrl } from '../src/mcp/index.js';
import { figmaToIR, validateNode, ROLES, collectWarnings } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';

const url = process.argv[2];
const outDir = process.argv[3] || 'example/out/convert';
const token = process.env.FIGMA_TOKEN;

if (!token || !url) {
  console.error('Usage: FIGMA_TOKEN=$(cat .figma-token) node example/convert.js "<figma-url>" [outDir]');
  process.exit(1);
}
fs.mkdirSync(outDir, { recursive: true });

// Collect ids of nodes that need a real asset exported from Figma.
// Any node with an image fill (leaf <img> OR a frame with a photo background)
// exports as PNG; vector clusters export as SVG.
function collectAssets(node, acc) {
  if (node.style?.imageFill) acc.images.push(node.id);
  if (node.role === ROLES.VECTOR) acc.vectors.push(node.id);
  node.children.forEach((c) => collectAssets(c, acc));
  return acc;
}

async function main() {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!fileKey || !nodeId) throw new Error(`Could not parse fileKey/node-id from URL`);
  const source = new FigmaRestSource({ token, fileKey });

  // CACHE everything we fetch, so codegen tweaks re-run OFFLINE (no rate limit).
  const rawPath = path.join(outDir, 'raw.json');
  const refPath = path.join(outDir, 'reference.png');
  const haveRef = fs.existsSync(refPath);

  let raw, variableMap, componentMap, referencePng;
  if (fs.existsSync(rawPath)) {
    console.log('1. Using cached Figma data (raw.json) — no API call...');
    ({ raw, variableMap, componentMap } = JSON.parse(fs.readFileSync(rawPath, 'utf8')));
  } else {
    console.log(`1. Fetching from Figma${haveRef ? ' (reusing existing reference.png)' : ''}...`);
    ({ raw, variableMap, componentMap, referencePng } = await loadFrame(source, nodeId, {
      screenshot: !haveRef,
    }));
    fs.writeFileSync(rawPath, JSON.stringify({ raw, variableMap, componentMap }));
    if (referencePng) fs.writeFileSync(refPath, referencePng);
  }
  console.log(`   node ${nodeId}: "${raw.name}" (${raw.type}) — ${Object.keys(componentMap).length} components`);

  console.log('2. Converting to IR...');
  const ir = figmaToIR(raw, { variableMap, componentMap });
  const problems = validateNode(ir);
  if (problems.length) console.warn('   IR warnings:', problems.slice(0, 5));

  // Design features with no faithful CSS equivalent. These will NOT be fixed by
  // refinement — the IR never captured them — so they need to be visible here.
  const unconvertible = collectWarnings(ir);
  if (unconvertible.length) {
    const kinds = new Map();
    for (const w of unconvertible) {
      const k = w.warning.split(':')[0];
      kinds.set(k, (kinds.get(k) || 0) + 1);
    }
    console.log(`   ${unconvertible.length} unconvertible feature(s): ` +
      [...kinds].map(([k, n]) => `${k} ×${n}`).join(', '));
  }

  console.log('3. Exporting assets from Figma...');
  const assetsPath = path.join(outDir, 'assets.json');
  const { images, vectors } = collectAssets(ir, { images: [], vectors: [] });
  let assets = {};
  if (fs.existsSync(assetsPath)) {
    console.log('   using cached assets.json — no API call');
    assets = JSON.parse(fs.readFileSync(assetsPath, 'utf8'));
  } else {
    // A failed / rate-limited export batch shouldn't abort the whole conversion —
    // that node just falls back to a placeholder.
    const tryExport = async (ids, fmt, scale) => {
      if (!ids.length) return;
      try {
        Object.assign(assets, await source.exportNodes(ids, fmt, scale, 300));
      } catch (e) {
        console.warn(`   (${fmt} export partially failed: ${e.message.slice(0, 60)}…)`);
      }
    };
    // Photos first (the visually dominant ones), then icons. One big batch each
    // = fewest requests = least rate-limit pressure.
    await tryExport(images, 'png', 2);
    await tryExport(vectors, 'svg', 1);
    // Only cache if we actually got assets (don't cache an all-failed export).
    if (Object.values(assets).filter(Boolean).length > 0) {
      fs.writeFileSync(assetsPath, JSON.stringify(assets));
    }
  }
  const ok = Object.values(assets).filter(Boolean).length;
  console.log(`   ${images.length} image-fills + ${vectors.length} vectors requested → ${ok} embedded`);

  console.log('4. Generating HTML with real assets...');
  const html = generateHtml(ir, { title: raw.name, assets });

  fs.writeFileSync(path.join(outDir, 'generated.html'), html);
  // Only on a fresh fetch. On the cached path referencePng is undefined and the
  // existing reference.png is already the one we want — writing here would throw
  // and lose the whole run's output.
  if (referencePng) fs.writeFileSync(refPath, referencePng);
  fs.writeFileSync(path.join(outDir, 'ir.json'), JSON.stringify(ir));
  console.log(`   wrote generated.html (${(html.length / 1024).toFixed(0)} KB), reference.png, ir.json to ${outDir}/`);

  console.log(`\nNext: node example/manual-refine.js ${outDir}/generated.html ${outDir}/reference.png ${outDir}/ir.json`);
}

main().catch((err) => {
  console.error('\nFAILED:', err.message);
  if (String(err.message).includes('403')) console.error('→ token lacks file access, or the file isn\'t shared with this account.');
  if (String(err.message).includes('404')) console.error('→ file key or node id not found.');
  process.exit(1);
});
