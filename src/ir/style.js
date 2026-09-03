// Stage 1/3 — Style extraction: Figma paints/effects/text → CSS-ready values.
//
// Kept deterministic. The rule here is: extract everything Figma actually says,
// and when something genuinely has no CSS equivalent, record a WARNING rather
// than dropping it silently. A silent drop is invisible until you diff the
// render, and by then the verify loop is guessing at a feature the IR never
// captured — which it can only paper over, never fix.

/** Warning codes surfaced on the IR so unsupported features are visible. */
export const WARN = Object.freeze({
  GRADIENT_UNSUPPORTED: 'GRADIENT_UNSUPPORTED',
  STROKE_PAINT_UNSUPPORTED: 'STROKE_PAINT_UNSUPPORTED',
  EFFECT_UNSUPPORTED: 'EFFECT_UNSUPPORTED',
  ARC_UNSUPPORTED: 'ARC_UNSUPPORTED',
  ROTATION_IN_FLOW: 'ROTATION_IN_FLOW',
  MIRROR_UNKNOWN: 'MIRROR_UNKNOWN',
});

const round = (n, p = 2) => Number(Number(n).toFixed(p));

/** Figma color {r,g,b,a} in 0..1 → CSS hex or rgba(). */
export function rgbaToCss({ r, g, b, a = 1 }) {
  const c = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
  const hex = (v) => c(v).toString(16).padStart(2, '0');
  if (a >= 1) return `#${hex(r)}${hex(g)}${hex(b)}`;
  return `rgba(${c(r)}, ${c(g)}, ${c(b)}, ${round(a, 3)})`;
}

/** First visible paint of a given type, or null. */
function firstVisiblePaint(paints, type) {
  if (!Array.isArray(paints)) return null;
  return paints.find((p) => p.visible !== false && p.type === type) || null;
}

/** Topmost visible paint of a given type, or null. */
function topVisiblePaint(paints, type) {
  if (!Array.isArray(paints)) return null;
  for (let i = paints.length - 1; i >= 0; i--) {
    const p = paints[i];
    if (p.visible !== false && p.type === type) return p;
  }
  return null;
}

const isGradient = (p) => typeof p.type === 'string' && p.type.startsWith('GRADIENT');

// --- gradients ------------------------------------------------------------

/**
 * Gradient stops → CSS colour-stop list.
 * The paint's own `opacity` multiplies every stop's alpha, exactly as Figma
 * composites the layer.
 */
function stopsToCss(stops, paintOpacity = 1) {
  if (!Array.isArray(stops) || stops.length === 0) return null;
  return stops
    .map((s) => {
      const col = s.color || {};
      const a = (col.a ?? 1) * paintOpacity;
      return `${rgbaToCss({ ...col, a })} ${round((s.position ?? 0) * 100)}%`;
    })
    .join(', ');
}

/**
 * Figma describes a gradient with three handles in the node's own normalised
 * space (0..1 on each axis): [0] is the origin, [1] the end of the primary axis,
 * [2] the end of the perpendicular axis.
 *
 * Those are normalised per-axis, so on a non-square box the visual angle is NOT
 * atan2 of the raw handles — a 45° handle pair across a 400x100 banner points
 * far shallower than 45° on screen. Scaling by the box dimensions first is what
 * makes wide/short gradients come out at the right angle.
 */
function handleVector(h0, h1, box) {
  const w = box?.width || 1;
  const ht = box?.height || 1;
  return { dx: (h1.x - h0.x) * w, dy: (h1.y - h0.y) * ht };
}

/** Screen-space delta → CSS gradient angle (0deg points up, clockwise). */
function cssAngle(dx, dy) {
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return round(((deg % 360) + 360) % 360, 1);
}

/**
 * One Figma gradient paint → a CSS gradient function, or null if it has no
 * faithful CSS equivalent.
 */
