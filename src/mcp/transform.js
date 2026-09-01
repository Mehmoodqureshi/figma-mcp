// Stage 1/4 — Adapter transforms: Figma API responses → the shapes figmaToIR needs.
//
// Pure functions, no I/O — easy to unit-test. The IR converter expects:
//   variableMap:  { 'VariableID:...': 'color/surface/card' }   (id → token name)
//   componentMap: { '<componentId>': { name: 'Badge', props } } (id → code component)
// These map raw Figma REST payloads into exactly that.

/** PascalCase a Figma name so it's a valid component identifier. 'Button/Primary' → 'ButtonPrimary'. */
export function componentName(raw) {
  const parts = String(raw || 'Component').split(/[^a-zA-Z0-9]+/).filter(Boolean);
  const pascal = parts.map((w) => w[0].toUpperCase() + w.slice(1)).join('');
  return pascal || 'Component';
}

/**
 * REST `GET /v1/files/:key/variables/local` → { 'VariableID:...': 'name' }.
 * Figma variable names already use "/" (e.g. "color/surface/card"), which is
 * exactly the token-path convention the codegen expects.
 * @param {Object} meta  The `.meta` object from the variables response.
 */
export function buildVariableMap(meta) {
  const map = {};
  const variables = meta?.variables || {};
  for (const [id, v] of Object.entries(variables)) {
    if (v?.name) map[id] = v.name;
  }
  return map;
}

/**
 * The `components` dict from a `GET /v1/files/:key/nodes` response
 * → { '<componentId>': { name, props } }.
 * REST doesn't carry Code Connect prop bindings, so props start empty — merge in
 * a real Code Connect map (from the MCP `get_code_connect_map`) when you have one.
 * @param {Object} componentsDict  id → { key, name, ... }
 */
export function buildComponentMap(componentsDict) {
  const map = {};
  for (const [id, c] of Object.entries(componentsDict || {})) {
    map[id] = { name: componentName(c?.name), props: {} };
  }
  return map;
}

/**
 * Parse a Figma URL into { fileKey, nodeId }.
 * Handles /file/ and /design/ URLs; converts node-id "1-2" → "1:2".
 * @param {string} url
 * @returns {{ fileKey: string|null, nodeId: string|null }}
 */
export function parseFigmaUrl(url) {
  const fileMatch = String(url).match(/figma\.com\/(?:file|design)\/([A-Za-z0-9]+)/);
  const nodeMatch = String(url).match(/[?&]node-id=([^&]+)/);
  return {
    fileKey: fileMatch ? fileMatch[1] : null,
    // node-id in URLs uses a dash for the first separator: "1-2" → "1:2".
    nodeId: nodeMatch ? decodeURIComponent(nodeMatch[1]).replace('-', ':') : null,
  };
}
