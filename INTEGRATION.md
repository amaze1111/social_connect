# Integrating Social Connect

Adds WhatsApp and LinkedIn sending to a web portal. Users log into the portal with their authorized credentials, connect their personal accounts, and send from those accounts.

## How it works

```
Portal page  ->  portal-client.js  ->  Browser extension  ->  User's WhatsApp Web and LinkedIn tabs
```

- The extension in `browser_extension/` runs in the user's own Chrome or Edge and reuses that browser's logins.
- Your servers never see or store WhatsApp or LinkedIn sessions, and sends come from the user's own IP.
- The portal needs no backend changes to send. It calls the extension from its pages.

## Status

- **Extension:** tested only on local fake pages. It has not yet sent through real WhatsApp or LinkedIn. Selectors come from the earlier server version, and clicks now run differently, so expect some fixes.
- **Earlier local server (`server/`):** confirmed on real accounts on Windows: WhatsApp send, LinkedIn 1st-degree message, and the LinkedIn 3rd-degree flow.
- **Not yet confirmed:** logins surviving several days, sending from a background tab on real sites, and macOS or Linux.
- There is no automated test suite in the repo yet.

## Requirements

| Item | Requirement |
|---|---|
| User's browser | Desktop Chrome or Edge. Phones and Firefox aren't supported. |
| Portal | Served over HTTPS at a known domain (`localhost` is allowed for development) |
| Portal code | Any stack. Include `browser_extension/portal-client.js` on the page. |
| Node.js | Only for the local demo and the earlier server |

## Permissions

**Extension permissions in `manifest.json`**

| Permission | Why |
|---|---|
| `tabs` | Open, reuse and close the WhatsApp and LinkedIn tabs |
| `scripting` | Press buttons and read status in those pages |
| `cookies` | Check that LinkedIn's `li_at` login cookie exists. The value is not read or sent anywhere. |
| `storage` | Remember connection state, rate limits and failure diagnostics, locally |
| `https://web.whatsapp.com/*`, `https://www.linkedin.com/*` | The only sites it can act on |

**Accounts**
- No API keys, OAuth scopes or Meta permissions.
- WhatsApp uses one linked device slot, if the user isn't already logged in there.

**End-user consent**
- This is unofficial automation of WhatsApp and LinkedIn, and can get accounts restricted or banned.
- Get each user's informed consent before connecting, and take legal advice on LinkedIn's and WhatsApp's terms before launch.

## Setup

### 1. Allow your portal's domain

In `browser_extension/manifest.json`, replace or extend:

```json
"externally_connectable": { "matches": ["https://portal.example.com/*"] }
```

Only listed origins can call the extension. Remove `http://localhost/*` from production builds.

### 2. Install the extension

- **Development:** open `chrome://extensions`, turn on Developer mode, choose **Load unpacked**, and select `browser_extension/`. Copy the ID it shows.
- **Production:** publish it through the Chrome Web Store, or deploy it through your organization's browser management. The store's review may reject this kind of automation, so check its policies early. Company-managed deployment avoids that dependency.

The ID changes between an unpacked install and a published one, so keep it in portal configuration.

### 3. Call it from the portal

```html
<script src="/portal-client.js"></script>
<script>
  const social = new SocialConnectClient(EXTENSION_ID);

  if (!(await social.isInstalled())) {
    // Show an "Install the extension" prompt.
  }

  const { whatsapp, linkedin } = await social.status();
  // Each has state: 'connected', 'disconnected' or 'pending'.

  await social.connect('whatsapp'); // Opens the real site in a tab for login.

  await social.send({ service: 'whatsapp', number: '919876543210', message: 'Hello' });
  const r = await social.send({ service: 'linkedin', url: 'https://www.linkedin.com/in/username', message: 'Hello' });
  // r.kind is 'message', or 'invite' if the text went as an invitation note.
</script>
```

