// Offline test of the Figma adapter: mock the REST API with a fake `fetch`, then
// run the FULL chain — loadFrame → figmaToIR → generateHtml — and assert.
// No network / token needed. Run: node example/mcp-adapter-test.js

import { PNG } from 'pngjs';
import { FigmaRestSource, loadFrame, parseFigmaUrl } from '../src/mcp/index.js';
import { figmaToIR, validateNode } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';
import { raw } from './fixture.js';

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) failures++;
};

// --- A tiny fake Figma REST API --------------------------------------------
const FILE_KEY = 'ABC123';
const NODE_ID = '1:1';
const RENDER_URL = 'https://figma-alpha-api.example/render.png';

function makePng() {
  const png = new PNG({ width: 4, height: 4 });
  png.data.fill(200);
  return PNG.sync.write(png);
}

const responses = {
  [`/v1/files/${FILE_KEY}/nodes?ids=1%3A1&geometry=paths`]: {
    nodes: {
      '1:1': {
        document: raw,
        components: { 'C:badge': { key: 'abcd', name: 'Badge' } },
      },
    },
  },
  [`/v1/files/${FILE_KEY}/variables/local`]: {
    meta: {
      variables: {
        'VariableID:card/bg': { name: 'color/surface/card' },
        'VariableID:space/2': { name: 'space/2' },
      },
    },
  },
  [`/v1/images/${FILE_KEY}?ids=1%3A1&format=png&scale=2`]: {
    images: { '1:1': RENDER_URL },
  },
};

const requestedPaths = [];
const fakeFetch = async (url) => {
  requestedPaths.push(String(url).replace('https://api.figma.com', ''));
  // Image binary download.
  if (url === RENDER_URL) {
    const buf = makePng();
    return { ok: true, status: 200, arrayBuffer: async () => buf };
  }
  // JSON API calls — match by path+query.
  const path = url.replace('https://api.figma.com', '');
  const body = responses[path];
  if (!body) return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) };
  return { ok: true, status: 200, json: async () => body };
};

