// Stages 1–3 — public API for the deterministic node-tree → IR path.
//
//   import { figmaToIR, validateNode } from './src/ir/index.js';
//
//   const ir = figmaToIR(rawFigmaNode, { variableMap, componentMap });
//   const problems = validateNode(ir);   // [] means valid
//
// Feed `ir` to codegen (Stage 6). Codegen reads ONLY the IR, never raw Figma JSON.

export { figmaToIR, collectWarnings } from './fromFigma.js';
export { normalizeTree, normalizeNode } from './normalize.js';
export { computeContainerLayout, computeChildLayout } from './autolayout.js';
export { createNode, validateNode, ROLES, LAYOUT } from './schema.js';
export {
  rgbaToCss,
  resolveFills,
  resolveBorder,
  resolveRadius,
  resolveShadow,
  resolveEffects,
  resolveBlendMode,
  resolveImageFit,
  resolveRingThickness,
  resolveText,
  resolveTextRuns,
  WARN,
} from './style.js';