`examples/portal-demo.html` is a working example with the connect indicator and disabled forms. Run `npm run demo`, then open http://localhost:4173.

### 4. Connect flow in the portal UI

1. On page load, call `status()` and poll it every few seconds.
2. If `disconnected`, show Connect. It opens WhatsApp Web or LinkedIn in a new tab for the user to log in. Users already logged in there connect with no extra step.
3. While `pending`, show a waiting state.
4. If `connected`, enable the send form. Otherwise keep the fields and Send disabled.

There is no Disconnect in the extension. Users sign out of WhatsApp Web or LinkedIn in their browser.

## Handling errors

Failed calls throw an `Error` with `status` and `message`.

| Status | Meaning | Automatic retry? |
|---|---|---|
| 400 | Invalid number, URL or missing message | No |
| 404 | Number is not on WhatsApp | No |
| 409 | Not connected, session ended, tab closed or several chats open | No |
| 422 | LinkedIn can't do this: no button, Premium upsell, note refused or too long | No |
| 429 | Rate limit. Nothing was sent. | After the wait in the message |
| 500 | Automation failed | **No, unless the message says nothing was sent** |
| 502 | Send not confirmed | **No, it may already have sent** |
| 503 | Extension missing or unreachable | After the user installs or enables it |
| 504 | Page or chat did not load. Nothing was sent. | Yes, with a delay |

- For an unknown result, ask the user to check the chat. An automatic retry can send a duplicate.
- WhatsApp "ok" means WhatsApp accepted the message, not that it was delivered.
- LinkedIn invitation notes over 300 characters are refused. LinkedIn may allow less on some plans.

## Limits and behaviour

- **Rate limits, per service, per browser:** one send every 15s and 50 per day, set by `LIMITS` in `background.js`. The portal can't override them. Treat these as starting values, not safe limits.
- **One send at a time per service:** further sends wait in a queue.
- **The browser must be open:** the extension can't send when Chrome is closed.
- **Tabs:** LinkedIn sends open a background tab and close it afterwards. WhatsApp allows one active tab, so if the user has WhatsApp Web open, the extension navigates that tab to the chat, which could disturb what they are doing.
- **Startup check:** on the first status call of a browser session, a known WhatsApp user sees `pending` while an inactive tab checks the login. This tab closes by itself.
- **Site changes:** selectors depend on live pages and can break without warning. Monitor send failures, and plan to ship extension updates quickly.

## Security

- **Portal access control:** the extension trusts any page on an allowed origin, and it can't tell which portal user is logged in. Your portal must only show sending to authorized users.
- **XSS:** a script injected into the portal could send messages from the user's accounts, limited by the rate limits. Use a strict Content Security Policy and keep untrusted content off these pages.
- **Compliance records:** the extension keeps no record of sent messages. If you need an audit trail, the portal must record it.
- **Diagnostics:** after a failed send, `lastFailure_whatsapp` or `lastFailure_linkedin` in `chrome.storage.local` holds page structure, and no message text, but it can include contact names. It stays in the user's browser.

## Debugging

1. Open `chrome://extensions`, then **Service worker** under Social Connect.
2. In the console, run `chrome.storage.local.get(console.log)`.

## Checking an integration

1. Load the extension and add your portal's origin.
2. Confirm `isInstalled()` is true on the portal, and that a page on another domain can't reach the extension.
3. Connect both services and confirm `connected`.
4. Send one test per service to a contact who has agreed, and check it arrived.
5. Restart the browser and confirm both return to `connected` with no new login.
6. Send twice within 15s and confirm the 429.

## Earlier local server

`server/` and `public/` are the single-user version, run with `npm start`. It's useful for comparing behaviour on real pages. It has a separate browser profile and login, listens on `127.0.0.1` only, and has no user accounts, so don't expose it to a network.

`server/whatsapp-cloud.js` is the official API client, and nothing loads it. It can't use personal numbers, so it only suits an optional automatic route for business numbers later.
