// Stage 3 — Figma node tree → IR.
//
// Orchestrates the deterministic pipeline:
//   raw Figma tree ──normalize (Stage 1)──▶ clean tree ──convert──▶ IR tree
// where convert() applies Auto-Layout→flex (Stage 2) and style/text/token
// extraction per node.
//
// Options let you resolve tokens and components:
//   variableMap:  { 'VariableID:...': 'color/brand/primary' }   (from get_variable_defs)
//   componentMap: { '<componentId>': { name: 'Button', props: {...} } }  (from get_code_connect_map)

import { createNode, ROLES, LAYOUT } from './schema.js';
import { normalizeTree } from './normalize.js';
import { computeContainerLayout, computeChildLayout, computeSizing } from './autolayout.js';
import {
  resolveFills,
  resolveBorder,
  resolveRadius,
  resolveEffects,
  resolveText,
  resolveRingThickness,
  resolveImageFit,
  resolveBlendMode,
  WARN,
} from './style.js';

const round = (n, p = 2) => Number(Number(n).toFixed(p));

/**
 * The node's 2D transform, as { rotation (deg), mirrored }.
 *
 * `relativeTransform` is [[a, b, tx], [c, d, ty]]. A pure rotation is
 * [[cos, -sin], [sin, cos]], so the angle falls out of the first column, and
 * CSS rotates clockwise for positive angles exactly as this matrix does in
 * screen space (y down) — no sign flip needed.
 *
 * A mirrored node is the case the angle alone cannot describe. Figma flips by
 * negating a scale axis, which makes the determinant negative; the matrix is
 * then R(theta) * diag(1, -1), whose first column is still [cos, sin], so
 * atan2 keeps reporting a believable angle while the flip vanishes. Rotating
 * by that angle without flipping points the artwork somewhere it never was —
 * on the frame this was written for, a hanging lamp that should read as tilted
 * 24 degrees came out at -156. Report the flip so the codegen can re-apply it.
 *
 * `rotation` (radians) is the fallback for payloads fetched without
 * `geometry=paths`. It agrees with atan2 on the angle but, being a single
 * number, carries no record of a mirror.
 */
function nodeTransform(node) {
  const m = node.relativeTransform;
  if (Array.isArray(m) && m.length >= 2) {
    const [[a, b], [c, d]] = m;
    const deg = (Math.atan2(c, a) * 180) / Math.PI;
    return {
      rotation: Math.abs(deg) < 0.01 ? 0 : round(deg, 3),
      mirrored: a * d - b * c < 0,
    };
  }
  if (typeof node.rotation === 'number' && node.rotation) {
    const deg = (node.rotation * 180) / Math.PI;
    return { rotation: Math.abs(deg) < 0.01 ? 0 : round(deg, 3), mirrored: false };
  }
  return { rotation: 0, mirrored: false };
}

/**
 * Box of `node` relative to its parent, in px.
 *
 * Two things this has to get right that the raw bounding box does not:
 *
 * Fractions. Figma positions on sub-pixels constantly. Rounding each node to a
 * whole pixel looks harmless in isolation, but the errors accumulate down a flex
 * column — fifteen children rounding half a pixel each drift the bottom of the
 * frame by several pixels, and it reads as a layout bug rather than a rounding one.
 *
 * Rotation. `absoluteBoundingBox` is AXIS-ALIGNED, so for a rotated node it is
 * bigger than the node actually is — a 100x20 label at 45° reports roughly 85x85.
 * Using it verbatim gives an element that is both unrotated and the wrong size.
 * `size` carries the true untransformed dimensions; rotation preserves the
 * centre, so placing the true-sized box concentric with the bounding box and
 * rotating about that centre reproduces Figma exactly. Deriving the position
 * this way (rather than from relativeTransform's translation) also survives
 * Stage 1 collapsing a wrapper frame, which would invalidate parent-relative
 * translations but never invalidates absolute ones.
 */
function relativeBox(node, parentBox, rotation) {
  const b = node.absoluteBoundingBox || { x: 0, y: 0, width: 0, height: 0 };
  const bw = b.width ?? 0;
  const bh = b.height ?? 0;
  const x = parentBox ? b.x - parentBox.x : 0;
  const y = parentBox ? b.y - parentBox.y : 0;

  if (!rotation) {
    return { x: round(x), y: round(y), width: round(bw), height: round(bh) };
  }
  const size =
    node.size?.x && node.size?.y
      ? { width: node.size.x, height: node.size.y }
      : unrotatedSize(bw, bh, rotation);
  if (!size) {
    return { x: round(x), y: round(y), width: round(bw), height: round(bh) };
  }
  return {
    x: round(x + bw / 2 - size.width / 2),
    y: round(y + bh / 2 - size.height / 2),
    width: round(size.width),
    height: round(size.height),
  };
}

