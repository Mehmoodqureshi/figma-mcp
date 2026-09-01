// Stage 7 verify-loop — public API.
//
// Typical usage:
//
//   import { verifyLoop } from './src/index.js';
//   import fs from 'node:fs';
//
//   const referencePng = fs.readFileSync('figma-frame.png'); // from get_screenshot
//
//   const result = await verifyLoop({
//     initialCode: firstPassHtml,          // from Stage 6 generation
//     referencePng,
//     viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
//     threshold: 0.02,                     // "exact enough" = ≤2% pixels differ
//     maxIterations: 5,
//     generate: async ({ code, correction }) => {
//       // Call YOUR LLM here. Return corrected code (string).
//       return await callYourModel({ code, correction });
//     },
//     onIteration: (e) => console.log(`iter ${e.iteration}: ${(e.diffRatio*100).toFixed(2)}% diff`),
//   });
//
//   console.log(result.converged, result.diffRatio);
//   fs.writeFileSync('out.html', result.code);
//   fs.writeFileSync('diff.png', result.bestDiffPng); // inspect what still differs

export { verifyLoop } from './verifyLoop.js';
export { renderHtml, renderUrl, renderHtmlWithBoxes, closeBrowser } from './render.js';
export { diffImages } from './diff.js';
export { buildCorrectionPrompt } from './correction.js';
export {
  flattenExpectedBoxes,
  computeElementDiffs,
  buildElementCorrection,
  iou,
} from './elementDiff.js';
