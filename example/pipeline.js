// Full pipeline on a REAL Figma frame: URL → IR → assets → code → verify.
//
//   FIGMA_TOKEN=figd_xxx node example/pipeline.js "https://www.figma.com/design/KEY/Name?node-id=1-2"
//
// Stages 1–7 wired together. Without an LLM key the `generate` callback is a
// no-op, so the run MEASURES how close the deterministic output already is
// (the initial diff vs the Figma render). Set a key to actually refine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadFromUrl, exportAssets } from '../src/mcp/index.js';
import { figmaToIR, validateNode, collectWarnings } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';
import { verifyLoop } from '../src/index.js';
import { createRefinerFromEnv } from '../src/refine/index.js';
import { loadCredentials } from '../src/config/credentials.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, 'out');
fs.mkdirSync(outDir, { recursive: true });

loadCredentials(); // .figma-token / .gemini-key / .anthropic-key → env (env still wins)
const url = process.argv[2];
const token = process.env.FIGMA_TOKEN;

if (!token || !url) {
  console.error('Usage: FIGMA_TOKEN=figd_xxx node example/pipeline.js "<figma-frame-url>"');
  process.exit(1);
}

/** Group warnings by kind so a page with 200 dropped gradients prints one line. */
function summarizeWarnings(warnings) {
  const byKind = new Map();
  for (const w of warnings) {
    const kind = w.warning.split(':')[0];
    if (!byKind.has(kind)) byKind.set(kind, []);
    byKind.get(kind).push(w.name);
  }
  return [...byKind.entries()].sort((a, b) => b[1].length - a[1].length);
}

async function main() {
  console.log('1. Loading frame from Figma...');
  const { raw, variableMap, componentMap, referencePng, nodeId, source } = await loadFromUrl(url, { token });
  fs.writeFileSync(path.join(outDir, 'reference.png'), referencePng);
  console.log(`   node ${nodeId}: "${raw.name}" · ${Object.keys(variableMap).length} vars · ${Object.keys(componentMap).length} components`);

  console.log('2. Converting to IR (Stages 1–4)...');
  const ir = figmaToIR(raw, { variableMap, componentMap });
  const problems = validateNode(ir);
  if (problems.length) console.warn('   IR warnings:', problems.slice(0, 5));

  // Anything the design uses that has no faithful CSS equivalent. Printing it
  // here is the difference between a known limitation and a mystery diff — the
  // refine loop cannot recover a feature the IR never captured, it can only
  // approximate it from the pixels.
  const warnings = collectWarnings(ir);
  if (warnings.length) {
    console.log(`   ${warnings.length} unconvertible feature(s):`);
    for (const [kind, names] of summarizeWarnings(warnings)) {
      const sample = [...new Set(names)].slice(0, 3).join(', ');
      console.log(`     ${kind} ×${names.length} — e.g. ${sample}`);
    }
  }

  console.log('3. Exporting assets (photos + icons)...');
  const { assets, requested, exported, errors } = await exportAssets(source, ir, {
    onProgress: (m) => console.log(m),
  });
  console.log(`   ${requested} requested → ${exported} embedded`);
  if (exported === 0 && requested > 0) {
    console.warn('   WARNING: no assets exported — every image/icon will render as a placeholder.');
    if (errors.length) console.warn(`   cause: ${errors.join(' | ')}`);
  }

  console.log('4. Generating code (Stage 6)...');
  const html = generateHtml(ir, { title: raw.name, assets });
  fs.writeFileSync(path.join(outDir, 'generated.html'), html);

  const refiner = createRefinerFromEnv();
  const provider = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? 'Gemini' : 'Claude';
  console.log(
    refiner
      ? `5. Verifying + refining with ${provider} (Stage 7)...`
      : '5. Verifying (Stage 7) — no LLM creds, measuring deterministic baseline only...'
  );
  const result = await verifyLoop({
    initialCode: html,
    referencePng,
    ir, // enables element-bbox IoU: reports MISSING/MISPLACED elements to the refiner
    viewport: { width: ir.box.width + 40, height: ir.box.height + 40, deviceScaleFactor: 2 },
    threshold: 0.02,
    maxIterations: refiner ? 5 : 0,
    generate: refiner || (async ({ code }) => code),
    onIteration: (e) => console.log(`   iter ${e.iteration}: diff = ${(e.diffRatio * 100).toFixed(2)}%`),
  });

  fs.writeFileSync(path.join(outDir, 'generated.html'), result.code);
  fs.writeFileSync(path.join(outDir, 'best-diff.png'), result.bestDiffPng);
  const label = refiner ? 'Final' : 'Deterministic baseline';
  console.log(`\n${label} diff: ${(result.diffRatio * 100).toFixed(2)}% (converged: ${result.converged})`);
  console.log(`Artifacts in ${outDir}: generated.html, reference.png, best-diff.png`);
  if (!refiner) console.log('Set GEMINI_API_KEY (or ANTHROPIC_API_KEY) to enable the refine loop.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
