// Stage 1 — Figma Dev Mode MCP server source.
//
// Wraps a running Figma Dev Mode MCP server (the tools get_screenshot,
// get_variable_defs, get_code_connect_map, ...) behind the same Source interface.
//
// IMPORTANT design note — why this delegates the node tree to REST:
// The Dev Mode MCP server is built to hand an AI agent *code* and *context*, not
// the raw node tree with id-keyed `boundVariables`. Our IR binds tokens/components
// by variable/component **id**, which the MCP tool outputs don't expose. So:
//   • node tree, variableMap, componentMap  → best sourced from REST (needs a token)
//   • screenshot                            → sourced from the MCP server here
// Pass a `restFallback` (a FigmaRestSource) for the structured data. If you truly
// have no token, you can still get a screenshot via MCP and diff against it, but
// token/component binding will be empty.
//
// `callTool(name, args) => Promise<mcpResult>` is injected — this stays testable
// and doesn't hard-depend on a specific MCP client.

export class FigmaMcpSource {
  /**
   * @param {Object} opts
   * @param {(name:string, args:Object)=>Promise<any>} opts.callTool  Calls an MCP tool.
   * @param {import('./source.js').FigmaRestSource} [opts.restFallback]  For tree/vars/components.
   * @param {Object} [opts.toolNames]  Override default tool names if your server differs.
   */
  constructor({ callTool, restFallback, toolNames = {} }) {
    if (typeof callTool !== 'function') throw new Error('FigmaMcpSource: callTool is required');
    this.callTool = callTool;
    this.rest = restFallback || null;
    this.tools = {
      screenshot: 'get_screenshot',
      variableDefs: 'get_variable_defs',
      codeConnect: 'get_code_connect_map',
      ...toolNames,
    };
  }

  _requireRest(method) {
    if (!this.rest) {
      throw new Error(
        `FigmaMcpSource.${method}: needs a restFallback. The Dev Mode MCP server does not ` +
          `expose the raw node tree / id-keyed variables. Construct with ` +
          `{ callTool, restFallback: new FigmaRestSource({ token, fileKey }) }.`
      );
    }
  }

  async getNode(nodeId) {
    this._requireRest('getNode');
    return this.rest.getNode(nodeId);
  }

  async getVariableMap(nodeId) {
    // Prefer REST (gives id → name, which boundVariables reference by id).
    if (this.rest) return this.rest.getVariableMap(nodeId);
    return {};
  }

  async getComponentMap(nodeId) {
    if (this.rest) return this.rest.getComponentMap(nodeId);
    return {};
  }

  /** Screenshot straight from the MCP server. */
  async getScreenshotPng(nodeId, scale = 2) {
    const result = await this.callTool(this.tools.screenshot, { nodeId, scale });
    return extractImageBuffer(result);
  }
}

/**
 * Pull a PNG Buffer out of an MCP tool result. MCP image content is typically
 * `{ content: [{ type: 'image', data: '<base64>', mimeType: 'image/png' }] }`,
 * but some servers return a URL — handle both.
 * @param {any} result
 * @returns {Buffer}
 */
export function extractImageBuffer(result) {
  const content = result?.content ?? result;
  const items = Array.isArray(content) ? content : [content];
  for (const item of items) {
    if (item?.type === 'image' && item.data) return Buffer.from(item.data, 'base64');
    if (typeof item?.data === 'string' && /^[A-Za-z0-9+/=]+$/.test(item.data.slice(0, 32))) {
      return Buffer.from(item.data, 'base64');
    }
  }
  throw new Error('FigmaMcpSource: could not extract image bytes from get_screenshot result');
}
