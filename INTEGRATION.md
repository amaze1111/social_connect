# Integrating Social Connect

How to add Social Connect's WhatsApp and LinkedIn sending to a larger project.

## Status

- Confirmed on real accounts on Windows only: WhatsApp send, LinkedIn message to a 1st-degree connection, LinkedIn flow to a 3rd-degree profile.
- Not yet confirmed: logins surviving a restart and several days, and macOS or Linux.
- There is no automated test suite in the repo yet.

## Tools and dependencies

| Tool | Requirement | Purpose |
|---|---|---|
| Node.js | 18 or later (needs global `fetch`). Run so far on 22.15. | Server runtime |
| npm packages | `express`, `playwright`, as in `package.json` | HTTP API, attaching to the browser |
| Chrome or Edge | Installed on the same machine | Runs WhatsApp Web and LinkedIn |
| Desktop session | Needed for LinkedIn login | LinkedIn login opens a visible browser window |

- Playwright's bundled browsers are not needed at runtime, so `npx playwright install` is only needed for tests on fake pages.
- Do not run this under a headless server account or as a Windows service. The LinkedIn login window would not be visible. On Linux without a desktop it needs `xvfb` and a way to reach the window.

## Permissions

The active WhatsApp and LinkedIn routes use no API keys, OAuth scopes or Meta permissions. They need the following.

**Operating system**
- Start and stop browser processes.
- Read and write the project's `.sessions/` folder.
- No administrator rights.

**Network**
- Outbound HTTPS to `*.linkedin.com`, `*.licdn.com`, `web.whatsapp.com`, `*.whatsapp.net` and `*.whatsapp.com`.
- LinkedIn pages also load third-party frames such as `www.google.com` (reCAPTCHA) and `li.protechts.net`. A strict allowlist may need more entries, so test on the real network.
- Loopback only for the server port (default 3000) and a random browser debugging port per browser launch. No inbound access from other machines.

**User accounts**
- WhatsApp: one linked device slot, from a maximum of 4. The user scans a QR once.
- LinkedIn: the user signs in once with password, Google or 2FA.

**End-user consent**
- This automation is unofficial and can get accounts restricted or banned. Tell users before they connect.

## Choosing an integration method

### Separate process (recommended)

Run Social Connect next to the host app, and call it from the host's backend.

```
npm install
PORT=3000 npm start
```

- Never call it directly from a browser page on another origin. The server rejects other `Origin` values with 403.
- A reverse proxy must set `Host` to `localhost:<PORT>` or `127.0.0.1:<PORT>`, or the request gets a 403.
- The API has no login. The host backend must check who may send before it forwards a request.
- Do not bind it to anything other than `127.0.0.1`. Anyone who can reach it can send from the connected accounts.

### Inside a Node host

Load the modules directly and add them to the host's own routes.

```js
const wa = require('./social-connect/server/whatsapp');
const li = require('./social-connect/server/linkedin');

const onChange = () => publish({ whatsapp: wa.getStatus(), linkedin: li.getStatus() });
wa.init(onChange); // restores the saved login
li.init(onChange);

await wa.startLogin(); // resolves when login ends. Read getStatus() for the result.
await wa.send('919876543210', 'Hello');
const kind = await li.send('https://www.linkedin.com/in/username', 'Hello'); // 'message' or 'invite'
await wa.logout();
```

- Both modules keep one account's state per process.
- `server/browser.js` must stay next to them.
- The host must add its own access control. `server/index.js` provides the guards only in the separate-process method.

## HTTP API

Errors return `{ "error": "<message>" }`.

| Endpoint | Body | Success response | Side effect |
|---|---|---|---|
| `GET /api/status` | | `{ whatsapp: { state, qr }, linkedin: { state } }` | None |
| `GET /api/events` | | Server-sent events with the same JSON | None |
| `POST /api/whatsapp/connect` | | `{ ok: true }` at once. Follow progress through status. | Starts a hidden browser and shows a QR |
| `POST /api/whatsapp/send` | `{ number, message }` | `{ ok: true }` | **Sends a real message** |
| `POST /api/whatsapp/logout` | | `{ ok: true }` | Deletes the local login |
| `POST /api/linkedin/connect` | | `{ ok: true }` at once. Follow progress through status. | Opens a visible login window |
| `POST /api/linkedin/send` | `{ url, message }` | `{ ok: true, kind: "message" or "invite" }` | **Sends a real message or invitation** |
| `POST /api/linkedin/logout` | | `{ ok: true }` | Deletes the local login |

