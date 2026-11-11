// Copies the game into app/www for the store app. Everything is bundled: the app never loads code from the network.
// The website's security headers (vercel.json) do not apply inside the app, so the CSP is added as a meta tag here.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(fileURLToPath(import.meta.url)), ROOT = join(APP, '..'), WWW = join(APP, 'www');
const FILES = ['index.html', 'game.js', 'songs.js', 'credits.html', 'privacy.html', 'icon-192.png', 'icon-512.png', 'manifest.webmanifest'];
const DIRS = ['inst'];
const DUEL = 'https://pingponglight-duel.nick760930.workers.dev';
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob:",
  "media-src 'self' data: blob:", "font-src 'self'", `connect-src 'self' ${DUEL} ${DUEL.replace('https:', 'wss:')}`,
  "object-src 'none'", "base-uri 'none'", "form-action 'none'"
].join('; ');

rmSync(WWW, { recursive: true, force: true });
mkdirSync(WWW, { recursive: true });
for (const f of FILES) cpSync(join(ROOT, f), join(WWW, f));
for (const d of DIRS) cpSync(join(ROOT, d), join(WWW, d), { recursive: true });

for (const page of ['index.html', 'credits.html', 'privacy.html']) {
  const p = join(WWW, page);
  let html = readFileSync(p, 'utf8');
  if (!html.includes('<meta charset="utf-8">')) throw new Error(page + ': charset meta not found');
  html = html.replace('<meta charset="utf-8">', `<meta charset="utf-8">\n<meta http-equiv="Content-Security-Policy" content="${CSP}">`);
  writeFileSync(p, html);
}
if (existsSync(join(WWW, 'sw.js'))) throw new Error('the service worker must not ship in the app');
console.log('www ready:', FILES.length, 'files +', DIRS.join(', '));
