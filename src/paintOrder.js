// Stage 7 — Paint order: z-order and clipping verification.
//
// The pixel diff says "these pixels differ"; the bbox IoU says "this element is
// 40px too low." Neither says "the chain is in front of the card when the design
// has it behind." That mismatch moves no boxes and can leave the diff ratio
// almost unchanged — an overlay drawn over a photo instead of under it swaps a
// few thousand pixels in a 10-megapixel frame — yet it is one of the most
// visible errors a person notices. Two elements in the right place, stacked the
// wrong way round, is a different failure from either of the ones already
// measured, so it needs its own signal.
//
// Two checks, both derived from information the IR already carries:
//
//   STACKING — Figma lists children back-to-front, so a node's pre-order index
//   IS its paint order. In the browser, `elementsFromPoint` returns hit
//   elements front-to-back. Sampling a grid and mapping each hit back to its
//   nearest `data-ir-id` ancestor gives the rendered order over every point
//   where two elements actually overlap. Disagreement is a z-order bug.
//
//   CLIPPING — an element can sit at the right coordinates and still be cut off
//   by an ancestor's `overflow`. The design says how much of each node survives
//   its own clipping ancestors; the render says how much survives in the
//   browser. A node the design shows whole and the render cuts in half is the
//   bug that leaves a hard seam where a decorative overhang should have been.

/**
 * Walk the IR in paint order (Figma children are back-to-front, so pre-order
 * index == paint index) collecting absolute boxes and each node's design-side
 * visible fraction after its clipping ancestors.
 *
 * @param {import('./ir/schema.js').IRNode} root
 * @returns {{
 *   order: Array<{id:string,label:string,role:string,index:number,box:{x,y,w,h},visible:number}>,
 *   byId: Map<string, {id:string,label:string,role:string,index:number,box:{x,y,w,h},visible:number}>
 * }}
 */
export function expectedPaintOrder(root) {
  const order = [];

  const walk = (node, offsetX, offsetY, clip) => {
    const box = {
      x: offsetX + node.box.x,
      y: offsetY + node.box.y,
      w: node.box.width,
      h: node.box.height,
    };
    order.push({
      id: node.id,
      label: node.text?.content?.slice(0, 60) || node.component?.name || node.name,
      role: node.role,
      index: order.length,
      box,
      visible: visibleFraction(box, clip),
    });

    // A node with a non-visible overflow clips its descendants, on top of
    // whatever its own ancestors already clip away.
    const overflow = node.style?.overflow;
    const childClip =
      overflow && overflow !== 'visible' ? intersect(clip, box) : clip;

    for (const child of node.children || []) {
      walk(child, box.x, box.y, childClip);
    }
  };

  // The frame itself is the outermost clip when it hides overflow — which is
  // how a chain drawn 3000px wide across a 1440px frame is meant to be cut.
  const frame = {
    x: root.box.x,
    y: root.box.y,
    w: root.box.width,
    h: root.box.height,
  };
  const rootClip =
    root.style?.overflow && root.style.overflow !== 'visible' ? frame : null;
  walk(root, 0, 0, rootClip);

  return { order, byId: new Map(order.map((n) => [n.id, n])) };
}

/** Intersection of two boxes, or `a` when there is no clip yet. */
function intersect(a, b) {
  if (!a) return { ...b };
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return { x, y, w: Math.max(0, r - x), h: Math.max(0, bt - y) };
}

/** Fraction of `box` surviving `clip` (1 when unclipped or zero-area). */
function visibleFraction(box, clip) {
  const area = box.w * box.h;
  if (area <= 0) return 1;
  if (!clip) return 1;
  const i = intersect(clip, box);
  return Math.min(1, (i.w * i.h) / area);
}

/**
 * @typedef {Object} StackingFinding
 * @property {'stacking'} kind
 * @property {string} frontId   Rendered in front.
 * @property {string} backId    Rendered behind.
 * @property {string} frontLabel
 * @property {string} backLabel
 * @property {number} samples   Sample points where the order was inverted.
 * @property {number} indexFront  Design paint index of the front element.
 * @property {number} indexBack
 */

