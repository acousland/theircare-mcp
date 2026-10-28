# TheirCare MCP

A local MCP server and companion for viewing and managing **TheirCare / FullyBooked** bookings through an AI assistant.

Read bookings, check availability, and prepare booking/cancellation previews. Review changes, fees and terms in the companion before personally saving.

**Unofficial community project. Not affiliated with, endorsed by, or supported by TheirCare or FullyBooked.** Early release using the undocumented family portal; requires an existing TheirCare account.

## Quick start

Install [Node.js 22 or newer](https://nodejs.org/) and [Git](https://git-scm.com/):

    git clone https://github.com/acousland/theircare-mcp.git
    cd theircare-mcp
    npm ci
    npm start

Open **http://127.0.0.1:43817**.

Choose **Try sample data** for a fictional demonstration without an account, or sign in with your TheirCare email/password. Browse **Your bookings** and **Find a day**. Selecting dates prepares an **unsaved preview**. Review the conditions and accept the terms before personally clicking the final save button.

To leave sample mode, select **Disconnect**, then sign in. Sample mode cannot save to a real account.

Terminal commands work on macOS, Linux and Windows with supported Node installations. Automated checks run across those platforms; live account testing has been performed on macOS.

## Connect your AI assistant

Uses **stdio MCP**. No OpenAI API key, cloud server or public tunnel is needed. Your assistant needs local MCP support.

    npm run config

This prints configuration with the **actual Node executable and absolute server path on your machine**.

### Codex

Run the registration command printed by npm run config, shaped like:

    codex mcp add theircare-local -- "/absolute/path/to/node" "/absolute/path/to/theircare-mcp/src/mcp.js"

Ask the assistant to check theircare_status. If tools are missing, reconnect MCP or start a new chat. Remove the registration with:

    codex mcp remove theircare-local

### Other local MCP clients

Add the JSON printed by npm run config to your client's local MCP settings:

    {
      "mcpServers": {
        "theircare-local": {
          "command": "/absolute/path/to/node",
          "args": ["/absolute/path/to/theircare-mcp/src/mcp.js"]
        }
      }
    }

The MCP server automatically starts the companion. Open its URL to sign in personally; keep passwords out of AI conversations.

## What you can ask

- “What care is booked next week?”
- “Is after-school care available next Wednesday?”
- “Prepare a preview to cancel Friday's after-school care.”

The assistant should first call account_context for current child, service and care-type IDs. Never hard-code another account's IDs.

| Tool | Purpose |
| --- | --- |
| theircare_status | Connection state and companion URL |
| theircare_account_context | Children, care types and services |
| theircare_list_bookings | Saved bookings |
| theircare_availability | Availability and session conditions |
| theircare_preview_changes | Unsaved booking, cancellation or waitlist review |
| theircare_discard_preview | Discard the preview |
| theircare_confirm_changes | Save the active preview (when `THEIRCARE_ALLOW_AI_SAVE=true`, and always in remote mode) |

Date ranges use **inclusive start / exclusive end**, up to 93 days. Previews support 1–31 dates for one child, care type and calendar year.

By default there is **no MCP tool for final saving or accepting terms**. You confirm personally in the companion.

To let your assistant book and cancel directly, set `THEIRCARE_ALLOW_AI_SAVE=true` in the environment of the MCP server (remote mode always allows it). This adds `theircare_confirm_changes`, which saves a preview after you agree in chat. The assistant then accepts TheirCare's booking terms on your behalf, and that may incur fees. The tool is marked destructive, so clients that support it ask before running it. It requires `accept_terms: true`, never works in sample mode, and uses the same re-check, single submit and calendar verification as the companion. One preview is active at a time, expiring after five minutes. Before saving, the adapter refreshes availability and review; changed fees/terms/state invalidate the old preview. It submits once, then checks the saved calendar. Check bookings before retrying an uncertain result.

## Privacy and local operation

- Passwords go over HTTPS only to **theircare.fullybookedccms.com.au**, never to disk or the AI.
- Portal cookies stay in process memory. Disconnecting/stopping clears the session.
- Only information needed for child/service selection is extracted. No payment, subsidy, medical-record or contact-editing tools are exposed.
- MCP results go to your chosen AI client and may be processed by its model provider.
- The companion listens only on **127.0.0.1:43817**, with Host/Origin checks and separate browser/MCP access.
- **.runtime/connection.json** holds a bridge credential. Git ignores it and packages exclude it. Never share .runtime.
- The browser confirmation boundary prevents saving through the provided MCP tools; it is not isolation from malicious software running as your OS user.
- Run on a trusted local computer. Do not expose local mode through a proxy or public tunnel; use [remote hosting](#remote-hosting-optional) instead.

To stop and clear the session:

    npm run stop

An enabled MCP client can restart the companion; remove/disable its registration to keep it stopped.

## Remote hosting (optional)

Remote mode runs an OAuth 2.1 authorization server and a **Streamable HTTP** MCP endpoint (`/mcp`) on one HTTPS origin, with no companion page. Use it to connect web or mobile assistants (such as ChatGPT or Claude.ai custom connectors) from anywhere, and sign in once. It is opt-in; the local stdio setup above is unchanged.

What changes in remote mode:

- **Connecting is signing in to TheirCare.** When you add the connector, its approval page asks for your TheirCare email and password and checks them with TheirCare. Only the account in `THEIRCARE_OWNER_EMAIL` is accepted, and five failed attempts lock the page for 15 minutes.
- **You stay signed in.** Your TheirCare sign-in is sealed with AES-256-GCM in `data/oauth.json`. The key is not stored on the server: it travels inside the AI app's tokens, so the server can unlock it only while that app is using a tool. Whenever TheirCare ends the session (it signs out idle sessions within minutes, and allows only one session per account, so signing in on the website ends the connector's), the server signs back in on the next tool call. Your browser session on the website may end in turn if you use both at once.
- **If TheirCare rejects the saved password** (for example after you change it), the server tries once, then drops that connection so your AI app asks you to reconnect, rather than retrying and risking an account lock.
- **Booking and cancelling go through the AI app**, after you agree in chat, because there is no review page. `theircare_confirm_changes` is always available remotely, and the approval page says so.
- **Only allowed AI apps can connect.** By default that is ChatGPT and Claude, identified by their OAuth redirect addresses. This stops a look-alike app sending you a genuine approval link that would hand your sign-in to someone else. Set `THEIRCARE_ALLOWED_REDIRECTS` to change the list.
- Access tokens last 1 hour; refresh tokens last a year and rotate on each use, so a connector used at least once a year never expires. If an already-used refresh token comes back more than two minutes later, someone else has a copy, so the server ends that connection and deletes its sealed sign-in. Tokens are stored hashed. Disconnect the app to revoke it, or delete `data/oauth.json` to revoke every connection and its sealed sign-in.
- Anyone holding the AI app's tokens can use your TheirCare account through this server until you disconnect it.

Docker on a home server with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel):

    git clone https://github.com/acousland/theircare-mcp.git && cd theircare-mcp
    cp .env.example .env            # public URL and your TheirCare email
    mkdir -p data
    docker compose up -d --build
    sudo tailscale funnel --bg --https=443 http://127.0.0.1:43817

