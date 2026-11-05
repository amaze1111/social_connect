# Social Connect

Local web app that sends WhatsApp and LinkedIn messages from the user's own accounts. The user authorizes each service once, and the login persists across sessions and days.

## Run

```
npm install
npm start
```

Open http://localhost:3000. `PORT` overrides the port. Requires Chrome or Edge installed on the machine.

This project will be integrated into a larger project. See `INTEGRATION.md`, and keep it updated when the API, permissions or limits change.

## Layout

- `server/index.js`: Express app, REST and SSE (`/api/events`) endpoints, local-only guards.
- `server/browser.js`: finds Chrome or Edge per OS, starts it as a normal process, attaches over CDP.
- `server/whatsapp.js`: WhatsApp Web automation. This is the code in use.
- `server/linkedin.js`: LinkedIn automation.
- `server/whatsapp-cloud.js`: official Cloud API client. Nothing loads it. Kept for possible automatic business sending later.
- `public/`: vanilla JS frontend, one card per service.
- `.sessions/`: login profiles and failure diagnostics. Contains secrets and is gitignored.

## Requirements

- Each card shows a status indicator on every load. If not connected, the authorization flow starts from that same card.
- WhatsApp: number, message, Send. LinkedIn: profile URL, message, Send. All disabled until that service is connected.
- WhatsApp Send must complete with no user action after the one-time QR scan.

## Constraints that are not obvious from the code

- **Do not launch browsers with Playwright.** Google blocks SSO in Playwright-launched browsers. Start the real browser with `browser.js` and attach over CDP.
- **Reach LinkedIn chat through its iframe.** The chat and message box render in a `/preload/` iframe. Real pointer clicks on them time out, probably because of a layer on the main page. Focus and press these elements directly with `evaluate`, and search every frame.
- **LinkedIn's first `main section` is not only the top card.** It can include other people's posts. Accept a Connect button only if its `aria-label` contains the profile's first name, so the invitation can't go to the wrong person.
- **WhatsApp has no usable delivery tick.** `.message-out` and tick `data-icon` selectors did not match the live page. "Sent" means the composer emptied, the text shows in the chat, and nothing looks pending for 3s. Keep the browser open until then, or a queued message could be lost.
- **`whatsapp-web.js` was removed.** Its QR flow hit "Can't link device" on the phone. Do not reintroduce it without a reason.
- **The official Cloud API cannot use personal numbers.** It also limits free text to the 24h customer service window, which is why it isn't the main route.
- **One browser per profile.** Each module's `busy` flag enforces this. A second Chrome on the same profile fails or hangs.
- **Security.** The server binds to `127.0.0.1` and rejects requests with another `Origin` or `Host`. Keep this unless the hosting model changes.

## Testing

- There is no test suite in the repo yet. Earlier tests were throwaway scripts running against fake pages with `page.route`.
- Export page-level functions (`composeAndSend`, `sendOnPage`) and test them on fake pages. Those functions take a Playwright page, so they need no real profile.
- Do not delete or test against `.sessions/whatsapp-web` or `.sessions/linkedin-chrome`. They hold the user's real logins.
- Never send a real message or invitation without the user's approval. Use no-send checks on live pages when possible.
- On a send failure, read `.sessions/linkedin-last-failure.json` or `.sessions/whatsapp-last-failure.json`. They hold page structure, not message text, but can include contact names.

## Risk

WhatsApp and LinkedIn automation is unofficial and can get accounts restricted or banned. LinkedIn pages load bot detection frames. Keep test volume low and do not add detection evasion.
