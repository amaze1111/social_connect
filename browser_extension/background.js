// Service worker. Only origins in manifest.json's externally_connectable can call it.
// It uses the user's own browser logins, so no session data leaves this browser.
importScripts('page-functions.js');

// Protects users' accounts from bans and limits harm if the portal misbehaves. Not bypassable from the portal.
const LIMITS = { minGapMs: 15000, perDay: 50 };
const LOGIN_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fail = (error, status) => Object.assign(new Error(error), { status });
const queues = { whatsapp: Promise.resolve(), linkedin: Promise.resolve() };
const connecting = { whatsapp: false, linkedin: false };

async function run(tabId, func, args = [], { world = 'ISOLATED', allFrames = false, frameId } = {}) {
  const target = frameId === undefined ? { tabId, allFrames } : { tabId, frameIds: [frameId] };
  try {
    return await chrome.scripting.executeScript({ target, func, args, world });
  } catch {
    return []; // tab is navigating or closed
  }
}

async function runOne(tabId, func, args, options) {
  const [result] = await run(tabId, func, args, options);
  return result ? result.result : null;
}

async function waitForLoad(tabId) {
  for (let i = 0; i < 60; i++) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw fail('The tab was closed. Nothing was sent.', 409);
    if (tab.status === 'complete') return;
    await sleep(500);
  }
  throw fail('The page did not load. Nothing was sent.', 504);
}

// WhatsApp Web allows one active tab per browser, so reuse the user's tab if there is one.
async function whatsappTab(url, active = false) {
  const [existing] = await chrome.tabs.query({ url: 'https://web.whatsapp.com/*' });
  if (existing) {
    const tab = await chrome.tabs.update(existing.id, active ? { url, active: true } : { url });
    return { id: tab.id, created: false };
  }
  const tab = await chrome.tabs.create({ url, active });
  return { id: tab.id, created: true };
}

const closeIfCreated = (t) => (t && t.created ? chrome.tabs.remove(t.id).catch(() => {}) : undefined);

// --- Status ---

async function saved(key) {
  return (await chrome.storage.local.get(key))[key];
}

async function linkedinConnected() {
  const cookie = await chrome.cookies.get({ url: 'https://www.linkedin.com', name: 'li_at' });
  return !!cookie;
}

// Reads the login from an inactive tab, once per browser session and only for known users.
async function verifyWhatsapp() {
  let t = null;
  try {
    t = await whatsappTab('https://web.whatsapp.com/');
    await waitForLoad(t.id);
    for (let i = 0; i < 60; i++) {
      const s = await runOne(t.id, waRead, [], { world: 'MAIN' });
      if (s && isLoggedIn(s)) return true;
      if (s && isUnpaired(s)) return false;
      await sleep(1000);
    }
    return false;
  } catch {
    return false;
  } finally {
    await closeIfCreated(t);
  }
}

let verifying = null;
async function whatsappState() {
  if (connecting.whatsapp) return 'pending';
  if (!(await saved('whatsappConnected'))) return 'disconnected';
  const { verified } = await chrome.storage.session.get('verified');
  if (verified) return 'connected';
  if (!verifying) {
    verifying = verifyWhatsapp().then(async (ok) => {
      await chrome.storage.local.set({ whatsappConnected: ok });
      await chrome.storage.session.set({ verified: true });
      verifying = null;
    });
  }
  return 'pending';
}

async function status() {
  return {
    whatsapp: { state: await whatsappState() },
    linkedin: {
      state: connecting.linkedin ? 'pending' : (await linkedinConnected()) ? 'connected' : 'disconnected',
    },
  };
}

// --- Connect: the user logs in on the real site, in a normal tab ---

async function watchLogin(service, tabId, isDone) {
  connecting[service] = true;
  try {
    const deadline = Date.now() + LOGIN_MS;
    while (Date.now() < deadline) {
      if (await isDone()) return true;
      if (!(await chrome.tabs.get(tabId).catch(() => null))) return false;
      await sleep(1500);
    }
    return false;
  } finally {
    connecting[service] = false;
  }
}