function gradientToCss(paint, box) {
  const h = paint.gradientHandlePositions;
  const stops = stopsToCss(paint.gradientStops, paint.opacity ?? 1);
  if (!stops || !Array.isArray(h) || h.length < 2) return null;

  if (paint.type === 'GRADIENT_LINEAR') {
    const { dx, dy } = handleVector(h[0], h[1], box);
    if (dx === 0 && dy === 0) return null;
    return `linear-gradient(${cssAngle(dx, dy)}deg, ${stops})`;
  }

  const cx = round((h[0].x ?? 0) * 100);
  const cy = round((h[0].y ?? 0) * 100);

  if (paint.type === 'GRADIENT_RADIAL' || paint.type === 'GRADIENT_DIAMOND') {
    // Without box dimensions the radii can't be expressed in px; farthest-side
    // is the closest shape-preserving fallback.
    if (!box?.width || !box?.height || h.length < 3) {
      return `radial-gradient(ellipse farthest-side at ${cx}% ${cy}%, ${stops})`;
    }
    const v = handleVector(h[0], h[1], box);
    const u = handleVector(h[0], h[2], box);
    const ry = Math.hypot(v.dx, v.dy);
    const rx = Math.hypot(u.dx, u.dy);
    if (!(rx > 0) || !(ry > 0)) return null;
    return `radial-gradient(ellipse ${round(rx)}px ${round(ry)}px at ${cx}% ${cy}%, ${stops})`;
  }

  if (paint.type === 'GRADIENT_ANGULAR') {
    const { dx, dy } = handleVector(h[0], h[1], box);
    const from = dx === 0 && dy === 0 ? 0 : cssAngle(dx, dy);
    return `conic-gradient(from ${from}deg at ${cx}% ${cy}%, ${stops})`;
  }

  return null;
}

/**
 * Resolve a fills array into CSS background layers.
 *
 * Figma stacks paints bottom-first: fills[0] is the BOTTOM layer and the last
 * entry is on top. CSS `background-image` is the opposite — the first layer in
 * the list paints on top — so the list is reversed on the way out.
 *
 * Every layer matters. The canonical hero is `[IMAGE photo, GRADIENT black→transparent]`:
 * keeping only the topmost paint of each type drops the scrim, and the white
 * text that was designed against it lands on a bright photo. Solid paints above
 * the bottom-most one are emitted as gradient layers too, since CSS only has one
 * background-color slot.
 *
 * `hasImage` and `imageRef` are separate on purpose: some image paints arrive
 * without an imageRef at all. Those still need exporting — just by rendering the
 * node rather than by looking the bitmap up — so a placeholder ref would send
 * them down a lookup that can only miss.
 *
 * @param {Array} fills
 * @param {{width:number,height:number}} [box]  Needed for correct gradient geometry.
 * @returns {{background?:string, layers?:string[], hasImage?:boolean, imageRef?:string, warnings?:string[]}}
 */
