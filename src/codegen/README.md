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
| `react.js` | `generateReact(ir, { assets })` → React component (inline styles). Bound instances become real JSX, and `generateComponentModules(ir)` emits the `./components/*` shells it imports. |
| `next.js` | `generateNext(ir, { assets })` → `{ files }`, a runnable Next.js App Router project. |
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
- **Auto Layout, including Grid.** `layoutMode` HORIZONTAL/VERTICAL become flexbox; `GRID` becomes
  CSS Grid, using Figma's own `gridColumnsSizing`/`gridRowsSizing` (already CSS track syntax, but
  validated before it reaches the stylesheet) and the children's 0-based row/column anchors. An
  unrecognised future `layoutMode` falls back to coordinate placement rather than being labelled a
  column — mislabelling a grid as a column is what stacks a row of cards on top of each other.

- **Two responsive strategies, picked from the design.** `responsive: true` on an Auto Layout root
  relaxes FILL→`flex`/`100%`, HUG→`fit-content`, FIXED→px with a fluid `max-width` root. A root with
  **no** Auto Layout has no sizing intent to relax — every child is `position:absolute` at a canvas
  coordinate — so relaxing the root to `width:100%` would leave those children pinned outside the
  narrower box and silently clipped by `overflow:hidden`. That tree keeps its exact CSS and gets a
  scaling shell (`canvasFitCss` / `canvasFitScript`) that maps the whole canvas to the viewport,
  down to a 0.5x floor and then horizontal scroll. Without JS it degrades to the unscaled canvas.
- **Token fallbacks:** tokens emit as `var(--token, <exact-figma-value>)`. Correct before your token
  file exists (uses the exact value), correct after (the token wins). Referenced tokens are listed
  in a comment for discoverability.
- **Bound components are real:** `generateReact` emits `<Badge variant="new" />` and imports it —
  Code Connect instances become your components, not lookalike divs. The import only resolves if the
  module exists, so `generateComponentModules(ir)` writes one passthrough shell per binding, and the
  instance's own content is passed to it as children. Emitting the import without the module is the
  difference between a project that runs and one that dies on `npm run dev`. Putting the content in
  the module instead of at the call site compiles too, and is just as wrong: a binding is
  instantiated many times per frame with different copy, so on a real page it rendered every nav
  link with the first one's label and lost 53 of 69 strings.
- **Every emitter takes the same `assets` map.** `generateReact` and `generateNext` inline the same
  data URIs the HTML emitter does, resolve cropped fills to a background layer on a `role="img"` div,
  and fall back to the same transparent placeholder when an export is missing. Without that the React
  tree renders structurally correct and completely blank, which is the hardest kind of wrong to spot.
- **`generateNext` is an arrangement, not a third emitter.** The component file it writes is
  byte-for-byte `generateReact`'s output; the rest is App Router scaffolding. A canvas-fit design
  scales itself with `useState`/`useEffect`, so that variant — and only that variant — is marked
  `'use client'`.

## Where the LLM fits (optional)

This deterministic pass is a strong baseline on its own. You can also use it as the `initialCode`
and let the verify loop's `generate` callback (your LLM) improve semantics/edge cases each round —
best of both: deterministic reliability + model polish, all checked against the render.
