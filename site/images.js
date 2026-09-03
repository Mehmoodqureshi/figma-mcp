// site/images.js — downscaled PNG cache for the browser.
//
// The artifacts on disk are 2x renders of whole pages: a tall frame's
// reference.png is routinely 2000x15000 and 30+ MB. That is the right fidelity
// for pixelmatch and the wrong thing to push down a socket every time someone
// switches tabs. So each requested width gets box-filtered down once, written
// next to the original under .web/, and streamed from there afterwards.
//
// Box filtering by an integer factor (rather than a general resampler) is what
// keeps this honest: averaging whole NxN blocks of a 2x render is exactly the
// downsample that preserves the mismatch highlights in diff.png. A nearest
// neighbour pick would drop thin 1px diff lines entirely and quietly make the
// render look better than it is.

import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';

// Keep a scaled copy under ~6 megapixels as well as under the requested width —
// a 700px-wide slice of a 15000px-tall page is still an enormous image.
const MAX_MEGAPIXELS = 6;

function scaledPath(srcPath, maxWidth) {
  const dir = path.join(path.dirname(srcPath), '.web');
  const base = path.basename(srcPath, '.png');
  return path.join(dir, `${base}@${maxWidth}.png`);
}

/** Integer downscale factor honouring both the width cap and the pixel budget. */
function factorFor(width, height, maxWidth) {
  const byWidth = Math.ceil(width / maxWidth);
  const byArea = Math.ceil(Math.sqrt((width * height) / (MAX_MEGAPIXELS * 1e6)));
  return Math.max(1, byWidth, byArea);
}

function boxDownscale(png, factor) {
  const w = Math.max(1, Math.floor(png.width / factor));
  const h = Math.max(1, Math.floor(png.height / factor));
  const out = new PNG({ width: w, height: h });
  const n = factor * factor;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let dy = 0; dy < factor; dy++) {
        const row = (y * factor + dy) * png.width;
        for (let dx = 0; dx < factor; dx++) {
          const i = (row + x * factor + dx) << 2;
          r += png.data[i];
          g += png.data[i + 1];
          b += png.data[i + 2];
          a += png.data[i + 3];
        }
      }
      const o = (y * w + x) << 2;
      out.data[o] = r / n;
      out.data[o + 1] = g / n;
      out.data[o + 2] = b / n;
      out.data[o + 3] = a / n;
    }
  }
  return out;
}

/**
 * Path to a copy of `srcPath` no wider than `maxWidth`, generating it if needed.
 * Returns `srcPath` itself when the original is already small enough, and also
 * whenever scaling fails — a slow big image beats a broken tab.
 */
export function scaledPng(srcPath, maxWidth) {
  try {
    const srcStat = fs.statSync(srcPath);
    const destPath = scaledPath(srcPath, maxWidth);
    const destStat = fs.existsSync(destPath) ? fs.statSync(destPath) : null;
    if (destStat && destStat.mtimeMs >= srcStat.mtimeMs) return destPath;

    const png = PNG.sync.read(fs.readFileSync(srcPath));
    const factor = factorFor(png.width, png.height, maxWidth);
    if (factor === 1) return srcPath;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, PNG.sync.write(boxDownscale(png, factor)));
    return destPath;
  } catch {
    return srcPath;
  }
}

/** Intrinsic pixel size of a PNG, read from the IHDR alone. */
export function pngSize(srcPath) {
  try {
    const fd = fs.openSync(srcPath, 'r');
    const head = Buffer.alloc(24);
    fs.readSync(fd, head, 0, 24, 0);
    fs.closeSync(fd);
    return { width: head.readUInt32BE(16), height: head.readUInt32BE(20) };
  } catch {
    return null;
  }
}