/**
 * @typedef {Object} ClipFinding
 * @property {'clipping'} kind
 * @property {string} id
 * @property {string} label
 * @property {string} role
 * @property {number} expected  Design-side visible fraction (0..1).
 * @property {number} actual    Rendered visible fraction (0..1).
 */

/**
 * Compare design paint order against what the browser actually painted.
 *
 * @param {ReturnType<typeof expectedPaintOrder>} expected
 * @param {Object} observed
 * @param {Array<{front:string,back:string,samples:number}>} observed.pairs
 *        Ordered pairs seen in the render, front-to-back, with a sample count.
 * @param {Object<string, number>} observed.clip  id → rendered visible fraction.
 * @param {Object} [opts]
 * @param {number} [opts.minSamples=2]   Ignore pairs seen at fewer points than this.
 * @param {number} [opts.clipTolerance=0.15]  Rendered may lose this much more
 *        than the design before it counts as wrongly clipped.
 * @returns {{stacking: StackingFinding[], clipping: ClipFinding[]}}
 */
export function computePaintDiffs(expected, observed, opts = {}) {
  const { minSamples = 2, clipTolerance = 0.15 } = opts;
  const { byId } = expected;

  const stacking = [];
  for (const pair of observed.pairs || []) {
    const front = byId.get(pair.front);
    const back = byId.get(pair.back);
    if (!front || !back) continue;
    if (pair.samples < minSamples) continue;
    // An ancestor is legitimately behind its own descendants; that is the same
    // relationship the pre-order index encodes, so it never trips this.
    if (front.index > back.index) continue; // rendered front is also design-front: fine
    stacking.push({
      kind: 'stacking',
      frontId: front.id,
      backId: back.id,
      frontLabel: front.label,
      backLabel: back.label,
      samples: pair.samples,
      indexFront: front.index,
      indexBack: back.index,
    });
  }
  stacking.sort((a, b) => b.samples - a.samples);

  const clipping = [];
  for (const node of expected.order) {
    const actual = observed.clip?.[node.id];
    if (actual === undefined || actual === null) continue;
    if (node.box.w <= 0 || node.box.h <= 0) continue;
    if (actual < node.visible - clipTolerance) {
      clipping.push({
        kind: 'clipping',
        id: node.id,
        label: node.label,
        role: node.role,
        expected: node.visible,
        actual,
      });
    }
  }
  clipping.sort((a, b) => a.actual - a.expected - (b.actual - b.expected));

  return { stacking, clipping };
}

/**
 * Turn paint findings into a correction the calling agent can act on.
 * @param {ReturnType<typeof computePaintDiffs>} findings
 * @param {Object} [opts]
 * @param {number} [opts.max=6]  Per section.
 * @returns {string}  '' when there is nothing to report
 */
export function buildPaintCorrection(findings, opts = {}) {
  const { max = 6 } = opts;
  const lines = [];

  const stacking = findings.stacking.slice(0, max);
  if (stacking.length) {
    lines.push('### Paint order (z-index) vs the design');
    for (const f of stacking) {
      lines.push(
        `- **WRONG STACKING** — "${f.frontLabel}" is painted IN FRONT OF ` +
          `"${f.backLabel}" at ${f.samples} sampled point(s), but the design ` +
          `stacks it BEHIND (Figma paint index ${f.indexFront} vs ${f.indexBack}; ` +
          `lower index = further back). Put "${f.frontLabel}" behind — lower its ` +
          `z-index, or move it earlier in the DOM among its positioned siblings.`
      );
    }
  }

  const clipping = findings.clipping.slice(0, max);
  if (clipping.length) {
    if (lines.length) lines.push('');
    lines.push('### Clipping vs the design');
    for (const f of clipping) {
      const p = (n) => `${Math.round(n * 100)}%`;
      lines.push(
        `- **OVER-CLIPPED** — "${f.label}" (${f.role}) renders only ${p(f.actual)} ` +
          `visible, but the design shows ${p(f.expected)} of it. An ancestor's ` +
          `overflow is cutting it: the element is meant to overhang. Move it out ` +
          `of the clipping ancestor, or let that ancestor show overflow.`
      );
    }
  }

  return lines.join('\n');
}

