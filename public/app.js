const LABELS = { connected: 'Connected', disconnected: 'Not connected', pending: 'Connecting…' };

async function post(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Failed');
  return j;
}

function bind(id, fields) {
  const el = document.getElementById(id);
  const form = el.querySelector('form.send');
  const result = form.querySelector('.result');
  const connectBtn = el.querySelector('.connect');
  const logoutBtn = el.querySelector('.logout');
  const loginHint = el.querySelector('.login-hint');
  const qr = el.querySelector('.qr');
  const qrHint = el.querySelector('.qr-hint');

  const showError = (e) => {
    result.className = 'result err';
    result.textContent = e.message;
  };
  connectBtn.onclick = () => post(`/api/${id}/connect`).catch(showError);
  logoutBtn.onclick = () => post(`/api/${id}/logout`).catch(showError);

  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = form.querySelector('button[type=submit]');
    const body = Object.fromEntries(fields.map((f) => [f, form.elements[f].value]));
    btn.disabled = true;
    result.className = 'result';
    result.textContent = 'Sending…';
    try {
      const j = await post(`/api/${id}/send`, body);
      result.className = 'result ok';
      result.textContent = j.kind === 'invite' ? 'Invitation sent, with your message as the note.' : 'Sent.';
      form.elements.message.value = '';
    } catch (err) {
      showError(err);
    } finally {
      btn.disabled = el.dataset.state !== 'connected';
    }
  };

  return (s) => {
    const connected = s.state === 'connected';
    el.dataset.state = s.state;
    el.querySelector('.label').textContent = LABELS[s.state];
    connectBtn.hidden = s.state !== 'disconnected';
    logoutBtn.hidden = !connected;
    [...form.elements].forEach((c) => (c.disabled = !connected));
    if (loginHint) loginHint.hidden = s.state !== 'pending';
    if (qr) {
      qr.hidden = !s.qr;
      qrHint.hidden = !s.qr;
      if (s.qr) qr.src = s.qr;
    }
  };
}

const render = {
  whatsapp: bind('whatsapp', ['number', 'message']),
  linkedin: bind('linkedin', ['url', 'message']),
};

function apply(s) {
  render.whatsapp(s.whatsapp);
  render.linkedin(s.linkedin);
}

fetch('/api/status').then((r) => r.json()).then(apply).catch(() => {});
const es = new EventSource('/api/events');
es.onmessage = (e) => apply(JSON.parse(e.data));
