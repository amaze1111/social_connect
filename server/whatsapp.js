// WhatsApp Web automation through the user's real Chrome/Edge, on its own saved profile.
// Unofficial: WhatsApp's terms restrict automation, so accounts carry a ban risk.
// The QR is shown in the app; the user scans it once, then sends run with no user action.
const path = require('path');
const fs = require('fs');
const { launch, shutdown } = require('./browser');

const PROFILE_DIR = path.join(__dirname, '..', '.sessions', 'whatsapp-web');
const DIAGNOSTICS_FILE = path.join(__dirname, '..', '.sessions', 'whatsapp-last-failure.json');
const LOGIN_MS = 5 * 60 * 1000;
const COMPOSER = 'footer [contenteditable="true"]';
const SEND_BUTTON = 'footer button[aria-label="Send"], footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"]';

const state = { state: 'disconnected', qr: null };
let notify = () => {};
let busy = false; // one Chrome per profile at a time

function set(patch) {
  Object.assign(state, patch);
  notify();
}

function getStatus() {
  return { state: state.state, qr: state.qr };
}

function err(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Null while the page is navigating.
function readPage(page) {
  return page
    .evaluate((composerSelector) => {
      let socket;
      try {
        socket = window.require?.('WAWebSocketModel')?.Socket?.state;
      } catch {}
      const composer = document.querySelector(composerSelector);
      const dialog = document.querySelector('[role="dialog"], [data-animate-modal-popup]');
      const canvas = document.querySelector('canvas');
      let qr = null;
      try {
        qr = canvas ? canvas.toDataURL('image/png') : null;
      } catch {}
      return {
        socket,
        side: !!document.querySelector('#side'),
        qr,
        composerText: composer ? composer.innerText.trim() : null,
        invalid: !!dialog && /invalid/i.test(dialog.innerText),
      };
    }, COMPOSER)
    .catch(() => null);
}

const isUnpaired = (s) => s.socket === 'UNPAIRED' || s.socket === 'UNPAIRED_IDLE';
const isLoggedIn = (s) => s.side || s.socket === 'CONNECTED';

async function openPage(h) {
  const page = h.context.pages()[0] || (await h.context.newPage());
  await page.goto('https://web.whatsapp.com/', { waitUntil: 'domcontentloaded' });
  return page;
}

// Check saved session on startup.
async function init(onChange) {
  if (onChange) notify = onChange;
  if (!fs.existsSync(PROFILE_DIR)) return set({ state: 'disconnected', qr: null });
  busy = true;
  set({ state: 'pending', qr: null });
  let h;
  let connected = false;
  try {
    h = await launch(PROFILE_DIR, true);
    const page = await openPage(h);
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      const s = await readPage(page);
      if (s && isLoggedIn(s)) {
        connected = true;
        break;
      }
      if (s && isUnpaired(s)) break;
      await sleep(1000);
    }
  } catch (e) {
    console.error('WhatsApp check failed:', e.message);
  } finally {
    if (h) await shutdown(h);
    busy = false;
    set({ state: connected ? 'connected' : 'disconnected', qr: null });
  }
}

// Shows the QR in the app until the phone links, the QR expires, or time runs out.
async function startLogin() {
  if (busy) return;
  busy = true;
  set({ state: 'pending', qr: null });
  let h;
  let connected = false;
  try {
    h = await launch(PROFILE_DIR, true);
    const page = await openPage(h);
    const deadline = Date.now() + LOGIN_MS;
    let shownQr = false;
    while (Date.now() < deadline) {
      const s = await readPage(page);
      if (s) {
        if (isLoggedIn(s)) {
          connected = true;
          break;
        }
        if (s.qr && s.qr !== state.qr) {
          shownQr = true;
          set({ qr: s.qr });
        }
        if (shownQr && s.socket === 'UNPAIRED_IDLE') break; // QR expired
      }
      await sleep(1000);
    }
    if (connected) {
      set({ qr: null });
      // First sync after linking: closing too early can lose the new session.
      const syncDeadline = Date.now() + 120000;
      while (Date.now() < syncDeadline) {
        const s = await readPage(page);
        if (s && s.side) break;
        await sleep(1000);
      }
      await sleep(5000);
    }
  } catch (e) {
    console.error('WhatsApp login failed:', e.message);
  } finally {
    if (h) await shutdown(h);
    busy = false;
    set({ state: connected ? 'connected' : 'disconnected', qr: null });
  }
}

