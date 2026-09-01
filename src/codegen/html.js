// Stage 6 — IR → self-contained HTML/CSS.
//
// This is the PRIMARY emitter because its output renders directly in the Stage 7
// verify loop (renderHtml). Structure comes first (semantic tags from roles),
// then a scoped stylesheet — mirroring the "structure then style" order the plan
// and UICopilot recommend.

import { ROLES } from '../ir/schema.js';
import { cssDeclarations, declToString, collectTokenVars, RESET } from './cssgen.js';

const escapeHtml = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// A CSS identifier may not start with a digit (or a dash followed by one), so a
// layer named "250 AED" or "© 2024 …" would produce `.250-aed{...}` — which the
// parser discards WITHOUT error, silently dropping every style on that element.
// Prefixing is cheaper and more readable than emitting `\32 50-aed` escapes.
const slug = (name) => {
  const s =
    String(name || 'node').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'node';
  return /^[0-9]/.test(s) ? `n${s}` : s;
};

// 1x1 transparent PNG so <img> renders cleanly when the real asset isn't wired yet.
const IMG_PLACEHOLDER =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Every font family + weight + slant the tree actually uses.
 *
 * Inline runs are collected too: a heading whose one bold word is a style
 * override needs that weight requested, or the browser synthesises a faux-bold
 * whose metrics don't match the design.
 *
 * @returns {Map<string, Set<string>>} family → set of "ital,wght" pairs e.g. "0,400"
 */
function collectFonts(node, acc = new Map()) {
  const t = node.text;
  const add = (family, weight, italic) => {
    if (!family) return;
    if (!acc.has(family)) acc.set(family, new Set());
    acc.get(family).add(`${italic ? 1 : 0},${weight || 400}`);
  };
  if (t) {
    add(t.fontFamily, t.fontWeight, t.fontStyle === 'italic');
    for (const run of t.runs || []) {
      add(run.style.fontFamily || t.fontFamily, run.style.fontWeight || t.fontWeight, (run.style.fontStyle || t.fontStyle) === 'italic');
    }
  }
  (node.children || []).forEach((c) => collectFonts(c, acc));
  return acc;
}

/**
 * <link> tags pulling the design's fonts from Google Fonts.
 *
 * Without these the page falls back to system fonts, and different metrics mean
 * every text box is a different width than Figma measured — which cascades into
 * wrapping and reflow that reads as a layout bug rather than a font bug. This is
 * the single largest source of diff on a first render.
 *
 * One link PER FAMILY on purpose: css2 rejects the whole request if any one
 * family is unknown to Google, so a single custom/licensed font would otherwise
 * take every other font down with it.
 */