async function connect(service) {
  if (connecting[service]) return;
  if (service === 'whatsapp') {
    const t = await whatsappTab('https://web.whatsapp.com/', true);
    watchLogin('whatsapp', t.id, async () => {
      const s = await runOne(t.id, waRead, [], { world: 'MAIN' });
      return !!s && isLoggedIn(s);
    }).then(async (ok) => {
      await chrome.storage.local.set({ whatsappConnected: ok });
      if (ok) await chrome.storage.session.set({ verified: true });
    });
  } else if (service === 'linkedin') {
    if (await linkedinConnected()) return;
    const tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/login', active: true });
    watchLogin('linkedin', tab.id, linkedinConnected);
  } else {
    throw fail('Unknown service', 400);
  }
}

// --- Rate limit ---

async function checkLimit(service) {
  const key = `limit_${service}`;
  const today = new Date().toISOString().slice(0, 10);
  const rec = (await saved(key)) || { day: today, count: 0, lastAt: 0 };
  if (rec.day !== today) Object.assign(rec, { day: today, count: 0 });
  if (rec.count >= LIMITS.perDay) throw fail(`Daily limit of ${LIMITS.perDay} reached. Nothing was sent.`, 429);
  const wait = rec.lastAt + LIMITS.minGapMs - Date.now();
  if (wait > 0) throw fail(`Please wait ${Math.ceil(wait / 1000)}s before the next send. Nothing was sent.`, 429);
  return async () => chrome.storage.local.set({ [key]: { ...rec, count: rec.count + 1, lastAt: Date.now() } });
}

// --- WhatsApp send ---

async function sendWhatsapp(number, message, record) {
  const url = `https://web.whatsapp.com/send/?phone=${number}&text=${encodeURIComponent(message)}&type=phone_number&app_absent=0`;
  const word = (message.match(/[\p{L}\p{N}]{2,}/u) || [''])[0];
  let t = null;
  try {
    t = await whatsappTab(url);
    await sleep(500);
    await waitForLoad(t.id);

    const ready = Date.now() + 90000;
    for (;;) {
      const s = await runOne(t.id, waRead, [], { world: 'MAIN' });
      if (s) {
        if (isUnpaired(s)) {
          await chrome.storage.local.set({ whatsappConnected: false });
          throw fail('WhatsApp session ended. Reconnect.', 409);
        }
        if (s.invalid) throw fail('This number is not on WhatsApp. Nothing was sent.', 404);
        if (s.composerText && s.composerText.includes(word)) break;
      }
      if (Date.now() > ready) throw fail('WhatsApp chat did not load. Nothing was sent.', 504);
      await sleep(500);
    }

    await sleep(500);
    await record();
    await runOne(t.id, waPressSend);

    // Closing the tab too soon could lose a queued message, so wait for it to settle.
    const confirm = Date.now() + 30000;
    let okSince = 0;
    for (;;) {
      const ok = await runOne(t.id, waIsSent, [word], { world: 'MAIN' });
      if (!ok) okSince = 0;
      else if (!okSince) okSince = Date.now();
      else if (Date.now() - okSince >= 3000) return { ok: true };
      if (Date.now() > confirm) throw fail('Send not confirmed. Check WhatsApp before retrying.', 502);
      await sleep(250);
    }
  } catch (e) {
    if (t) await saveDiagnostics('whatsapp', e.message, t.id);
    throw e;
  } finally {
    await closeIfCreated(t);
  }
}

// --- LinkedIn send ---

// The chat and dialogs can render inside an iframe, so search every frame.
async function findFrame(tabId, func, args, timeout) {
  const deadline = Date.now() + timeout;
  do {
    const results = await run(tabId, func, args, { allFrames: true });
    const hit = results.find((r) => r.result);
    if (hit) return { frameId: hit.frameId, result: hit.result };
    await sleep(300);
  } while (Date.now() < deadline);
  return null;
}

async function sendInvite(tabId, message, record) {
  const note = await findFrame(tabId, liClickAddNote, [], 8000);
  if (!note) throw fail('Could not add a note to the invitation. Nothing was sent.', 422);
  const box = await findFrame(tabId, liHasNoteBox, [], 8000);
  if (!box) throw fail('LinkedIn did not allow a note, possibly a monthly limit. Nothing was sent.', 422);
  await record();
  const sent = await runOne(tabId, liFillAndSendNote, [message], { frameId: box.frameId });
  if (!sent) throw fail('LinkedIn would not accept this note, possibly too long for your plan. Nothing was sent.', 422);
  for (let i = 0; i < 32; i++) {
    if (!(await runOne(tabId, liHasNoteBox, [], { frameId: box.frameId }))) return { ok: true, kind: 'invite' };
    await sleep(250);
  }
  throw fail('Send not confirmed. Check LinkedIn before retrying.', 502);
}

