/**
 * postinstall — install the Chromium that the verify loop renders in.
 *
 * `figma_verify` renders your HTML in a real browser to pixel-diff it against
 * the Figma frame, so Chromium is required for the loop — but NOT for
 * `figma_convert` or `figma_inspect`, which are pure data work. So this is
 * skip-guarded and never fatal: a failed or skipped download must not break
 * `npm install` when someone only wants conversion, or when CI has no use for a
 * 130 MB browser.
 *
 * Skips when:
 *   - FIGMA_MCP_SKIP_BROWSER_DOWNLOAD / PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD is set,
 *   - CI is set,
 *   - playwright is not resolvable.
 */
'use strict';

function shouldSkip() {
  return (
    process.env.FIGMA_MCP_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD === '1' ||
    process.env.CI === 'true' ||
    process.env.CI === '1'
  );
}

function hasPlaywright() {
  try {
    require.resolve('playwright');
    return true;
  } catch {
    return false;
  }
}

function main() {
  if (shouldSkip()) {
    process.stdout.write('[postinstall] skipping Chromium download (guard set).\n');
    return;
  }
  if (!hasPlaywright()) {
    process.stdout.write('[postinstall] playwright not resolvable; skipping Chromium download.\n');
    return;
  }
  try {
    const { execFileSync } = require('node:child_process');
    const { dirname, join } = require('node:path');
    // Drive Playwright's CLI through node rather than the `npx`/`playwright` bin
    // shim: on Windows those are .cmd files, which execFileSync cannot spawn
    // without a shell. `cli.js` is playwright's own bin target; resolving it via
    // package.json avoids the exports map, which exposes no './cli' subpath.
    const cli = join(dirname(require.resolve('playwright/package.json')), 'cli.js');
    execFileSync(process.execPath, [cli, 'install', 'chromium'], { stdio: 'inherit' });
  } catch (err) {
    process.stdout.write(
      `[postinstall] Chromium install skipped (non-fatal): ${err && err.message ? err.message : err}\n` +
        '[postinstall] figma_convert and figma_inspect still work. For figma_verify, run:\n' +
        '[postinstall]   npx playwright install chromium\n',
    );
  }
}

main();
