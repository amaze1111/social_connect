// Serves only the demo page and its two assets, so `.sessions/` is never exposed.
const path = require('path');
const express = require('express');

const root = path.join(__dirname, '..');
const PORT = process.env.PORT || 4173;
const app = express();
app.get('/', (req, res) => res.sendFile(path.join(root, 'examples', 'portal-demo.html')));
app.get('/style.css', (req, res) => res.sendFile(path.join(root, 'public', 'style.css')));
app.get('/portal-client.js', (req, res) => res.sendFile(path.join(root, 'browser_extension', 'portal-client.js')));
app.listen(PORT, '127.0.0.1', () => console.log(`Portal demo on http://localhost:${PORT}`));