function fontLinks(ir) {
  const fonts = collectFonts(ir);
  if (!fonts.size) return '';
  const links = [...fonts.entries()].map(([family, pairs]) => {
    const fam = family.trim().replace(/\s+/g, '+');
    // css2 requires the axis tuples sorted ascending, ital first.
    const sorted = [...pairs].sort((a, b) => {
      const [ai, aw] = a.split(',').map(Number);
      const [bi, bw] = b.split(',').map(Number);
      return ai - bi || aw - bw;
    });
    const anyItalic = sorted.some((p) => p.startsWith('1,'));
    const axis = anyItalic
      ? `ital,wght@${sorted.join(';')}`
      : `wght@${sorted.map((p) => p.split(',')[1]).join(';')}`;
    return `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=${fam}:${axis}&display=swap">`;
  });
  return (
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>` +
    links.join('')
  );
}

const cssPx = (n) => `${Number(Number(n).toFixed(2))}px`;

/** A run's own overrides as an inline style (only what differs from the node). */
function runStyle(style) {
  const d = [];
  if (style.fontFamily) d.push(`font-family:'${style.fontFamily}', sans-serif`);
  if (style.fontWeight) d.push(`font-weight:${style.fontWeight}`);
  if (style.fontSize) d.push(`font-size:${cssPx(style.fontSize)}`);
  if (style.fontStyle) d.push(`font-style:${style.fontStyle}`);
  if (style.letterSpacing) d.push(`letter-spacing:${cssPx(style.letterSpacing)}`);
  if (style.color) d.push(`color:${style.color}`);
  if (style.textTransform) d.push(`text-transform:${style.textTransform}`);
  if (style.textDecoration) d.push(`text-decoration:${style.textDecoration}`);
  return d.join(';');
}

/** Text content, preserving Figma's line breaks and any mixed inline styling. */
function textContent(text) {
  const br = (s) => escapeHtml(s).replace(/\n/g, '<br>');
  if (!Array.isArray(text.runs) || text.runs.length === 0) return br(text.content);
  return text.runs
    .map((run) => {
      const css = runStyle(run.style || {});
      return css ? `<span style="${css}">${br(run.text)}</span>` : br(run.text);
    })
    .join('');
}

/** Pick a semantic tag for a text node from its size/weight. */
function textTag(node) {
  const size = node.text?.fontSize ?? 14;
  if (size >= 28) return 'h1';
  if (size >= 22) return 'h2';
  if (size >= 18) return 'h3';
  return 'p';
}

/**
 * Generate a self-contained HTML document from an IR tree.
 * @param {import('../ir/schema.js').IRNode} ir
 * @param {Object} [opts]
 * @param {string} [opts.title='Generated']
 * @param {boolean} [opts.responsive=false]  Stage 8: emit relative units (flex/%/auto/max-width).
 * @returns {string} full HTML document
 */
export function generateHtml(ir, opts = {}) {
  const { title = 'Generated', responsive = false, assets = {} } = opts;
  const rules = [];
  let counter = 0;

  function walk(node, parentLayout) {
    const cls = `${slug(node.name)}-${counter++}`;
    rules.push(`.${cls}{${declToString(cssDeclarations(node, { responsive, parentLayout, assets }))}}`);
    // data-ir-id lets Stage 7 measure each element's rendered box and compare it
    // to the design box (element-bbox IoU). Harmless if unused.
    const id = `data-ir-id="${escapeHtml(node.id)}"`;

    switch (node.role) {
      case ROLES.TEXT: {
        const tag = textTag(node);
        return `<${tag} class="${cls}" ${id}>${textContent(node.text)}</${tag}>`;
      }
      case ROLES.IMAGE: {
        // A cropped fill can't be expressed on an <img> — the crop window lives
        // in background-size/-position, which cssgen has already emitted.
        if (node.style.imageFit?.fit === 'crop' && assets[node.id]) {
          return `<div class="${cls}" ${id} role="img" aria-label="${escapeHtml(node.name)}"></div>`;
        }
        // Real exported image if we have it, else a transparent placeholder.
        const src = assets[node.id] || IMG_PLACEHOLDER;
        const fit = node.style.imageFit?.fit === 'contain' ? 'contain' : 'cover';
        return `<img class="${cls}" ${id} src="${src}" alt="${escapeHtml(node.name)}" style="object-fit:${fit};">`;
      }
      case ROLES.VECTOR: {
        // Real exported SVG/PNG if we have it, else a sized placeholder box.
        const src = assets[node.id];
        if (src) return `<img class="${cls}" ${id} src="${src}" alt="${escapeHtml(node.name)}" style="object-fit:contain;">`;
        // Missing asset. A filled `currentColor` block used to be painted here,
        // which reads as a solid black icon — it dominates the pixel diff and
        // sends the refiner off correcting a colour instead of a missing export.
        // A faint outline still shows up as a difference without drowning it out.
        return `<svg class="${cls}" ${id} viewBox="0 0 ${node.box.width} ${node.box.height}" aria-label="${escapeHtml(node.name)} (asset not exported)"><rect width="100%" height="100%" rx="2" fill="none" stroke="#c8c8c8" stroke-dasharray="3 3"/></svg>`;
      }
      case ROLES.COMPONENT:
        // Bound code component — keep the binding marker, but also render its
        // inner content so raw conversion doesn't drop everything inside it.
        return `<div class="${cls}" ${id} data-component="${escapeHtml(node.component.name)}">${node.children.map((c) => walk(c, node.layout)).join('')}</div>`;
      default:
        return `<div class="${cls}" ${id}>${node.children.map((c) => walk(c, node.layout)).join('')}</div>`;
    }
  }

  const body = walk(ir, null);

  // Token vars are referenced with exact fallbacks (var(--x, #fff)), so we must
  // NOT emit `--x: initial` here — that would shadow the fallback. Instead list
  // the tokens as a comment so they're discoverable; define them in your real
  // token file / Tailwind @theme and they'll take over automatically.
  const vars = [...collectTokenVars(ir).keys()];
  const rootBlock = vars.length ? `/* Design tokens to define: ${vars.join(', ')} */` : '';

  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<title>${escapeHtml(title)}</title>` +
    fontLinks(ir) +
    `<style>${RESET}${rootBlock}${rules.join('')}</style>` +
    `</head><body>${body}</body></html>`
  );
}
