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

Date ranges use **inclusive start / exclusive end**, up to 93 days. Previews support 1–31 dates for one child, care type and calendar year.

There is **no MCP tool for final saving or accepting terms**. You confirm personally in the companion. One preview is active at a time, expiring after five minutes. Before saving, the adapter refreshes availability and review; changed fees/terms/state invalidate the old preview. It submits once, then checks the saved calendar. Check bookings before retrying an uncertain result.

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

Remote mode runs the companion, an OAuth 2.1 authorization server and a **Streamable HTTP** MCP endpoint (`/mcp`) on one HTTPS origin. Use it to connect web or mobile assistants (such as Claude.ai custom connectors) from anywhere. It is opt-in; the local stdio setup above is unchanged.

What changes in remote mode:

- **Sign in with Google** protects the companion and every OAuth approval. Only the one verified address in `THEIRCARE_OWNER_EMAIL` is let in.
- AI apps register themselves, then you approve each one in the companion. Access tokens last 1 hour, and refresh tokens last 30 days and rotate on each use. Tokens are stored hashed in `data/oauth.json`. Delete that file to revoke every connection.
- The local bridge token is disabled. There is still no MCP tool for final saving; you confirm in the companion.
- Google sign-ins last 30 days and are stored hashed in `data/sessions.json`, so restarts keep you signed in.
- Your TheirCare session stays in memory, so after a restart you sign in to TheirCare again. The server keeps it from idling out for up to 12 hours after each TheirCare sign-in.

Create a Google OAuth client first. In [Google Cloud Console](https://console.cloud.google.com/apis/credentials), set up the OAuth consent screen (External, Testing, with your address as a test user). Then create an **OAuth client ID** of type **Web application**, with the authorized redirect URI `<THEIRCARE_PUBLIC_URL>/login/google/callback`. Only the `openid` and `email` scopes are requested.

Docker on a home server with [Tailscale Funnel](https://tailscale.com/kb/1223/funnel):

    git clone https://github.com/acousland/theircare-mcp.git && cd theircare-mcp
    cp .env.example .env            # public URL, Google client ID/secret, owner email
    mkdir -p data
    docker compose up -d --build
    sudo tailscale funnel --bg --https=443 http://127.0.0.1:43817

The container publishes only on `127.0.0.1`. Funnel must be allowed for the device in your tailnet policy. Serve TheirCare at the **root of its own Funnel port**: OAuth discovery uses `/.well-known/...` paths, so it cannot share a port behind a path prefix. Funnel opens a whole port to the internet, so never turn it on for a port that also serves tailnet-only apps.

Use port 443: Claude.ai's connector service did not reach Funnel on port 8443. Then add `https://<your-device>.<tailnet>.ts.net/mcp` as a custom connector in your AI app. Approve it after signing in with Google. Open the same origin in a browser to sign in to TheirCare and confirm reviews.

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
