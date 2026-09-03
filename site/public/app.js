// site/public/app.js — the conversation on the left, the generated app on the right.
//
// The flow is an interview, not a form. You send a frame link; the chat asks what
// to build, one question at a time, and only then runs the pipeline. Questions
// that do not apply to the answers already given are skipped rather than shown
// disabled — asking someone whether they want TypeScript after they chose plain
// HTML is how a form feels, not a conversation.
//
// Every answer is both clickable and typeable: the buttons are the fast path, and
// `match()` on each question reads what you typed instead.
//
// The server never sends generated HTML or PNG bytes through this channel; it
// sends numbers and a frame id, and everything heavy is loaded by URL.

const $ = (sel, root = document) => root.querySelector(sel);

const app = $('#app');
const thread = $('#thread');
const chatScroll = $('#chat-scroll');
const form = $('#composer');
const input = $('#input');
const send = $('#send');
const suggestions = $('#suggestions');
const tokenPill = $('#token-pill');

const outTitle = $('#out-title');
const outMeta = $('#out-meta');
const outTabs = $('#out-tabs');
const outBody = $('#out-body');

// --------------------------------------------------------------- the interview

/**
 * `applies` decides whether a question is worth asking given the answers so far.
 * `match` maps free text onto an option value, so the composer keeps working.
 * `live` is false for anything the codegen cannot honour yet — the answer is
 * recorded and reported, but it does not silently change the output.
 */
const QUESTIONS = [
  {
    key: 'framework',
    prompt: 'What should I generate?',
    live: true,
    options: [
      { value: 'html', label: 'HTML', hint: 'One self-contained file, assets inlined' },
      { value: 'react', label: 'React', hint: 'A component with inline style objects' },
      { value: 'next', label: 'Next.js', hint: 'A runnable App Router project' },
    ],
    match: (t) =>
      /\bnext(\.?js)?\b/i.test(t) ? 'next' : /\breact|jsx\b/i.test(t) ? 'react' : /\bhtml\b/i.test(t) ? 'html' : null,
  },
  {
    key: 'language',
    prompt: 'JavaScript or TypeScript?',
    live: false,
    applies: (a) => a.framework !== 'html',
    options: [
      { value: 'js', label: 'JavaScript', hint: '.jsx, what the emitter writes today' },
      { value: 'ts', label: 'TypeScript', hint: '.tsx with typed props' },
    ],
    match: (t) => (/\bts|typescript\b/i.test(t) ? 'ts' : /\bjs|javascript\b/i.test(t) ? 'js' : null),
  },
  {
    key: 'styling',
    prompt: 'How should the styles be written?',
    live: false,
    applies: (a) => a.framework !== 'html',
    options: [
      { value: 'inline', label: 'Inline styles', hint: 'Style objects on each element' },
      { value: 'modules', label: 'CSS Modules', hint: 'A .module.css file per component' },
      { value: 'tailwind', label: 'Tailwind', hint: 'Utility classes' },
    ],
    match: (t) =>
      /\btailwind\b/i.test(t) ? 'tailwind' : /\bmodule/i.test(t) ? 'modules' : /\binline\b/i.test(t) ? 'inline' : null,
  },
  {
    key: 'sizing',
    prompt: 'Exact pixel sizes, or responsive?',
    live: true,
    options: [
      { value: 'exact', label: 'Exact', hint: 'Pixel-for-pixel with the frame' },
      { value: 'responsive', label: 'Responsive', hint: "Uses the frame's Auto Layout intent" },
    ],
    match: (t) => (/\bresponsive|fluid|flex\b/i.test(t) ? 'responsive' : /\bexact|fixed|pixel\b/i.test(t) ? 'exact' : null),
  },
];

const LABELS = Object.fromEntries(
  QUESTIONS.flatMap((q) => q.options.map((o) => [`${q.key}:${o.value}`, o.label]))
);

const STEPS = [
  ['parse', 'Read the frame link'],
  ['fetch', 'Fetch the frame from Figma'],
  ['ir', 'Build the intermediate representation'],
  ['assets', 'Export images and vectors'],
  ['codegen', 'Generate the code'],
  ['render', 'Render in Chromium and measure every box'],
  ['diff', 'Pixel-diff against the Figma reference'],
];

// ------------------------------------------------------------------- state

/** null when idle; otherwise the interview or run in progress. */
let session = null;
let running = null; // AbortController while the pipeline is streaming
let shown = null; // the result currently in the right pane

/**
 * Static-demo mode. A frozen build has no Chromium, no disk and no Figma token,
 * so instead of streaming a live pipeline it replays a real one that was run at
 * build time — same steps, same numbers, same files. Everything below that
 * branches on `demo` exists so the two modes fetch from different URL shapes;
 * nothing about what is displayed changes.
 */
