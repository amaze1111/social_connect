// Official WhatsApp Business Cloud API (Meta Graph API).
// Messages go from the business phone number the user registered with Meta.
const fs = require('fs');
const path = require('path');

const GRAPH = 'https://graph.facebook.com/v22.0';
const CONFIG_FILE = path.join(__dirname, '..', '.sessions', 'whatsapp.json');
const WINDOW_CLOSED = 131047; // free-form text only allowed within 24h of the user's last message

const state = { state: 'disconnected', info: null };
let config = null;
let notify = () => {};

function set(patch) {
  Object.assign(state, patch);
  notify();
}

function getStatus() {
  return { state: state.state, info: state.info };
}

function fail(message, status) {
  const e = new Error(message);
  e.status = status;
  return e;
}

async function graph(method, urlPath, token, body) {
  const res = await fetch(`${GRAPH}${urlPath}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = json.error || {};
    const e = fail(err.error_data?.details || err.message || `Meta API error ${res.status}`, 502);
    e.code = err.code;
    throw e;
  }
  return json;
}

async function verify(cfg) {
  const j = await graph('GET', `/${cfg.phoneNumberId}?fields=display_phone_number,verified_name`, cfg.accessToken);
  return `${j.verified_name || 'WhatsApp'} · ${j.display_phone_number || cfg.phoneNumberId}`;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    return null;
  }
}

// Restore saved credentials on startup.
async function init(onChange) {
  if (onChange) notify = onChange;
  config = loadConfig();
  if (!config) return set({ state: 'disconnected', info: null });
  set({ state: 'pending' });
  try {
    set({ state: 'connected', info: await verify(config) });
  } catch (e) {
    console.error('WhatsApp credentials check failed:', e.message);
    // Token rejected -> reconnect needed. Network trouble -> keep config, show disconnected.
    if (e.code === 190) {
      config = null;
      fs.rmSync(CONFIG_FILE, { force: true });
    }
    set({ state: 'disconnected', info: null });
  }
}

async function connect({ phoneNumberId, accessToken, templateName, templateLang }) {
  const cfg = {
    phoneNumberId: String(phoneNumberId || '').trim(),
    accessToken: String(accessToken || '').trim(),
    templateName: String(templateName || '').trim() || undefined,
    templateLang: String(templateLang || '').trim() || 'en_US',
  };
  if (!/^\d{5,20}$/.test(cfg.phoneNumberId)) throw fail('Phone number ID must be digits only', 400);
  if (!cfg.accessToken) throw fail('Access token required', 400);
  set({ state: 'pending' });
  try {
    const info = await verify(cfg);
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg), { mode: 0o600 });
    config = cfg;
    set({ state: 'connected', info });
  } catch (e) {
    set({ state: 'disconnected', info: null });
    e.status = 400;
    throw e;
  }
}

async function send(number, message) {
  if (state.state !== 'connected' || !config) throw fail('WhatsApp not connected', 409);
  const to = String(number).replace(/[\s+()-]/g, '');
  if (!/^\d{8,15}$/.test(to)) {
    throw fail('Invalid number. Use country code + digits, e.g. 919876543210', 400);
  }
  const url = `/${config.phoneNumberId}/messages`;
  const base = { messaging_product: 'whatsapp', to };
  try {
    await graph('POST', url, config.accessToken, { ...base, type: 'text', text: { body: message } });
  } catch (e) {
    if (e.code === 190) {
      await logout();
      throw fail('WhatsApp token expired or revoked. Reconnect.', 409);
    }
    if (e.code !== WINDOW_CLOSED) throw e;
    if (!config.templateName) {
      throw fail(
        'Recipient has not messaged you in the last 24h. WhatsApp only allows an approved template now. Set a template name in Connect.',
        422,
      );
    }
    // Template body must contain exactly one variable {{1}}; it receives the message text.
    await graph('POST', url, config.accessToken, {
      ...base,
      type: 'template',
      template: {
        name: config.templateName,
        language: { code: config.templateLang },
        components: [
          { type: 'body', parameters: [{ type: 'text', text: message.replace(/\s+/g, ' ').trim() }] },
        ],
      },
    });
  }
}

async function logout() {
  config = null;
  fs.rmSync(CONFIG_FILE, { force: true });
  set({ state: 'disconnected', info: null });
}

module.exports = { init, connect, getStatus, send, logout };