export function resolveFills(fills, box) {
  if (!Array.isArray(fills) || fills.length === 0) return {};
  const visible = fills.filter((p) => p.visible !== false);
  if (visible.length === 0) return {};

  const out = {};
  const warnings = [];
  const layers = []; // bottom-first while building

  // The bottom-most solid becomes background-color; anything above it has to be
  // a layer, because CSS has only one colour slot.
  const firstSolidIdx = visible.findIndex((p) => p.type === 'SOLID');

  visible.forEach((paint, i) => {
    if (paint.type === 'SOLID') {
      const a = (paint.opacity ?? 1) * (paint.color?.a ?? 1);
      const css = rgbaToCss({ ...paint.color, a });
      if (i === firstSolidIdx) out.background = css;
      else layers.push(`linear-gradient(${css}, ${css})`);
      return;
    }
    if (paint.type === 'IMAGE') {
      out.hasImage = true;
      if (paint.imageRef) out.imageRef = paint.imageRef;
      return; // the bitmap layer is emitted by codegen from the exported asset
    }
    if (isGradient(paint)) {
      const css = gradientToCss(paint, box);
      if (css) layers.push(css);
      else warnings.push(`${WARN.GRADIENT_UNSUPPORTED}: ${paint.type}`);
    }
  });

  if (layers.length) out.layers = layers.reverse(); // → topmost first, CSS order
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** Figma scaleMode → how the bitmap fills its box. */
const SCALE_MODE = { FILL: 'cover', FIT: 'contain', TILE: 'repeat', STRETCH: 'crop' };

/**
 * How a node's image fill should be fitted into its box.
 *
 * Only matters once the ORIGINAL bitmap is used instead of a node render — a
 * node render arrives pre-cropped, so anything fits with `cover`. The original
 * does not, and `STRETCH` (what Figma's crop tool produces) carries the visible
 * window in `imageTransform`: a 2x3 matrix whose diagonal is the crop rect's
 * size and whose last column is its offset, both normalised to the image.
 * Inverting that gives CSS background-size/-position percentages.
 *
 * @returns {{fit:string, sizeX?:number, sizeY?:number, posX?:number, posY?:number}|undefined}
 */
export function resolveImageFit(fills) {
  const paint = topVisiblePaint(fills, 'IMAGE');
  if (!paint) return undefined;
  const fit = SCALE_MODE[paint.scaleMode] || 'cover';
  // A PAINT's own opacity is not the node's. Figma uses it constantly to sink a
  // hero photo into the frame colour behind it — the JJ Carson hero is a
  // full-bleed photo at 0.4 over near-black, and dropping the 0.4 renders the
  // whole band at full brightness. It has no per-layer equivalent in CSS, so
  // codegen applies it as element opacity, which is only safe on a leaf.
  const alpha = typeof paint.opacity === 'number' && paint.opacity < 1 ? round(paint.opacity, 3) : undefined;
  const m = paint.imageTransform;
  if (fit !== 'crop' || !Array.isArray(m) || m.length < 2) {
    return alpha === undefined ? { fit } : { fit, opacity: alpha };
  }

  const sx = m[0][0];
  const sy = m[1][1];
  const tx = m[0][2] ?? 0;
  const ty = m[1][2] ?? 0;
  // rotated/degenerate crop window — don't guess the box, but keep the alpha
  if (!(sx > 0) || !(sy > 0)) return alpha === undefined ? { fit: 'cover' } : { fit: 'cover', opacity: alpha };

  return {
    fit: 'crop',
    ...(alpha === undefined ? {} : { opacity: alpha }),
    sizeX: round(100 / sx, 3),
    sizeY: round(100 / sy, 3),
    // The offset is a fraction of the leftover, exactly like a CSS percentage.
    posX: round(sx >= 1 ? 0 : (tx / (1 - sx)) * 100, 3),
    posY: round(sy >= 1 ? 0 : (ty / (1 - sy)) * 100, 3),
  };
}

/**
 * Strokes → border description, including per-side widths.
 *
 * Two things CSS models differently and both are common enough to matter:
 *
 * Alignment — Figma can put a stroke INSIDE / CENTER / OUTSIDE the bounds. A CSS
 * `border` is always inside and eats into the content box, so a centred or
 * outside stroke both misplaces the line and shrinks whatever it wraps. Codegen
 * switches to `outline` for the other two alignments.
 *
 * Per-side widths — `individualStrokeWeights` is how every divider, underlined
 * tab and table row is drawn. Reading only the uniform `strokeWeight` turns a
 * single bottom rule into a box around the element, which is one of the most
 * visible ways a conversion goes wrong. When sides differ we must use `border`
 * (outline has no per-side form), so a non-inside alignment is reported.
 *
 * @returns {{css:string,width:number,align:string,color:string,style:string,
 *            sides?:{top:number,right:number,bottom:number,left:number},
 *            warnings?:string[]}|undefined}
 */
export function resolveBorder(node) {
  const stroke = firstVisiblePaint(node.strokes, 'SOLID');
  const warnings = [];

  if (!stroke) {
    // A gradient stroke has no CSS border equivalent (it needs border-image or a
    // pseudo-element); say so rather than rendering nothing.
    const grad = Array.isArray(node.strokes) && node.strokes.find((s) => s.visible !== false && isGradient(s));
    if (grad && (node.strokeWeight || node.individualStrokeWeights)) {
      return { warnings: [`${WARN.STROKE_PAINT_UNSUPPORTED}: ${grad.type}`] };
    }
    return undefined;
  }

  const isw = node.individualStrokeWeights;
  const uniform = node.strokeWeight ?? 0;
  const sides = isw
    ? { top: isw.top ?? 0, right: isw.right ?? 0, bottom: isw.bottom ?? 0, left: isw.left ?? 0 }
    : null;
  const maxWeight = sides ? Math.max(sides.top, sides.right, sides.bottom, sides.left) : uniform;
  if (!maxWeight) return undefined;

  const a = (stroke.opacity ?? 1) * (stroke.color?.a ?? 1);
  const color = rgbaToCss({ ...stroke.color, a });
  const style = Array.isArray(node.strokeDashes) && node.strokeDashes.length > 0 ? 'dashed' : 'solid';
  const align = { CENTER: 'center', OUTSIDE: 'outside' }[node.strokeAlign] || 'inside';

  const mixed = sides && new Set(Object.values(sides)).size > 1;
  if (mixed && align !== 'inside') {
    warnings.push(`${WARN.STROKE_PAINT_UNSUPPORTED}: per-side stroke forced to inside (was ${align})`);
  }

  const out = {
    css: `${round(maxWeight)}px ${style} ${color}`,
    width: maxWeight,
    align: mixed ? 'inside' : align,
    color,
    style,
  };
  if (sides) out.sides = sides;
  if (warnings.length) out.warnings = warnings;
  return out;
}

/**
 * cornerRadius (single) or rectangleCornerRadii ([tl,tr,br,bl]).
 * An ELLIPSE carries no radius fields at all — its roundness is implied by the
 * node type, so without this it renders as a square.
 */
export function resolveRadius(node) {
  if (node.type === 'ELLIPSE') return '50%';
  if (Array.isArray(node.rectangleCornerRadii)) return node.rectangleCornerRadii;
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) return node.cornerRadius;
  return undefined;
}

