#!/usr/bin/env node
// site/build-demo.js — freeze the site into a static, shareable demo.
//
//   node site/build-demo.js        →  site/demo-dist/
//
// Why this exists: the live tool needs Chromium, a writable disk and a Figma
// token, none of which a static host has. So the pipeline is run here, on a
// machine that has all three, and its real output is frozen to disk under the
// same URLs the app already fetches. The page then replays a genuine run rather
// than pretending to do one — every number, every pixel and every line of code
// in the demo came out of the real pipeline.
//
// What is deliberately NOT shipped: the full multi-megabyte source of each
// generated file. The Code tab only ever shows its first 256 KB, so only that
// is baked; the download buttons are hidden in demo mode rather than linking to
// a file that isn't there.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadCredentials } from '../src/config/credentials.js';
import { closeBrowser } from '../src/render.js';
import { run, CACHE_ROOT, ROOT } from './pipeline.js';
import { scaledPng } from './images.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, 'demo-dist');
const PUBLIC = path.join(HERE, 'public');

loadCredentials(ROOT);

// The two frames tell the whole story: one converges cleanly so the mechanism is
// understood, the other passes the pixel threshold while the clipping check
// catches an entire footer rendering off the bottom of the frame.
const FRAMES = [
  {
    url: 'https://www.figma.com/design/IlxSDTjJGvCOscYoJnniBy/demo?node-id=110-13',
    frameworks: ['html', 'react', 'next'],
    // Small enough to also carry the responsive variant of the page itself.
    responsiveVariants: [false, true],
  },
  {
    url: 'https://www.figma.com/design/Qp3ff4RuhjL5xbfGcqUuoX/demo?node-id=7513-2126',
    frameworks: ['html', 'react', 'next'],
    responsiveVariants: [false],
  },
];

const CODE_MAX = 262144; // matches the live server's head slice

const write = (rel, data) => {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, data);
};

/** Copy a directory of .js sources, skipping what the convert path never loads. */
const copyTree = (from, rel) => {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name);
    if (e.isDirectory()) copyTree(src, path.join(rel, e.name));
    else if (e.name.endsWith('.js')) copy(src, path.join(rel, e.name));
  }
};

const copy = (from, rel) => {
  const dest = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(from, dest);
};

const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

async function main() {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  for (const f of ['index.html', 'styles.css', 'app.js']) copy(path.join(PUBLIC, f), f);

  // The conversion endpoint, plus the library it calls. Stages 1-5 need no
  // browser and no disk, so an arbitrary frame really is convertible on a static
  // host; only the render and pixel diff stay local. Under api/_src/ because
  // Vercel treats a leading underscore as "bundle this, do not route to it".
  copy(path.join(HERE, 'api', 'convert.js'), 'api/convert.js');
  copyTree(path.join(ROOT, 'src'), 'api/_src');
  write('package.json', JSON.stringify({ private: true, type: 'module' }, null, 2) + '\n');

  const runs = {};
  const frames = [];

  for (const spec of FRAMES) {
    for (const framework of spec.frameworks) {
      for (const responsive of spec.responsiveVariants) {
        const steps = [];
        const result = await run({
          url: spec.url,
          framework,
          responsive,
          verify: true,
          // The render default is tuned for a fast refine loop. A frame carrying
          // fifteen large images is still painting at that point, and a
          // screenshot taken then reports a frame that converges as one that
          // fails. A frozen demo should show the settled measurement.
          settleMs: 2500,
          onStep: (e) => {
            if (e.status === 'ok') steps.push({ key: e.key, detail: e.detail || '' });
          },
        });

        const dir = result.dir;
        const key = `${result.id}|${framework}|${responsive ? 'responsive' : 'exact'}`;

        // The page itself, at full fidelity — this is the artifact on show.
        const previewName = responsive ? 'preview-responsive.html' : 'preview.html';
        const previewSrc = path.join(dir, responsive ? 'responsive.html' : 'generated.html');
        if (!fs.existsSync(path.join(OUT, 'f', result.id, previewName))) {
          copy(previewSrc, `f/${result.id}/${previewName}`);
        }

        // Verify images, box-filtered down to something a browser can decode.
        for (const kind of ['reference', 'render', 'diff']) {
          const rel = `f/${result.id}/img/${kind}.png`;
          if (fs.existsSync(path.join(OUT, rel))) continue;
          const src = path.join(dir, `${kind}.png`);
          if (fs.existsSync(src)) copy(scaledPng(src, 1200), rel);
        }

        // Source, as the Code tab would receive it.
        result.codeFiles.forEach((file, i) => {
          const src = path.join(dir, file.path);
          if (!fs.existsSync(src)) return;
          const size = fs.statSync(src).size;
          const fd = fs.openSync(src, 'r');
          const buf = Buffer.alloc(Math.min(size, CODE_MAX));
          fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          write(
            `f/${result.id}/${framework}/${responsive ? 'responsive' : 'exact'}/code/${i}.json`,
            JSON.stringify({ path: file.path, size, truncated: size > buf.length, text: buf.toString('utf8') })
          );
        });

        runs[key] = { result, steps };
        if (!frames.some((x) => x.id === result.id)) {
          frames.push({
            id: result.id,
            name: result.name,
            width: result.width,
            height: result.height,
            url: spec.url,
          });
        }
        console.log(
          `  baked ${result.name.padEnd(20)} ${framework.padEnd(5)} ${responsive ? 'responsive' : 'exact    '}` +
            `  ${result.verify ? (result.verify.diffRatio * 100).toFixed(2) + '% diff' : ''}`
        );
      }
    }
  }

  // Static hosting config. cleanUrls would rewrite /preview.html to /preview and
  // break every artifact link; the artifacts themselves are content-addressed by
  // frame id and never change within a deployment, so they cache forever.
  write(
    'vercel.json',
    JSON.stringify(
      {
        cleanUrls: false,
        trailingSlash: false,
        // Converting a large frame means fetching and inlining every asset from
        // Figma one batch at a time; a 300-node page with 80 images genuinely
        // takes minutes, and the default ceiling would cut it off mid-export.
        functions: { 'api/convert.js': { maxDuration: 300 } },
        headers: [
          {
            source: '/f/(.*)',
            headers: [{ key: 'Cache-Control', value: 'public, max-age=31536000, immutable' }],
          },
          {
            source: '/config.json',
            headers: [{ key: 'Cache-Control', value: 'public, max-age=60' }],
          },
        ],
      },
      null,
      2
    ) + '\n'
  );

  write(
    'config.json',
    JSON.stringify({
      demo: true,
      hasToken: true,
      frames,
      runs,
      // Which (framework, sizing) pairs actually have a baked page, so the chat
      // can be honest when an answer combination was not frozen.
      baked: Object.keys(runs),
    })
  );

  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else total += fs.statSync(p).size;
    }
  };
  walk(OUT);

  console.log(`\n${OUT}`);
  console.log(`total ${mb(total)} across ${Object.keys(runs).length} baked runs, ${frames.length} frames`);
  await closeBrowser();
}

main().catch(async (err) => {
  console.error(err);
  await closeBrowser().catch(() => {});
  process.exit(1);
});