If the larger project exposes these to an AI agent as tools, make status and connect available freely, and require human approval for both send operations and both logout operations.

**Fields**
- `state`: `connected`, `disconnected` or `pending`.
- `qr`: a PNG data URL while WhatsApp waits for a scan, otherwise `null`. Show it as an image. It changes over time, so subscribe to events.
- `number`: country code and digits with no leading zero, such as `919876543210`. Spaces, `+`, `-` and brackets are removed.
- `url`: `https://www.linkedin.com/in/<profile>`.

**Connect flow for a host UI**
1. On load, read `/api/status` and subscribe to `/api/events`.
2. If `disconnected`, show Connect, which calls the connect endpoint.
3. While `pending`, show the QR for WhatsApp, or "sign in in the browser window" for LinkedIn.
4. If `connected`, enable the send form.

## Handling errors

| Status | Meaning | Automatic retry? |
|---|---|---|
| 400 | Invalid or missing input | No, fix the input |
| 403 | Blocked by the `Origin` or `Host` check | No, fix the setup |
| 404 | Number is not on WhatsApp | No |
| 409 | Not connected, session ended, service busy, or several LinkedIn chats open | Only for "busy" |
| 422 | LinkedIn can't do this: no button, Premium upsell, note refused or too long | No |
| 500 | Automation failed | **No, it may already have sent** |
| 502 | Send not confirmed | **No, it may already have sent** |
| 504 | WhatsApp chat did not load. Nothing was sent. | Yes, with a delay |

- Treat 500 and 502 as "unknown", and ask a person to check the chat. An automatic retry can send a duplicate.
- WhatsApp "Sent" means WhatsApp accepted the message, not that it was delivered.
- A LinkedIn `kind` of `invite` means the person is not a connection, so the text went as an invitation note. Notes over 300 characters are refused, and LinkedIn may allow less on some plans.

## Operational limits

- **Slow sends:** each send starts a browser and closes it afterwards. Give client requests a timeout of at least 3 minutes.
- **One action at a time per service:** a second request gets a 409 "busy". The host should queue requests.
- **No rate limiting:** add it in the host, and keep volume low.
- **Startup:** both services check saved logins when the server starts. WhatsApp shows `pending`, but LinkedIn shows `disconnected` until its check finishes, so don't treat that as logged out straight away. Connect is ignored during this check.
- **Site changes:** selectors depend on live LinkedIn and WhatsApp pages and can break without warning. Monitor send failures.
- **Logout:** this only deletes the local login. Remove the entry from the phone's Linked devices list too.

## Data and security

- `.sessions/whatsapp-web` and `.sessions/linkedin-chrome` hold live account sessions. Treat them as passwords: keep them out of git, backups and logs, and don't copy them between machines.
- `.sessions/*-last-failure.json` holds page structure on failure. It has no message text, but can include contact names.
- Message text passes through the browser and is not stored by this app.
- Any local process can call the API or reach the browser's debugging port while it is open. Only run this on machines the account owner trusts.

## Changes the larger project will probably need

These are not built yet.

- **Configurable data folder:** `.sessions/` is fixed to the project folder, which fails if the app is installed read-only, such as in a packaged desktop app.
- **Several accounts or users:** each process supports one WhatsApp and one LinkedIn account. Options are one process per user, or moving module state and profile paths into per-user objects.
- **Hosted deployment:** this design assumes each user's own computer. Hosting needs user login, per-user sessions, a new LinkedIn login flow and an account-risk review.
- **Allowed origins:** a host frontend calling the API directly needs a change to the checks in `server/index.js`, plus CORS. Calling through the host's backend avoids this.
- **API authentication:** add a shared token if other local processes shouldn't be able to send.
- **Automatic tests:** export of `composeAndSend` and `sendOnPage` allows tests on fake pages.

## Official WhatsApp API

`server/whatsapp-cloud.js` is not connected to anything. It would need a Meta app, a WhatsApp Business Account, a permanent access token and outbound access to `graph.facebook.com`. It can't use personal numbers, and free text is limited to 24 hours after the recipient's last message. Offering it to other businesses also requires Tech Provider approval and a hosted service for Embedded Signup.

## Checking an integration

1. Start the server and confirm `/api/status` responds from the host backend.
2. Connect both services and confirm the status changes to `connected`.
3. Send one test message per service to a contact who has agreed, and check it arrived.
4. Restart the server and confirm both return to `connected` with no new login.
5. Send a request with `Origin: https://example.com` and confirm a 403.
6. From another machine, confirm the port can't be reached.
