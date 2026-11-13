// Read testers' bug reports on this computer: node bugs-view.mjs [new|all] [--done <id>...]
// Fetches the reports and their images with the admin token (.prod-admin, never printed), saves the images as
// .bugs/<id>-<i>.jpg|png and writes .bugs/index.html (git-ignored), then opens it. --done marks reports as handled.
// If the server stops answering partway, whatever was fetched so far is still written.
import fs from 'node:fs'; import path from 'node:path'; import { execFile } from 'node:child_process'; import { fileURLToPath } from 'node:url';
const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRV = process.env.PPL_SRV || 'https://pingponglight-duel.nick760930.workers.dev';
const tokenLine = fs.readFileSync(path.join(DIR, '.prod-admin'), 'utf8').split(/\r?\n/).find(l => l.trim()) || '';
const TOKEN = tokenLine.includes('=') ? tokenLine.slice(tokenLine.indexOf('=') + 1).trim() : tokenLine.trim();
const wait = ms => new Promise(r => setTimeout(r, ms));
async function admin(b) {
  for (let k = 0; k < 6; k++) {
    const r = await fetch(SRV + '/lb/admin', { method: 'POST', body: JSON.stringify({ token: TOKEN, ...b }) });
    if (r.status === 429) { await wait(20000); continue; }       // the admin path shares the per-network limit
    return r.json();
  }
  throw new Error('rate limited');
}
const args = process.argv.slice(2);
if (args[0] === '--done') {
  for (const id of args.slice(1).map(Number).filter(Number.isInteger)) console.log(id, JSON.stringify(await admin({ op: 'bugdone', id })));
  process.exit(0);
}
const all = args[0] === 'all';
const out = path.join(DIR, '.bugs'); fs.mkdirSync(out, { recursive: true });
const KIND = { bug: '遊戲錯誤', gfx: '畫面異常', audio: '聲音／節奏', net: '連線／對戰', friend: '好友／訊息', idea: '建議', other: '其他' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const IMG = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;
const parts = []; let count = 0, note = '';
try {
  let before;
  for (;;) {   // 200 reports per request, newest first
    const res = await admin({ op: 'bugs', ...(all ? {} : { status: 'new' }), ...(before ? { before } : {}) });
    if (res.error) throw new Error('server said: ' + res.error);
    for (const r of res.rows) {
      let meta = {}; try { meta = JSON.parse(r.meta); } catch (e) {}
      const imgs = [];
      for (let i = 0; i < r.n; i++) {
        const x = await admin({ op: 'bugimg', id: r.id, i }); await wait(300);
        const m = x.img && IMG.exec(x.img); if (!m) continue;
        const name = r.id + '-' + i + (m[1] === 'png' ? '.png' : '.jpg');
        fs.writeFileSync(path.join(out, name), Buffer.from(m[2], 'base64')); imgs.push(name);
      }
      parts.push(`<div class="r ${r.status === 'done' ? 'done' : ''}"><div class="h"><b>#${+r.id}</b><span>${esc(new Date(r.ts).toLocaleString('zh-TW'))}</span><span>${esc(KIND[r.kind] || r.kind)}</span>
<span>${r.name ? esc(r.name) + '（' + esc(r.pid) + '）' : '未設定暱稱'}</span><span>${esc(r.status)}</span></div>
<div class="t">${esc(r.body) || '<i style="color:#6f78a8">（沒有文字說明）</i>'}</div>${imgs.map(f => `<a href="${f}" target="_blank"><img src="${f}"></a>`).join('')}
<div class="m">${Object.entries(meta).map(([k, v]) => esc(k) + '：' + esc(v)).join('　')}</div></div>`);
      count++;
    }
    if (res.rows.length < 200) break;
    before = res.rows[res.rows.length - 1].id;
  }
} catch (e) { note = '<p style="color:#ffb86b">只抓到一部分：' + esc(e.message) + '</p>'; console.error(e.message); }
const html = `<!doctype html><meta charset="utf-8"><title>問題回報</title><style>
body{background:#0b0d1c;color:#e8ecff;font:14px "Microsoft JhengHei",sans-serif;max-width:1100px;margin:auto;padding:16px}
.r{border:1px solid #2a3166;border-radius:12px;padding:12px;margin:12px 0}.h{display:flex;gap:10px;flex-wrap:wrap;color:#8a93c0}
.h b{color:#7cf0ff}.t{white-space:pre-wrap;margin:8px 0;font-size:15px}.m{font-size:12px;color:#8a93c0;word-break:break-all}
img{max-width:48%;border-radius:8px;margin:4px;border:1px solid #333}.done{opacity:.55}</style>
<h1>問題回報（${all ? '全部' : '未處理'}，${count} 則）</h1>${note}<p class="m">處理完：node bugs-view.mjs --done 編號 …</p>${parts.join('\n')}`;
const file = path.join(out, 'index.html'); fs.writeFileSync(file, html);
console.log(count + ' reports ->', file);
if (process.platform === 'win32') execFile('cmd', ['/c', 'start', '', file]);
