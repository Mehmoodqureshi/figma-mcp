// Stage 7 — Correction: turn a diff result into an instruction the model can act on.
//
// The model that generated the code never sees the rendered result. This module
// translates "these regions are wrong" into targeted, human-readable guidance so
// the next generation pass can fix the specific mismatches instead of rewriting
// blindly.

/**
 * Map a region's grid position to a human location phrase (top-left, etc.).
 */
function locate(region, grid) {
  const vBand = region.row < grid / 3 ? 'top' : region.row < (2 * grid) / 3 ? 'middle' : 'bottom';
  const hBand = region.col < grid / 3 ? 'left' : region.col < (2 * grid) / 3 ? 'center' : 'right';
  if (vBand === 'middle' && hBand === 'center') return 'center';
  return `${vBand}-${hBand}`;
}

/**
 * Build a correction prompt from a diff result.
 *
 * @param {import('./diff.js').DiffResult} diff
 * @param {Object} [opts]
 * @param {number} [opts.iteration=1]
 * @param {number} [opts.grid=6]           Must match the grid used in diffImages.
 * @param {number} [opts.regionThreshold=0.02]  Ignore regions below this diff ratio.
 * @param {number} [opts.maxRegions=6]     Only report the worst N regions.
 * @returns {string}
 */
export function buildCorrectionPrompt(diff, opts = {}) {
  const { iteration = 1, grid = 6, regionThreshold = 0.02, maxRegions = 6 } = opts;

  const worst = diff.regions
    .filter((r) => r.ratio >= regionThreshold)
    .slice(0, maxRegions);

  const pct = (n) => `${(n * 100).toFixed(1)}%`;

  const lines = [];
  lines.push(`## Visual verification — iteration ${iteration}`);
  lines.push(
    `The code you produced was rendered in a browser and compared pixel-by-pixel ` +
      `against the Figma reference.`
  );
  lines.push(`Overall mismatch: **${pct(diff.diffRatio)}** of pixels differ.`);
  lines.push('');

  if (worst.length === 0) {
    lines.push(
      `No large localized differences remain — mismatches are spread thinly ` +
        `(anti-aliasing, sub-pixel spacing). Focus on exact spacing, font-size, ` +
        `line-height, and color-token values.`
    );
  } else {
    lines.push(`The largest differences are concentrated in these regions:`);
    for (const r of worst) {
      lines.push(
        `- **${locate(r, grid)}** region (x:${r.box.x} y:${r.box.y} ` +
          `w:${r.box.w} h:${r.box.h}) — ${pct(r.ratio)} of that area differs.`
      );
    }
    lines.push('');
    lines.push(`### For each region above, check in this order:`);
    lines.push(`1. **Missing/extra elements** — is an element from the design absent, or one added?`);
    lines.push(`2. **Position & spacing** — padding, gap, margins, alignment (verify against Auto Layout values).`);
    lines.push(`3. **Size** — width/height/font-size of the element in that region.`);
    lines.push(`4. **Color & typography** — are you using the correct design tokens?`);
  }
  lines.push('');
  lines.push(
    `Return the corrected code only. Do not restructure parts that already match — ` +
      `change only what's needed to reduce the differences above.`
  );
  return lines.join('\n');
}
