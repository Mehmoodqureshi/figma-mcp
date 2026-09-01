# Stage 6 — Codegen (IR → code)

The missing middle that connects the two halves of the pipeline:

```
Figma MCP → [Stage 1–4: figmaToIR] → IR → [Stage 6: codegen] → code → [Stage 7: verify loop] → exact
```

Deterministic, no LLM. Because the IR already resolved layout (flex, not coordinates), styles, and
tokens, codegen is a straight serialization. Its output is the **`initialCode`** the Stage 7 verify
loop refines toward pixel-exact.

## Modules

| File | Role |
|---|---|
| `cssgen.js` | IR node → CSS declarations (shared by both emitters). Token fallbacks, reset. |
| `html.js` | `generateHtml(ir)` → self-contained HTML doc. **Primary** — renders directly in the verify loop. |
| `react.js` | `generateReact(ir)` → React component (inline styles). Bound instances become real JSX. |
| `index.js` | Public exports. |

## Usage

```js
import { figmaToIR } from './src/ir/index.js';
import { generateHtml } from './src/codegen/index.js';

const ir = figmaToIR(rawFigmaNode, { variableMap, componentMap });
const html = generateHtml(ir, { title: 'PricingCard' }); // → hand to verifyLoop as initialCode
```

Run the demo: `node example/codegen-example.js` — raw Figma → IR → HTML + React → rendered PNG.

## Design decisions

- **Structure first, then style** (per UICopilot / the plan): semantic tags from role
  (text→`h1..h3`/`p`, container→`div`, image→`img`, vector→`svg`, bound instance→component), then a
  scoped stylesheet.
- **Exact-first sizing:** explicit `width`/`height` from the IR box so the first render is close to
  exact — which is what the verify loop needs to start from. `flex-grow` children use `flex:1`
  instead of a fixed main-size. **Stage 8 (responsiveness pass) relaxes fixed sizes afterward.**
- **Token fallbacks:** tokens emit as `var(--token, <exact-figma-value>)`. Correct before your token
  file exists (uses the exact value), correct after (the token wins). Referenced tokens are listed
  in a comment for discoverability.
- **Bound components are real:** `generateReact` emits `<Badge variant="new" />` and imports it —
  Code Connect instances become your components, not lookalike divs.

## Where the LLM fits (optional)

This deterministic pass is a strong baseline on its own. You can also use it as the `initialCode`
and let the verify loop's `generate` callback (your LLM) improve semantics/edge cases each round —
best of both: deterministic reliability + model polish, all checked against the render.