/**
 * The size a node must be for its bounding box to come out `bw` x `bh` once
 * turned by `rotation`. Only needed when `size` is missing — fetch with
 * `geometry=paths` and Figma states it outright.
 *
 * Rotating a w x h box by theta sweeps out
 *   bw = w|cos| + h|sin|,  bh = w|sin| + h|cos|,
 * two equations solved here for w and h. They stop being independent at 45
 * degrees, where every box of a given perimeter sweeps out the same square;
 * there the bounding box genuinely does not determine the size, so hand back
 * null and let the caller keep what it has.
 */
function unrotatedSize(bw, bh, rotation) {
  const rad = (rotation * Math.PI) / 180;
  const c = Math.abs(Math.cos(rad));
  const s = Math.abs(Math.sin(rad));
  const det = c * c - s * s;
  if (Math.abs(det) < 0.02) return null;
  const width = (bw * c - bh * s) / det;
  const height = (bh * c - bw * s) / det;
  return width > 0 && height > 0 ? { width, height } : null;
}

/** boundVariables → { cssProp: tokenName }. Falls back to the raw id if unmapped. */
function resolveTokens(node, variableMap) {
  const bv = node.boundVariables;
  if (!bv || typeof bv !== 'object') return {};
  const out = {};
  for (const [key, val] of Object.entries(bv)) {
    const alias = Array.isArray(val) ? val[0] : val;
    if (alias && alias.id) out[key] = variableMap[alias.id] || alias.id;
  }
  return out;
}

/** INSTANCE → bound code component (or null if not in the map). */
function resolveComponent(node, componentMap) {
  const key = node.componentId || node.mainComponentId;
  if (!key) return null;
  const match = componentMap[key];
  if (!match) return null; // unbound instance → treat as a normal container
  return { key, name: match.name, props: match.props || {} };
}

/** Vector cluster → svg asset; image fill on a LEAF → image asset (an <img>). */
function resolveAsset(node) {
  if (node.__vectorCluster) return { type: 'svg', ref: node.id };
  const { hasImage, imageRef } = resolveFills(node.fills);
  // Only a childless node becomes an <img>. A frame with an image fill AND
  // children (a hero, a card) keeps its children and gets the photo as a
  // CSS background instead (see style.imageFill below).
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  // Fall back to the node id when the paint carries no imageRef — that node has
  // to be rendered rather than looked up.
  if (hasImage && !hasChildren) return { type: 'image', ref: imageRef || node.id };
  return null;
}

/**
 * @param {Object} node
 * @param {boolean} isVector  True when this node is exported as a flattened SVG.
 *   Its fills, strokes and radius are already baked into that SVG, so re-emitting
 *   them as CSS paints a second copy — a stroked arrow icon ends up sitting inside
 *   an opaque bordered box that hides it.
 * @param {{width:number,height:number}} box  Used for gradient geometry.
 * @param {string[]} warnings  Collected in place.
 */
function buildStyle(node, isVector, box, warnings) {
  const style = {};
  if (typeof node.opacity === 'number' && node.opacity < 1) style.opacity = node.opacity;
  if (node.clipsContent) style.overflow = 'hidden';

  const blend = resolveBlendMode(node);
  if (blend) style.blendMode = blend;

  // Effects sit outside the vector short-circuit: a shadow is cast BY the icon,
  // not painted inside its SVG, so it survives flattening and must still be emitted.
  const effects = resolveEffects(node.effects);
  if (effects.boxShadow) style.boxShadow = effects.boxShadow;
  if (effects.filter) style.filter = effects.filter;
  if (effects.backdropFilter) style.backdropFilter = effects.backdropFilter;
  if (effects.warnings) warnings.push(...effects.warnings);

  if (isVector) return style;

  const fills = resolveFills(node.fills, box);
  if (fills.warnings) warnings.push(...fills.warnings);
  if (node.type !== 'TEXT') {
    if (fills.background) style.background = fills.background;
    if (fills.layers) style.backgroundLayers = fills.layers;
    // Keep the imageRef itself (not just a flag) so the exporter can resolve the
    // photo through /v1/files/:key/images instead of re-rendering the node.
    // `true` means "image fill with no ref" — export it by rendering the node.
    if (fills.hasImage) {
      style.imageFill = fills.imageRef || true;
      style.imageFit = resolveImageFit(node.fills);
    }
  }

  const radius = resolveRadius(node);
  if (radius !== undefined) style.borderRadius = radius;

  const border = resolveBorder(node);
  if (border) {
    if (border.warnings) warnings.push(...border.warnings);
    if (border.css) {
      style.border = border.css;
      style.borderWidth = border.width;
      style.strokeAlign = border.align;
      style.borderColor = border.color;
      style.borderStyle = border.style;
      if (border.sides) style.borderSides = border.sides;
    }
  }

  // A ring (donut ellipse) is drawn with a border, not a fill.
  const ring = resolveRingThickness(node);
  if (ring?.warnings) warnings.push(...ring.warnings);
  if (ring?.thickness && style.background) {
    style.border = `${ring.thickness}px solid ${style.background}`;
    style.borderWidth = ring.thickness;
    style.strokeAlign = 'inside';
    delete style.background;
    delete style.borderSides;
  }
  return style;
}

