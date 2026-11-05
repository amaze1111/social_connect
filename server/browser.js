// Starts the user's real Chrome/Edge as a normal process and attaches over CDP.
const fs = require('fs');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const { chromium } = require('playwright');

function err(msg, status) {
  const e = new Error(msg);
  e.status = status;
  return e;
}

function findBrowser() {
  const env = process.env;
  const candidates = {
    win32: [
      `${env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe`,
      `${env['PROGRAMFILES(X86)']}\\Microsoft\\Edge\\Application\\msedge.exe`,
      `${env.PROGRAMFILES}\\Microsoft\\Edge\\Application\\msedge.exe`,
    ],
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ],
    linux: [],
  }[process.platform] || [];
  if (process.platform === 'linux') {
    for (const bin of ['google-chrome', 'google-chrome-stable', 'microsoft-edge', 'chromium', 'chromium-browser']) {
      const r = spawnSync('which', [bin], { encoding: 'utf8' });
      if (r.status === 0 && r.stdout.trim()) candidates.push(r.stdout.trim());
    }
  }
  const found = candidates.find((p) => p && fs.existsSync(p));
  if (!found) throw err('Chrome or Edge not found. Install Google Chrome.', 500);
  return found;
}

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForDebugger(port) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw err('Browser did not start', 500);
}

async function launch(profileDir, headless) {
  const exe = findBrowser();
  fs.mkdirSync(profileDir, { recursive: true });
  const port = await freePort();
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--window-size=1200,800',
  ];
  if (headless) args.push('--headless=new');
  args.push('about:blank');
  const child = spawn(exe, args, { stdio: 'ignore' });
  const exited = new Promise((r) => child.once('exit', r));
  try {
    await waitForDebugger(port);
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0] || (await browser.newContext());
    return { browser, context, child, exited };
  } catch (e) {
    child.kill();
    throw e;
  }
}

async function shutdown({ browser, child, exited }) {
  try {
    const s = await browser.newBrowserCDPSession();
    await s.send('Browser.close'); // graceful: flushes session data to disk
  } catch {}
  await Promise.race([exited, new Promise((r) => setTimeout(r, 5000))]);
  if (child.exitCode === null) child.kill();
}

module.exports = { launch, shutdown };
