// site/pipeline.js — the web front-end's orchestration of the real pipeline.
//
// This is the same sequence src/mcp/server.js runs for figma_convert +
// figma_verify, with two differences that only matter to a browser client:
//
//  • It reports progress step by step through an `onStep` callback, so the page
//    can show the loop working instead of a spinner that lasts a minute.
//  • It never returns HTML or PNG bytes. A converted frame is routinely 20+ MB
//    of data URIs; that goes to disk and the browser streams it back by URL.
//
// Every measurement below comes from src/ — nothing here reimplements the
// converter, the differ, or the verifier.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { FigmaRestSource, loadFrame, parseFigmaUrl } from '../src/mcp/index.js';
import { figmaToIR, validateNode, ROLES } from '../src/ir/index.js';
import { generateHtml, generateReact, generateNext } from '../src/codegen/index.js';
import { renderHtmlWithBoxes } from '../src/render.js';
import { diffImages } from '../src/diff.js';
import { buildCorrectionPrompt } from '../src/correction.js';
import {
  flattenExpectedBoxes,
  computeElementDiffs,
  buildElementCorrection,
} from '../src/elementDiff.js';
import {
  expectedPaintOrder,
  computePaintDiffs,
  buildPaintCorrection,
} from '../src/paintOrder.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Anchored to the repo root rather than cwd, so the site shares whatever the MCP
// server already cached here no matter which directory you launch it from.
export const CACHE_ROOT = process.env.FIGMA_MCP_CACHE_DIR
  ? path.resolve(process.env.FIGMA_MCP_CACHE_DIR)
  : path.join(ROOT, '.figma-cache');

const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

/** Cancelled between steps — Chromium and the Figma fetch are not interruptible. */
export class Cancelled extends Error {
  constructor() {
    super('cancelled');
    this.name = 'Cancelled';
  }
}

export function frameIdFor(fileKey, nodeId) {
  return `${fileKey}-${nodeId.replace(':', '-')}`;
}

