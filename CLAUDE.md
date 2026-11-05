# Social Connect

Lets users of a web portal send WhatsApp and LinkedIn messages from their own personal accounts. Each user connects once, and the login persists across sessions and days.

The chosen architecture is a browser extension that the portal calls. See `INTEGRATION.md`, and keep it updated when the API, permissions or limits change.

## Run

- Extension: load `browser_extension/` unpacked at `chrome://extensions`.
- Portal demo: `npm install`, `npm run demo`, then open http://localhost:4173 and paste the extension ID.
- Earlier local server: `npm start`, then open http://localhost:3000. Requires Chrome or Edge.

## Layout

- `browser_extension/background.js`: service worker. Handles portal requests, tabs, queues, rate limits.
- `browser_extension/page-functions.js`: functions injected into WhatsApp and LinkedIn pages. Each must be self-contained.
- `browser_extension/portal-client.js`: client the portal includes.
- `examples/`: demo portal page and its server.
- `server/`, `public/`: earlier single-user version, proven on real accounts. Keep as a reference until the extension is proven.
- `server/whatsapp-cloud.js`: official Cloud API client. Nothing loads it.
- `.sessions/`: real logins and failure diagnostics for the local server. Contains secrets and is gitignored.

## Requirements

- Each service shows a status indicator on every load. If not connected, authorization starts from that same place.
- WhatsApp: number, message, Send. LinkedIn: profile URL, message, Send. All disabled until that service is connected.
- WhatsApp Send must complete with no user action after the one-time login.

## Constraints that are not obvious from the code

- **Reach LinkedIn chat through its iframe.** The chat and message box render in a `/preload/` iframe. Search every frame. In the server version, real pointer clicks on them timed out, so press these elements directly.
- **LinkedIn's first `main section` is not only the top card.** It can include other people's posts. Accept a Connect button only if its `aria-label` contains the profile's first name, so the invitation can't go to the wrong person.
- **WhatsApp has no usable delivery tick.** `.message-out` and tick `data-icon` selectors did not match the live page. "Sent" means the composer emptied, the text shows in the chat, and nothing looks pending for 3s. Keep the tab open until then, or a queued message could be lost.
- **WhatsApp Web allows one active tab per browser.** The extension reuses an existing tab.
- **Google blocks SSO in Playwright-launched browsers.** The server version starts the real browser and attaches over CDP. The extension avoids this by using the user's own browser.
- **`whatsapp-web.js` was removed.** Its QR flow hit "Can't link device" on the phone.
- **The official Cloud API cannot use personal numbers.**
- **Do not add detection evasion.** The rate limits protect accounts and must not be bypassable from the portal.

## Testing

- There is no test suite in the repo yet. Earlier tests were throwaway scripts.
- To test the extension, load it in Playwright's Chromium (`channel: 'chromium'`, `--load-extension`). Branded Chrome no longer accepts that flag.
- **Playwright's `route` does not catch the first load in a tab the extension opens, so that request reaches the real site.** Use `--host-resolver-rules` to map the sites to a local HTTPS server and block all other hosts.
- For the server version, test `composeAndSend` and `sendOnPage` on fake pages.
- Do not delete or test against `.sessions/whatsapp-web` or `.sessions/linkedin-chrome`. They hold the user's real logins.
- Never send a real message or invitation without the user's approval. Use no-send checks on live pages when possible.

## Risk

WhatsApp and LinkedIn automation is unofficial and can get accounts restricted or banned. LinkedIn pages load bot detection frames. Keep test volume low.