// --- Run the chain ----------------------------------------------------------
async function main() {
  console.log('parseFigmaUrl:');
  const parsed = parseFigmaUrl(`https://www.figma.com/design/${FILE_KEY}/My-File?node-id=1-1&t=x`);
  assert(parsed.fileKey === FILE_KEY, `fileKey parsed → ${parsed.fileKey}`);
  assert(parsed.nodeId === '1:1', `node-id "1-1" → "1:1" → ${parsed.nodeId}`);

  console.log('\nloadFrame (via mocked REST):');
  // lockoutFile: null keeps the suite off the repo's real lockout record — it
  // must neither read a stale one nor leave one behind.
  const source = new FigmaRestSource({
    token: 'faketoken',
    fileKey: FILE_KEY,
    fetch: fakeFetch,
    lockoutFile: null,
  });
  const frame = await loadFrame(source, NODE_ID);

  assert(frame.raw?.name === 'PricingCard', 'raw node tree fetched');
  assert(
    requestedPaths.some((p) => p.includes('/nodes?') && p.includes('geometry=paths')),
    'the node request asks for geometry=paths (without it Figma omits size + relativeTransform)'
  );
  assert(frame.variableMap['VariableID:card/bg'] === 'color/surface/card', 'variableMap: card/bg → token name');
  assert(frame.variableMap['VariableID:space/2'] === 'space/2', 'variableMap: space/2 → token name');
  assert(frame.componentMap['C:badge']?.name === 'Badge', 'componentMap: C:badge → Badge');
  assert(Buffer.isBuffer(frame.referencePng) && frame.referencePng.length > 0, 'referencePng is a PNG buffer');

  console.log('\nfigmaToIR + generateHtml (adapter output → code):');
  const ir = figmaToIR(frame.raw, { variableMap: frame.variableMap, componentMap: frame.componentMap });
  assert(validateNode(ir).length === 0, 'IR from adapter output is valid');

  const html = generateHtml(ir);
  assert(html.includes('var(--color-surface-card, #ffffff)'), 'token binding survived into CSS');
  assert(html.includes('data-component="Badge"'), 'bound component survived into HTML');

  // --- Rate-limit backoff ----------------------------------------------------
  // Regression: Figma rate-limits by COST, not per-minute. An exhausted token
  // returns Retry-After in the tens of hours (142666s ≈ 40h observed live). The
  // old code did `retryAfter * 1000` uncapped → a 40-hour setTimeout → the whole
  // process hangs silently with no error. Never again.
  console.log('\nrate-limit backoff:');
  const rl = (retryAfter) => async () => ({
    ok: false,
    status: 429,
    statusText: 'Too Many Requests',
    headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? String(retryAfter) : null) },
    json: async () => ({ status: 429, err: 'Rate limit exceeded' }),
  });

  // lockoutFile: null — otherwise this test leaves a 40-hour /nodes lockout in
  // the repo and every later run (tests and the real server) skips /nodes.
  const hugeSrc = new FigmaRestSource({
    token: 't',
    fileKey: FILE_KEY,
    fetch: rl(142666),
    lockoutFile: null,
    cooldownQuietMs: 5,
    recoveryTimeoutMs: 50,
  });
  const t0 = Date.now();
  let caught = null;
  try {
    await hugeSrc.getNode(NODE_ID);
  } catch (e) {
    caught = e;
  }
  const elapsed = Date.now() - t0;
  assert(caught?.name === 'RateLimitError', 'a 40-hour Retry-After throws RateLimitError');
  assert(elapsed < 1000, `fails fast instead of sleeping (took ${elapsed}ms, not 40h)`);
  assert(caught?.retryAfterSec === 142666, 'error carries retryAfterSec');
  assert(caught?.resetAt instanceof Date, 'error carries a resetAt timestamp');
  assert(/39\.6 hours/.test(caught?.message || ''), 'message states the wait in human terms');

  // A short Retry-After is still honored — we only refuse the absurd ones.
  let attempts = 0;
  const shortSrc = new FigmaRestSource({
    token: 't',
    fileKey: FILE_KEY,
    maxRetryWaitMs: 50,
    lockoutFile: null,
    fetch: async (url) => {
      if (attempts++ === 0) return rl(0.01)();
      return fakeFetch(url);
    },
  });
  const recovered = await shortSrc.getNode(NODE_ID);
  assert(recovered?.name === 'PricingCard', 'a short Retry-After is honored and the retry succeeds');
  assert(attempts === 2, `retried exactly once (${attempts} attempts)`);

  // --- Rotation and mirroring ------------------------------------------------
  // Figma reports a rotated node's AABB, which is bigger than the node and says
  // nothing about the angle; `size` + `relativeTransform` are the real geometry.
  // A mirror is the case an angle alone cannot express — the matrix determinant
  // goes negative and atan2 keeps reporting a plausible-looking angle, so a flip
  // dropped here renders the artwork pointing somewhere it never was.
  console.log('\ntransforms (rotation + mirror):');
  const cos = Math.cos, sin = Math.sin;
  const T = (deg, mirror, x, y, w, h, bw, bh) => {
    const r = (deg * Math.PI) / 180;
    // [[a, b, tx], [c, d, ty]] — a mirror negates the second column.
    const m = mirror
      ? [[cos(r), sin(r), x], [sin(r), -cos(r), y]]
      : [[cos(r), -sin(r), x], [sin(r), cos(r), y]];
    return {
      id: `n:${deg}${mirror ? 'm' : ''}`,
      name: `prop-${deg}${mirror ? '-mirrored' : ''}`,
      type: 'RECTANGLE',
      absoluteBoundingBox: { x, y, width: bw, height: bh },
      size: { x: w, y: h },
      relativeTransform: m,
      fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 1 }],
    };
  };
  const frameRaw = {
    id: '0:1',
    name: 'Frame',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 1014 },
    size: { x: 1440, y: 1014 },
    relativeTransform: [[1, 0, 0], [0, 1, 0]],
    children: [
      // A 547.5x542 node turned -57.7deg sweeps out a 750.7x752.3 box.
      T(-57.7, false, -211.1, 520.2, 547.5, 542, 750.7, 752.3),
      // Same shape, mirrored: only the determinant tells you.
      T(-155.92, true, 868, 89, 647.6, 472.4, 784, 695.5),
    ],
  };
  const tIr = figmaToIR(frameRaw);
  const [rot, mir] = tIr.children;
  assert(
    Math.round(rot.box.width) === 548 && Math.round(rot.box.height) === 542,
    `rotated node keeps its own size, not the bounding box (${Math.round(rot.box.width)}x${Math.round(rot.box.height)}, not 751x752)`
  );
  assert(
    Math.abs(rot.box.x - -109.5) < 0.1 && Math.abs(rot.box.y - 625.35) < 0.1,
    `rotated node stays concentric with its bounding box (${rot.box.x},${rot.box.y})`
  );
  assert(Math.abs(rot.style.rotation + 57.7) < 0.01, `rotation recovered → ${rot.style.rotation}deg`);
  assert(!rot.style.mirrored, 'an unmirrored node is not marked mirrored');
  assert(mir.style.mirrored === true, 'a negative-determinant transform is marked mirrored');
  assert(
    Math.abs(mir.style.rotation + 155.92) < 0.01,
    `mirrored node still reports its angle → ${mir.style.rotation}deg`
  );
  const tHtml = generateHtml(tIr);
  assert(
    /transform:\s*rotate\(-57\.7\d*deg\)(?!\s*scaleY)/.test(tHtml),
    'unmirrored node emits rotate() alone'
  );
  assert(
    /transform:\s*rotate\(-155\.92\d*deg\)\s+scaleY\(-1\)/.test(tHtml),
    'mirrored node emits rotate() followed by scaleY(-1)'
  );

  // Without geometry=paths there is no matrix and no size; the angle survives
  // via `rotation` (radians) and the size is solved back out of the AABB.
  const noGeom = {
    ...frameRaw,
    // A paint of its own, so Stage 1 does not collapse this single-child frame
    // into its child and leave the assertions below reading the wrong node.
    fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }],
    children: [
      {
        ...T(-57.7, false, -211.1, 520.2, 547.5, 542, 750.7, 752.3),
        size: undefined,
        relativeTransform: undefined,
        rotation: (-57.7 * Math.PI) / 180,
      },
    ],
  };
  const fb = figmaToIR(noGeom).children[0];
  assert(
    Math.abs(fb.box.width - 547.5) < 1 && Math.abs(fb.box.height - 542) < 1,
    `size recovered from the bounding box when \`size\` is absent (${fb.box.width}x${fb.box.height})`
  );

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `${failures} FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
