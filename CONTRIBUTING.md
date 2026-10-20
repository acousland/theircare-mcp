# Contributing

Use Node.js 22 or newer. Install with npm ci, then run npm run check and npm test.

Use fictional fixtures. Never commit real family names, account IDs, CRNs, contact information, exports, authenticated HTML, credentials, cookies, runtime files or screenshots of real accounts.

Report changed portal flows with synthetic/redacted examples, not raw authenticated responses.

Adapter: src/portal.js. Local browser API: src/companion.js. MCP tools: src/mcp.js. Keep final confirmation out of MCP. Preserve untouched fields, verify the upstream review, and never automatically retry uncertain final submissions.

Add regression tests for parsing, dates, sessions, preview isolation and verification. Do not perform live booking mutations in automated tests.
