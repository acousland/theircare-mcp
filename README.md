# TheirCare MCP

An MCP server for viewing and managing **TheirCare / FullyBooked** bookings through an AI assistant such as ChatGPT, Claude or Codex.

Ask about saved bookings, check availability, and book or cancel sessions, with fees and terms shown before anything is saved.

**Unofficial community project. Not affiliated with, endorsed by, or supported by TheirCare or FullyBooked.** It uses the undocumented family portal and requires an existing TheirCare account.

## Choose how to run it

| | **Local** | **Remote (self-hosted)** |
| --- | --- | --- |
| Works with | Desktop AI apps with local MCP support (Codex, Claude Desktop and similar) | ChatGPT and Claude on the web and mobile |
| Runs on | Your computer | An always-on machine of yours, e.g. a home server, published with Tailscale Funnel |
| Signing in | In a local browser page each time the companion starts | Once, when you connect the AI app |
| Saving changes | You confirm in the local page (or opt in to saving from chat) | From chat, after you agree there |
| Setup | `npm start` | Docker, Tailscale and a few settings |

Start with **local** to try it, including a sample mode that needs no account. Use **remote** if you want it in ChatGPT or Claude on your phone.

## Local quick start

Install [Node.js 22 or newer](https://nodejs.org/) and [Git](https://git-scm.com/):

    git clone https://github.com/acousland/theircare-mcp.git
    cd theircare-mcp
    npm ci
    npm start

Open **http://127.0.0.1:43817**.

Choose **Try sample data** for a fictional demonstration without an account, or sign in with your TheirCare email and password. Browse **Your bookings** and **Find a day**. Selecting dates prepares an **unsaved preview**. Review the conditions and accept the terms before personally clicking the final save button.

To leave sample mode, select **Disconnect**, then sign in. Sample mode cannot save to a real account.

Terminal commands work on macOS, Linux and Windows with supported Node installations. Automated checks run across those platforms; live account testing has been performed on macOS.

### Connect a local AI assistant

Local mode uses **stdio MCP**. No API key, cloud server or public tunnel is needed. Your assistant needs local MCP support.

    npm run config

This prints configuration with the **actual Node executable and absolute server path on your machine**.

**Codex:** run the registration command printed by `npm run config`, shaped like:

    codex mcp add theircare-local -- "/absolute/path/to/node" "/absolute/path/to/theircare-mcp/src/mcp.js"

Ask the assistant to check `theircare_status`. If tools are missing, reconnect MCP or start a new chat. Remove the registration with `codex mcp remove theircare-local`.

**Other local MCP clients:** add the JSON printed by `npm run config` to your client's MCP settings:

    {
      "mcpServers": {
        "theircare-local": {
          "command": "/absolute/path/to/node",
          "args": ["/absolute/path/to/theircare-mcp/src/mcp.js"]
        }
      }
    }

The MCP server automatically starts the companion. Open its URL to sign in personally; keep passwords out of AI conversations.

To stop and clear the session:

    npm run stop

An enabled MCP client can restart the companion; remove or disable its registration to keep it stopped.

## Remote hosting

Remote mode runs an OAuth 2.1 authorization server and a **Streamable HTTP** MCP endpoint (`/mcp`) on one HTTPS address, so ChatGPT or Claude can reach it from anywhere. It serves one TheirCare account: yours.

### What you need

- An always-on Linux machine (or Mac) with [Docker](https://docs.docker.com/engine/install/) and Docker Compose.
- A free [Tailscale](https://tailscale.com/) account, with Tailscale installed on that machine. Your phone does **not** need Tailscale: Funnel makes the server reachable from the internet.
- A ChatGPT or Claude plan that allows custom connectors.

### 1. Prepare Tailscale

In the [Tailscale admin console](https://login.tailscale.com/admin):

1. **DNS:** turn on **MagicDNS** and **HTTPS Certificates**.
2. **Access controls:** allow Funnel by adding a `nodeAttrs` entry to your tailnet policy file:

       "nodeAttrs": [
         {"target": ["autogroup:member"], "attr": ["funnel"]}
       ]

Your server's public address will be `https://<machine-name>.<tailnet>.ts.net`. The full name is shown for the machine on the **Machines** page of the admin console.

### 2. Configure and start

    git clone https://github.com/acousland/theircare-mcp.git && cd theircare-mcp
    cp .env.example .env
    mkdir -m 700 data

Edit `.env`:

| Setting | Value |
| --- | --- |
| `THEIRCARE_PUBLIC_URL` | Your server's public address, e.g. `https://homeserver.tailabc123.ts.net`, with no path or trailing slash |
| `THEIRCARE_OWNER_EMAIL` | The email you sign in to TheirCare with. Only this account can connect. |
| `THEIRCARE_ALLOWED_REDIRECTS` | Optional. Which AI apps may connect; defaults to ChatGPT and Claude. |

Then start it:

    docker compose up -d --build
    docker compose ps          # should show "healthy" after about 30 seconds

The container listens only on `127.0.0.1:43817`, runs as a non-root user with a read-only filesystem, and keeps its state in `data/`.

### 3. Publish with Funnel

    sudo tailscale funnel --bg --https=443 http://127.0.0.1:43817

Open your public address in a browser. You should see a page showing your connector URL. The first request can take a few seconds while Tailscale issues the certificate.

- **Use port 443.** ChatGPT's and Claude's connector services did not reach Funnel on port 8443.
- **Serve it at the root of its own port.** OAuth discovery uses `/.well-known/...` paths, so it cannot sit behind a path prefix.
- Funnel opens the whole port to the internet, so never turn it on for a port that also serves private apps.

### 4. Connect your AI app

Your connector URL is your public address followed by `/mcp`, e.g. `https://homeserver.tailabc123.ts.net/mcp`.

- **ChatGPT:** in Settings, open **Apps & Connectors** (you may need to turn on developer mode under Advanced), create a connector with the URL above, and choose **OAuth** authentication.
- **Claude:** in Settings, open **Connectors**, choose **Add custom connector**, and enter the URL above.

Menu names change from time to time; look for "custom connector" or "MCP" in your app's settings.

The app opens an approval page on your server. Enter your TheirCare email and password and select **Sign in and connect**. That's the only time you sign in. Then ask, for example, *"What care is booked next week?"*

### How remote mode keeps you signed in, safely

- **Connecting is signing in to TheirCare.** The approval page checks your email and password with TheirCare. Only the account in `THEIRCARE_OWNER_EMAIL` is accepted, and five failed attempts lock the page for 15 minutes.
- **Your sign-in is stored encrypted, and the key is not on the server.** It is sealed with AES-256-GCM in `data/oauth.json`. The key travels inside the AI app's tokens, so the server can unlock it only while that app is using a tool. Tokens are stored hashed.
- **Lost sessions are restored automatically.** TheirCare signs out idle sessions within minutes and allows only one session per account, so signing in on the website ends the connector's session. The server signs back in on the next tool call. Your website session may end in turn if you use both at once.
- **A changed password stops after one attempt.** The server then drops that connection so your AI app asks you to reconnect, rather than retrying and risking an account lock.
- **Only allowed AI apps can connect,** identified by their OAuth redirect addresses. This stops a look-alike app sending you a genuine approval link that would hand your sign-in to someone else.
- **Access lasts while you use it.** Access tokens last an hour; refresh tokens last a year and rotate on each use. If an already-used refresh token comes back more than two minutes later, someone else has a copy, so the server ends that connection and deletes its stored sign-in.
- Anyone holding your AI app's tokens can use your TheirCare account through this server until you disconnect it.

**To disconnect,** remove the connector in your AI app. To revoke every connection and stored sign-in at once, stop the server, delete `data/oauth.json` and start it again.

**To update:**

    git pull --ff-only && docker compose up -d --build

Existing connections keep working across updates and restarts.

**To view logs** (no passwords, tokens or OAuth codes are logged):

    docker compose logs -f

**Without Docker:** run `npm ci` then `npm run remote` with the same environment variables. `THEIRCARE_HOST`, `THEIRCARE_PORT` and `THEIRCARE_DATA_DIR` are optional.

## What you can ask

- "What care is booked next week?"
- "Is after-school care available next Wednesday?"
- "Book after-school care for the next three Thursdays."
- "Cancel Friday's after-school care."

The assistant should first call `theircare_account_context` for current child, service and care-type IDs. Never hard-code another account's IDs.

| Tool | Purpose |
| --- | --- |
| theircare_status | Connection state |
| theircare_account_context | Children, care types and services |
| theircare_list_bookings | Saved bookings |
| theircare_availability | Availability and session conditions |
| theircare_preview_changes | Unsaved booking, cancellation or waitlist review |
| theircare_discard_preview | Discard the preview |
| theircare_confirm_changes | Save the active preview (remote mode, or local with `THEIRCARE_ALLOW_AI_SAVE=true`) |

Date ranges use **inclusive start / exclusive end**, up to 93 days. Previews support 1–31 dates for one child, care type and calendar year.

### Booking and cancelling

Every change starts as an **unsaved preview** showing the exact dates, fees, cancellation policy and terms.

- **Locally, by default,** there is no MCP tool for saving or accepting terms. You confirm personally in the companion. Set `THEIRCARE_ALLOW_AI_SAVE=true` in the MCP server's environment to allow saving from chat instead.
- **In remote mode,** saving from chat is always available, because there is no review page.

When saving from chat, the assistant calls `theircare_confirm_changes` after you agree, and accepts TheirCare's booking terms on your behalf. That may incur fees. Safeguards:

- The tool is marked destructive, so apps that support it ask you before each save. **Don't choose "always allow" for it.**
- It requires `accept_terms: true` and never works in sample mode.
- One preview is active at a time, expiring after five minutes.
- Before saving, it refreshes availability and the review, and refuses if fees, terms or availability changed.
- It submits once, then checks the saved calendar and reports each date as verified. A save is never retried automatically. If a result is uncertain, check bookings before trying again.

## Privacy

- Passwords go over HTTPS only to **theircare.fullybookedccms.com.au**. Locally they are never written to disk; in remote mode they are stored only in the encrypted form described above. They never reach the AI.
- Portal cookies stay in process memory.
- Only information needed for child and service selection is extracted. No payment, subsidy, medical-record or contact-editing tools are exposed.
- MCP results go to your chosen AI app and may be processed by its model provider.
- Locally, the companion listens only on **127.0.0.1:43817**, with Host/Origin checks and separate browser and MCP access. **.runtime/connection.json** holds a bridge credential; Git ignores it and packages exclude it. Never share `.runtime`.
- The local browser confirmation boundary is not isolation from malicious software running as your OS user.
- Never expose local mode through a proxy or public tunnel; use [remote hosting](#remote-hosting) instead.

## Updating (local)

Stop the companion first, then:

    git pull --ff-only
    npm ci
    npm start

Sign in again. Dependencies are pinned in package-lock.json.

## Validation and limits

**Live-verified:** password sign-in, children and care types, bookings, availability, and unsaved booking/cancellation reviews with policies and terms. In remote mode: connecting from ChatGPT, reading bookings, and signing back in automatically after TheirCare ended the session.

**Final saving is implemented but tested only against fictional responses. No live final save was made during development.** Check the official portal after your first real change.

- Password sign-in only; passkeys, CAPTCHA and extra verification are unsupported.
- Waitlist actions have offline coverage but await live validation.
- Multi-service accounts, alternate session types, block bookings and excursions/authorisations need more validation.
- Only **Australia/Melbourne** time is supported, matching the live-tested service.
- FullyBooked's feed marks local clock components with Z. The adapter preserves official-portal display hours and emits Melbourne offsets.
- Only TheirCare's portal hostname is supported, not all FullyBooked operators.
- The undocumented portal can change without notice.

## Troubleshooting

| Problem | Next step |
| --- | --- |
| Port 43817 in use | Stop another copy; avoid running two checkouts at once. |
| Local: expired sign-in | Disconnect and sign in again in the companion. |
| Unsupported or extra verification flow | Use the official portal. |
| Review mismatch | No save occurs through a preview. Report it with synthetic or redacted details. |
| Uncertain save | Check the official calendar before retrying. |
| Missing MCP tools | Local: check paths from `npm run config` and reconnect. Remote: refresh or re-add the connector. |
| Remote: "couldn't discover OAuth settings" | Check that your public address loads in a browser, Funnel is on port 443, and `THEIRCARE_PUBLIC_URL` matches it exactly. |
| Remote: "This TheirCare account is not allowed" | `THEIRCARE_OWNER_EMAIL` must be the email you sign in to TheirCare with. Restart after changing `.env`. |
| Remote: `invalid_client_metadata` when connecting | Your AI app isn't allowed. Add its OAuth redirect address to `THEIRCARE_ALLOWED_REDIRECTS`. |
| Remote: `RECONNECT_REQUIRED` | TheirCare rejected the stored password, e.g. after you changed it. Remove and re-add the connector. |
| Remote: anything else | `docker compose logs --tail 100` shows each request and tool result. |

## Development

    npm ci
    npm run check
    npm test

Tests use fictional responses and need no live account.

    npm run test:mcp

The optional transport check verifies MCP initialization and tool discovery. In explicitly selected sample mode it reads fictional data and creates an unsaved sample preview. With a real account it checks status only. It never performs a final save.

See [CONTRIBUTING.md](CONTRIBUTING.md), [SECURITY.md](SECURITY.md) and the [MIT licence](LICENSE).