function determineRole(node, { component, asset, hasChildren }) {
  if (component) return ROLES.COMPONENT;
  if (node.type === 'TEXT') return ROLES.TEXT;
  if (asset?.type === 'svg') return ROLES.VECTOR;
  if (asset?.type === 'image') return ROLES.IMAGE;
  if (hasChildren) return ROLES.CONTAINER;
  return ROLES.SHAPE;
}

function convert(node, ctx, options) {
  const containerLayout = computeContainerLayout(node);
  const childHints = computeChildLayout(node, ctx.parentLayout);
  const sizing = computeSizing(node); // { widthMode, heightMode } for Stage 8
  const layout = { ...containerLayout, ...childHints, ...sizing };

  const warnings = [];
  const { rotation, mirrored } = nodeTransform(node);
  if (rotation && layout.position !== 'absolute' && ctx.parentLayout?.mode === LAYOUT.FLEX) {
    // In flow, the rotated element still occupies its unrotated box, so a large
    // angle can overlap its siblings the way it does not in Figma.
    warnings.push(`${WARN.ROTATION_IN_FLOW}: ${rotation}deg inside an auto-layout parent`);
  }

  const box = relativeBox(node, ctx.parentBox, rotation);

  const component = node.type === 'INSTANCE' ? resolveComponent(node, options.componentMap) : null;
  const asset = resolveAsset(node);
  const text = node.type === 'TEXT' ? resolveText(node) : null;
  const hasChildren = Array.isArray(node.children) && node.children.length > 0;
  const role = determineRole(node, { component, asset, hasChildren });

  const style = buildStyle(node, role === ROLES.VECTOR, box, warnings);
  if (rotation) style.rotation = rotation;
  if (mirrored) style.mirrored = true;
  if (text?.color) style.color = text.color; // surface text color at style level too

  // Vector clusters flatten to a single SVG. Component instances DO descend —
  // we keep the binding (component.name/props) but also render their inner
  // content, so raw conversion doesn't lose everything inside an instance.
  const descend = role !== ROLES.VECTOR;
  const children = descend && hasChildren
    ? node.children.map((c) =>
        convert(
          c,
          { parentBox: node.absoluteBoundingBox, parentLayout: containerLayout },
          options
        )
      )
    : [];

  return createNode({
    id: node.id,
    name: node.name,
    role,
    box,
    layout,
    style,
    text,
    tokens: resolveTokens(node, options.variableMap),
    component,
    asset,
    warnings,
    children,
  });
}

/**
 * Every warning in the tree, with the node that raised it.
 * Use this after conversion to see exactly which design features did NOT survive
 * — the alternative is discovering it as an unexplained pixel diff.
 * @param {import('./schema.js').IRNode} node
 * @returns {Array<{id:string,name:string,warning:string}>}
 */
export function collectWarnings(node, acc = []) {
  if (!node) return acc;
  for (const w of node.warnings || []) acc.push({ id: node.id, name: node.name, warning: w });
  (node.children || []).forEach((c) => collectWarnings(c, acc));
  return acc;
}

/**
 * Convert a raw Figma node tree into the IR.
 * @param {Object} figmaTree  Raw Figma node (frame/document).
 * @param {Object} [options]
 * @param {Object<string,string>} [options.variableMap]
 * @param {Object<string,{name:string,props?:Object}>} [options.componentMap]
 * @returns {import('./schema.js').IRNode|null}  null if the whole tree was pruned.
 */
export function figmaToIR(figmaTree, options = {}) {
  const opts = { variableMap: options.variableMap || {}, componentMap: options.componentMap || {} };
  const clean = normalizeTree(figmaTree);
  if (!clean) return null;
  // Root has no parent → it flows normally (static), never absolutely placed.
  // Its own children still get correct hints from the root's computed layout.
  return convert(clean, { parentBox: null, parentLayout: { mode: LAYOUT.BLOCK } }, opts);
}
