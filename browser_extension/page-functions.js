// Functions passed to chrome.scripting.executeScript. Each runs inside the page,
// so it can't use anything outside itself. The two helpers at the top run in the service worker.

const isUnpaired = (s) => s.socket === 'UNPAIRED' || s.socket === 'UNPAIRED_IDLE';
const isLoggedIn = (s) => s.side || s.socket === 'CONNECTED';

// --- WhatsApp Web ---

function waRead() {
  let socket;
  try {
    socket = window.require?.('WAWebSocketModel')?.Socket?.state;
  } catch {}
  const composer = document.querySelector('footer [contenteditable="true"]');
  const dialog = document.querySelector('[role="dialog"], [data-animate-modal-popup]');
  return {
    socket,
    side: !!document.querySelector('#side'),
    composerText: composer ? composer.innerText.trim() : null,
    invalid: !!dialog && /invalid/i.test(dialog.innerText),
  };
}

function waPressSend() {
  const icon = document.querySelector(
    'footer button[aria-label="Send"], footer [data-icon="send"], footer [data-icon="wds-ic-send-filled"], footer [data-icon*="send"]',
  );
  if (icon) {
    (icon.closest('button') || icon).click();
    return 'button';
  }
  const composer = document.querySelector('footer [contenteditable="true"]');
  composer.focus();
  composer.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true }));
  return 'enter';
}

// WhatsApp has no stable delivery tick to read, so this means: accepted, not delivered.
function waIsSent(word) {
  const composer = document.querySelector('footer [contenteditable="true"]');
  if (composer && composer.innerText.trim()) return false;
  const chat = document.querySelector('#main') || document.body;
  if (word && !chat.innerText.includes(word)) return false;
  return !chat.querySelector('[data-icon*="time"], [data-icon*="clock"], [aria-label*="Pending" i]');
}

// --- LinkedIn ---

// The first section can also hold other people's posts. Only accept a Connect button
// labelled with this profile's name, so an invitation can't go to the wrong person.
async function liClickAction(message) {
  const topCard = document.querySelector('main section');
  if (!topCard) return 'none';
  const visible = (el) => el.getClientRects().length > 0;
  const named = (pattern) =>
    [...topCard.querySelectorAll('button, a, [role="button"]')].filter(
      (el) => visible(el) && pattern.test((el.innerText || '').trim()),
    );
  const firstName = document.title.replace(/^\(\d+\+?\)\s*/, '').split('|')[0].trim().toLowerCase().split(/\s+/)[0];
  const findConnect = () =>
    named(/^connect$/i).find((el) => firstName && (el.getAttribute('aria-label') || '').toLowerCase().includes(firstName));

  let connect = findConnect();
  if (!connect) {
    // 3rd-degree profiles often keep Connect inside the More menu.
    const more = named(/^more( actions)?$/i)[0];
    if (more) {
      more.click();
      await new Promise((r) => setTimeout(r, 500));
      connect = findConnect();
      if (!connect) more.click();
    }
  }
  if (connect) {
    if (message.length > 300) return 'too-long';
    connect.click();
    return 'invite';
  }
  const msg = named(/^message$/i)[0];
  if (!msg) return 'none';
  msg.click();
  return 'message';
}

function liEditorCount() {
  const all = document.querySelectorAll(
    '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][aria-label*="message" i]',
  );
  return [...all].filter((el) => el.getClientRects().length > 0).length;
}

async function liTypeAndSend(message) {
  const box = [...document.querySelectorAll(
    '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][aria-label*="message" i]',
  )].find((el) => el.getClientRects().length > 0);
  if (!box) return 'not-typed';
  box.focus();
  document.execCommand('insertText', false, message);
  if (!box.innerText.trim()) return 'not-typed';
  const button = () =>
    document.querySelector('button.msg-form__send-button') ||
    [...document.querySelectorAll('button[type="submit"]')].find((b) => /send/i.test(b.innerText));
  for (let i = 0; i < 25; i++) {
    const b = button();
    if (b && !b.disabled) {
      b.click();
      return 'pressed';
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return 'disabled';
}

function liEditorIsEmpty() {
  const box = document.querySelector(
    '.msg-form__contenteditable[contenteditable="true"], [contenteditable="true"][aria-label*="message" i]',
  );
  return !box || !box.innerText.trim();
}

function liClickAddNote() {
  const b = [...document.querySelectorAll('button')].find(
    (el) => el.getClientRects().length > 0 && /^add a note$/i.test((el.innerText || '').trim()),
  );
  if (!b) return false;
  b.click();
  return true;
}

function liHasNoteBox() {
  const t = document.querySelector('textarea[name="message"], [role="dialog"] textarea');
  return !!t && t.getClientRects().length > 0;
}

async function liFillAndSendNote(message) {
  const t = document.querySelector('textarea[name="message"], [role="dialog"] textarea');
  if (!t) return false;
  // React ignores a plain value change, so use the native setter and fire input.
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(t, message);
  t.dispatchEvent(new Event('input', { bubbles: true }));
  for (let i = 0; i < 25; i++) {
    const b = [...document.querySelectorAll('button')].find((el) =>
      /^send( invitation)?$/i.test((el.innerText || el.getAttribute('aria-label') || '').trim()),
    );
    if (b && !b.disabled) {
      b.click();
      return true;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  return false;
}

// --- Failure diagnostics: page structure only, never message text ---

function pageStructure() {
  const short = (s) => (s || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  const visible = (el) => el.getClientRects().length > 0;
  return {
    url: location.origin + location.pathname,
    hasSide: !!document.querySelector('#side'),
    hasFooter: !!document.querySelector('footer'),
    footerIcons: [...document.querySelectorAll('footer [data-icon]')].map((i) => i.getAttribute('data-icon')).slice(0, 20),
    chatIcons: [...new Set([...document.querySelectorAll('#main [data-icon]')].map((i) => i.getAttribute('data-icon')))].slice(0, 30),
    sections: document.querySelectorAll('main section').length,
    actions: [...document.querySelectorAll('main button, main [role="button"]')]
      .filter((el) => visible(el) && /^(connect|message|more)/i.test((el.innerText || '').trim()))
      .map((el) => ({ text: short(el.innerText), aria: short(el.getAttribute('aria-label')) }))
      .slice(0, 15),
    editors: [...document.querySelectorAll('[contenteditable="true"], textarea')].map((el) => ({
      tag: el.tagName,
      aria: short(el.getAttribute('aria-label')),
      visible: visible(el),
    })),
    dialogs: document.querySelectorAll('[role="dialog"]').length,
  };
}
