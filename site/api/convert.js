// site/api/convert.js — live Figma conversion, as a serverless function.
//
// This is the half of the pipeline that needs neither a browser nor a disk:
// fetch the frame, build the IR, export the assets, emit the code. Every line of
// it is the same src/ code the MCP server and the local site run, so a frame
// converted here and a frame converted locally produce identical output.
//
// What is deliberately absent is stage 6 and 7 — render in Chromium and pixel
// diff. Those need a browser binary and a writable disk, so on a static host the
// page verifies geometry and paint order in the viewer's own browser instead,
// and says plainly that the pixel diff is local-only.
//
// Nothing is written to disk: the generated files go back in the response and
// the page holds them in memory.

import { FigmaRestSource, loadFrame, parseFigmaUrl } from './_src/mcp/index.js';
import { figmaToIR, ROLES } from './_src/ir/index.js';
import {
  generateHtml,
  generateReact,
  generateNext,
  generateComponentModules,
} from './_src/codegen/index.js';

/** Same rule as the MCP server: a string imageFill is a real Figma imageRef. */
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

/**
 * The reference render's URL rather than its bytes. Figma hands back a signed
 * link the browser can load directly, which keeps several megabytes out of this
 * response for an image the page only ever displays.
 */
async function referenceUrl(fileKey, nodeId, token) {
  try {
    const res = await fetch(
      `https://api.figma.com/v1/images/${fileKey}?ids=${encodeURIComponent(nodeId)}&format=png&scale=2`,
      { headers: { 'X-Figma-Token': token } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    return data?.images?.[nodeId] || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: `${req.method} not allowed` });
    return;
  }

  const token = process.env.FIGMA_TOKEN;
  if (!token) {
    res.status(500).json({
      error: 'This deployment has no Figma token configured, so it can only show its baked frames.',
    });
    return;
  }

  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      body = {};
    }
  }
  const url = String(body?.url || '').trim();
  const framework = ['html', 'react', 'next'].includes(body?.framework) ? body.framework : 'html';
  const responsive = !!body?.responsive;

  const t0 = Date.now();
  const steps = [];
  const step = (key, detail) => steps.push({ key, detail });

  try {
    const { fileKey, nodeId } = parseFigmaUrl(url);
    if (!fileKey || !nodeId) {
      res.status(400).json({
        error:
          'Could not read a file key and node id from that link. In Figma, right-click the frame ' +
          'and choose "Copy link to selection".',
      });
      return;
    }
    step('parse', `${fileKey} node ${nodeId}`);

    // lockoutFile: null — the cross-run rate-limit memory is a disk file, and
    // this filesystem is read-only.
    const source = new FigmaRestSource({ token, fileKey, lockoutFile: null });
    const { raw, variableMap, componentMap } = await loadFrame(source, nodeId, { screenshot: false });
    step('fetch', `fetched "${raw.name}"`);

    const ir = figmaToIR(raw, { variableMap, componentMap });
    const counts = roleCounts(ir);
    const nodes = Object.values(counts).reduce((a, b) => a + b, 0);
    step('ir', `${nodes} nodes`);

    const { imageFills, imageNodes, vectors } = collectAssets(ir);
    const assets = {};
    const soften = async (fn) => {
      try {
        Object.assign(assets, await fn());
      } catch {
        /* a failed batch degrades to placeholders, exactly as it does locally */
      }
    };
    if (imageFills.length) await soften(() => source.exportImageFills(imageFills));
    const rerender = [...imageNodes, ...imageFills.filter((e) => !assets[e.id]).map((e) => e.id)];
    if (rerender.length) await soften(() => source.exportNodes(rerender, 'png', 2, 300));
    if (vectors.length) await soften(() => source.exportNodes(vectors, 'svg', 1, 300));
    const embedded = Object.values(assets).filter(Boolean).length;
    const requested = imageFills.length + imageNodes.length + vectors.length;
    step('assets', `${embedded}/${requested} embedded as data URIs`);

    const html = generateHtml(ir, { title: raw.name, assets, responsive });
    const codeFiles = [];
    if (framework === 'react') {
      codeFiles.push({
        path: 'generated.jsx',
        text: generateReact(ir, { assets, responsive }),
      });
      // The component imports './components/<X>' for each Code Connect binding;
      // ship those modules or the download does not compile.
      for (const [file, text] of Object.entries(generateComponentModules(ir))) {
        codeFiles.push({ path: `components/${file}`, text });
      }
    } else if (framework === 'next') {
      const app = generateNext(ir, { assets, responsive, title: raw.name });
      for (const [rel, text] of Object.entries(app.files)) codeFiles.push({ path: `next/${rel}`, text });
    }
    codeFiles.push({ path: 'generated.html', text: html });
    step(
      'codegen',
      framework === 'next'
        ? `${codeFiles.length - 1} Next.js files + ${(html.length / 1024).toFixed(0)} KB HTML`
        : framework === 'react'
          ? `React component + ${(html.length / 1024).toFixed(0)} KB HTML`
          : `${(html.length / 1024).toFixed(0)} KB HTML, self-contained`
    );

    const reference = await referenceUrl(fileKey, nodeId, token);

    res.status(200).json({
      id: `${fileKey}-${nodeId.replace(':', '-')}`,
      name: raw.name,
      type: raw.type,
      width: Math.round(ir.box.width),
      height: Math.round(ir.box.height),
      framework,
      responsive,
      nodes,
      htmlBytes: html.length,
      assets: { requested, embedded },
      tokens: Object.keys(variableMap || {}).length,
      components: Object.keys(componentMap || {}).length,
      ms: Date.now() - t0,
      steps,
      html,
      ir,
      codeFiles,
      reference,
    });
  } catch (err) {
    const m = String(err?.message || err);
    const hint = m.includes('403')
      ? 'This deployment’s Figma token cannot see that file.'
      : m.includes('404')
        ? 'No such file key or node id.'
        : err?.name === 'RateLimitError'
          ? 'Figma is rate-limiting this token. Try again shortly, or use one of the baked frames.'
          : '';
    res.status(502).json({ error: m, hint });
  }
}
