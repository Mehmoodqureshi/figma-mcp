// Stage 6 — IR → React component (inline style objects).
//
// Secondary emitter — demonstrates the IR is framework-agnostic. Uses inline
// style objects so it's deterministic and pixel-exact out of the gate; a Tailwind
// class mapper can be layered on top of the same cssDeclarations() later.
//
// Bound components render as real JSX elements (<Badge variant="new" />), which is
// the whole point of Code Connect: instances become your components, not lookalikes.

import { ROLES } from '../ir/schema.js';
import { cssDeclarations } from './cssgen.js';

const kebabToCamel = (k) => k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
const pascal = (name) =>
  (String(name || 'Node').replace(/[^a-zA-Z0-9]+/g, ' ').trim().split(/\s+/)
    .map((w) => w[0].toUpperCase() + w.slice(1)).join('') || 'Node');

/** Declaration map → a JS style-object literal string. */
function styleLiteral(node, ctx) {
  const d = cssDeclarations(node, ctx);
  const entries = Object.entries(d).map(([k, v]) => `${kebabToCamel(k)}: ${JSON.stringify(v)}`);
  return `{ ${entries.join(', ')} }`;
}

/** props object → JSX attribute string. */
function propsToJsx(props = {}) {
  return Object.entries(props)
    .map(([k, v]) => (typeof v === 'string' ? `${k}=${JSON.stringify(v)}` : `${k}={${JSON.stringify(v)}}`))
    .join(' ');
}

function textTag(node) {
  const size = node.text?.fontSize ?? 14;
  if (size >= 28) return 'h1';
  if (size >= 22) return 'h2';
  if (size >= 18) return 'h3';
  return 'p';
}

/** A run's overrides as a JSX style object literal. */
function runStyleLiteral(style) {
  const d = {};
  if (style.fontFamily) d.fontFamily = `'${style.fontFamily}', sans-serif`;
  if (style.fontWeight) d.fontWeight = style.fontWeight;
  if (style.fontSize) d.fontSize = `${style.fontSize}px`;
  if (style.fontStyle) d.fontStyle = style.fontStyle;
  if (style.letterSpacing) d.letterSpacing = `${style.letterSpacing}px`;
  if (style.color) d.color = style.color;
  if (style.textTransform) d.textTransform = style.textTransform;
  if (style.textDecoration) d.textDecoration = style.textDecoration;
  const entries = Object.entries(d).map(([k, v]) => `${k}: ${JSON.stringify(v)}`);
  return `{ ${entries.join(', ')} }`;
}

/**
 * Text as JSX children.
 *
 * Always an expression container, never a bare literal: design copy contains
 * braces, angle brackets and quotes often enough ("{name}", "A < B", "Terms &
 * Conditions") that interpolating it raw produces JSX that will not parse.
 */
function textChildren(text) {
  if (!Array.isArray(text.runs) || text.runs.length === 0) return `{${JSON.stringify(text.content)}}`;
  return text.runs
    .map((run) => {
      const css = runStyleLiteral(run.style || {});
      return css === '{  }'
        ? `{${JSON.stringify(run.text)}}`
        : `<span style={${css}}>{${JSON.stringify(run.text)}}</span>`;
    })
    .join('');
}

function emit(node, indent, usedComponents, ctx) {
  const pad = '  '.repeat(indent);
  const style = `style={${styleLiteral(node, ctx)}}`;
  const childCtx = { responsive: ctx.responsive, parentLayout: node.layout };

  switch (node.role) {
    case ROLES.TEXT: {
      const tag = textTag(node);
      return `${pad}<${tag} ${style}>${textChildren(node.text)}</${tag}>`;
    }
    case ROLES.IMAGE:
      return `${pad}<img ${style} src={${JSON.stringify(node.asset?.ref ? `./assets/${node.asset.ref}` : '')}} alt=${JSON.stringify(node.name)} />`;
    case ROLES.VECTOR:
      return `${pad}<svg ${style} viewBox=${JSON.stringify(`0 0 ${node.box.width} ${node.box.height}`)} aria-label=${JSON.stringify(node.name)}><rect width="100%" height="100%" rx="2" fill="none" stroke="#c8c8c8" strokeDasharray="3 3" /></svg>`;
    case ROLES.COMPONENT: {
      usedComponents.add(node.component.name);
      const attrs = propsToJsx(node.component.props);
      return `${pad}<${node.component.name} ${style} ${attrs} />`;
    }
    default: {
      const children = node.children.map((c) => emit(c, indent + 1, usedComponents, childCtx)).join('\n');
      return `${pad}<div ${style}>\n${children}\n${pad}</div>`;
    }
  }
}

/**
 * Generate a React component module from an IR tree.
 * @param {import('../ir/schema.js').IRNode} ir
 * @param {Object} [opts]
 * @param {string} [opts.componentName]  Defaults to PascalCase of the root name.
 * @returns {string} JSX source
 */
export function generateReact(ir, opts = {}) {
  const name = opts.componentName || pascal(ir.name);
  const usedComponents = new Set();
  const tree = emit(ir, 2, usedComponents, { responsive: opts.responsive || false, parentLayout: null });

  const imports = [...usedComponents]
    .map((c) => `import { ${c} } from './components/${c}';`)
    .join('\n');

  return (
    `${imports ? imports + '\n\n' : ''}export function ${name}() {\n` +
    `  return (\n${tree}\n  );\n}\n`
  );
}
