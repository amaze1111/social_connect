// LinkedIn via the user's real Chrome/Edge, driven over CDP.
// Google blocks sign-in inside Playwright-launched browsers ("browser may not be secure"),
// so the browser is started as a normal process (no automation flags) and only attached to afterwards.
const path = require('path');
const fs = require('fs');
const { launch: browserLaunch, shutdown } = require('./browser');

const PROFILE_DIR = path.join(__dirname, '..', '.sessions', 'linkedin-chrome');
const DIAGNOSTICS_FILE = path.join(__dirname, '..', '.sessions', 'linkedin-last-failure.json');
const state = { state: 'disconnected' };
let notify = () => {};
let busy = false; // one Chrome per profile at a time

function set(s) {
  state.state = s;
  notify();
}

function getStatus() {
  return { state: state.state };
}

function err(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

const launch = (headless) => browserLaunch(PROFILE_DIR, headless);

async function hasSession(context) {
  const cookies = await context.cookies('https://www.linkedin.com');
  return cookies.some((c) => c.name === 'li_at');
}

async function isLoggedIn(context) {
  if (!(await hasSession(context))) return false;
  const page = context.pages()[0] || (await context.newPage());
  await page.goto('https://www.linkedin.com/feed/', { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);
  const url = page.url();
  return url.includes('/feed') && !/login|authwall|checkpoint/.test(url);
}

// Check saved session on startup.
async function init(onChange) {
  if (onChange) notify = onChange;
  if (!fs.existsSync(PROFILE_DIR)) return set('disconnected');
  busy = true;
  let h;
  try {
    h = await launch(true);
    set((await isLoggedIn(h.context)) ? 'connected' : 'disconnected');
  } catch (e) {
    console.error('LinkedIn check failed:', e.message);
    set('disconnected');
  } finally {
    if (h) await shutdown(h);
    busy = false;
  }
}

// Visible browser; user signs in any way (password, Google SSO, 2FA). Profile persists.
async function startLogin() {
  if (busy) return;
  busy = true;
  set('pending');
  let h;
  let ok = false;
  try {
    h = await launch(false);
    let closed = false;
    h.browser.on('disconnected', () => (closed = true));
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto('https://www.linkedin.com/login');
    const deadline = Date.now() + 5 * 60 * 1000;
    while (Date.now() < deadline && !closed) {
      if (await hasSession(h.context).catch(() => false)) {
        ok = true;
        break;
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
    if (ok) await new Promise((r) => setTimeout(r, 2000)); // let cookies settle
  } catch (e) {
    console.error('LinkedIn login failed:', e.message);
  } finally {
    if (h) await shutdown(h);
    busy = false;
    set(ok ? 'connected' : 'disconnected');
  }
}

// LinkedIn may render dialogs and chat inside an iframe, so search every frame.
async function findVisible(page, selector, timeout) {
  const deadline = Date.now() + timeout;
  do {
    for (const frame of page.frames()) {
      const all = frame.locator(selector);
      const count = await all.count().catch(() => 0);
      const visible = [];
      for (let i = 0; i < count; i++) {
        if (await all.nth(i).isVisible().catch(() => false)) visible.push(all.nth(i));
      }
      if (visible.length) return { frame, visible };
    }
    await new Promise((r) => setTimeout(r, 300));
  } while (Date.now() < deadline);
  return null;
}

// Actions stay inside the profile's top card. Lower sections list other people,
// so a page-wide match could message or invite the wrong person.
async function composeAndSend(page, message) {
  await page.waitForSelector('main section', { timeout: 15000 });
  await page.waitForTimeout(1500); // top card buttons render after the shell
  const topCard = page.locator('main section').first();
  const clickable = 'button:visible, a:visible, [role="button"]:visible';
  const action = (name) =>
    topCard.locator(clickable).filter({ hasText: new RegExp(`^\\s*${name}\\s*$`, 'i') });

  // The first section can also hold activity posts by other people, whose Connect buttons
  // would invite the wrong person. Only accept a button labelled with this profile's name.
  const profileName = (await page.title()).replace(/^\(\d+\+?\)\s*/, '').split('|')[0].trim().toLowerCase();
  const firstName = profileName.split(/\s+/)[0];
  const findConnect = async () => {
    const all = action('Connect');
    for (let i = 0, n = await all.count(); i < n; i++) {
      const label = ((await all.nth(i).getAttribute('aria-label')) || '').toLowerCase();
      if (firstName && label.includes(firstName)) return all.nth(i);
    }
    return null;
  };

  // Connect only shows for people outside 1st-degree. Message there opens a Premium upsell.
  let connect = await findConnect();
  if (!connect) {
    // 3rd-degree profiles often keep Connect inside the More menu.
    const more = topCard.locator('button:visible').filter({ hasText: /^\s*More(\s+actions)?\s*$/i }).first();
    if (await more.count()) {
      await more.click({ timeout: 5000 }).catch(() => {});
      await page.waitForTimeout(500);
      connect = await findConnect();
      if (!connect) {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(300);
      }
    }
  }
  if (connect) {
    await sendInvite(page, connect, message);
    return 'invite';
  }

  const msgBtn = action('Message').first();
  if (!(await msgBtn.count())) throw err('No Message or Connect button on this profile', 422);
  await msgBtn.click();

  const editors = '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][aria-label*="message" i]';
  const found = await findVisible(page, editors, 15000);
  if (!found) throw err('Message box did not open. LinkedIn may require Premium for this profile.', 422);
  if (found.visible.length > 1) throw err('More than one chat is open. Nothing was sent.', 409);
  const box = found.visible[0];

  // Chat renders in an iframe under a layer of the main page, so pointer clicks never land.
  // Focus and press the elements directly instead.
  await box.evaluate((el) => el.focus());
  await page.keyboard.insertText(message);
  if (!(await box.innerText()).trim()) throw err('Could not type the message. Nothing was sent.', 500);

  const sendBtn = found.frame.locator('button.msg-form__send-button:visible, button[type="submit"]:visible:has-text("Send")').first();
  await sendBtn.waitFor({ timeout: 5000 });
  const enabledBy = Date.now() + 5000;
  while (await sendBtn.isDisabled()) {
    if (Date.now() > enabledBy) throw err('Send button stayed disabled. Nothing was sent.', 500);
    await new Promise((r) => setTimeout(r, 200));
  }
  await sendBtn.evaluate((b) => b.click());

  // LinkedIn empties the box once the message is accepted.
  const deadline = Date.now() + 8000;
  while ((await box.innerText().catch(() => '')).trim()) {
    if (Date.now() > deadline) throw err('Send not confirmed. Check LinkedIn before retrying.', 502);
    await new Promise((r) => setTimeout(r, 300));
  }
  return 'message';
}

async function sendInvite(page, connect, message) {
  if (message.length > 300) {
    throw err(`This person isn't a connection, so the message goes as an invitation note, limited to 300 characters. Yours has ${message.length}. Nothing was sent.`, 422);
  }
  await connect.click({ timeout: 5000 });
  // Dialogs can render in the iframe under a page layer, so press these elements directly.
  const addNote = await findVisible(page, 'button:has-text("Add a note")', 8000);
  if (!addNote) throw err('Could not add a note to the invitation. Nothing was sent.', 422);
  await addNote.visible[0].evaluate((b) => b.click());
  const note = await findVisible(page, 'textarea[name="message"], [role="dialog"] textarea', 8000);
  if (!note) throw err('LinkedIn did not allow a note, possibly a monthly limit. Nothing was sent.', 422);
  await note.visible[0].fill(message);
  const sendBtn = note.frame.getByRole('button', { name: /^Send( invitation)?$/i }).first();
  const enabledBy = Date.now() + 5000;
  while (await sendBtn.isDisabled({ timeout: 5000 })) {
    if (Date.now() > enabledBy) throw err('LinkedIn would not accept this note, possibly too long for your plan. Nothing was sent.', 422);
    await new Promise((r) => setTimeout(r, 200));
  }
  await sendBtn.evaluate((b) => b.click());
  await note.visible[0].waitFor({ state: 'hidden', timeout: 8000 }).catch(() => {
    throw err('Send not confirmed. Check LinkedIn before retrying.', 502);
  });
}

// Page structure only, never message text, to diagnose selector failures.
async function saveDiagnostics(page, reason) {
  try {
    const frames = [];
    for (const frame of page.frames()) {
      frames.push(
        await frame
          .evaluate(() => {
            const short = (s) => (s || '').trim().replace(/\s+/g, ' ').slice(0, 60);
            const visible = (el) => el.getClientRects().length > 0;
            return {
              url: location.origin + location.pathname,
              sections: document.querySelectorAll('main section').length,
              connectLabels: [...document.querySelectorAll('main button, main a, main [role="button"]')]
                .filter((el) => /^(connect|more)/i.test((el.innerText || '').trim()))
                .map((el) => ({ text: short(el.innerText), aria: short(el.getAttribute('aria-label')), visible: visible(el) }))
                .slice(0, 15),
              topCardActions: [...(document.querySelector('main section')?.querySelectorAll('button, a') || [])]
                .filter(visible)
                .map((el) => short(el.innerText))
                .filter(Boolean)
                .slice(0, 30),
              editors: [...document.querySelectorAll('[contenteditable="true"], textarea, [role="textbox"]')].map((el) => ({
                tag: el.tagName,
                cls: short(el.className),
                aria: short(el.getAttribute('aria-label')),
                visible: visible(el),
              })),
              dialogs: [...document.querySelectorAll('[role="dialog"]')].map((el) => short(el.getAttribute('aria-label'))),
            };
          })
          .catch((e) => ({ url: frame.url().split('?')[0], error: e.message.split('\n')[0] })),
      );
    }
    fs.mkdirSync(path.dirname(DIAGNOSTICS_FILE), { recursive: true });
    fs.writeFileSync(DIAGNOSTICS_FILE, JSON.stringify({ reason: reason.split('\n')[0], frames }, null, 2));
    console.error('LinkedIn send failed. Diagnostics saved:', DIAGNOSTICS_FILE);
  } catch (e) {
    console.error('Could not save diagnostics:', e.message);
  }
}

async function send(url, message) {
  if (state.state !== 'connected') throw err('LinkedIn not connected', 409);
  if (!/^https:\/\/([a-z]{2,3}\.)?linkedin\.com\/in\/[^/\s]+\/?/i.test(url)) {
    throw err('Invalid URL. Use https://www.linkedin.com/in/<profile>', 400);
  }
  if (busy) throw err('LinkedIn is busy. Try again in a moment.', 409);
  busy = true;
  let h;
  try {
    h = await launch(true);
    const page = h.context.pages()[0] || (await h.context.newPage());
    await page.goto(url, { waitUntil: 'domcontentloaded' });
    if (/login|authwall/.test(page.url())) {
      set('disconnected');
      throw err('LinkedIn session expired. Reconnect.', 409);
    }
    return await composeAndSend(page, message);
  } catch (e) {
    if (h) await saveDiagnostics(h.context.pages()[0], e.message);
    if (!e.status) {
      e.status = 500;
      e.message = 'LinkedIn automation failed: ' + e.message.split('\n')[0];
    }
    throw e;
  } finally {
    if (h) await shutdown(h);
    busy = false;
  }
}

async function logout() {
  if (busy) throw err('LinkedIn is busy. Try again in a moment.', 409);
  fs.rmSync(PROFILE_DIR, { recursive: true, force: true });
  set('disconnected');
}

module.exports = { init, startLogin, getStatus, send, logout, composeAndSend };
