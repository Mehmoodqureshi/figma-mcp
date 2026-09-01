// Offline test of the MCP SERVER: spawn it over real stdio, speak real MCP, and
// drive the tools end to end. No Figma token / network needed — we pre-seed the
// cache dir that figma_convert would have written, then exercise the two tools
// that read it (figma_inspect, figma_verify).
//
// This is the inverse of mcp-adapter-test.js: that one tests us as a client of
// Figma; this one tests us as a server to an agent.
//
// Run: node example/mcp-server-test.js

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { figmaToIR } from '../src/ir/index.js';
import { generateHtml } from '../src/codegen/index.js';
import { renderHtml, closeBrowser } from '../src/render.js';
import { raw } from './fixture.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SERVER = path.join(ROOT, 'src', 'mcp', 'server.js');

let failures = 0;
const assert = (cond, msg) => {
  console.log(`${cond ? '  ✓' : '  ✗ FAIL:'} ${msg}`);
  if (!cond) failures++;
};

/** Flatten an MCP tool result's text content. */
const textOf = (res) =>
  (res.content || [])
    .filter((c) => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/**
 * Seed a cache dir exactly as figma_convert would, but offline.
 * The reference PNG is the render of the CORRECT html, so a matching html must
 * converge and a broken one must not — that's what makes the assertions real.
 */
async function seedCacheDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'figma-mcp-test-'));
  const ir = figmaToIR(raw, { variableMap: {}, componentMap: {} });
  const html = generateHtml(ir, { title: 'Fixture' });

  const referencePng = await renderHtml(html, {
    width: Math.round(ir.box.width),
    height: Math.round(ir.box.height),
  });
  await closeBrowser();

  fs.writeFileSync(path.join(dir, 'ir.json'), JSON.stringify(ir));
  fs.writeFileSync(path.join(dir, 'generated.html'), html);
  fs.writeFileSync(path.join(dir, 'reference.png'), referencePng);
  return { dir, ir, html };
}

async function main() {
  console.log('Seeding an offline cache dir (render fixture → reference.png)...');
  const { dir, html } = await seedCacheDir();

  console.log('\nConnecting to the MCP server over stdio...');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER],
    stderr: 'ignore',
  });
  const client = new Client({ name: 'figma-mcp-test', version: '0.1.0' });
  await client.connect(transport);

  try {
    // --- Handshake -----------------------------------------------------------
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    console.log(`\nTools: ${names.join(', ')}`);
    assert(names.length === 3, 'server exposes 3 tools');
    assert(names.includes('figma_convert'), 'figma_convert registered');
    assert(names.includes('figma_verify'), 'figma_verify registered');
    assert(names.includes('figma_inspect'), 'figma_inspect registered');
    assert(
      tools.every((t) => t.description && t.inputSchema),
      'every tool has a description and an input schema'
    );

    // --- figma_inspect -------------------------------------------------------
    console.log('\nfigma_inspect:');
    const inspect = await client.callTool({ name: 'figma_inspect', arguments: { dir } });
    const outline = textOf(inspect);
    assert(!inspect.isError, 'figma_inspect succeeds');
    assert(outline.split('\n').length > 1, 'returns a multi-line outline');
    assert(/\[\d+x\d+ @/.test(outline), 'outline includes box geometry');

    const filtered = await client.callTool({
      name: 'figma_inspect',
      arguments: { dir, filter: 'zzz-no-such-node' },
    });
    assert(textOf(filtered).includes('No nodes matched'), 'filter with no hits reports cleanly');

    // --- figma_verify: the matching html must converge ------------------------
    console.log('\nfigma_verify (unmodified html — should converge):');
    const good = await client.callTool({ name: 'figma_verify', arguments: { dir } });
    const goodText = textOf(good);
    assert(!good.isError, 'figma_verify succeeds');
    assert(goodText.includes('CONVERGED'), 'identical render converges');
    assert(fs.existsSync(path.join(dir, 'diff.png')), 'wrote diff.png');
    assert(fs.existsSync(path.join(dir, 'render.png')), 'wrote render.png');
    assert(!/base64/i.test(JSON.stringify(good.content)), 'no image blobs unless asked');

    // --- figma_verify: a broken html must NOT converge, and must say why ------
    console.log('\nfigma_verify (broken html — should report the damage):');
    const brokenPath = path.join(dir, 'broken.html');
    // Shove everything 120px down and drop the first element entirely.
    const broken = html
      .replace('<body>', '<body style="padding-top:120px">')
      .replace(/<(h1|h2|h3|p)\b[^>]*>.*?<\/\1>/, '');
    fs.writeFileSync(brokenPath, broken);

    const bad = await client.callTool({
      name: 'figma_verify',
      arguments: { dir, htmlPath: brokenPath },
    });
    const badText = textOf(bad);
    assert(badText.includes('NOT CONVERGED'), 'broken render does not converge');
    assert(/MISSING|MISPLACED/.test(badText), 'element check names MISSING/MISPLACED elements');
    assert(badText.includes('figma_verify again'), 'tells the agent how to iterate');

    // --- Error paths ---------------------------------------------------------
    console.log('\nError handling:');
    const noDir = await client.callTool({
      name: 'figma_verify',
      arguments: { dir: '/nonexistent-dir-xyz' },
    });
    assert(noDir.isError === true, 'missing dir returns isError');
    assert(textOf(noDir).includes('figma_convert'), 'error tells you to run figma_convert first');

    const badUrl = await client.callTool({
      name: 'figma_convert',
      arguments: { url: 'https://example.com/not-figma' },
    });
    assert(badUrl.isError === true, 'unparseable URL returns isError');
    assert(textOf(badUrl).includes('node-id'), 'error explains the expected URL shape');

    // --- includeImages opt-in ------------------------------------------------
    console.log('\nfigma_verify (includeImages):');
    const withImgs = await client.callTool({
      name: 'figma_verify',
      arguments: { dir, includeImages: true },
    });
    const imgs = withImgs.content.filter((c) => c.type === 'image');
    assert(imgs.length === 3, 'includeImages returns reference + render + diff');
    assert(
      imgs.every((i) => i.mimeType === 'image/png' && i.data.length > 0),
      'images are non-empty PNGs'
    );
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }

  console.log(`\n${failures === 0 ? 'ALL PASS ✅' : `${failures} FAILED ❌`}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