const FULL_SWEEP = Math.PI * 2 - 1e-3;

/**
 * A Figma "ring" — an ELLIPSE with arcData.innerRadius > 0 — is a donut, not a
 * disc. There's no CSS for a partial arc, so only a FULL sweep is handled; the
 * fill colour becomes a border of the ring's thickness and the fill is dropped.
 *
 * @returns {{thickness:number}|{warnings:string[]}|undefined}
 */
export function resolveRingThickness(node) {
  if (node.type !== 'ELLIPSE') return undefined;
  const arc = node.arcData;
  if (!arc) return undefined;
  const inner = arc.innerRadius ?? 0;
  const sweep = Math.abs((arc.endingAngle ?? 0) - (arc.startingAngle ?? 0));
  if (!(inner > 0 && inner < 1)) {
    // A partial disc (pie slice) also has no CSS form.
    if (sweep > 0 && sweep < FULL_SWEEP) return { warnings: [`${WARN.ARC_UNSUPPORTED}: partial arc`] };
    return undefined;
  }
  if (sweep < FULL_SWEEP) return { warnings: [`${WARN.ARC_UNSUPPORTED}: partial ring`] };
  const radius = (node.absoluteBoundingBox?.width ?? 0) / 2;
  const thickness = radius * (1 - inner);
  return thickness > 0 ? { thickness: round(thickness) } : undefined;
}

// --- effects --------------------------------------------------------------

// Figma's blur radius is roughly twice the Gaussian standard deviation CSS
// filters take, so passing it through verbatim gives a visibly over-blurred
// result. Shadows are the exception — Figma's shadow radius already matches
// CSS's blur-radius argument closely enough to use directly.
const BLUR_SCALE = 0.5;

/**
 * All visible effects → CSS.
 *
 * Reading only the first DROP_SHADOW loses three things that show up constantly:
 * layered shadows (every design system stacks two or three for depth), inner
 * shadows, and blurs — BACKGROUND_BLUR in particular, which is the entire visual
 * of a glassmorphism card. Without it the card renders as a flat opaque box.
 *
 * Shadow order matters: CSS paints the first box-shadow on top, and Figma lists
 * effects bottom-first, so the list is reversed.
 *
 * @returns {{boxShadow?:string, filter?:string, backdropFilter?:string, warnings?:string[]}}
 */
