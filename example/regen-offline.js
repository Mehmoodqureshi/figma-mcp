// Rebuild generated.html for an existing cache dir WITHOUT touching /v1/images.
//
// Used to exercise IR + codegen changes against a frame whose raw.json is already
// cached. Vector SVGs are reused from the cached assets.json; image fills are
// re-resolved through /v1/files/:key/images, which has its own cost budget and
// keeps working while node rendering is rate-limited.
//
//   node example/regen-offline.js <cacheDir> <fileKey>

import fs from 'node:fs';
import path from 'node:path';
import { figmaToIR } from '../src/ir/fromFigma.js';
import { generateHtml } from '../src/codegen/html.js';
import { FigmaRestSource } from '../src/mcp/source.js';
import { ROLES } from '../src/ir/schema.js';

const [dir, fileKey] = process.argv.slice(2);
if (!dir || !fileKey) {
  console.error('usage: node example/regen-offline.js <cacheDir> <fileKey>');
  process.exit(1);
}

const p = (f) => path.join(dir, f);
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const { raw, variableMap, componentMap } = readJson(p('raw.json'));
const ir = figmaToIR(raw, { variableMap, componentMap });
fs.writeFileSync(p('ir.json'), JSON.stringify(ir));

function collect(node, acc = { imageFills: [], imageNodes: [], vectors: [] }) {
  const fill = node.style?.imageFill;
  if (typeof fill === 'string') acc.imageFills.push({ id: node.id, ref: fill });
  else if (fill) acc.imageNodes.push(node.id);
  if (node.role === ROLES.VECTOR) acc.vectors.push(node.id);
  (node.children || []).forEach((c) => collect(c, acc));
  return acc;
}
const { imageFills, imageNodes, vectors } = collect(ir);

const cached = fs.existsSync(p('assets.json')) ? readJson(p('assets.json')) : {};
const assets = {};
// Reuse anything already cached (vectors, and images that needed node rendering)
// so this script never touches /v1/images.
for (const id of [...vectors, ...imageNodes]) if (cached[id]) assets[id] = cached[id];

const token = fs.readFileSync(path.join(process.cwd(), '.figma-token'), 'utf8').trim();
const source = new FigmaRestSource({ token, fileKey });
Object.assign(assets, await source.exportImageFills(imageFills));

const html = generateHtml(ir, { title: raw.name, assets });
fs.writeFileSync(p('generated.html'), html);

const got = imageFills.filter((e) => assets[e.id]).length;
console.log(`image fills: ${got}/${imageFills.length} resolved`);
console.log(`vectors:     ${vectors.filter((v) => assets[v]).length}/${vectors.length} from cache`);
console.log(`rendered:    ${imageNodes.filter((v) => assets[v]).length}/${imageNodes.length} from cache (no imageRef)`);
console.log(`wrote ${p('generated.html')} (${Math.round(html.length / 1024)} KB)`);
