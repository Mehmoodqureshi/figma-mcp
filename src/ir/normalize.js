// Stage 1 — Extract & Normalize (deterministic, no LLM).
//
// Raw Figma JSON is ~90% noise. This prunes it so the IR converter and codegen
// see only meaningful structure. Operates on the RAW Figma node tree (not IR)
// and returns a cleaned raw tree.
//
// Rules (from the Figma2Code preprocessing recipe):
//   1. Drop invisible nodes (visible === false, opacity 0).
//   2. Drop zero-area nodes.
//   3. Collapse redundant wrapper frames/groups (single child, no own styling).
//   4. Mark vector clusters so the converter can emit a single SVG asset.
//
// Editor-only props are simply never read by the converter, so no explicit strip.

const VECTOR_TYPES = new Set(['VECTOR', 'STAR', 'LINE', 'REGULAR_POLYGON', 'BOOLEAN_OPERATION']);

function isInvisible(node) {
  if (node.visible === false) return true;
  if (typeof node.opacity === 'number' && node.opacity === 0) return true;
  return false;
}

function isZeroArea(node) {
  const b = node.absoluteBoundingBox;
  if (!b) return false; // some nodes legitimately lack a box; keep them
  return (b.width ?? 0) <= 0 || (b.height ?? 0) <= 0;
}

/** A container with no visible paint/stroke/effect/radius of its own. */
function hasNoOwnStyling(node) {
  const hasFill = Array.isArray(node.fills) && node.fills.some((f) => f.visible !== false);
  const hasStroke = Array.isArray(node.strokes) && node.strokes.some((s) => s.visible !== false);
  const hasEffect = Array.isArray(node.effects) && node.effects.some((e) => e.visible !== false);
  const hasRadius =
    (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) ||
    (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.some((r) => r > 0));
  return !hasFill && !hasStroke && !hasEffect && !hasRadius;
}

/** A container that only wraps a single child and adds nothing layout-wise. */
function isRedundantWrapper(node) {
  const isContainer = node.type === 'GROUP' || node.type === 'FRAME';
  if (!isContainer) return false;
  if (!Array.isArray(node.children) || node.children.length !== 1) return false;
  // Keep it if it contributes Auto Layout (padding/spacing) or visible styling.
  const contributesLayout =
    node.layoutMode && node.layoutMode !== 'NONE' &&
    (node.paddingTop || node.paddingBottom || node.paddingLeft || node.paddingRight || node.itemSpacing);
  return hasNoOwnStyling(node) && !contributesLayout;
}

/**
 * Recursively normalize a raw Figma node. Returns the cleaned node, or null if
 * the whole node should be dropped.
 * @param {Object} node  Raw Figma node.
 * @returns {Object|null}
 */
export function normalizeNode(node) {
  if (!node || isInvisible(node) || isZeroArea(node)) return null;

  // Clean children first.
  let children = Array.isArray(node.children)
    ? node.children.map(normalizeNode).filter(Boolean)
    : [];

  // Collapse a redundant wrapper: replace it with its (single, cleaned) child,
  // but preserve the wrapper's bounding box so absolute positioning stays correct.
  if (isRedundantWrapper({ ...node, children }) && children.length === 1) {
    return children[0];
  }

  // Mark a cluster of vectors so the converter emits one SVG instead of N nodes.
  const isVectorCluster =
    VECTOR_TYPES.has(node.type) ||
    (children.length > 0 && children.every((c) => VECTOR_TYPES.has(c.type)));

  return { ...node, children, __vectorCluster: isVectorCluster };
}

/**
 * Entry point — normalize a document/frame subtree.
 * @param {Object} root
 * @returns {Object|null}
 */
export function normalizeTree(root) {
  return normalizeNode(root);
}
