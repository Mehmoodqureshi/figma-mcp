// Stage 1/4 — Orchestrator: pull everything a frame needs from a Source, in one call.
//
// Returns the exact inputs the rest of the pipeline consumes:
//   { raw, variableMap, componentMap, referencePng }
//     raw          → figmaToIR(raw, { variableMap, componentMap })
//     referencePng → verifyLoop({ referencePng, ... })
//
// Source-agnostic: works with FigmaRestSource, FigmaMcpSource, or any object
// implementing the same methods.

import { FigmaRestSource } from './source.js';
import { parseFigmaUrl } from './transform.js';

/**
 * @param {Object} source   A Source (FigmaRestSource / FigmaMcpSource / mock).
 * @param {string} nodeId
 * @param {Object} [opts]
 * @param {number} [opts.scale=2]           Screenshot scale (match Figma 2x).
 * @param {boolean} [opts.screenshot=true]  Fetch the reference PNG.
 * @returns {Promise<{raw:Object, variableMap:Object, componentMap:Object, referencePng:Buffer|null}>}
 */
export async function loadFrame(source, nodeId, opts = {}) {
  const { scale = 2, screenshot = true } = opts;

  // Node tree first — some sources (REST) cache the components dict from it.
  const raw = await source.getNode(nodeId);

  const [variableMap, componentMap, referencePng] = await Promise.all([
    source.getVariableMap(nodeId),
    source.getComponentMap(nodeId),
    screenshot ? source.getScreenshotPng(nodeId, scale) : Promise.resolve(null),
  ]);

  return { raw, variableMap, componentMap, referencePng };
}

/**
 * Convenience: load a frame straight from a Figma URL using the REST API.
 * @param {string} url    e.g. https://www.figma.com/design/KEY/Name?node-id=1-2
 * @param {Object} opts
 * @param {string} opts.token             Figma personal access token.
 * @param {Function} [opts.fetch]
 * @param {number} [opts.scale]
 * @returns {Promise<{raw,variableMap,componentMap,referencePng, fileKey, nodeId, source}>}
 *   `source` is returned so callers can export assets (icons, photos) from the
 *   same authenticated session — without it a caller has to rebuild the source
 *   just to call exportNodes, which is easy to forget and leaves every image in
 *   the output as a placeholder.
 */
export async function loadFromUrl(url, opts = {}) {
  const { fileKey, nodeId } = parseFigmaUrl(url);
  if (!fileKey || !nodeId) {
    throw new Error(`Could not parse fileKey/node-id from URL: ${url}`);
  }
  const source = new FigmaRestSource({ token: opts.token, fileKey, fetch: opts.fetch });
  const frame = await loadFrame(source, nodeId, opts);
  return { ...frame, fileKey, nodeId, source };
}