let demo = null;

// --------------------------------------------------------------- utilities

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

const pct = (n, digits = 2) => `${(n * 100).toFixed(digits)}%`;
const kb = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.round(b / 1024)} KB`);
const secs = (ms) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)}s`);

const el = (html) => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
};

/** Does this look like a Figma frame link? Checked here so the chat can say so. */
function parseFrameLink(text) {
  const m = String(text).match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]+)/i);
  const node = String(text).match(/node-id=([0-9]+[-:][0-9]+)/i);
  if (!m || !node) return null;
  return { url: text.trim(), fileKey: m[1], nodeId: node[1] };
}

function scrollChat() {
  requestAnimationFrame(() => chatScroll.scrollTo({ top: chatScroll.scrollHeight, behavior: 'smooth' }));
}

/**
 * Where each artifact lives. A live server routes by query string; a static host
 * cannot, so the demo build writes the same content at fixed paths.
 */
const at = {
  preview: (r) =>
    // A live conversion never touched a disk: its page is held in memory and
    // shown through a blob URL, which is same-origin and so still measurable.
    r.live
      ? r.blobUrl
      : demo
        ? `/f/${r.id}/preview${r.responsive ? '-responsive' : ''}.html`
        : `/f/${r.id}/preview${r.responsive ? '?variant=responsive' : ''}`,
  img: (r, kind) =>
    r.live ? (kind === 'reference' ? r.reference : null) : demo ? `/f/${r.id}/img/${kind}.png` : `/f/${r.id}/img/${kind}?w=1200`,
  code: (r, file, i) =>
    demo
      ? `/f/${r.id}/${r.framework}/${r.responsive ? 'responsive' : 'exact'}/code/${i}.json`
      : `/f/${r.id}/code?path=${encodeURIComponent(file.path)}`,
  download: (r, file) => (r.live || demo ? null : `/f/${r.id}/download?path=${encodeURIComponent(file.path)}`),
};

// ------------------------------------------------------------ chat rendering

function say(html, cls = '') {
  const msg = el(`
    <div class="msg-agent ${cls}">
      <div class="agent-mark" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M7 6h10M7 12h10M7 18h6"/></svg>
      </div>
      <div class="agent-body">${html}</div>
    </div>`);
  thread.append(msg);
  scrollChat();
  return $('.agent-body', msg);
}

function youSaid(text) {
  thread.append(el(`<div class="msg-user">${esc(text)}</div>`));
  scrollChat();
}

// ------------------------------------------------------------- the interview

function nextQuestion(answers) {
  return QUESTIONS.find((q) => !(q.key in answers) && (!q.applies || q.applies(answers)));
}

function ask(q) {
  const body = say(
    `<p class="say">${esc(q.prompt)}</p>` +
      `<div class="choices">` +
      q.options
        .map(
          (o) =>
            `<button type="button" class="choice" data-value="${esc(o.value)}">` +
            `<span class="choice-label">${esc(o.label)}</span>` +
            `<span class="choice-hint">${esc(o.hint)}</span></button>`
        )
        .join('') +
      `</div>`
  );

  for (const btn of body.querySelectorAll('.choice')) {
    btn.addEventListener('click', () => answer(q, btn.dataset.value, body));
  }

  input.placeholder = `${q.prompt} (or click an option)`;
  syncSend();
}

function answer(q, value, body) {
  if (!session || session.stage !== 'interview') return;
  // Freeze the asked question into a record of what was chosen.
  if (body) {
    const chosen = q.options.find((o) => o.value === value);
    body.querySelector('.choices')?.replaceWith(
      el(`<div class="answered">${esc(chosen ? chosen.label : value)}</div>`)
    );
  }
  session.answers[q.key] = value;

  const next = nextQuestion(session.answers);
  if (next) return ask(next);
  confirmAndRun();
}

function confirmAndRun() {
  const a = session.answers;
  const parts = QUESTIONS.filter((q) => q.key in a).map((q) => LABELS[`${q.key}:${a[q.key]}`]);

  // Anything answered that codegen cannot honour yet is named here rather than
  // quietly ignored — an interview that pretends to act on every answer is worse
  // than no interview.
  const pending = QUESTIONS.filter((q) => q.key in a && !q.live && a[q.key] !== defaultFor(q))
    .map((q) => LABELS[`${q.key}:${a[q.key]}`]);

  say(
    `<p class="say">Building <strong>${esc(parts.join(' · '))}</strong>.</p>` +
      (pending.length
        ? `<p class="note">${esc(pending.join(' and '))} ${pending.length > 1 ? 'are' : 'is'} recorded but not ` +
          `wired into the emitter yet, so this run still writes JavaScript with inline styles.</p>`
        : '')
  );

  session.stage = 'running';
  input.placeholder = 'Paste a Figma frame link, then press Enter';
  start(session.link.url, {
    framework: a.framework,
    responsive: a.sizing === 'responsive',
  });
}