export function resolveEffects(effects) {
  if (!Array.isArray(effects)) return {};
  const out = {};
  const shadows = [];
  const filters = [];
  const backdrop = [];
  const warnings = [];

  for (const e of effects) {
    if (e.visible === false) continue;
    const { offset = { x: 0, y: 0 }, radius = 0, spread = 0, color = {} } = e;
    switch (e.type) {
      case 'DROP_SHADOW':
        shadows.push(
          `${round(offset.x)}px ${round(offset.y)}px ${round(radius)}px ${round(spread)}px ${rgbaToCss(color)}`
        );
        break;
      case 'INNER_SHADOW':
        shadows.push(
          `inset ${round(offset.x)}px ${round(offset.y)}px ${round(radius)}px ${round(spread)}px ${rgbaToCss(color)}`
        );
        break;
      case 'LAYER_BLUR':
        filters.push(`blur(${round(radius * BLUR_SCALE)}px)`);
        break;
      case 'BACKGROUND_BLUR':
        backdrop.push(`blur(${round(radius * BLUR_SCALE)}px)`);
        break;
      default:
        if (e.type) warnings.push(`${WARN.EFFECT_UNSUPPORTED}: ${e.type}`);
    }
  }

  if (shadows.length) out.boxShadow = shadows.reverse().join(', ');
  if (filters.length) out.filter = filters.join(' ');
  if (backdrop.length) out.backdropFilter = backdrop.join(' ');
  if (warnings.length) out.warnings = warnings;
  return out;
}

/** @deprecated Use resolveEffects. Kept so existing importers keep working. */
export function resolveShadow(effects) {
  return resolveEffects(effects).boxShadow;
}

/** Figma blendMode → CSS mix-blend-mode. PASS_THROUGH/NORMAL need no property. */
const BLEND_MODE = {
  MULTIPLY: 'multiply',
  SCREEN: 'screen',
  OVERLAY: 'overlay',
  DARKEN: 'darken',
  LIGHTEN: 'lighten',
  COLOR_DODGE: 'color-dodge',
  COLOR_BURN: 'color-burn',
  HARD_LIGHT: 'hard-light',
  SOFT_LIGHT: 'soft-light',
  DIFFERENCE: 'difference',
  EXCLUSION: 'exclusion',
  HUE: 'hue',
  SATURATION: 'saturation',
  COLOR: 'color',
  LUMINOSITY: 'luminosity',
};

export function resolveBlendMode(node) {
  return BLEND_MODE[node.blendMode] || undefined;
}

// --- text -----------------------------------------------------------------

const TEXT_CASE = {
  UPPER: 'uppercase',
  LOWER: 'lowercase',
  TITLE: 'capitalize',
  ORIGINAL: 'none',
};
const TEXT_DECORATION = { UNDERLINE: 'underline', STRIKETHROUGH: 'line-through', NONE: 'none' };
const TEXT_ALIGN = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFIED: 'justify' };
const TEXT_VALIGN = { TOP: 'top', CENTER: 'center', BOTTOM: 'bottom' };

/** leadingTrim values that collapse the line box onto the glyphs. */
const TRIMMED_LEADING = new Set(['CAP_HEIGHT', 'BOTH']);

/** Italic can arrive either as a flag or only in the PostScript name. */
function isItalic(s) {
  if (s.italic === true) return true;
  return /italic|oblique/i.test(s.fontPostScriptName || '');
}

/**
 * Split a TEXT node into styled runs when parts of it differ.
 *
 * Figma stores this as a per-character array of style ids (`characterStyleOverrides`)
 * plus a lookup table (`styleOverrideTable`). Ignoring it flattens "Get **50% off**
 * today" into one uniform string — the bold, the accent colour and every inline
 * link in the design disappear.
 *
 * @returns {Array<{text:string, style:Object}>|null}  null when the text is uniform.
 */
