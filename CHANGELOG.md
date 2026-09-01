## 0.1.0 - 2026-09-01

First release.

- feat: three MCP tools over stdio — `figma_convert` (frame → self-contained HTML
  + IR + assets, deterministic, no LLM), `figma_verify` (render in Chromium,
  pixel-diff against the Figma reference, IoU-check every element box, return
  targeted fix instructions), and `figma_inspect` (IR as a filterable outline).
  Tools return file paths and numbers rather than blobs — a converted frame is
  often 100+ KB of HTML, and pushing that through a tool result would burn the
  agent's context for nothing.
- feat: the refine loop runs through the CALLING agent, not an LLM inside the
  server. No `ANTHROPIC_API_KEY`, no second model billing, and the agent keeps
  full context on what it already tried. `src/refine/` still offers a headless
  loop for library use.
- feat: Figma responses are cached per frame, so everything after the first
  `figma_convert` runs offline — including while rate-limited, where a stale
  frame still beats no frame.
- fix: the cache and `.figma-token` are now anchored to the directory the server
  is started from, not to the package root, with `FIGMA_MCP_CACHE_DIR` to
  override. Installed via `npx` the package root is a throwaway directory inside
  `node_modules`: a 100 MB frame cache written there is silently lost on the next
  install, and a `.figma-token` there could never be found at all.
- fix: `verifyLoop`'s `onIteration` event now carries `renderPng`. It previously
  exposed only the diff, and a diff of a blank page is indistinguishable from a
  converged one — which is exactly how `example/run-example.js` came to write its
  diff images out under `render-N.png`, making a converged run look like it had
  rendered nothing. Both are now written under their real names.
- chore: `postinstall` no longer fails the install when the Chromium download
  fails or is skipped. `figma_convert` and `figma_inspect` need no browser at
  all, so a CI install or a `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` install is a
  perfectly reasonable thing to want.