async function sendMessage(tabId, message, record) {
  const found = await findFrame(tabId, liEditorCount, [], 15000);
  if (!found) throw fail('Message box did not open. LinkedIn may require Premium for this profile.', 422);
  if (found.result > 1) throw fail('More than one chat is open. Nothing was sent.', 409);
  await record();
  const typed = await runOne(tabId, liTypeAndSend, [message], { frameId: found.frameId });
  if (typed === 'not-typed') throw fail('Could not type the message. Nothing was sent.', 500);
  if (typed !== 'pressed') throw fail('Send button stayed disabled. Nothing was sent.', 500);
  for (let i = 0; i < 32; i++) {
    if (await runOne(tabId, liEditorIsEmpty, [], { frameId: found.frameId })) return { ok: true, kind: 'message' };
    await sleep(250);
  }
  throw fail('Send not confirmed. Check LinkedIn before retrying.', 502);
}

async function sendLinkedin(url, message, record) {
  if (!(await linkedinConnected())) throw fail('LinkedIn not connected', 409);
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForLoad(tab.id);
    const { url: finalUrl } = await chrome.tabs.get(tab.id);
    if (/login|authwall|checkpoint/.test(finalUrl)) throw fail('LinkedIn session expired. Reconnect.', 409);

    let loaded = false;
    for (let i = 0; i < 50 && !loaded; i++) {
      loaded = await runOne(tab.id, () => !!document.querySelector('main section'));
      if (!loaded) await sleep(300);
    }
    if (!loaded) throw fail('Profile did not load. Nothing was sent.', 504);
    await sleep(1500); // action buttons render after the page shell

    const action = await runOne(tab.id, liClickAction, [message]);
    if (action === 'too-long') {
      throw fail(`This person isn't a connection, so the message goes as an invitation note, limited to 300 characters. Yours has ${message.length}. Nothing was sent.`, 422);
    }
    if (action === 'invite') return await sendInvite(tab.id, message, record);
    if (action === 'message') return await sendMessage(tab.id, message, record);
    throw fail('No Message or Connect button on this profile', 422);
  } catch (e) {
    await saveDiagnostics('linkedin', e.message, tab.id);
    throw e;
  } finally {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

// Page structure only, never message text. Read from the service worker console when a send fails.
async function saveDiagnostics(service, reason, tabId) {
  const results = await run(tabId, pageStructure, [], { allFrames: true });
  await chrome.storage.local.set({
    [`lastFailure_${service}`]: { reason, at: new Date().toISOString(), frames: results.map((r) => r.result) },
  });
}

// --- Requests from the portal ---

function send(req) {
  const service = req.service;
  if (service !== 'whatsapp' && service !== 'linkedin') throw fail('Unknown service', 400);
  const message = String(req.message || '');
  if (!message.trim()) throw fail('message required', 400);

  let target;
  if (service === 'whatsapp') {
    target = String(req.number || '').replace(/[\s+()-]/g, '');
    if (!/^[1-9]\d{7,14}$/.test(target)) {
      throw fail('Use country code + digits, with no leading zero, e.g. 919876543210', 400);
    }
  } else {
    target = String(req.url || '').trim();
    if (!/^https:\/\/www\.linkedin\.com\/in\/[^/\s?#]+\/?$/i.test(target)) {
      throw fail('Invalid URL. Use https://www.linkedin.com/in/<profile>', 400);
    }
  }

  // One send at a time per service.
  const job = queues[service].then(async () => {
    const record = await checkLimit(service);
    return service === 'whatsapp' ? sendWhatsapp(target, message, record) : sendLinkedin(target, message, record);
  });
  queues[service] = job.catch(() => {});
  return job;
}

async function handle(req) {
  switch (req && req.type) {
    case 'ping':
      return { ok: true, version: chrome.runtime.getManifest().version };
    case 'status':
      return { ok: true, ...(await status()) };
    case 'connect':
      await connect(req.service);
      return { ok: true };
    case 'send':
      return await send(req);
    default:
      throw fail('Unknown request', 400);
  }
}

chrome.runtime.onMessageExternal.addListener((req, _sender, reply) => {
  handle(req)
    .then(reply)
    .catch((e) => reply({ ok: false, status: e.status || 500, error: e.message }));
  return true; // reply is asynchronous
});