export function resolveTextRuns(node) {
  const chars = node.characters ?? '';
  const overrides = node.characterStyleOverrides;
  const table = node.styleOverrideTable;
  if (!chars || !Array.isArray(overrides) || !table) return null;

  const idAt = (i) => overrides[i] ?? 0;
  const runs = [];
  let start = 0;
  for (let i = 1; i <= chars.length; i++) {
    if (i === chars.length || idAt(i) !== idAt(start)) {
      runs.push({ text: chars.slice(start, i), styleId: idAt(start) });
      start = i;
    }
  }
  if (runs.length <= 1) return null; // uniform — the node-level style covers it

  return runs.map((r) => {
    const s = r.styleId ? table[String(r.styleId)] || {} : {};
    const style = {};
    if (s.fontFamily) style.fontFamily = s.fontFamily;
    if (s.fontWeight) style.fontWeight = s.fontWeight;
    if (s.fontSize) style.fontSize = s.fontSize;
    if (s.letterSpacing) style.letterSpacing = s.letterSpacing;
    if (isItalic(s)) style.fontStyle = 'italic';
    if (s.textCase && TEXT_CASE[s.textCase]) style.textTransform = TEXT_CASE[s.textCase];
    if (s.textDecoration && TEXT_DECORATION[s.textDecoration]) {
      style.textDecoration = TEXT_DECORATION[s.textDecoration];
    }
    const fill = resolveFills(s.fills);
    if (fill.background) style.color = fill.background;
    return { text: r.text, style };
  });
}

/**
 * Figma TEXT node style → IR TextStyle.
 *
 * leadingTrim is the subtle one. With `leadingTrim: CAP_HEIGHT` Figma discards
 * the half-leading and the line box becomes exactly the cap height — so the
 * reported `lineHeightPx` is NOT the rendered line height. Designs routinely
 * carry a leftover default like `lineHeightPx: 70` on 9px text and still render
 * a 6px-tall line; emitting that verbatim blows every such label up to 70px.
 *
 * For a single trimmed line the node's own box height IS the line box, so use
 * it directly — that reproduces Figma exactly and needs no font metrics. The
 * guard `boxH < fontSize` is what establishes "single line": a trimmed line is
 * roughly 0.7em (the cap-height ratio), while any second line would add a full
 * lineHeight on top. Multi-line trimmed text falls through to the raw value.
 *
 * verticalAlign is the one people miss. Figma centres text inside its box by
 * default for anything laid out by hand, and CSS puts it at the top — so every
 * button label, badge and nav item sits high by a few pixels. It's small per
 * element and unmistakable across a whole page.
 */
export function resolveText(node) {
  const s = node.style || {};
  const fills = resolveFills(node.fills);
  let lineHeight =
    s.lineHeightPx ??
    (s.lineHeightPercentFontSize && s.fontSize
      ? (s.lineHeightPercentFontSize / 100) * s.fontSize
      : undefined);

  const boxHeight = node.absoluteBoundingBox?.height;
  if (TRIMMED_LEADING.has(s.leadingTrim) && boxHeight > 0 && s.fontSize && boxHeight < s.fontSize) {
    lineHeight = boxHeight;
  }

  // letterSpacing arrives in px, but can be a percentage of the font size when
  // the designer typed one — Figma reports which via letterSpacingUnit.
  let letterSpacing = s.letterSpacing;
  if (letterSpacing != null && s.letterSpacingUnit === 'PERCENT' && s.fontSize) {
    letterSpacing = (letterSpacing / 100) * s.fontSize;
  }

  return {
    content: node.characters ?? '',
    runs: resolveTextRuns(node),
    fontFamily: s.fontFamily,
    fontWeight: s.fontWeight,
    fontSize: s.fontSize,
    fontStyle: isItalic(s) ? 'italic' : undefined,
    lineHeight: lineHeight != null ? round(lineHeight) : undefined,
    letterSpacing: letterSpacing != null ? round(letterSpacing, 3) : undefined,
    align: TEXT_ALIGN[s.textAlignHorizontal] || 'left',
    verticalAlign: TEXT_VALIGN[s.textAlignVertical] || 'top',
    textTransform: TEXT_CASE[s.textCase] || 'none',
    textDecoration: TEXT_DECORATION[s.textDecoration] || 'none',
    color: fills.background,
    // WIDTH_AND_HEIGHT means the box was sized to the text, so it never wrapped
    // in Figma. Codegen turns this into white-space:nowrap.
    autoResize: s.textAutoResize,
    leadingTrim: s.leadingTrim,
    // ENDING truncates with an ellipsis; maxLines bounds it to N lines.
    truncation: s.textTruncation === 'ENDING' ? 'ellipsis' : undefined,
    maxLines: typeof s.maxLines === 'number' && s.maxLines > 0 ? s.maxLines : undefined,
  };
}