// Goes straight to the page that wa.me's "Continue to WhatsApp Web" button links to.
async function sendOnPage(page, number, message, limits = { ready: 90000, confirm: 30000, settle: 3000 }) {
  const url = `https://web.whatsapp.com/send/?phone=${number}&text=${encodeURIComponent(message)}&type=phone_number&app_absent=0`;
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const ready = Date.now() + limits.ready;
  for (;;) {
    const s = await readPage(page);
    if (s) {
      if (isUnpaired(s)) {
        set({ state: 'disconnected', qr: null });
        throw err('WhatsApp session ended. Reconnect.', 409);
      }
      if (s.invalid) throw err('This number is not on WhatsApp. Nothing was sent.', 404);
      if (s.composerText) break;
    }
    if (Date.now() > ready) throw err('WhatsApp chat did not load. Nothing was sent.', 504);
    await sleep(500);
  }
  await sleep(500);

  const sendBtn = page.locator(SEND_BUTTON).first();
  if (await sendBtn.count()) await sendBtn.click();
  else await page.locator(COMPOSER).first().press('Enter');

  // WhatsApp's markup has no stable delivery tick to read, so "sent" means: the box emptied,
  // the text shows in the chat, and nothing looks pending for a few seconds.
  // Closing the browser sooner could lose a message still queued.
  const word = (message.match(/[\p{L}\p{N}]{2,}/u) || [''])[0];
  const confirm = Date.now() + limits.confirm;
  let okSince = 0;
  for (;;) {
    const ok = await page
      .evaluate(
        ({ composerSelector, word }) => {
          const composer = document.querySelector(composerSelector);
          if (composer && composer.innerText.trim()) return false;
          const chat = document.querySelector('#main') || document.body;
          if (word && !chat.innerText.includes(word)) return false;
          return !chat.querySelector('[data-icon*="time"], [data-icon*="clock"], [aria-label*="Pending" i]');
        },
        { composerSelector: COMPOSER, word },
      )
      .catch(() => false);
    if (!ok) okSince = 0;
    else if (!okSince) okSince = Date.now();
    else if (Date.now() - okSince >= limits.settle) return;
    if (Date.now() > confirm) throw err('Send not confirmed. Check WhatsApp before retrying.', 502);
    await sleep(250);
  }
}

// Page structure only, never message text, to diagnose selector failures.
async function saveDiagnostics(page, reason) {
  try {
    const info = await page.evaluate(() => {
      const icons = (el) => [...(el?.querySelectorAll('[data-icon]') || [])].map((i) => i.getAttribute('data-icon')).slice(0, 30);
      const all = document.querySelectorAll('.message-out');
      return {
        hasMain: !!document.querySelector('#main'),
        chatIcons: [...new Set(icons(document.querySelector('#main')))],
        outgoingById: document.querySelectorAll('#main [data-id^="true_"]').length,
        url: location.origin + location.pathname,
        hasSide: !!document.querySelector('#side'),
        hasFooter: !!document.querySelector('footer'),
        editors: [...document.querySelectorAll('[contenteditable="true"]')].map((e) => ({
          inFooter: !!e.closest('footer'),
          aria: (e.getAttribute('aria-label') || '').slice(0, 40),
        })),
        footerIcons: icons(document.querySelector('footer')),
        outgoingCount: all.length,
        lastOutgoingIcons: icons(all[all.length - 1]),
        dialogs: document.querySelectorAll('[role="dialog"], [data-animate-modal-popup]').length,
      };
    });
    fs.mkdirSync(path.dirname(DIAGNOSTICS_FILE), { recursive: true });
    fs.writeFileSync(DIAGNOSTICS_FILE, JSON.stringify({ reason: reason.split('\n')[0], ...info }, null, 2));
    console.error('WhatsApp send failed. Diagnostics saved:', DIAGNOSTICS_FILE);
  } catch (e) {
    console.error('Could not save diagnostics:', e.message);
  }
}

async function send(number, message) {
  if (state.state !== 'connected') throw err('WhatsApp not connected', 409);
  const digits = String(number).replace(/[\s+()-]/g, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) {
    throw err('Use country code + digits, with no leading zero, e.g. 919876543210', 400);
  }
  if (busy) throw err('WhatsApp is busy. Try again in a moment.', 409);
  busy = true;
  let h;
  try {
    h = await launch(PROFILE_DIR, true);
    const page = h.context.pages()[0] || (await h.context.newPage());
    await sendOnPage(page, digits, message);
  } catch (e) {
    if (h && h.context.pages()[0]) await saveDiagnostics(h.context.pages()[0], e.message);
    if (!e.status) {
      e.status = 500;
      e.message = 'WhatsApp automation failed: ' + e.message.split('\n')[0];
    }
    throw e;
  } finally {
    if (h) await shutdown(h);
    busy = false;
  }
}

// Removes this app's login. The phone's Linked devices list may still show the entry.
async function logout() {
  if (busy) throw err('WhatsApp is busy. Try again in a moment.', 409);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  set({ state: 'disconnected', qr: null });
}

module.exports = { init, startLogin, getStatus, send, logout, sendOnPage };
