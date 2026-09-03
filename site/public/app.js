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
  if (r.verify) {
    panels.push(
      { id: 'results', label: 'Results', build: () => buildResults(r) },
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
  const variant = r.responsive ? '?variant=responsive' : '';
  const frame = el(`<iframe title="Generated page for ${esc(r.name)}" sandbox src="/f/${r.id}/preview${variant}"></iframe>`);
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

  const load = async (f) => {
    for (const b of list.children) b.setAttribute('aria-selected', String(b.dataset.path === f.path));
    view.replaceChildren(el('<div class="code-loading">Loading…</div>'));
    try {
      const res = await fetch(`/f/${r.id}/code?path=${encodeURIComponent(f.path)}`);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Server responded ${res.status}`);
      view.replaceChildren(
        el(
          `<div class="code-head"><span class="code-path">${esc(data.path)}</span>` +
            `<span class="code-size">${esc(kb(data.size))}</span>` +
            `<a class="fbtn" href="/f/${r.id}/download?path=${encodeURIComponent(f.path)}" download>Download</a></div>`
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

  for (const f of r.codeFiles) {
    const b = el(
      `<button class="file" data-path="${esc(f.path)}" aria-selected="false">${esc(f.path)}</button>`
    );
    b.addEventListener('click', () => load(f));
    list.append(b);
  }
  load(r.codeFiles[0]);
  return wrap;
}

function buildResults(r) {
  const v = r.verify;
  const wrap = el('<div class="results"></div>');

  const badge = v.converged && !v.paint.stacking && !v.paint.clipping
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
        tile('Pixel diff', pct(v.diffRatio), v.converged ? 'good' : 'bad', `threshold ${pct(v.threshold, 1)}`) +
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

  const raw = [v.corrections.element, v.corrections.paint, v.corrections.pixel].filter(Boolean).join('\n\n');
  if (raw) {
    wrap.append(
      el(`<details class="raw"><summary>Fix instructions, exactly as the agent receives them</summary>
            <pre>${esc(raw)}</pre></details>`)
    );
  }
  wrap.append(el(`<div class="path">${esc(r.dir)}</div>`));
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
  wrap.append(el(`<img alt="${esc(kind)} for ${esc(r.name)}" src="/f/${r.id}/img/${kind}?w=1200">`));
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

(async function init() {
  autosize();
  syncSend();
  input.focus();

  let config;
  try {
    config = await (await fetch('/api/config')).json();
  } catch {
    return;
  }

  tokenPill.hidden = false;
  if (config.hasToken) {
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
        input.value = `https://www.figma.com/design/${fileKey}/frame?node-id=${rest.join('-')}`;
        autosize();
        syncSend();
        input.focus();
      });
      row.append(b);
    }
  }
})();
