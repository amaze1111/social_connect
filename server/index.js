const path = require('path');
const express = require('express');
const wa = require('./whatsapp');
const li = require('./linkedin');

const PORT = process.env.PORT || 3000;
const HOST = '127.0.0.1';
const ALLOWED_HOSTS = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);

const app = express();

// Only this machine's own page may call the API. Blocks other websites from driving
// the server through the user's browser (cross-site requests, DNS rebinding).
app.use((req, res, next) => {
  const origin = req.headers.origin;
  const allowed =
    ALLOWED_HOSTS.has(req.headers.host) &&
    (!origin || origin === `http://localhost:${PORT}` || origin === `http://127.0.0.1:${PORT}`);
  if (!allowed) return res.status(403).json({ error: 'Forbidden' });
  next();
});

app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));

const clients = new Set();
const snapshot = () => ({ whatsapp: wa.getStatus(), linkedin: li.getStatus() });
const broadcast = () => {
  const data = `data: ${JSON.stringify(snapshot())}\n\n`;
  clients.forEach((res) => res.write(data));
};

app.get('/api/status', (req, res) => res.json(snapshot()));

app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write(`data: ${JSON.stringify(snapshot())}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

const wrap = (fn) => async (req, res) => {
  try {
    await fn(req, res);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
};

function needs(body, ...keys) {
  for (const k of keys) {
    if (!body[k] || !String(body[k]).trim()) {
      const e = new Error(`${k} required`);
      e.status = 400;
      throw e;
    }
  }
}

app.post('/api/whatsapp/connect', wrap((req, res) => {
  wa.startLogin();
  res.json({ ok: true });
}));
app.post('/api/whatsapp/send', wrap(async (req, res) => {
  needs(req.body, 'number', 'message');
  await wa.send(req.body.number, req.body.message);
  res.json({ ok: true });
}));
app.post('/api/whatsapp/logout', wrap(async (req, res) => {
  await wa.logout();
  res.json({ ok: true });
}));

app.post('/api/linkedin/connect', wrap((req, res) => {
  li.startLogin();
  res.json({ ok: true });
}));
app.post('/api/linkedin/send', wrap(async (req, res) => {
  needs(req.body, 'url', 'message');
  const kind = await li.send(req.body.url.trim(), req.body.message);
  res.json({ ok: true, kind });
}));
app.post('/api/linkedin/logout', wrap(async (req, res) => {
  await li.logout();
  res.json({ ok: true });
}));

app.listen(PORT, HOST, () => {
  console.log(`Social Connect on http://localhost:${PORT}`);
  // Restore saved sessions.
  wa.init(broadcast);
  li.init(broadcast);
});
