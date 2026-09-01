// Stage 7 — The verify loop: render → diff → refine, until it converges.
//
// This is the accuracy engine. It's framework-agnostic: you supply a `generate`
// callback that calls YOUR LLM (Opus / GPT-5 / Gemini). The loop feeds that
// callback the correction prompt derived from the visual diff and takes back the
// improved code. It never gets worse than the best iteration seen (it keeps the
// best result even if a later pass regresses).

import { renderHtml, renderUrl, renderHtmlWithBoxes, closeBrowser } from './render.js';
import { diffImages } from './diff.js';
import { buildCorrectionPrompt } from './correction.js';
import { flattenExpectedBoxes, computeElementDiffs, buildElementCorrection } from './elementDiff.js';

/**
 * @typedef {Object} VerifyOptions
 * @property {string} initialCode                 First-pass code from Stage 6.
 * @property {Buffer} referencePng                Figma reference screenshot (PNG buffer).
 * @property {(args: {code:string, correction:string, iteration:number, referencePng:Buffer, renderPng:Buffer, diffPng:Buffer}) => Promise<string>} generate
 *           Your LLM call. Receives the current code + correction prompt + the reference,
 *           current-render, and pixel-diff PNGs (for vision models), and returns improved code.
 * @property {(code: string) => Promise<Buffer>} [render]
 *           How to render a code string to a PNG. Defaults to renderHtml (self-contained HTML).
 *           For a dev server, pass e.g. `async () => renderUrl('http://localhost:3000/preview', vp)`.
 * @property {number} [threshold=0.02]            Stop when diffRatio ≤ this (2% of pixels).
 * @property {number} [maxIterations=5]
 * @property {Object} [viewport]                  { width, height, deviceScaleFactor } for the default renderer.
 * @property {number} [grid=6]                    Region grid size (shared by diff + correction).
 * @property {(evt: LoopEvent) => void} [onIteration]  Progress callback.
 * @property {boolean} [autoCloseBrowser=true]    Close the shared Playwright browser when done.
 * @property {import('./ir/schema.js').IRNode} [ir]  Pass the IR to enable element-bbox IoU:
 *           the loop measures each element's rendered box (via data-ir-id) and reports
 *           missing/misplaced elements in the correction. Default HTML-render path only.
 */

/**
 * @typedef {Object} LoopEvent
 * @property {number} iteration
 * @property {number} diffRatio
 * @property {import('./diff.js').DiffResult} diff
 * @property {string} code
 * @property {Buffer} renderPng   What this iteration actually rendered. Without it a
 *           progress callback can only see the diff, and a diff of a blank page is
 *           indistinguishable from a converged one.
 * @property {ReturnType<typeof computeElementDiffs>|null} elementFindings
 */

/**
 * @typedef {Object} VerifyResult
 * @property {string} code            Best code found.
 * @property {number} diffRatio       Its diff ratio.
 * @property {boolean} converged      True if threshold was met.
 * @property {number} iterations      How many refine passes ran.
 * @property {Buffer} bestRenderPng   Render of the best code.
 * @property {Buffer} bestDiffPng     Visual diff of the best code.
 * @property {LoopEvent[]} history    Every iteration, in order.
 */

/**
 * @param {VerifyOptions} options
 * @returns {Promise<VerifyResult>}
 */
export async function verifyLoop(options) {
  const {
    initialCode,
    referencePng,
    generate,
    threshold = 0.02,
    maxIterations = 5,
    viewport = {},
    grid = 6,
    onIteration,
    autoCloseBrowser = true,
    ir = null,
  } = options;

  const render = options.render || ((code) => renderHtml(code, viewport));

  // Element-bbox IoU is available only on the default HTML-render path (it needs
  // the live DOM). Precompute the expected boxes from the IR once.
  const useElementDiff = !!ir && !options.render;
  const expectedBoxes = useElementDiff ? flattenExpectedBoxes(ir) : null;
  const expectedIds = useElementDiff ? expectedBoxes.map((b) => b.id) : null;

  let code = initialCode;
  let best = null; // { code, diffRatio, diff, render }
  const history = [];

  try {
    for (let iteration = 0; iteration <= maxIterations; iteration++) {
      let renderPng, renderedBoxes = null;
      if (useElementDiff) {
        const r = await renderHtmlWithBoxes(code, expectedIds, ir.id, viewport);
        renderPng = r.png;
        renderedBoxes = r.boxes;
      } else {
        renderPng = await render(code);
      }
      const diff = diffImages(renderPng, referencePng, { grid });
      const elementFindings = renderedBoxes
        ? computeElementDiffs(expectedBoxes, renderedBoxes)
        : null;

      const evt = { iteration, diffRatio: diff.diffRatio, diff, code, renderPng, elementFindings };
      history.push(evt);
      if (onIteration) onIteration(evt);

      if (!best || diff.diffRatio < best.diffRatio) {
        best = { code, diffRatio: diff.diffRatio, diff, render: renderPng, elementFindings };
      }

      // Converged, or out of budget — stop.
      if (diff.diffRatio <= threshold || iteration === maxIterations) break;

      let correction = buildCorrectionPrompt(diff, { iteration: iteration + 1, grid });
      if (elementFindings) {
        const elementText = buildElementCorrection(elementFindings, { rootId: ir.id });
        if (elementText) correction += `\n\n${elementText}`;
      }
      // Pass the images too so a vision model can SEE the target, its own render,
      // and exactly where they differ — far more effective than the text alone.
      const next = await generate({
        code,
        correction,
        iteration: iteration + 1,
        referencePng,
        renderPng,
        diffPng: diff.diffPng,
      });
      if (!next || next.trim() === code.trim()) break; // model gave up / no change
      code = next;
    }
  } finally {
    if (autoCloseBrowser) await closeBrowser();
  }

  return {
    code: best.code,
    diffRatio: best.diffRatio,
    converged: best.diffRatio <= threshold,
    iterations: history.length - 1,
    bestRenderPng: best.render,
    bestDiffPng: best.diff.diffPng,
    elementFindings: best.elementFindings, // per-element IoU results (null if no `ir`)
    history,
  };
}

export { renderHtml, renderUrl, closeBrowser };
