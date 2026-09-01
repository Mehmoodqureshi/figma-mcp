// Stage 7 — Diff: compare the rendered screenshot against the Figma reference.
//
// Produces two things:
//   1. A global diff ratio (0 = identical, 1 = totally different) — the loop's
//      stopping signal.
//   2. A per-region breakdown — a grid of the image with a diff ratio per cell,
//      so we can tell the model *where* it's wrong, not just *how much*.
//
// The region grid is a lightweight stand-in for full element/bounding-box
// matching: it localizes mismatches (top-right is off, footer is fine) which is
// exactly what the correction prompt needs. Swap in true bbox IoU later if you
// extract element boxes from the Figma node tree.

import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Pad a decoded PNG onto a transparent canvas of (w × h), anchored top-left.
 * Lets us diff images whose dimensions differ slightly without resampling.
 */
function padTo(png, w, h) {
  if (png.width === w && png.height === h) return png;
  const out = new PNG({ width: w, height: h });
  out.data.fill(0); // transparent
  for (let y = 0; y < Math.min(h, png.height); y++) {
    for (let x = 0; x < Math.min(w, png.width); x++) {
      const si = (png.width * y + x) << 2;
      const di = (w * y + x) << 2;
      out.data[di] = png.data[si];
      out.data[di + 1] = png.data[si + 1];
      out.data[di + 2] = png.data[si + 2];
      out.data[di + 3] = png.data[si + 3];
    }
  }
  return out;
}

/**
 * @typedef {Object} DiffRegion
 * @property {number} row
 * @property {number} col
 * @property {number} ratio     Diff ratio for this cell (0..1).
 * @property {{x:number,y:number,w:number,h:number}} box  Cell bounds in px.
 */

/**
 * @typedef {Object} DiffResult
 * @property {number} diffRatio        Global fraction of differing pixels (0..1).
 * @property {number} diffPixels
 * @property {number} totalPixels
 * @property {number} width
 * @property {number} height
 * @property {Buffer} diffPng          Visual diff image (differing pixels highlighted).
 * @property {DiffRegion[]} regions    Per-cell breakdown, worst-first.
 */

/**
 * @param {Buffer} actualPng     Rendered screenshot (from render.js).
 * @param {Buffer} referencePng  Figma reference screenshot.
 * @param {Object} [opts]
 * @param {number} [opts.threshold=0.1]   Per-pixel color tolerance (pixelmatch).
 * @param {number} [opts.grid=6]          Region grid is grid×grid cells.
 * @returns {DiffResult}
 */
export function diffImages(actualPng, referencePng, opts = {}) {
  const { threshold = 0.1, grid = 6 } = opts;

  let a = PNG.sync.read(actualPng);
  let b = PNG.sync.read(referencePng);

  const w = Math.max(a.width, b.width);
  const h = Math.max(a.height, b.height);
  a = padTo(a, w, h);
  b = padTo(b, w, h);

  const diff = new PNG({ width: w, height: h });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, w, h, {
    threshold,
    includeAA: false,
    // diffMask: leave matching pixels transparent so the region counter below
    // (and the saved diff PNG) reflect ONLY the pixels that actually differ.
    diffMask: true,
  });
  const totalPixels = w * h;

  // Per-region diff counts from the diff mask: differing pixels are opaque,
  // everything else is transparent.
  const rows = grid;
  const cols = grid;
  const cellW = Math.ceil(w / cols);
  const cellH = Math.ceil(h / rows);
  const regions = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x0 = c * cellW;
      const y0 = r * cellH;
      const x1 = Math.min(x0 + cellW, w);
      const y1 = Math.min(y0 + cellH, h);
      let cellDiff = 0;
      let cellTotal = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (w * y + x) << 2;
          // With diffMask, only differing pixels have non-zero alpha.
          if (diff.data[i + 3] > 0) cellDiff++;
          cellTotal++;
        }
      }
      regions.push({
        row: r,
        col: c,
        ratio: cellTotal ? cellDiff / cellTotal : 0,
        box: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 },
      });
    }
  }
  regions.sort((p, q) => q.ratio - p.ratio); // worst first

  return {
    diffRatio: totalPixels ? diffPixels / totalPixels : 0,
    diffPixels,
    totalPixels,
    width: w,
    height: h,
    diffPng: PNG.sync.write(diff),
    regions,
  };
}