/** Frame dirs already on disk, newest first — the page offers these instantly. */
export function listCachedFrames() {
  if (!fs.existsSync(CACHE_ROOT)) return [];
  return fs
    .readdirSync(CACHE_ROOT, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(CACHE_ROOT, e.name);
      const irPath = path.join(dir, 'ir.json');
      if (!fs.existsSync(irPath)) return null;
      let ir;
      try {
        ir = readJson(irPath);
      } catch {
        return null;
      }
      return {
        id: e.name,
        name: ir.name || e.name,
        width: Math.round(ir.box?.width || 0),
        height: Math.round(ir.box?.height || 0),
        hasReference: fs.existsSync(path.join(dir, 'reference.png')),
        hasRender: fs.existsSync(path.join(dir, 'render.png')),
        hasDiff: fs.existsSync(path.join(dir, 'diff.png')),
        mtime: fs.statSync(irPath).mtimeMs,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.mtime - a.mtime);
}

/**
 * Nodes needing a real asset. Same rule as the MCP server: a string imageFill is
 * a Figma imageRef (fetch the original bitmap), `true` means the paint carried
 * none and the node itself has to be rendered.
 */
function collectAssets(node, acc = { imageFills: [], imageNodes: [], vectors: [] }) {
  const fill = node.style?.imageFill;
  if (typeof fill === 'string') acc.imageFills.push({ id: node.id, ref: fill });
  else if (fill) acc.imageNodes.push(node.id);
  if (node.role === ROLES.VECTOR) acc.vectors.push(node.id);
  (node.children || []).forEach((c) => collectAssets(c, acc));
  return acc;
}

function roleCounts(node, acc = {}) {
  acc[node.role] = (acc[node.role] || 0) + 1;
  (node.children || []).forEach((c) => roleCounts(c, acc));
  return acc;
}

function warningCounts(node, acc = {}) {
  for (const w of node.warnings || []) {
    const code = String(w).split(':')[0];
    acc[code] = (acc[code] || 0) + 1;
  }
  (node.children || []).forEach((c) => warningCounts(c, acc));
  return acc;
}

/** Was this raw tree fetched with geometry=paths? Without it, mirrors are lost. */
function hasTransforms(node) {
  if (!node || typeof node !== 'object') return false;
  if (Array.isArray(node.relativeTransform)) return true;
  return (node.children || []).some(hasTransforms);
}

/**
 * Convert a Figma frame and verify the result against it.
 *
 * @param {object}   opts
 * @param {string}   opts.url         Figma frame URL.
 * @param {boolean} [opts.responsive] Also emit responsive.html.
 * @param {'html'|'react'|'next'} [opts.framework]  What to emit alongside the
 *   verified HTML: nothing, a React component, or a Next.js App Router project.
 * @param {boolean} [opts.refresh]    Ignore the cache, re-fetch from Figma.
 * @param {boolean} [opts.verify]     Run the render/diff pass (default true).
 * @param {number}  [opts.threshold]  Diff ratio treated as "exact enough".
 * @param {(e:object)=>void} [opts.onStep]      Progress reporter.
 * @param {()=>boolean}      [opts.isCancelled] Checked between steps.
 */
export async function run({
  url,
  responsive = false,
  framework = 'html',
  refresh = false,
  verify = true,
  threshold = 0.02,
  onStep = () => {},
  isCancelled = () => false,
}) {
  const t0 = Date.now();
  const step = (key, status, detail) => onStep({ key, status, detail });
  const checkpoint = () => {
    if (isCancelled()) throw new Cancelled();
  };

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    throw new Error(
      'No Figma token. Put one in .figma-token at the repo root, or set FIGMA_TOKEN before ' +
        'starting the server. Figma -> Settings -> Security -> Personal access tokens, ' +
        'scope "File content: read".'
    );
  }

  // --- 1. Parse ------------------------------------------------------------
  step('parse', 'run');
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!fileKey || !nodeId) {
    throw new Error(
      'Could not read a file key and node id from that link. Expected something like ' +
        'https://www.figma.com/design/KEY/Name?node-id=1-2 — in Figma, right-click the frame ' +
        'and choose "Copy link to selection".'
    );
  }
  const id = frameIdFor(fileKey, nodeId);
  const dir = path.join(CACHE_ROOT, id);
  fs.mkdirSync(dir, { recursive: true });
  const p = (f) => path.join(dir, f);
  step('parse', 'ok', `${fileKey} node ${nodeId}`);
  checkpoint();

  // --- 2. Figma data (cached) ---------------------------------------------
  step('fetch', 'run');
  const source = new FigmaRestSource({ token, fileKey });
  const rawPath = p('raw.json');
  const refPath = p('reference.png');

  let raw;
  let variableMap;
  let componentMap;
  let referencePng;
  let cachedRaw = !refresh && fs.existsSync(rawPath);
  let staleCache = false;

  if (cachedRaw) {
    ({ raw, variableMap, componentMap } = readJson(rawPath));
    // Caches written before the fetch asked for geometry=paths have no
    // relativeTransform, so every mirrored node in them is silently wrong.
    if (!hasTransforms(raw)) cachedRaw = false;
  }

  if (!cachedRaw) {
    const haveRef = !refresh && fs.existsSync(refPath);
    try {
      ({ raw, variableMap, componentMap, referencePng } = await loadFrame(source, nodeId, {
        screenshot: !haveRef,
      }));
      fs.writeFileSync(rawPath, JSON.stringify({ raw, variableMap, componentMap }));
      if (referencePng) fs.writeFileSync(refPath, referencePng);
    } catch (err) {
      if (!raw) throw err; // nothing cached to fall back to
      staleCache = true;
    }
  }
  step(
    'fetch',
    'ok',
    cachedRaw
      ? 'served from cache (offline, no API budget spent)'
      : staleCache
        ? 're-fetch failed, using the cached copy'
        : `fetched "${raw.name}"`
  );
  checkpoint();

  // --- 3. IR ---------------------------------------------------------------
  step('ir', 'run');
  const ir = figmaToIR(raw, { variableMap, componentMap });
  const problems = validateNode(ir);
  fs.writeFileSync(p('ir.json'), JSON.stringify(ir));
  const counts = roleCounts(ir);
  const nodeTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  step('ir', 'ok', `${nodeTotal} nodes`);
  checkpoint();

  // --- 4. Assets -----------------------------------------------------------
  step('assets', 'run');
  const assetsPath = p('assets.json');
  const { imageFills, imageNodes, vectors } = collectAssets(ir);
  let assets = {};
  const assetNotes = [];

  if (!refresh && fs.existsSync(assetsPath)) {
    assets = readJson(assetsPath);
  } else {
    const tryExport = async (label, fn) => {
      try {
        Object.assign(assets, await fn());
      } catch (e) {
        assetNotes.push(`${label} export partially failed: ${e.message}`);
      }
    };
    if (imageFills.length) {
      await tryExport('image-fill', () => source.exportImageFills(imageFills));
    }
    const render = [...imageNodes, ...imageFills.filter((e) => !assets[e.id]).map((e) => e.id)];
    if (render.length) await tryExport('png', () => source.exportNodes(render, 'png', 2, 300));
    if (vectors.length) await tryExport('svg', () => source.exportNodes(vectors, 'svg', 1, 300));
    if (Object.values(assets).filter(Boolean).length > 0) {
      fs.writeFileSync(assetsPath, JSON.stringify(assets));
    }
  }
  const embedded = Object.values(assets).filter(Boolean).length;
  const requested = imageFills.length + imageNodes.length + vectors.length;
  step('assets', 'ok', `${embedded}/${requested} embedded as data URIs`);
  checkpoint();

  // --- 5. Codegen ----------------------------------------------------------
  // generated.html is always written, whatever framework was asked for: it is
  // the only variant verify can meaningfully compare against a fixed-size Figma
  // render, and every emitter derives its styles from the same IR, so it is also
  // the honest preview of what the React and Next.js output look like.
  step('codegen', 'run');
  const html = generateHtml(ir, { title: raw.name, assets, responsive: false });
  fs.writeFileSync(p('generated.html'), html);

  // Files the browser may read back, in the order the UI should list them.
  const codeFiles = [];
  const addFile = (rel, label) =>
    codeFiles.push({ path: rel, label, bytes: fs.statSync(p(rel)).size });

  let responsiveBytes = 0;
  const canvasFit = responsive && ir.layout?.mode === 'absolute';
  if (responsive) {
    const rHtml = generateHtml(ir, { title: raw.name, assets, responsive: true });
    fs.writeFileSync(p('responsive.html'), rHtml);
    responsiveBytes = rHtml.length;
  }

  let componentName = null;
  if (framework === 'react') {
    fs.writeFileSync(p('generated.jsx'), generateReact(ir, { assets, responsive }));
    addFile('generated.jsx', 'React component');
  } else if (framework === 'next') {
    const generated = generateNext(ir, { assets, responsive, title: raw.name });
    componentName = generated.componentName;
    // Everything lands under next/ so the directory is a project you can copy
    // out and `npm install && npm run dev` without picking files apart.
    for (const [rel, contents] of Object.entries(generated.files)) {
      const dest = p(`next/${rel}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, contents);
      addFile(`next/${rel}`, null);
    }
  }

  const frameworkFileCount = codeFiles.length;
  addFile('generated.html', 'Self-contained HTML');
  if (responsive) addFile('responsive.html', 'Responsive HTML');

  const htmlKb = `${(html.length / 1024).toFixed(0)} KB HTML`;
  step(
    'codegen',
    'ok',
    framework === 'next'
      ? `${frameworkFileCount} Next.js files + ${htmlKb}`
      : framework === 'react'
        ? `React component + ${htmlKb}`
        : `${htmlKb}, self-contained`
  );
  checkpoint();

  const warnCounts = warningCounts(ir);
  const result = {
    id,
    dir,
    url,
    fileKey,
    nodeId,
    name: raw.name,
    type: raw.type,
    width: Math.round(ir.box.width),
    height: Math.round(ir.box.height),
    cached: cachedRaw,
    staleCache,
    htmlBytes: html.length,
    responsive,
    responsiveBytes,
    canvasFit,
    framework,
    componentName,
    codeFiles,
    nodes: nodeTotal,
    roles: Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([role, n]) => ({ role, n })),
    tokens: Object.keys(variableMap || {}).length,
    components: Object.keys(componentMap || {}).length,
    assets: { requested, embedded, imageFills: imageFills.length, vectors: vectors.length },
    assetNotes,
    mirrorUnknown: warnCounts.MIRROR_UNKNOWN || 0,
    irProblems: problems.slice(0, 5),
    irProblemCount: problems.length,
    verify: null,
    ms: 0,
  };

  if (!verify) {
    result.ms = Date.now() - t0;
    return result;
  }

  if (!fs.existsSync(refPath)) {
    throw new Error(
      'No reference.png for this frame, so there is nothing to verify against. ' +
        'Re-run with "Refresh from Figma" on to fetch the reference render.'
    );
  }

  // --- 6. Render in Chromium ----------------------------------------------
  step('render', 'run');
  const renderOpts = { width: result.width, height: result.height, fullPage: false };
  const expected = flattenExpectedBoxes(ir);
  const { png: renderPng, boxes, paint } = await renderHtmlWithBoxes(
    html,
    expected.map((e) => e.id),
    ir.id,
    renderOpts
  );
  fs.writeFileSync(p('render.png'), renderPng);
  step('render', 'ok', `${result.width}x${result.height} at 2x, ${expected.length} boxes measured`);
  checkpoint();

  // --- 7. Diff -------------------------------------------------------------
  step('diff', 'run');
  const referenceBuf = fs.readFileSync(refPath);
  const diff = diffImages(renderPng, referenceBuf);
  fs.writeFileSync(p('diff.png'), diff.diffPng);

  const findings = computeElementDiffs(expected, boxes);
  const missing = findings.filter((f) => f.status === 'missing');
  const misplaced = findings.filter((f) => f.status === 'misplaced');
  const ok = findings.filter((f) => f.status === 'ok');

  const paintFindings = computePaintDiffs(expectedPaintOrder(ir), paint);
  const converged = diff.diffRatio <= threshold;

  result.verify = {
    converged,
    threshold,
    diffRatio: diff.diffRatio,
    diffPixels: diff.diffPixels,
    totalPixels: diff.totalPixels,
    comparedAt: { width: diff.width, height: diff.height },
    elements: {
      ok: ok.length,
      total: findings.length,
      missing: missing.length,
      misplaced: misplaced.length,
    },
    paint: { stacking: paintFindings.stacking.length, clipping: paintFindings.clipping.length },
    // The worst offenders, named — this is what turns a percentage into a task.
    worst: findings
      .filter((f) => f.status !== 'ok')
      .slice(0, 12)
      .map((f) => ({
        label: f.label,
        role: f.role,
        status: f.status,
        iou: f.iou,
        expected: f.expected,
        actual: f.actual,
      })),
    regions: diff.regions.slice(0, 4).map((r) => ({ ratio: r.ratio, box: r.box })),
    corrections: {
      element: buildElementCorrection(findings, { rootId: ir.id }) || '',
      paint: buildPaintCorrection(paintFindings) || '',
      pixel: buildCorrectionPrompt(diff, { iteration: 1 }) || '',
    },
  };

  step(
    'diff',
    'ok',
    `${(diff.diffRatio * 100).toFixed(2)}% of pixels differ, ${ok.length}/${findings.length} elements in place`
  );

  result.ms = Date.now() - t0;
  return result;
}
