// Demo of Stages 1–3: raw Figma node tree → normalized → IR.
// No network/API needed. Run: node example/ir-example.js

import { figmaToIR, validateNode, ROLES } from '../src/ir/index.js';
import { raw, variableMap, componentMap } from './fixture.js';

const ir = figmaToIR(raw, { variableMap, componentMap });

const problems = validateNode(ir);
console.log('IR valid:', problems.length === 0, problems.length ? problems : '');

// Compact structural summary so the output is readable.
function summarize(node, depth = 0) {
  const pad = '  '.repeat(depth);
  const L = node.layout;
  const layoutStr =
    L.mode === 'flex'
      ? `flex/${L.direction} gap:${L.gap} pad:[${L.padding.top},${L.padding.right},${L.padding.bottom},${L.padding.left}] justify:${L.justify} align:${L.align}`
      : L.mode;
  const extras = [];
  if (node.role === ROLES.TEXT) extras.push(`"${node.text.content}" ${node.text.fontSize}px/${node.text.fontWeight}`);
  if (node.role === ROLES.COMPONENT) extras.push(`<${node.component.name} ${JSON.stringify(node.component.props)}>`);
  if (node.asset) extras.push(`asset:${node.asset.type}`);
  if (Object.keys(node.tokens).length) extras.push(`tokens:${JSON.stringify(node.tokens)}`);
  if (L.grow) extras.push('grow:1');
  console.log(
    `${pad}${node.name} [${node.role}] box:${node.box.width}x${node.box.height}@(${node.box.x},${node.box.y}) ${layoutStr} ${extras.join(' ')}`
  );
  node.children.forEach((c) => summarize(c, depth + 1));
}

console.log('\n=== IR TREE ===');
summarize(ir);