/**
 * Browser-side measurement. Passed to page.evaluate, which serializes it, so it
 * must close over nothing and use only DOM globals. Returns {pairs, clip}.
 *
 * Sampling a grid rather than testing every pair keeps this to one round-trip
 * and naturally weights by visible area: a pair that overlaps across a large
 * region is sampled at many points, one that barely grazes at none.
 *
 * @param {{ids: string[], rootId: string, grid: number, maxPoints: number}} args
 */
export function measurePaint({ ids, rootId, grid, maxPoints }) {
  const root = document.querySelector('[data-ir-id=' + JSON.stringify(rootId) + ']');
  const rb = root ? root.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };

  // elementsFromPoint skips anything with pointer-events:none, which is exactly
  // what decorative overlays carry — the elements this check exists to catch.
  // pointer-events has no layout effect, so forcing it on is safe and reversible.
  const patch = document.createElement('style');
  patch.textContent = '*{pointer-events:auto !important}';
  document.head.appendChild(patch);

  const wanted = new Set(ids);
  const idOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const id = n.getAttribute && n.getAttribute('data-ir-id');
      if (id && wanted.has(id)) return id;
    }
    return null;
  };

  const counts = new Map();

  // Sample on a square pitch so density does not depend on the frame's aspect:
  // a 1440x10490 page gets 350 rows of 48, not 48 squashed bands 218px tall.
  const docLeft = rb.left + scrollX;
  const docTop = rb.top + scrollY;
  const step = Math.max(1, rb.width / grid);
  const cols = grid;
  const rows = Math.max(1, Math.min(Math.ceil(rb.height / step), Math.ceil(maxPoints / cols)));

  const scroll0 = { x: scrollX, y: scrollY };
  for (let gy = 0; gy < rows; gy++) {
    const docY = docTop + (gy + 0.5) * (rb.height / rows);
    // elementsFromPoint is viewport-relative. A frame taller than the viewport
    // would otherwise be sampled only across its first screen, and every
    // overlap below the fold would silently pass.
    if (docY < scrollY || docY >= scrollY + innerHeight) {
      scrollTo(0, Math.max(0, docY - innerHeight / 2));
    }
    for (let gx = 0; gx < cols; gx++) {
      const x = docLeft + (gx + 0.5) * step - scrollX;
      const y = docY - scrollY;
      if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
      const stack = [];
      for (const el of document.elementsFromPoint(x, y)) {
        const id = idOf(el);
        if (id && !stack.includes(id)) stack.push(id);
      }
      // stack is front-to-back; record every ordered pair once per point.
      for (let i = 0; i < stack.length; i++) {
        for (let j = i + 1; j < stack.length; j++) {
          const key = stack[i] + '|' + stack[j];
          counts.set(key, (counts.get(key) || 0) + 1);
        }
      }
    }
  }
  scrollTo(scroll0.x, scroll0.y);

  const clip = {};
  for (const id of ids) {
    const el = document.querySelector('[data-ir-id=' + JSON.stringify(id) + ']');
    if (!el) { clip[id] = null; continue; }
    const r = el.getBoundingClientRect();
    const area = r.width * r.height;
    if (area <= 0) { clip[id] = null; continue; }
    let l = r.left, t = r.top, rr = r.right, bb = r.bottom;
    for (let p = el.parentElement; p; p = p.parentElement) {
      const cs = getComputedStyle(p);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        const pr = p.getBoundingClientRect();
        l = Math.max(l, pr.left); t = Math.max(t, pr.top);
        rr = Math.min(rr, pr.right); bb = Math.min(bb, pr.bottom);
      }
    }
    clip[id] = Math.min(1, (Math.max(0, rr - l) * Math.max(0, bb - t)) / area);
  }

  patch.remove();

  const pairs = [];
  for (const [key, samples] of counts) {
    const [front, back] = key.split('|');
    pairs.push({ front, back, samples });
  }
  return { pairs, clip };
}
