// api/mcp.mjs  ->  /api/mcp
// Bare endpoint for the GA4 MCP server; auth via Authorization: Bearer <token>
// request header (set in the Claude connector). Shared logic in ./_ga4-mcp.mjs.
export { default } from './_ga4-mcp.mjs';
