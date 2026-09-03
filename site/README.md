# site/

A local web front end for the same pipeline the MCP server exposes to an agent,
split in two: a chat on the left, the generated app on the right.

```bash
npm run site          # http://localhost:5173
npm run site:open     # the same, and open a browser (macOS)
PORT=8080 npm run site
```

It needs the same Figma token the MCP server does: `.figma-token` at the repo
root, or `FIGMA_TOKEN` in the environment. The page tells you if it cannot find
one.

## The flow

You send a Figma frame link. The chat then asks what to build, one question at a
time, and only runs the pipeline once it has the answers:

| Question | Answers | Drives codegen |
|---|---|---|
| What should I generate? | HTML · React · Next.js | yes |
| JavaScript or TypeScript? | JS · TS | **not yet** |
| How should the styles be written? | Inline · CSS Modules · Tailwind | **not yet** |
| Exact pixel sizes, or responsive? | Exact · Responsive | yes |

Answers are clickable or typeable — each question carries a `match()` that reads
free text, so "responsive please" lands the same as the button. Questions that do
not apply to the answers already given are skipped rather than shown disabled:
choose HTML and you are never asked about TypeScript.

**Two of those answers are recorded but do not change the output yet.** The
emitters write JavaScript with inline style objects, full stop. The chat says so
in the build summary rather than handing you `.jsx` after you asked for
TypeScript — an interview that pretends to act on every answer is worse than no
interview. Wiring them up is `generateReact`/`generateNext` work, not site work.

The right pane then shows the running app, its source files, the verify numbers,
and the reference / render / diff images.

## What it is for

The MCP server is driven by an agent, which makes the loop hard to watch. This is
the same loop with a person in the agent's seat: useful for checking a frame
converts cleanly before pointing an agent at it, and for showing someone what
"verified against the design" means rather than describing it.

It is a local tool, not a deployed service. It binds to localhost, runs Chromium,
and writes to your `.figma-cache/`.

## Layout

| File | What it does |
|---|---|
| `server.js` | HTTP routing, the SSE progress stream, static files, artifact streaming. |
| `pipeline.js` | Orchestrates `src/` — convert, render, diff — and reports each step. |
| `images.js` | Box-filtered downscale cache so 30 MB reference renders are viewable. |
| `public/` | The page: `index.html`, `styles.css`, `app.js`. No build step, no dependencies. |

`pipeline.js` reimplements nothing. Every measurement on the page comes from
`figmaToIR`, `generateHtml`, `generateReact`, `generateNext`,
`renderHtmlWithBoxes`, `diffImages`, `computeElementDiffs` and
`computePaintDiffs`, exactly as `src/mcp/server.js` calls them. The two entry
points agree because they run the same code.

## Three constraints that shaped it

**Artifacts never travel through the API.** A converted frame is routinely 20+ MB
of inlined data URIs and a reference render can be 30 MB. The progress stream
carries numbers and a frame id; everything heavy is written to the cache dir and
streamed back by URL.

**The preview is the real artifact.** The Preview tab is an iframe of the actual
`generated.html` at its true design width, uniformly scaled to fit the pane — not
a screenshot. The exact-sizing variant is laid out for one specific width, so
letting the iframe reflow at pane width would show a broken page the artifact
does not actually have. It is also the file the pixel diff measured, which is why
it stays the preview for the React and Next.js options: every emitter derives its
styles from the same IR.

**Code is served as a head slice.** A component with its assets inlined is tens of
megabytes, nearly all of it data URIs. The Code tab reads the first 256 KB and
says what it truncated, with a download for the whole file.

## Endpoints

| Route | Purpose |
|---|---|
| `POST /api/run` | Convert and verify. Body takes `url`, `framework`, `responsive`, `refresh`. Server-sent events: `step`, then `done` or `error`. |
| `GET /api/config` | Token status, cache root, and the frames already cached here. |
| `GET /f/<id>/preview` | `generated.html` (`?variant=responsive` for the other one). |
| `GET /f/<id>/code?path=` | Source text of one generated file, truncated with `size` and `truncated` reported. |
| `GET /f/<id>/img/<reference\|render\|diff>` | Downscaled PNG (`?w=` to size, `?full=1` for the original). |
| `GET /f/<id>/download?path=` | Any generated file as a download. |

`<id>` is a directory name under `.figma-cache/` and `path` is a relative file
inside it. Both arrive from the client, so both are pattern-checked and then
re-resolved against the cache root before they reach the filesystem.

## Stopping a run

The stop button aborts the request, and the pipeline notices at the next step
boundary. A Figma fetch or a Chromium render already in flight runs to
completion — neither is interruptible — so stopping during those takes effect
once they return.
