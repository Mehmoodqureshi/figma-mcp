# Stages 1–3 — Node-Tree Normalizer & IR

The deterministic front half of the pipeline from [`FIGMA_TO_CODE_PLAN.md`](../../FIGMA_TO_CODE_PLAN.md):

```
raw Figma tree ──normalize (Stage 1)──▶ clean tree ──figmaToIR (Stages 2–3)──▶ IR tree ──▶ codegen (Stage 6)
```

No LLM here — it's all rule-based. This is what makes generation reliable: codegen reads the
**IR only**, never raw Figma JSON, and layout arrives as **flexbox**, not coordinates.

## Modules

| File | Role |
|---|---|
| `schema.js` | IR shape (`IRNode`), `createNode` factory, `validateNode`, `ROLES`/`LAYOUT` enums. |
| `normalize.js` | Stage 1 — drop invisible/zero-area nodes, collapse redundant wrappers, mark vector clusters. |
| `autolayout.js` | Stage 2 — Figma Auto Layout → flex (`computeContainerLayout`, `computeChildLayout`). |
| `style.js` | Paints/effects/text → CSS-ready values (colors, border, radius, shadow, TextStyle). |
| `fromFigma.js` | Stage 3 — orchestrates normalize + autolayout + style into the IR (`figmaToIR`). |
| `index.js` | Public exports. |

## Usage

```js
import { figmaToIR, validateNode } from './src/ir/index.js';

const ir = figmaToIR(rawFigmaNode, {
  variableMap,   // { 'VariableID:...': 'color/brand/primary' }  ← get_variable_defs
  componentMap,  // { '<componentId>': { name: 'Button', props } } ← get_code_connect_map
});

const problems = validateNode(ir);  // [] === valid
```

Run the demo: `node example/ir-example.js` — converts a realistic fixture and prints the IR tree.

## What each stage guarantees

- **Normalize:** invisible nodes gone, single-child no-style wrappers collapsed (bounding box
  preserved so absolute positioning stays correct), vector clusters flagged for single-SVG export.
- **Auto Layout → flex:** `HORIZONTAL/VERTICAL` → `row/column`; `itemSpacing` → `gap`; padding →
  `padding`; `primaryAxisAlignItems` → `justify`; `counterAxisAlignItems` → `align`; per-child
  `layoutGrow` → `grow`, `layoutAlign` → `alignSelf`, `layoutPositioning:ABSOLUTE` → escapes flow.
- **IR:** every node has a `role` (container/text/image/vector/shape/component), a **relative**
  box, resolved `style`, `text`, `tokens` (from `boundVariables`), and `component` (bound
  instances). Components and vector clusters are black boxes — the tree stops descending into them.

## Fallback behavior (by design)

- An **unbound instance** (not in `componentMap`) degrades to a normal container, not an error.
- An **unresolved token** (not in `variableMap`) keeps its raw `VariableID:` so nothing is lost.
- **Gradient/image fills** are marked (`var(--gradient-todo)` / `asset:image`) rather than guessed.

## Next: element-bbox verification

Every IR node carries its box. Feed those boxes into the Stage 7 verify loop to upgrade its
region-grid diff into true **per-element IoU matching** ("the CTA button is missing / 12px too low")
instead of per-grid-cell. That closes the loop between these stages and the accuracy engine.
