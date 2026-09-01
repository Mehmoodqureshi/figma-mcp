// Stage 2 — Auto Layout → Flexbox (deterministic, no LLM).
//
// This is the single biggest lever against the research-proven failure mode:
// models hardcoding absolute x/y coordinates. Figma Auto Layout maps almost 1:1
// to flexbox, so we compute the flex layout in code and hand codegen a clean
// `layout` object — the model never has to guess.
//
// Figma layout fields (REST API / Plugin API):
//   layoutMode: 'NONE' | 'HORIZONTAL' | 'VERTICAL'
//   primaryAxisAlignItems: 'MIN'|'CENTER'|'MAX'|'SPACE_BETWEEN'
//   counterAxisAlignItems: 'MIN'|'CENTER'|'MAX'|'BASELINE'
//   itemSpacing, paddingLeft/Right/Top/Bottom
//   layoutWrap: 'NO_WRAP' | 'WRAP'
// Per-child:
//   layoutGrow: 0|1, layoutAlign: 'STRETCH'|'INHERIT'|..., layoutPositioning: 'AUTO'|'ABSOLUTE'

import { LAYOUT } from './schema.js';

const PRIMARY_TO_JUSTIFY = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  SPACE_BETWEEN: 'space-between',
};

const COUNTER_TO_ALIGN = {
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
  BASELINE: 'baseline',
};

const CHILD_ALIGN_SELF = {
  STRETCH: 'stretch',
  MIN: 'flex-start',
  CENTER: 'center',
  MAX: 'flex-end',
};

/**
 * Compute the container-level `layout` from a raw Figma frame node.
 * @param {Object} figmaNode
 * @returns {import('./schema.js').Layout}
 */
export function computeContainerLayout(figmaNode) {
  const mode = figmaNode.layoutMode;

  // No Auto Layout. A leaf (no children) is just block flow; a container with
  // children but no Auto Layout positions those children absolutely by coords.
  if (!mode || mode === 'NONE') {
    const hasChildren = Array.isArray(figmaNode.children) && figmaNode.children.length > 0;
    return { mode: hasChildren ? LAYOUT.ABSOLUTE : LAYOUT.BLOCK };
  }

  const padding = {
    top: figmaNode.paddingTop ?? 0,
    right: figmaNode.paddingRight ?? 0,
    bottom: figmaNode.paddingBottom ?? 0,
    left: figmaNode.paddingLeft ?? 0,
  };

  return {
    mode: LAYOUT.FLEX,
    direction: mode === 'HORIZONTAL' ? 'row' : 'column',
    gap: figmaNode.itemSpacing ?? 0,
    padding,
    justify: PRIMARY_TO_JUSTIFY[figmaNode.primaryAxisAlignItems] ?? 'flex-start',
    align: COUNTER_TO_ALIGN[figmaNode.counterAxisAlignItems] ?? 'flex-start',
    wrap: figmaNode.layoutWrap === 'WRAP' ? 'wrap' : 'nowrap',
  };
}

const SIZING = { FIXED: 'fixed', HUG: 'hug', FILL: 'fill' };

/**
 * Capture Figma's per-axis sizing intent — the signal Stage 8 uses to make the
 * layout responsive. `layoutSizingHorizontal`/`layoutSizingVertical` are FIXED
 * (keep px), HUG (size to content), or FILL (stretch to fill the parent).
 * Falls back to inference from grow/align/sizing-mode for older payloads.
 * @param {Object} figmaNode
 * @returns {{widthMode:'fixed'|'hug'|'fill', heightMode:'fixed'|'hug'|'fill'}}
 */
export function computeSizing(figmaNode) {
  let widthMode = SIZING[figmaNode.layoutSizingHorizontal];
  let heightMode = SIZING[figmaNode.layoutSizingVertical];

  // Fallback inference when the modern fields are absent.
  if (!widthMode || !heightMode) {
    const mode = figmaNode.layoutMode;
    // A child that grows fills its parent's main axis.
    if (figmaNode.layoutGrow === 1) {
      // Main axis depends on the PARENT's direction, which we don't have here;
      // grow is surfaced separately as layout.grow, so leave modes at fixed and
      // let the codegen honor grow. This keeps the fallback conservative.
    }
    // An Auto-Layout container that hugs sizes to its children.
    if (mode && mode !== 'NONE') {
      if (figmaNode.primaryAxisSizingMode === 'AUTO') {
        if (mode === 'HORIZONTAL') widthMode ||= 'hug';
        else heightMode ||= 'hug';
      }
      if (figmaNode.counterAxisSizingMode === 'AUTO') {
        if (mode === 'HORIZONTAL') heightMode ||= 'hug';
        else widthMode ||= 'hug';
      }
    }
  }

  return { widthMode: widthMode || 'fixed', heightMode: heightMode || 'fixed' };
}

/**
 * Compute child-level layout hints (flex-grow, align-self, absolute escape).
 * Merged onto the child's own layout by the converter.
 * @param {Object} childFigmaNode
 * @param {import('./schema.js').Layout} parentLayout
 * @returns {Partial<import('./schema.js').Layout>}
 */
export function computeChildLayout(childFigmaNode, parentLayout) {
  const out = {};

  // A child explicitly marked ABSOLUTE escapes the flex flow.
  if (childFigmaNode.layoutPositioning === 'ABSOLUTE') {
    out.position = 'absolute';
    return out;
  }

  // Inside a flex parent, translate grow/stretch.
  if (parentLayout?.mode === LAYOUT.FLEX) {
    out.position = 'static';
    if (childFigmaNode.layoutGrow === 1) out.grow = 1;
    const self = CHILD_ALIGN_SELF[childFigmaNode.layoutAlign];
    if (self) out.alignSelf = self;
  } else if (parentLayout?.mode === LAYOUT.ABSOLUTE) {
    // In an absolute parent, every child is absolutely placed by its box.
    out.position = 'absolute';
  }

  return out;
}