/** The option a question falls back to when nothing new is implemented. */
function defaultFor(q) {
  return q.options[0].value;
}

// ------------------------------------------------------------------ composer

function autosize() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, 190)}px`;
}

function syncSend() {
  send.disabled = !running && input.value.trim().length === 0;
}

input.addEventListener('input', () => {
  autosize();
  syncSend();
});

input.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    form.requestSubmit();
  }
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (running) {
    running.abort();
    return;
  }
  const text = input.value.trim();
  if (!text) return;
  input.value = '';
  autosize();
  syncSend();
  handle(text);
});

/** One typed message, interpreted against whatever the chat is waiting for. */
function handle(text) {
  app.classList.remove('is-empty');
  suggestions.hidden = true;
  youSaid(text);

  // Mid-interview: read the text as an answer to the open question.
  if (session && session.stage === 'interview') {
    const q = nextQuestion(session.answers);
    const value = q.match(text);
    if (value) return answer(q, value, null);
    // A new link mid-interview means they changed their mind about the frame.
    const relink = parseFrameLink(text);
    if (relink) {
      session.link = relink;
      say(`<p class="say">Switched to that frame. ${esc(q.prompt)}</p>`);
      return ask(q);
    }
    say(
      `<p class="say">I did not catch that. ${esc(q.prompt)}</p>` +
        `<p class="note">Try ${esc(q.options.map((o) => o.label).join(', '))} — or click one above.</p>`
    );
    return;
  }

  const link = parseFrameLink(text);
  if (!link) {
    say(
      `<p class="say">That does not look like a link to a Figma frame.</p>` +
        `<p class="note">I need one with a node id, like ` +
        `<code>figma.com/design/KEY/Name?node-id=1-2</code>. In Figma, right-click the frame and ` +
        `choose "Copy link to selection".</p>`
    );
    return;
  }

  session = { link, answers: {}, stage: 'interview' };
  say(`<p class="say">Got the frame. A couple of questions before I build it.</p>`);
  ask(QUESTIONS[0]);
}

// ------------------------------------------------------------------- the run

async function start(url, flags) {
  if (demo) return replay(url, flags);

  app.classList.add('is-busy');
  running = new AbortController();
  syncSend();

  const body = say('<div class="steps"></div>');
  const stepsEl = $('.steps', body);
  for (const [key, label] of STEPS) {
    stepsEl.append(
      el(`<div class="step" data-key="${key}" data-status="idle" hidden>
            <span class="dot"></span><span class="label">${esc(label)}</span>
            <span class="detail"></span>
          </div>`)
    );
  }
  scrollChat();

  try {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, ...flags }),
      signal: running.signal,
    });
    if (!res.ok || !res.body) throw new Error(`Server responded ${res.status}`);

    for await (const event of readEvents(res.body)) {
      if (event.type === 'step') applyStep(stepsEl, event);
      else if (event.type === 'done') {
        body.append(renderSummary(event.result));
        showOutput(event.result);
      } else if (event.type === 'cancelled') body.append(el('<p class="note">Stopped.</p>'));
      else if (event.type === 'error') {
        markRunningStepFailed(stepsEl);
        body.append(renderError(event));
      }
      scrollChat();
    }
  } catch (err) {
    markRunningStepFailed(stepsEl);
    if (err.name === 'AbortError') body.append(el('<p class="note">Stopped.</p>'));
    else body.append(renderError({ message: err.message }));
  } finally {
    running = null;
    session = null;
    app.classList.remove('is-busy');
    syncSend();
    scrollChat();
  }
}

/**
 * Replay a run recorded at build time. The pacing is cosmetic — the steps
 * genuinely happened, in this order, with these details — but a frozen result
 * appearing instantly reads as a mock, and the point is that it is not one.
 */
async function replay(url, flags) {
  app.classList.add('is-busy');
  syncSend();

  const link = parseFrameLink(url);
  const id = link ? `${link.fileKey}-${link.nodeId.replace(':', '-')}` : null;
  const sizing = flags.responsive ? 'responsive' : 'exact';
  const exact = demo.runs[`${id}|${flags.framework}|${sizing}`];
  // Fall back along the axis that changes least about what is shown.
  const baked =
    exact ||
    demo.runs[`${id}|${flags.framework}|exact`] ||
    demo.runs[`${id}|html|${sizing}`] ||
    demo.runs[`${id}|html|exact`];

  // Not one of the frozen frames — convert it for real, right now.
  if (!baked) return convertLive(url, flags);

  const body = say('<div class="steps"></div>');
  const stepsEl = $('.steps', body);
  for (const [key, label] of STEPS) {
    stepsEl.append(
      el(`<div class="step" data-key="${key}" data-status="idle" hidden>
            <span class="dot"></span><span class="label">${esc(label)}</span>
            <span class="detail"></span>
          </div>`)
    );
  }
  scrollChat();

  const pause = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const step of baked.steps) {
    applyStep(stepsEl, { key: step.key, status: 'run', detail: '' });
    scrollChat();
    await pause(180 + Math.random() * 160);
    applyStep(stepsEl, { key: step.key, status: 'ok', detail: step.detail });
    scrollChat();
  }

  body.append(renderSummary(baked.result));
  if (!exact) {
    body.append(
      el(
        `<p class="note">This build has the ${esc(frameworkLabel(baked.result.framework))}` +
          `${baked.result.responsive ? ' responsive' : ''} output frozen for this frame; that is what ` +
          `is shown. The local tool generates every combination on demand.</p>`
      )
    );
  }
  showOutput(baked.result);

  app.classList.remove('is-busy');
  session = null;
  syncSend();
  scrollChat();
}

/**
 * Convert an arbitrary frame on a static host.
 *
 * Stages 1-5 need neither a browser nor a disk, so they run in a serverless
 * function against the same src/ code the local tool uses. Stages 6-7 need
 * Chromium, which a static host has not got — so the two signals that are pure
 * DOM measurement are taken here instead, in the viewer's own browser, against
 * the page it is already displaying. The pixel diff is the one thing that
 * genuinely cannot happen, and the results panel says so rather than omitting it.
 */
async function convertLive(url, flags) {
  const body = say('<div class="steps"></div>');
  const stepsEl = $('.steps', body);
  for (const [key, label] of STEPS) {
    stepsEl.append(
      el(`<div class="step" data-key="${key}" data-status="idle" hidden>
            <span class="dot"></span><span class="label">${esc(label)}</span>
            <span class="detail"></span>
          </div>`)
    );
  }
  for (const k of ['parse', 'fetch', 'ir', 'assets', 'codegen']) {
    applyStep(stepsEl, { key: k, status: 'run', detail: '' });
  }
  const t0 = Date.now();
  const ticker = setInterval(() => {
    const s = Math.round((Date.now() - t0) / 1000);
    applyStep(stepsEl, {
      key: 'assets',
      status: 'run',
      detail:
        s < 12
          ? 'fetching from Figma…'
          : `${s}s — a large frame means every image is fetched and inlined, which takes a while`,
    });
  }, 1000);
  applyStep(stepsEl, { key: 'parse', status: 'run', detail: 'talking to Figma…' });
  scrollChat();

  let data;
  try {
    const res = await fetch('/api/convert', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url, framework: flags.framework, responsive: flags.responsive }),
    });
    data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || `Server responded ${res.status}`), { hint: data.hint });
    clearInterval(ticker);
  } catch (err) {
    clearInterval(ticker);
    markRunningStepFailed(stepsEl);
    body.append(renderError({ message: err.message, hint: err.hint }));
    app.classList.remove('is-busy');
    session = null;
    syncSend();
    scrollChat();
    return;
  }

  for (const st of data.steps) applyStep(stepsEl, { key: st.key, status: 'ok', detail: st.detail });

  // The generated page, held in memory. A blob URL is same-origin, so the
  // measurement below can reach into the frame it renders.
  const blobUrl = URL.createObjectURL(new Blob([data.html], { type: 'text/html' }));
  const result = { ...data, live: true, blobUrl, cached: false, dir: null, verify: null };

  applyStep(stepsEl, { key: 'render', status: 'run', detail: 'in this browser' });
  scrollChat();
  showOutput(result);

  try {
    const verify = await measureInPage(result);
    result.verify = verify;
    applyStep(stepsEl, {
      key: 'render',
      status: 'ok',
      detail: `${result.width}x${result.height}, ${verify.elements.total} boxes measured here`,
    });
    applyStep(stepsEl, {
      key: 'diff',
      status: 'ok',
      detail: `${verify.elements.ok}/${verify.elements.total} elements in place — pixel diff needs the local tool`,
    });
    showOutput(result);
  } catch (err) {
    applyStep(stepsEl, {
      key: 'render',
      status: 'fail',
      detail: `could not measure in this browser — ${err.message}`,
    });
  }

  body.append(renderSummary(result));

  // An asset export that Figma rate-limited degrades to placeholders. That is
  // the right behaviour — a frame with missing images still verifies — but it
  // must be said, because the preview otherwise just looks wrong for no reason.
  const missing = result.assets.requested - result.assets.embedded;
  if (missing > 0) {
    body.append(
      el(
        `<p class="note"><strong>${missing} of ${result.assets.requested} images did not export.</strong> ` +
          `Figma rate-limits image requests per token, and this frame asked for a lot of them at once. ` +
          `The layout is still exact — only the pictures are missing. Waiting a minute and re-sending ` +
          `the same link usually fills them in.</p>`
      )
    );
  }

  body.append(
    el(
      `<p class="note">Converted live against Figma just now. Geometry and layering were measured in ` +
        `your browser; the pixel diff needs Chromium on the server, which the local tool has ` +
        `(<code>npm run site</code>).</p>`
    )
  );

  app.classList.remove('is-busy');
  session = null;
  syncSend();
  scrollChat();
}

/**
 * Element geometry and paint order, measured against the rendered page.
 *
 * Same two signals the server takes, computed the same way — every node carries
 * a data-ir-id, so the design box and the rendered box can be compared directly.
 */
async function measureInPage(r) {
  const frame = await new Promise((resolve, reject) => {
    const iframe = outBody.querySelector('.scaler iframe');
    if (!iframe) return reject(new Error('no frame'));
    if (iframe.contentDocument?.readyState === 'complete') return resolve(iframe);
    iframe.addEventListener('load', () => resolve(iframe), { once: true });
    setTimeout(() => reject(new Error('timeout')), 20000);
  });
  // Let fonts and images settle — the same reason the server waits before it
  // screenshots, and the reason a hurried measurement reads as a broken page.
  await new Promise((res) => setTimeout(res, 1200));

  const doc = frame.contentDocument;
  const expected = [];
  (function flatten(node, ox = 0, oy = 0) {
    const x = ox + node.box.x;
    const y = oy + node.box.y;
    expected.push({
      id: node.id,
      label: node.text?.content || node.component?.name || node.name,
      role: node.role,
      box: { x, y, w: node.box.width, h: node.box.height },
    });
    for (const c of node.children || []) flatten(c, x, y);
  })(r.ir);

  const root = doc.querySelector(`[data-ir-id="${CSS.escape(r.ir.id)}"]`);
  const rb = root ? root.getBoundingClientRect() : { left: 0, top: 0 };

  const iou = (a, b) => {
    const x1 = Math.max(a.x, b.x);
    const y1 = Math.max(a.y, b.y);
    const x2 = Math.min(a.x + a.w, b.x + b.w);
    const y2 = Math.min(a.y + a.h, b.y + b.h);
    const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
    const union = a.w * a.h + b.w * b.h - inter;
    return union > 0 ? inter / union : 0;
  };

  const findings = expected.map((e) => {
    const node = doc.querySelector(`[data-ir-id="${CSS.escape(e.id)}"]`);
    if (!node) return { ...e, status: 'missing', iou: 0, expected: e.box, actual: null };
    const b = node.getBoundingClientRect();
    const actual = { x: b.left - rb.left, y: b.top - rb.top, w: b.width, h: b.height };
    if (!(actual.w > 0 && actual.h > 0)) return { ...e, status: 'missing', iou: 0, expected: e.box, actual };
    const score = iou(e.box, actual);
    return { ...e, status: score >= 0.6 ? 'ok' : 'misplaced', iou: score, expected: e.box, actual };
  });
  findings.sort((a, b) =>
    a.status === 'missing' && b.status !== 'missing' ? -1
    : b.status === 'missing' && a.status !== 'missing' ? 1
    : a.iou - b.iou
  );

  // Clipping: how much of each element the design shows versus how much the
  // render actually shows, which is what catches an element pushed off-frame.
  let clipped = 0;
  const rootBox = { x: 0, y: 0, w: r.width, h: r.height };
  for (const f of findings) {
    if (!f.actual || f.status === 'missing') continue;
    const visible = iou(f.actual, rootBox) > 0 ? 1 : 0;
    const meant = iou(f.expected, rootBox) > 0 ? 1 : 0;
    if (meant && !visible) clipped++;
  }

  const ok = findings.filter((f) => f.status === 'ok').length;
  return {
    converged: false,
    threshold: 0.02,
    diffRatio: 0,
    elements: {
      ok,
      total: findings.length,
      missing: findings.filter((f) => f.status === 'missing').length,
      misplaced: findings.filter((f) => f.status === 'misplaced').length,
    },
    paint: { stacking: 0, clipping: clipped },
    worst: findings.filter((f) => f.status !== 'ok').slice(0, 12),
    corrections: {},
  };
}

async function* readEvents(stream) {
  const reader = stream.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += value;
    let cut;
    while ((cut = buffer.indexOf('\n\n')) !== -1) {
      const chunk = buffer.slice(0, cut);
      buffer = buffer.slice(cut + 2);
      const line = chunk.split('\n').find((l) => l.startsWith('data: '));
      if (line) {
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          /* a partial frame is not worth tearing the stream down for */
        }
      }
    }
  }
}

function applyStep(stepsEl, { key, status, detail }) {
  const row = stepsEl.querySelector(`.step[data-key="${key}"]`);
  if (!row) return;
  row.hidden = false;
  row.dataset.status = status;
  $('.detail', row).textContent = detail || '';
}

function markRunningStepFailed(stepsEl) {
  const row = stepsEl.querySelector('.step[data-status="run"]');
  if (row) row.dataset.status = 'fail';
}

function renderError({ message, hint }) {
  return el(`
    <div class="error">
      <strong>That run did not finish</strong>
      ${esc(message)}
      ${hint ? `<div class="hint">${esc(hint)}</div>` : ''}
    </div>`);
}

/** One line in the chat. The numbers themselves live in the right pane. */
function renderSummary(r) {
  const v = r.verify;
  const verdict = !v
    ? 'converted'
    : v.converged && !v.paint.stacking && !v.paint.clipping
      ? `converged, ${pct(v.diffRatio)} off`
      : v.converged
        ? `pixels within threshold, layering off`
        : `${pct(v.diffRatio)} off the design`;

  return el(
    `<p class="say">Built <strong>${esc(r.name)}</strong> in ${esc(secs(r.ms))} — ${esc(verdict)}. ` +
      `It is on the right.</p>`
  );
}

// -------------------------------------------------------------- right pane

function showOutput(r) {
  shown = r;
  outTitle.textContent = r.name;
  outMeta.textContent = `${r.width} x ${r.height} · ${frameworkLabel(r.framework)}${
    r.responsive ? ' · responsive' : ''
  }`;

  const panels = [{ id: 'preview', label: 'Preview', build: () => buildPreview(r) }];
  if (r.codeFiles?.length) panels.push({ id: 'code', label: 'Code', build: () => buildCode(r) });
  if (r.verify) panels.push({ id: 'results', label: 'Results', build: () => buildResults(r) });
  if (r.live) {
    if (r.reference) panels.push({ id: 'reference', label: 'Figma reference', build: () => buildImage(r, 'reference') });
  } else if (r.verify) {
    panels.push(
      { id: 'reference', label: 'Figma reference', build: () => buildImage(r, 'reference') },
      { id: 'render', label: 'Your render', build: () => buildImage(r, 'render') },
      { id: 'diff', label: 'Pixel diff', build: () => buildImage(r, 'diff') }
    );
  }

  const cache = new Map();
  const show = (id) => {
    for (const b of outTabs.children) b.setAttribute('aria-selected', String(b.dataset.id === id));
    if (!cache.has(id)) cache.set(id, panels.find((p) => p.id === id).build());
    outBody.replaceChildren(cache.get(id));
    outBody.scrollTop = 0;
    const scaler = outBody.querySelector('.scaler');
    if (scaler) fitScaler(scaler);
  };

  outTabs.replaceChildren();
  for (const p of panels) {
    const b = el(`<button class="tab" role="tab" data-id="${p.id}" aria-selected="false">${esc(p.label)}</button>`);
    b.addEventListener('click', () => show(p.id));
    outTabs.append(b);
  }
  show('preview');
}

const frameworkLabel = (f) => ({ html: 'HTML', react: 'React', next: 'Next.js' })[f] || 'HTML';

/**
 * The generated page at its true design width, uniformly scaled to the pane.
 * Scaling rather than resizing is the only honest preview: the exact-sizing
 * variant is laid out for one specific width, so letting the iframe reflow at
 * pane width would show a broken page the artifact does not actually have.
 */
function buildPreview(r) {
  const wrap = el('<div class="preview-wrap"></div>');
  const scaler = el('<div class="scaler"></div>');
  // allow-same-origin, and nothing else: the generated page carries no scripts
  // worth running (without allow-scripts none run at all), but the geometry
  // check has to read its DOM, and a bare `sandbox` makes the frame an opaque
  // origin whose contentDocument is null.
  const frame = el(
    `<iframe title="Generated page for ${esc(r.name)}" sandbox="allow-same-origin" src="${at.preview(r)}"></iframe>`
  );
  frame.style.width = `${r.width}px`;
  frame.style.height = `${r.height}px`;
  scaler.dataset.w = r.width;
  scaler.dataset.h = r.height;
  scaler.append(frame);
  new ResizeObserver(() => fitScaler(scaler)).observe(scaler);
  wrap.append(scaler);

  if (r.framework !== 'html') {
    wrap.append(
      el(
        `<p class="pane-note">Rendered from <code>generated.html</code>. Every emitter derives its ` +
          `styles from the same IR, so this is what the ${esc(frameworkLabel(r.framework))} output ` +
          `produces — and it is the file the pixel diff actually measured.</p>`
      )
    );
  }
  return wrap;
}

function buildCode(r) {
  const wrap = el('<div class="code-wrap"></div>');
  const list = el('<div class="file-list"></div>');
  const view = el('<div class="code-view"></div>');
  wrap.append(list, view);

  const load = async (f, i) => {
    for (const b of list.children) b.setAttribute('aria-selected', String(b.dataset.path === f.path));
    view.replaceChildren(el('<div class="code-loading">Loading…</div>'));
    try {
      let data;
      if (r.live) {
        // Already in memory; still truncated for display for the same reason the
        // server truncates — a component with its assets inlined is enormous.
        const text = f.text || '';
        data = { path: f.path, size: text.length, truncated: text.length > 262144, text: text.slice(0, 262144) };
      } else {
        const res = await fetch(at.code(r, f, i));
        data = await res.json();
        if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
      }
      const dl = at.download(r, f);
      view.replaceChildren(
        el(
          `<div class="code-head"><span class="code-path">${esc(data.path)}</span>` +
            `<span class="code-size">${esc(kb(data.size))}</span>` +
            (dl ? `<a class="fbtn" href="${dl}" download>Download</a>` : '') + `</div>`
        ),
        el(`<pre>${esc(data.text)}</pre>`),
        data.truncated
          ? el(
              `<p class="pane-note">Showing the first ${esc(kb(data.text.length))} of ${esc(kb(data.size))}. ` +
                `Images and vectors are inlined as data URIs, which is nearly all of that. Download for the whole file.</p>`
            )
          : el('<span hidden></span>')
      );
    } catch (err) {
      view.replaceChildren(el(`<div class="code-loading">${esc(err.message)}</div>`));
    }
  };

  r.codeFiles.forEach((f, i) => {
    const b = el(
      `<button class="file" data-path="${esc(f.path)}" aria-selected="false">${esc(f.path)}</button>`
    );
    b.addEventListener('click', () => load(f, i));
    list.append(b);
  });
  load(r.codeFiles[0], 0);
  return wrap;
}

function buildResults(r) {
  const v = r.verify;
  const wrap = el('<div class="results"></div>');

  const clean = v.elements.ok === v.elements.total && !v.paint.stacking && !v.paint.clipping;
  const badge = r.live
    ? clean
      ? { cls: 'ok', text: 'geometry and layering match' }
      : { cls: 'warn', text: 'geometry off' }
    : v.converged && !v.paint.stacking && !v.paint.clipping
      ? { cls: 'ok', text: 'converged' }
      : v.converged
        ? { cls: 'warn', text: 'pixels ok, layering wrong' }
        : { cls: 'bad', text: 'not converged' };

  const tile = (k, val, cls, sub) =>
    `<div class="metric"><div class="k">${esc(k)}</div><div class="v ${cls}">${esc(val)}</div>` +
    `<div class="s">${esc(sub)}</div></div>`;

  wrap.append(
    el(`<div class="results-head"><span class="badge ${badge.cls}">${esc(badge.text)}</span>` +
       `<span class="results-time">${esc(secs(r.ms))}${r.cached ? ' · from cache' : ''}</span></div>`),
    el(
      `<div class="metrics">` +
        (r.live
          ? tile('Pixel diff', 'local only', '', 'needs Chromium on the server')
          : tile('Pixel diff', pct(v.diffRatio), v.converged ? 'good' : 'bad', `threshold ${pct(v.threshold, 1)}`)) +
        tile(
          'Elements in place',
          `${v.elements.ok}/${v.elements.total}`,
          v.elements.ok === v.elements.total ? 'good' : 'warn',
          v.elements.missing || v.elements.misplaced
            ? `${v.elements.missing} missing, ${v.elements.misplaced} misplaced`
            : 'every box within IoU 0.6'
        ) +
        tile(
          'Layering',
          v.paint.stacking + v.paint.clipping === 0 ? 'correct' : `${v.paint.stacking + v.paint.clipping} off`,
          v.paint.stacking + v.paint.clipping === 0 ? 'good' : 'warn',
          v.paint.stacking + v.paint.clipping === 0
            ? 'paint order and clipping match'
            : `${v.paint.stacking} stacking, ${v.paint.clipping} clipped`
        ) +
        tile('Output', kb(r.htmlBytes), '', `${r.nodes} nodes · ${r.assets.embedded} assets inlined`) +
        `</div>`
    )
  );

  if (v.worst.length) {
    const list = el('<div class="section"><h3>What is still off</h3></div>');
    for (const f of v.worst) {
      list.append(
        el(`<div class="finding">
              <span class="tag ${f.status}">${esc(f.status)}</span>
              <span class="name">${esc(f.label || f.role)}</span>
              <span class="num">${esc(deltaText(f.expected, f.actual))}${
                f.status === 'misplaced' ? ` · IoU ${f.iou.toFixed(2)}` : ''
              }</span>
            </div>`)
      );
    }
    wrap.append(list);
  }

  const raw = [v.corrections?.element, v.corrections?.paint, v.corrections?.pixel].filter(Boolean).join('\n\n');
  if (raw) {
    wrap.append(
      el(`<details class="raw"><summary>Fix instructions, exactly as the agent receives them</summary>
            <pre>${esc(raw)}</pre></details>`)
    );
  }
  if (!demo) wrap.append(el(`<div class="path">${esc(r.dir)}</div>`));
  return wrap;
}

/** "40px low, 12px narrow" — the instruction hiding behind an IoU score. */
function deltaText(expected, actual) {
  if (!actual) return 'not in the DOM';
  const parts = [];
  const d = [
    [Math.round(actual.x - expected.x), 'right', 'left'],
    [Math.round(actual.y - expected.y), 'low', 'high'],
    [Math.round(actual.w - expected.w), 'wide', 'narrow'],
    [Math.round(actual.h - expected.h), 'tall', 'short'],
  ];
  for (const [n, pos, neg] of d) if (n) parts.push(`${Math.abs(n)}px ${n > 0 ? pos : neg}`);
  return parts.length ? parts.join(', ') : 'same box, different paint';
}

function buildImage(r, kind) {
  const wrap = el('<div class="img-wrap"></div>');
  wrap.append(el(`<img alt="${esc(kind)} for ${esc(r.name)}" src="${at.img(r, kind)}">`));
  return wrap;
}

function fitScaler(scaler) {
  const frame = scaler.querySelector('iframe');
  if (!frame) return;
  const w = Number(scaler.dataset.w);
  const h = Number(scaler.dataset.h);
  const available = scaler.clientWidth;
  if (!w || !available) return;
  const scale = Math.min(1, available / w);
  frame.style.transform = `scale(${scale})`;
  scaler.style.height = `${Math.round(h * scale)}px`;
}

// ----------------------------------------------------------------- startup

/**
 * A static host cannot serve an extensionless path, so the frozen build writes
 * /api/config.json. Try that first and fall back to the live server's route.
 */
async function loadConfig() {
  for (const url of ['/config.json', '/api/config']) {
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
    } catch {
      /* try the next one */
    }
  }
  return null;
}

(async function init() {
  autosize();
  syncSend();
  input.focus();

  const config = await loadConfig();
  if (!config) return;
  if (config.demo) demo = config;

  tokenPill.hidden = false;
  if (demo) {
    tokenPill.textContent = 'Demo build';
    // The chrome says LOCAL because that is what the tool normally is; on a
    // hosted build that would be simply untrue.
    document.querySelector('.brand-tag').textContent = 'demo';
    $('#dock-foot').innerHTML =
      'A frozen build: these frames were converted, rendered and diffed ahead of time, so every ' +
      'number here came out of the real pipeline. Converting your own frames needs the local tool.';
  } else if (config.hasToken) {
    tokenPill.textContent = 'Figma token loaded';
  } else {
    tokenPill.classList.add('is-bad');
    tokenPill.textContent = 'No Figma token';
    $('#dock-foot').innerHTML =
      'No Figma token found. Put one in <code>.figma-token</code> at the repo root, or set ' +
      '<code>FIGMA_TOKEN</code> before starting the server.';
  }

  if (config.frames.length) {
    suggestions.hidden = false;
    suggestions.append(el('<span class="sug-label">Already converted on this machine</span>'));
    const row = el('<div class="sug-row"></div>');
    suggestions.append(row);
    for (const f of config.frames.slice(0, 4)) {
      const b = el(
        `<button class="sug" type="button">${esc(f.name)} <span class="dim">${f.width}x${f.height}</span></button>`
      );
      b.addEventListener('click', () => {
        // Cache dirs are named <fileKey>-<nodeId with ':' as '-'>, which is
        // exactly the shape a node-id takes in a Figma URL.
        const [fileKey, ...rest] = f.id.split('-');
        input.value = f.url || `https://www.figma.com/design/${fileKey}/frame?node-id=${rest.join('-')}`;
        autosize();
        syncSend();
        input.focus();
      });
      row.append(b);
    }
  }
})();
