# Contributing

Use Node.js 22 or newer. Install with npm ci, then run npm run check and npm test.

Use fictional fixtures. Never commit real family names, account IDs, CRNs, contact information, exports, authenticated HTML, credentials, cookies, runtime files, `data/` or `.env` files, or screenshots of real accounts.

Report changed portal flows with synthetic/redacted examples, not raw authenticated responses.

Where things live:

- src/portal.js: the TheirCare adapter.
- src/tools.js: MCP tool definitions, shared by both modes.
- src/companion.js: the local browser companion and the tool operations.
- src/mcp.js: the local stdio bridge.
- src/remote.js: remote mode, covering the approval page, automatic re-sign-in and the `/mcp` endpoint.
- src/oauth.js: the OAuth server, sealed sign-ins and the redirect allowlist.

Keep saving behind an explicit choice (`THEIRCARE_ALLOW_AI_SAVE` locally) and `accept_terms: true`. Preserve untouched fields, verify the upstream review, and never automatically retry uncertain final submissions or a save after a lost session.

Add regression tests for parsing, dates, sessions, preview isolation, verification and OAuth. Do not perform live booking mutations in automated tests.