The container publishes only on `127.0.0.1`. Funnel must be allowed for the device in your tailnet policy. Serve TheirCare at the **root of its own Funnel port**: OAuth discovery uses `/.well-known/...` paths, so it cannot share a port behind a path prefix. Funnel opens a whole port to the internet, so never turn it on for a port that also serves tailnet-only apps.

Use port 443: ChatGPT's and Claude.ai's connector services did not reach Funnel on port 8443. Then add `https://<your-device>.<tailnet>.ts.net/mcp` as a custom connector in your AI app, choosing OAuth, and sign in to TheirCare on the page it opens.

Without Docker: `npm run remote` with the same environment variables (`THEIRCARE_HOST`, `THEIRCARE_PORT` and `THEIRCARE_DATA_DIR` are optional).

## Updating

Stop the companion first, then:

    git pull --ff-only
    npm ci
    npm start

Sign in again. Dependencies are pinned in package-lock.json.

## Validation and limits

Live-verified: password sign-in, children/care types, bookings, availability, and unsaved booking/cancellation reviews with policies and terms. Test previews were discarded.

**Final saving is implemented but tested only against fictional responses. No live final save was made during development.** Check the official portal after any intended real change.

- Password sign-in only; passkeys, CAPTCHA and extra verification are unsupported.
- Waitlist actions have offline coverage but await live validation.
- Multi-service accounts, alternate session types, block bookings and excursions/authorisations need more validation.
- This release uses **Australia/Melbourne**, matching the live-tested service. Other service time zones are not supported yet.
- FullyBooked's feed marks local clock components with Z. The adapter preserves official-portal display hours and emits Melbourne offsets.
- Only TheirCare's portal hostname is supported, not all FullyBooked operators.
- The undocumented portal can change without notice.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Port 43817 in use | Stop another copy; avoid simultaneous checkouts. |
| Expired sign-in | Disconnect and sign in again. |
| Unsupported/extra verification flow | Use the official portal. |
| Review mismatch | No final save occurs through preview. Report with synthetic/redacted details. |
| Uncertain save | Check the official calendar before retrying. |
| Missing MCP tools | Check paths from npm run config and reconnect. |

## Development

    npm ci
    npm run check
    npm test

Tests use fictional responses and need no live account.

    npm run test:mcp

The optional transport check verifies MCP initialization/tool discovery. In explicitly selected sample mode it reads fictional data and creates an unsaved sample preview. With a real account it checks status only. It never performs a final save.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [MIT licence](LICENSE).

Codex registration follows the [official MCP documentation](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
