// Stage 1 — Asset export: walk an IR tree, pull the real bitmaps and icons.
//
// This lives here rather than in an example because forgetting it is silently
// catastrophic: codegen falls back to a 1x1 transparent PNG for every photo and
// an empty outline for every icon, so the render comes out structurally right
// and visually blank. That reads as a conversion failure when it is only a
// missing export step.

import { ROLES } from '../ir/schema.js';

/**
 * Node ids that need a real asset exported.
 * Any node with an image fill (a leaf <img> OR a frame with a photo background)
 * exports as PNG; vector clusters export as SVG.
 * @param {import('../ir/schema.js').IRNode} node
 * @returns {{images:string[], vectors:string[]}}
 */
export function collectAssetIds(node, acc = { images: [], vectors: [] }) {
  if (node.style?.imageFill) acc.images.push(node.id);
  if (node.role === ROLES.VECTOR) acc.vectors.push(node.id);
  (node.children || []).forEach((c) => collectAssetIds(c, acc));
  return acc;
}

/**
 * Export every asset an IR tree references, as data URIs keyed by node id.
 *
 * A failed or rate-limited batch degrades to placeholders for those nodes rather
 * than aborting the conversion — but it is reported, because "some icons are
 * missing" and "the export was throttled" look identical in the render.
 *
 * @param {Object} source   FigmaRestSource (or anything with exportNodes).
 * @param {import('../ir/schema.js').IRNode} ir
 * @param {Object} [opts]
 * @param {(msg:string)=>void} [opts.onProgress]
 * @returns {Promise<{assets:Object<string,string>, requested:number, exported:number, errors:string[]}>}
 */
export async function exportAssets(source, ir, opts = {}) {
  const { onProgress = () => {} } = opts;
  const { images, vectors } = collectAssetIds(ir);
  const assets = {};
  const errors = [];

  const tryExport = async (ids, fmt, scale) => {
    if (!ids.length) return;
    try {
      Object.assign(assets, await source.exportNodes(ids, fmt, scale, 300));
    } catch (e) {
      errors.push(`${fmt}: ${e.message}`);
      onProgress(`   (${fmt} export failed: ${String(e.message).slice(0, 80)})`);
    }
  };

  // Photos first (the visually dominant ones), then icons. One big batch each
  // = fewest requests = least rate-limit pressure.
  await tryExport(images, 'png', 2);
  await tryExport(vectors, 'svg', 1);

  const exported = Object.values(assets).filter(Boolean).length;
  return { assets, requested: images.length + vectors.length, exported, errors };
}
