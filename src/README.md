# Stage 7 — Verify Loop

The accuracy engine from [`FIGMA_TO_CODE_PLAN.md`](../FIGMA_TO_CODE_PLAN.md). It closes the loop:

```
generated code ──render──▶ screenshot ──diff──▶ correction prompt ──▶ your LLM ──▶ better code ──▶ (repeat)
```

Without this, the model generates blind and output stalls at "90% there." With it, the model
gets ground truth every pass and converges toward the design.

## Modules

| File | Role |
|---|---|
| `render.js` | Playwright: render an HTML string (`renderHtml`) or a dev-server URL (`renderUrl`) → PNG buffer. |
| `diff.js` | `diffImages(actual, reference)` → global diff ratio + per-region grid breakdown + visual diff PNG. |
| `correction.js` | `buildCorrectionPrompt(diff)` → targeted, human-readable fix instructions for the model. |
| `verifyLoop.js` | Orchestrates render → diff → refine until `diffRatio ≤ threshold` or `maxIterations`. |
| `index.js` | Public exports. |

## Install

```bash
npm install          # installs Playwright + downloads Chromium (via postinstall)
npm run example      # runnable demo, no API key needed — watch the diff ratio fall
```

## Wiring it to your pipeline

The loop is framework-agnostic. You provide two things:

1. **`referencePng`** — the Figma reference screenshot (from the MCP `get_screenshot`).
2. **`generate({ code, correction, iteration })`** — a callback that calls **your** LLM and
   returns improved code. This is the only place an API is involved.

```js
import { verifyLoop } from './src/index.js';
import fs from 'node:fs';

const result = await verifyLoop({
  initialCode: firstPassHtml,                 // from Stage 6
  referencePng: fs.readFileSync('frame.png'), // from Figma MCP
  viewport: { width: 1440, height: 900, deviceScaleFactor: 2 },
  threshold: 0.02,                            // ≤2% pixels differ = "exact enough"
  maxIterations: 5,
  generate: async ({ code, correction }) => callYourModel({ code, correction }),
});

console.log(result.converged, result.diffRatio);
fs.writeFileSync('out.html', result.code);
fs.writeFileSync('diff.png', result.bestDiffPng); // inspect remaining mismatches
```

### Rendering a React/dev-server component instead of an HTML string

Pass a custom `render`:

```js
import { renderUrl } from './src/index.js';

await verifyLoop({
  // ...
  render: () => renderUrl('http://localhost:3000/preview', { width: 1440, height: 900 }),
  generate: async ({ correction }) => {
    // write the new component to disk / hot-reload, then return its source
  },
});
```

## Tuning

- **`threshold`** — start at `0.02`. Lower = stricter (more iterations). Anti-aliasing and font
  hinting put a natural floor around `0.005–0.015`; don't chase 0.
- **`diff` per-pixel `threshold`** (in `diffImages`) — raise toward `0.2` to ignore minor
  color/AA noise; lower to catch subtle color-token errors.
- **`grid`** — region resolution for localization. `6` (36 cells) is a good default; raise for
  large pages so corrections point to smaller areas.
- **`maxIterations`** — 3–5 is usually enough; the biggest gains are in the first two passes.

## Notes / next steps

- The per-region grid is a lightweight stand-in for true **element bounding-box (IoU) matching**.
  When you extract element boxes from the Figma node tree (Stage 1–3), feed them here to report
  mismatches per *element* ("the CTA button is missing") instead of per *grid cell*.
- The loop keeps the **best** iteration seen — a later regression never makes the result worse.
