/* PingPongLight shop and collection (docs/shop-spec.md, docs/design/shop-mockup.html).
   cosmetics.js owns the catalogue and the draw code; game.js draws with what is equipped (PPLC.look()).
   This file owns: what the player owns / has equipped (localStorage, synced with the server), the shop and collection screens,
   the "try one song" button and the purchase buttons per SHOP_MODE:
     iap  = the iOS app (StoreKit through window.PPLIAP, written separately)
     test = the free web test period (the button just says 取得)
     web  = the released web version: the shop only explains that purchases are in the app (mockup B)
   Server (reused game.js api() and the player's key): POST /shop/state {pk}, /shop/claim {pk,item}, /shop/equip {pk,slot,item}.
   Without a server answer everything falls back to localStorage. */
(function(){
'use strict';
const G=window.PPLG,C=window.PPLC;if(!G||!C)return;
const $=s=>document.querySelector(s),LS='ppl-shop-';
const VIS=['avatar','plate','title'];                       // the equipment other players see: kept on the server
const LOOK=['orb','trail','hit','frame','bg'];
let MODE=G.APP?'iap':(G.lsGet(LS+'mode')||(/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname)?'test':'web'));
let SRV=false;                                              // the server answered the last /shop/state for this player
let serverOwned=new Set();

// ---------------------------------------------------------------- persistence
const jget=(k,d)=>{try{const v=JSON.parse(G.lsGet(LS+k)||'null');return v==null?d:v}catch(e){return d}};
function save(){
  const S=C.state;
  G.lsSet(LS+'own',JSON.stringify([...S.own].filter(id=>C.byId[id]&&C.byId[id].how!=='default')));
  G.lsSet(LS+'eq',JSON.stringify(S.eq));G.lsSet(LS+'keep',JSON.stringify(S.keep));G.lsSet(LS+'themecol',JSON.stringify(S.themeCol||''));
}
(function load(){
  const S=C.state;
  for(const id of jget('own',[]))if(typeof id==='string'&&C.byId[id])S.own.add(id);
  const eq=jget('eq',{});
  for(const slot of C.slots){const id=eq&&eq[slot];if(typeof id==='string'&&(id===''&&slot==='title'||C.byId[id]&&C.byId[id].cat===slot))S.eq[slot]=id}
  const kp=jget('keep',{});for(const id in kp)if(C.byId[id])S.keep[id]=1;
  const tc=jget('themecol','');S.themeCol=typeof tc==='string'&&C.byId[tc]&&C.byId[tc].cat==='theme'?tc:'';
  C.bump();
})();
// an equipped item must be owned (a theme counts as owned when its bundle is): otherwise back to the default
function sanitize(){
  const S=C.state;let ch=false;
  for(const slot of C.slots){const id=S.eq[slot];if(id&&!S.own.has(id)){S.eq[slot]=C.defaults[slot];ch=true}}
  if(S.themeCol&&!S.own.has(S.themeCol)){S.themeCol='';ch=true}
  if(ch)C.bump();
}

// ---------------------------------------------------------------- server
// A failed or empty answer (error, HTTP 4xx/5xx, no owned list, no nickname yet) never touches what is stored on this device:
// ownership and equipment stay as they are and nothing is written back to localStorage. Only a real owned list replaces the local copy.
let NONAME=false;                                           // the server does not know this player (no nickname yet): everything stays local
let busyT=0;                                                // a 429 from the server: no requests before this time
const goodOwned=r=>!!r&&!r.error&&!(r._s>=400)&&Array.isArray(r.owned);
const claimQ={run:false,timer:0,bad:new Set()};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
// local-only claims (taken in the test period without a server or a nickname) that the server does not have yet
const pendingClaims=()=>{
  const l=[...C.state.own].filter(id=>{const it=C.byId[id];return it&&it.how==='buy'&&it.cat!=='sponsor'&&!serverOwned.has(id)&&!claimQ.bad.has(id)});
  const covered=new Set();for(const id of l){const it=C.byId[id];if(it.cat==='theme')for(const p of it.parts||[])covered.add(p)}   // a theme brings its own parts
  return l.filter(id=>!covered.has(id))};
// sends them one by one at least 2.5 s apart (the server allows 30 requests a minute for the whole shop); a 429 stops the queue and tries again later
async function claimPending(){
  if(claimQ.run||MODE!=='test'||!SRV||NONAME)return;
  claimQ.run=true;clearTimeout(claimQ.timer);
  try{
    for(const id of pendingClaims()){
      if(MODE!=='test'||!SRV||NONAME)break;
      const wait=busyT-Date.now();if(wait>0){claimQ.timer=setTimeout(claimPending,wait+500);break}
      const c=await G.api('/shop/claim',{pk:G.pkey(),item:id},6000);
      if(c&&(c._s===429||c.error==='slow')){busyT=Date.now()+65000;claimQ.timer=setTimeout(claimPending,65500);break}
      if(c&&c.ok&&c.state&&Array.isArray(c.state.owned)){for(const x of c.state.owned)if(C.byId[x])serverOwned.add(x)}
      else if(c&&c._s===403){break}                           // not in the test period any more
      else if(c&&c.error==='noname'){NONAME=true;break}
      else if(c&&c._s===400)claimQ.bad.add(id);               // the server refuses this item: stop asking
      else break;                                             // a network error: the next sync tries again
      await sleep(2500);
    }
  }finally{claimQ.run=false}
  pushEquipAll()
}
// the three slots others can see: a choice made while the server was out of reach goes up once the items are on the server
function pushEquipAll(){
  if(!SRV||NONAME||!srvEq)return;
  for(const slot of VIS){const id=C.state.eq[slot];if(id&&id!==C.defaults[slot]&&srvEq[slot]!==id&&(serverOwned.has(id)||C.byId[id].how==='default'))pushEquip(slot,id)}
}
let srvEq=null;
// a good /shop/state or /ach/sync answer: take what the server says
function applyServer(r){
  const S=C.state;
  SRV=true;NONAME=false;serverOwned=new Set(r.owned.filter(id=>typeof id==='string'&&C.byId[id]));
  const keep=MODE==='test'?[...S.own].filter(id=>C.byId[id]&&C.byId[id].how==='buy'&&C.byId[id].cat!=='sponsor'&&!serverOwned.has(id)):[];   // test period: what was taken here stays until it is on the server
  S.own=new Set([...C.items.filter(i=>i.how==='default').map(i=>i.id),...serverOwned,...keep]);
  srvEq={};
  if(r.equip&&typeof r.equip==='object')for(const slot of VIS){const v=r.equip[slot],sv=typeof v==='string'&&v&&C.byId[v]&&C.byId[v].cat===slot?v:C.defaults[slot];srvEq[slot]=sv;
    const mine=S.eq[slot];if(sv===C.defaults[slot]&&mine&&mine!==sv&&S.own.has(mine))continue;   // a local choice the server has not heard about yet
    S.eq[slot]=sv}
  sanitize();C.bump();save();
  if(window.PPLA&&Array.isArray(r.ach))window.PPLA.setServer(r);
}
async function sync(){
  if(busyT>Date.now())return null;
  let r;try{r=await G.api('/shop/state',{pk:G.pkey()},6000)}catch(e){r=null}
  if(r&&(r._s===429||r.error==='slow')){busyT=Date.now()+65000}
  if(r&&r._s>0&&typeof r.mode==='string'&&!G.APP&&(r.mode==='test'||r.mode==='web')){MODE=r.mode;G.lsSet(LS+'mode',MODE)}
  if(!G.ME){NONAME=true;SRV=false;return r}                   // no nickname: only the mode is taken from the server; what is owned stays local (the server needs a nickname to know the player)
  if(r&&(r.noname===true||r.error==='noname')){NONAME=true;SRV=false;return r}
  if(goodOwned(r)){applyServer(r);pushEquipAll();claimPending()}
  else SRV=false;                                           // no usable answer: the local copy stays untouched
  return r;
}
// the three slots others can see are also stored on the server (best effort: a failure keeps the local choice)
function pushEquip(slot,id){if(SRV&&!NONAME&&VIS.includes(slot)){if(srvEq)srvEq[slot]=id||C.defaults[slot];G.api('/shop/equip',{pk:G.pkey(),slot,item:id||''},6000).then(()=>cosPing()).catch(()=>{})}}
// tell the room (when connected to one) that the look changed: the server reads it again and shows it to the others
let pingT=0;
let lastCos=0;
function cosPing(){clearTimeout(pingT);const wait=Math.max(700,lastCos+3200-Date.now());pingT=setTimeout(()=>{lastCos=Date.now();if(G.roomSend)G.roomSend({t:'cos'})},wait)}   // the server accepts one per 3 s per connection and drops the rest: trailing throttle

// ---------------------------------------------------------------- acquiring
async function claim(it){   // test period: free
  const S=C.state,ids=C.grants(it);
  if(SRV&&!NONAME){const r=await G.api('/shop/claim',{pk:G.pkey(),item:it.id},6000);
    if(r&&r.ok&&r.state&&Array.isArray(r.state.owned)){serverOwned=new Set(r.state.owned.filter(id=>C.byId[id]));for(const id of serverOwned)S.own.add(id);for(const id of ids)S.own.add(id);save();return true}
    if(r&&(r._s===429||r.error==='slow')){busyT=Date.now()+65000;clearTimeout(claimQ.timer);claimQ.timer=setTimeout(claimPending,66000)}   // kept on this device, sent up a little later
    else if(r&&r.error==='noname')NONAME=true;
    else if(r&&(r._s===403||r._s===400)){G.toast('目前無法取得，請稍後再試');return false}}
  for(const id of ids)S.own.add(id);save();return true   // no server (or no account yet): owned on this device; sent up when a nickname exists
}
async function buy(it){
  if(MODE==='test'){const ok=await claim(it);if(ok){done(it)}return}
  if(MODE==='iap'){
    if(!window.PPLIAP||typeof window.PPLIAP.buy!=='function'){G.toast('購買功能尚未就緒，請稍後再試');return}
    try{const r=await window.PPLIAP.buy(it.pid);if(r&&r.error==='off')G.toast('目前無法驗證購買，請稍後再試');else if(r===false||r&&r.ok===false&&!r.cancelled){G.toast('購買沒有完成')}}catch(e){G.toast('購買沒有完成')}
    await sync();render();return}
  webDialog();
}
function done(it){
  if(it.id==='full'){dlg('✦ 已解鎖完整版','謝謝支持！每個星座後面的曲目已經開放挑戰。',[{t:'好',c:'pri'}],true);window.dispatchEvent(new Event('ppl-full'))}

  render();
}
async function restore(){
  if(MODE==='iap'){
    if(!window.PPLIAP||typeof window.PPLIAP.restore!=='function'){G.toast('恢復購買尚未就緒');return}
    try{const r=await window.PPLIAP.restore();   // the server's answer: {error:'off'} when it cannot verify; a result's status 'moved' = it was bought by another player and now belongs to this one
      const res=r&&Array.isArray(r.results)?r.results:Array.isArray(r)?r:[];
      if(r&&r.error==='off')G.toast('目前無法驗證購買，請稍後再試');
      else if(res.some(x=>x&&x.status==='moved'))G.toast('已恢復購買（購買已轉移到這個玩家）');
      else G.toast('已恢復購買')}catch(e){G.toast('恢復購買沒有完成')}
    await sync();render();return}
  if(MODE==='test'){G.toast('測試期間所有外觀免費取得，不需要恢復購買。');return}
  webDialog();
}

// ---------------------------------------------------------------- equipping
function equip(slot,id){C.equipOne(slot,id);save();if(VIS.includes(slot))pushEquip(slot,id);else cosPing();if(window.PPLA)window.PPLA.ev('equip',{slot,id})}
function equipTheme(th){C.equipTheme(th);save();cosPing();if(window.PPLA)window.PPLA.ev('equip',{slot:'theme',id:th.id})}
function unequipTheme(){for(const s of LOOK)C.state.eq[s]=C.defaults[s];C.state.themeCol='';C.bump();save();cosPing()}
const isEq=it=>it.cat==='theme'?(C.state.themeCol===it.id||it.id==='theme.stars'&&!C.state.themeCol&&C.look().allDef):it.cat==='full'||it.cat==='sponsor'?false:C.state.eq[it.cat]===it.id;
const isOwn=it=>C.state.own.has(it.id);
function keepOn(it){   // "combo colour" switch: ON means the combo tier colours the item; off keeps the item's own colours
  if(it.cat==='theme')return !C.themePartIds(it).every(id=>C.keepOf(id));
  return !C.keepOf(it.id)}
function setCombo(it,on){
  if(it.cat==='theme')for(const id of C.themePartIds(it))C.setKeep(id,!on);else C.setKeep(it.id,!on);
  save()}
C.themePartIds=th=>(th.parts||[]).filter(id=>/^(orb|trail|hit)\./.test(id));

// ---------------------------------------------------------------- ui state
const SIDE=[['full','完整版'],['theme','主題套組'],['single','單件外觀'],['vis','名牌與頭像'],['emote','對戰表情'],['share','分享圖外框'],['sponsor','贊助']];
const SUBS={single:[['orb','光球'],['trail','尾跡'],['hit','打擊特效'],['frame','框線'],['bg','背景']],vis:[['plate','名牌框'],['avatar','頭像'],['title','稱號']]};
const UI={view:'shop',cat:'theme',sub:{single:'orb',vis:'plate'},sel:{}};
const catOf=()=>UI.cat==='single'||UI.cat==='vis'?UI.sub[UI.cat]:UI.cat;
const shopOpen=()=>!$('#shop').classList.contains('hidden');
const esc=C.esc;
const priceTxt=it=>MODE==='test'?'免費':'NT$'+it.price;

function listFor(cat){
  let l=C.items.filter(i=>i.cat===cat);
  if(UI.view==='coll')l=l.filter(isOwn);
  if(cat==='title'||cat==='avatar'||cat==='plate')l=l.slice().sort((a,b)=>(isOwn(b)-isOwn(a)));
  return l}
function statusOf(it){   // [css class, text]
  if(isEq(it))return['eq','使用中'];
  if(isOwn(it))return['own','已擁有'];
  if(it.how==='buy')return['pay',priceTxt(it)];
  if(it.how==='sponsor')return['ach','贊助取得'];
  if(it.how.indexOf('ach:')===0)return['ach','成就'];
  return['own','預設']}

// ---------------------------------------------------------------- render
function sideBtn(k,t){
  const full=k==='full'&&UI.view==='shop'&&!isOwn(C.byId.full)?'<em>'+priceTxt(C.byId.full)+'</em>':'';
  return '<button data-k="'+k+'" class="'+(UI.cat===k?'on':'')+'">'+t+full+'</button>'}
function render(){
  if(!shopOpen())return;
  const coll=UI.view==='coll';
  $('#shT').textContent=coll?'收藏':'商城';$('#shMy').textContent=coll?'商城':'收藏';$('#shRes').hidden=coll;
  const side=SIDE.filter(([k])=>!coll||(k!=='full'&&k!=='sponsor'));
  if(!side.some(([k])=>k===UI.cat))UI.cat='theme';
  $('#shSide').innerHTML=side.map(([k,t])=>sideBtn(k,t)).join('');
  const subs=SUBS[UI.cat];
  $('#shSub').hidden=!subs;$('#shSub').innerHTML=subs?subs.map(([k,t])=>'<button data-k="'+k+'" class="'+(UI.sub[UI.cat]===k?'on':'')+'">'+t+'</button>').join(''):'';
  grid();pview();
}
function cell(it){
  const [sc,st]=statusOf(it),cat=it.cat,sel=UI.sel[cat]===it.id;
  let vis;
  if(['theme','orb','trail','hit','frame','bg'].includes(cat)){vis='<img class="sw" alt="" src="'+C.thumb(thumbT(it),150,60,2)+'">'}
  else if(cat==='plate')vis='<div class="ctr">'+C.plateHTML(it.id,C.state.eq.avatar,'小光','',22)+'</div>';
  else if(cat==='avatar')vis='<div class="ctr">'+C.avHTML(C.avSpec(it.id,2),44)+'</div>';
  else if(cat==='title')vis='<div class="ctr">'+C.titleHTML(it.id)+'</div>';
  else if(cat==='emote')vis='<div class="ctr" style="font-size:12px;color:#cfd5f5;text-align:center;line-height:1.5">'+esc(it.list.slice(0,3).join('　'))+'</div>';
  else if(cat==='share')vis='<div class="ctr"><span style="'+esc(it.css)+';border-radius:8px;padding:6px 16px;font-size:12px;font-weight:700">'+esc(it.name)+'</span></div>';
  else vis='';
  const lk=!isOwn(it)&&it.how!=='buy'?' lk':'';
  return '<button class="shIt'+(sel?' sel':'')+lk+'" data-id="'+it.id+'">'+vis+'<span class="row"><span class="nm">'+esc(it.name)+'</span><span class="pr '+sc+'">'+st+'</span></span>'+(cat==='title'&&!isOwn(it)?'<small>'+esc(it.desc)+'</small>':'')+'</button>'}
// a thumbnail shows the item itself on top of the current look (themes: the whole bundle)
function thumbT(it){return it.cat==='theme'?C.previewT(it):C.previewT(it)}
function grid(){
  const g=$('#shGrid'),coll=UI.view==='coll';g.className='shGrid';
  if(UI.cat==='full'){
    g.classList.add('one');const f=C.byId.full,own=isOwn(f);
    g.innerHTML='<div class="shFull"><div class="ic">🌌</div><div style="flex:1"><b>完整版　'+(MODE==='test'?'測試期間免費':'NT$'+f.price)+'</b><br>解除每個星座 30% 的上限：71 首全部可以過關解鎖（免費版 27 首）。之後新增的正式曲目也包含在內。一次買斷，不訂閱、沒有廣告。</div>'
      +(own?'<span class="pr own">已擁有</span>':'<button class="gold" data-buy="full">'+(MODE==='test'?'取得':'購買')+'</button>')+'</div>'
      +'<div class="shNote">獎勵星座和音符座一律免費，只要玩就能取得。</div>';return}
  if(UI.cat==='sponsor'){
    g.innerHTML=C.items.filter(i=>i.cat==='sponsor').map(it=>{const ic={'30':'☕','90':'🎵','300':'🎹'}[it.k]||'✦',nm={'30':'請喝咖啡','90':'買一張唱片','300':'送一台鋼琴'}[it.k]||it.name;
      const sub={'30':'贊助者稱號「點燈人」','90':'稱號＋金冠頭像','300':'稱號＋金冠＋金色名牌框「燈塔」'}[it.k]||it.desc;
      return '<div class="shIt shSp"><div class="ic">'+ic+'</div><div class="nm" style="text-align:center">'+esc(nm)+'</div><small style="margin:3px 0 6px">'+esc(sub)+'</small>'
        +(MODE==='test'?'<button disabled>App 版開放</button>':'<button class="gold" data-buy="'+it.id+'">NT$'+it.price+'</button>')+'</div>'}).join('')
      +'<div class="shNote">贊助不會讓遊戲變簡單，也不影響排行榜，只會讓別人看到你支持了這款遊戲。可以重複贊助，稱號與外觀只會給一次。'+(MODE==='test'?'<br><b>測試期間不開放贊助</b>（贊助是真實付費，App 上架後才能買）。':'')+'</div>';return}
  const l=listFor(catOf());
  if(UI.cat==='theme'&&coll)l.unshift(null);
  if(!l.length){g.innerHTML='<div class="shEmpty">'+(coll?'還沒有這類外觀，到商城看看。':'沒有品項')+'</div>';return}
  g.innerHTML=l.map(it=>it?cell(it):'<button class="shIt'+(UI.sel.theme==='_def'?' sel':'')+'" data-id="_def"><div class="ctr" style="font-size:12px;color:#cfd5f5">全部用預設</div><span class="row"><span class="nm">預設外觀</span><span class="pr '+(C.state.themeCol===''&&C.look().allDef?'eq':'own')+'">'+(C.state.themeCol===''&&C.look().allDef?'使用中':'已擁有')+'</span></span></button>').join('');
}

// ---------------------------------------------------------------- preview panel
let PV={raf:0,s:null,cv:null,last:0};
function pvStop(){if(PV.raf)cancelAnimationFrame(PV.raf);PV.raf=0;PV.s=null;PV.cv=null}
function pvLoop(ts){
  PV.raf=0;if(!PV.s||!shopOpen()||!PV.cv||!PV.cv.isConnected)return;
  const dt=Math.min(.05,(ts-PV.last)/1000||.016);PV.last=ts;C.step(PV.s,dt);PV.raf=requestAnimationFrame(pvLoop)}
function pvScene(cv,T){
  pvStop();PV.cv=cv;PV.s=C.scene(cv,T);PV.last=performance.now();
  if(G.SET&&G.SET.lowFx){C.step(PV.s,.016);for(let i=0;i<40;i++)C.step(PV.s,.03);return}   // reduced effects: a still frame
  PV.raf=requestAnimationFrame(pvLoop)}
// what a single item looks like in the preview: the item on top of what the player has equipped now
function pvT(it){
  if(it.cat==='theme')return Object.assign({},C.previewT(it));
  const eq=C.state.eq,T={bg:C.byId[eq.bg].k,frame:C.byId[eq.frame].k,orb:C.byId[eq.orb].k,trail:C.byId[eq.trail].k,hit:C.byId[eq.hit].k,c1:'#7cf0ff',c2:'#8f6bff'};
  const o=C.previewT(it);Object.assign(T,o);
  if(UI.view==='coll'&&['orb','trail','hit'].includes(it.cat))T.keep=!keepOn(it)?1:0;
  return T}
function selected(){
  const cat=catOf();if(cat==='full')return C.byId.full;
  if(UI.cat==='sponsor')return null;
  const id=UI.sel[cat];if(id==='_def')return'def';
  const it=id&&C.byId[id];if(it&&listFor(cat).includes(it))return it;
  const l=listFor(cat);return l[0]||(UI.view==='coll'&&UI.cat==='theme'?'def':null)}
function pview(){
  const p=$('#shPv'),it=selected();pvStop();
  if(UI.cat==='sponsor'){p.innerHTML='<div class="t">謝謝你</div><div class="d">贊助不會讓遊戲變簡單，也不影響排行榜。稱號與外觀只會給一次，之後的贊助是純粹的支持。</div>';return}
  if(UI.cat==='full'){const f=C.byId.full;p.innerHTML='<div class="t">買了之後</div><div class="d">每個星座 30% 以後的曲目，標籤從「完整版」變成「通過上一首後開放」，照樣一首一首解鎖。</div>'+(isOwn(f)?'<div class="d" style="color:#8fe388">你已擁有完整版。</div>':'');return}
  if(it==='def'){p.innerHTML='<div class="big" id="pvC" style="aspect-ratio:19/9"></div><div class="t">預設外觀</div><div class="d">光球、尾跡、打擊特效、框線、背景全部回到最初的樣子。</div><div class="btns"><button class="pri" data-act="alldef">'+(C.look().allDef&&!C.state.themeCol?'使用中':'使用')+'</button></div>';
    const b=p.querySelector('.btns button');if(C.look().allDef&&!C.state.themeCol)b.disabled=true;
    const cv=document.createElement('canvas');cv.className='big';$('#pvC').replaceWith(cv);pvScene(cv,{});return}
  if(!it){p.innerHTML='<div class="d">沒有可預覽的品項。</div>';return}
  const cat=it.cat,vis=['theme','orb','trail','hit','frame','bg'].includes(cat);
  let top='';
  if(vis)top='<canvas class="big"></canvas>';
  else if(cat==='plate')top='<div class="bx">'+C.plateHTML(it.id,C.state.eq.avatar,'小光',C.state.eq.title,28)+'</div>';
  else if(cat==='avatar')top='<div class="bx">'+C.avHTML(C.avSpec(it.id,2),56)+'</div>';
  else if(cat==='title')top='<div class="bx">'+C.plateHTML(C.state.eq.plate,C.state.eq.avatar,'小光',it.id,26)+'</div>';
  else if(cat==='emote')top='<div class="bx" style="flex-direction:column;gap:3px;font-size:12px;line-height:1.4">'+it.list.map(esc).join('<br>')+'</div>';
  else if(cat==='share')top='<div class="bx"><span style="'+esc(it.css)+';border-radius:10px;padding:10px 26px;font-size:13px;font-weight:700">我的成績 S</span></div>';
  const own=isOwn(it),eq=isEq(it),[sc,st]=statusOf(it);
  let how='';
  if(!own){how=it.how==='buy'?(it.also?'也可由成就「'+esc(it.also.slice(4))+'」取得':''):it.how==='sponsor'?'贊助 NT$90 以上取得':'取得方式：'+esc(C.howText(it))}
  let keep='';
  if(UI.view==='coll'&&own&&it.id!==C.defaults[cat]&&it.id!=='theme.stars'&&(cat==='theme'||['orb','trail','hit'].includes(cat)))keep='<div class="kp"><span>連擊變色</span><button class="tog'+(keepOn(it)?' on':'')+'" data-act="keep" role="switch" aria-checked="'+keepOn(it)+'" aria-label="連擊變色"></button></div>';
  let b='';
  if(vis)b+='<button data-act="try">試玩一首</button>';
  if(own){
    if(eq&&(cat==='theme'))b+='<button data-act="off">卸下（回到預設）</button>';
    else if(eq&&cat!=='full'&&it.id!==C.defaults[cat]&&!(cat==='title'))b+='<button class="pri" disabled>使用中</button><button data-act="off">卸下</button>';
    else if(eq)b+='<button class="pri" disabled>使用中</button>'+(cat==='title'?'<button data-act="off">卸下</button>':'');
    else b+='<button class="pri" data-act="use">使用</button>';
  }else if(it.how==='buy'&&UI.view==='shop'){
    b+=MODE==='test'?'<button class="gold" data-act="buy">取得</button>':MODE==='iap'?'<button class="gold" data-act="buy">購買 NT$'+it.price+'</button>':'<button class="gold" data-act="buy">購買 NT$'+it.price+'</button>';
  }else if(!own){b+='<button disabled>'+(it.how==='sponsor'?'贊助取得':'成就取得')+'</button>'}
  const priceLine=!own&&it.how==='buy'?'<div class="d" style="color:#ffd36b">'+(MODE==='test'?'測試期間免費':'NT$'+it.price)+(it.cat==='theme'?'　（單買 5 件要 NT$150）':'')+'</div>':'';
  p.innerHTML=top+'<div class="t">'+esc(it.name)+'</div><div class="d">'+esc(it.desc)+'</div>'+priceLine+(how?'<div class="d">'+how+'</div>':'')+(it.limited?'<div class="d" style="color:#c9b6ff">限定</div>':'')+keep+'<div class="btns">'+b+'</div>';
  if(vis){const cv=p.querySelector('canvas.big');pvScene(cv,pvT(it))}
}

// ---------------------------------------------------------------- actions
function tryOne(it){
  if(window.PPLA)window.PPLA.ev('preview',{id:it.id});   // a short song with this look: nothing is recorded; back to the shop afterwards
  let tr;
  if(it.cat==='theme'){tr=C.themeSlots(it);tr.themeCol=it.id}
  else{tr={};for(const s of LOOK)tr[s]=C.state.eq[s];tr[it.cat]=it.id;tr.themeCol=C.state.themeCol}
  $('#shop').classList.add('hidden');pvStop();G.startTry(tr)}
function act(a){
  const it=selected();
  if(a==='alldef'){unequipTheme();for(const s of LOOK)C.state.eq[s]=C.defaults[s];C.bump();save();render();return}
  if(!it||it==='def')return;
  if(a==='try')return tryOne(it);
  if(a==='buy')return buy(it);
  if(a==='keep'){setCombo(it,!keepOn(it));render();return}
  if(a==='use'){
    if(it.cat==='theme')equipTheme(it);else equip(it.cat,it.id);
    render();return}
  if(a==='off'){
    if(it.cat==='theme')unequipTheme();else equip(it.cat,C.defaults[it.cat]);
    render()}
}
$('#shGrid').addEventListener('click',e=>{
  const bb=e.target.closest('[data-buy]');
  if(bb){const it=C.byId[bb.dataset.buy];if(it)buy(it);return}
  const c=e.target.closest('.shIt[data-id]');if(!c)return;
  UI.sel[catOf()]=c.dataset.id;grid();pview();
  const it=C.byId[c.dataset.id];if(it&&window.PPLA&&['theme','orb','trail','hit','frame','bg'].includes(it.cat))window.PPLA.ev('preview',{id:it.id})});
$('#shPv').addEventListener('click',e=>{const b=e.target.closest('[data-act]');if(b&&!b.disabled)act(b.dataset.act)});
$('#shSide').addEventListener('click',e=>{const b=e.target.closest('button[data-k]');if(!b)return;UI.cat=b.dataset.k;render()});
$('#shSub').addEventListener('click',e=>{const b=e.target.closest('button[data-k]');if(!b)return;UI.sub[UI.cat]=b.dataset.k;render()});
$('#shMy').onclick=()=>{if(UI.view==='coll'&&MODE==='web'){webDialog();return}UI.view=UI.view==='coll'?'shop':'coll';render()};
$('#shRes').onclick=restore;
$('#shBk').onclick=close;

// ---------------------------------------------------------------- dialogs (mockup B and J)
function dlg(title,text,btns,gold){
  $('#shDt').textContent=title;$('#shDt').style.color=gold?'#ffd36b':'';$('#shDp').textContent=text;
  const r=$('#shDr');r.innerHTML='';
  for(const b of btns){const e=document.createElement('button');e.textContent=b.t;if(b.c)e.className=b.c;e.onclick=()=>{dlgClose();if(b.fn)b.fn()};r.appendChild(e)}
  $('#shDlg').classList.remove('hidden');const f=r.querySelector('button');if(f)f.focus()}
function dlgClose(){$('#shDlg').classList.add('hidden')}
const dlgOpen=()=>!$('#shDlg').classList.contains('hidden');
$('#shDx').onclick=dlgClose;
function webDialog(){dlg('商城只在 App 版提供','完整版與外觀請在 iOS App 內購買。App 與網頁的購買暫時不互通，之後會提供帳號轉移。網頁版可以免費玩前 30% 的曲目。',[{t:'知道了',c:'pri'}])}

// ---------------------------------------------------------------- open / close
function open(view){   // view: 'shop' (default) or 'coll' (the collection: what the player owns and wears; works in every mode)
  UI.view=view==='coll'?'coll':'shop';
  if(MODE==='web'&&UI.view==='shop'){webDialog();sync().then(()=>{if(MODE!=='web'&&dlgOpen()){dlgClose();open()}});return}   // may still turn out to be the test period: ask the server
  $('#home').classList.add('hidden');$('#shop').classList.remove('hidden');
  render();
  sync().then(()=>{if(MODE==='web'&&UI.view==='shop'){close();webDialog()}else render()});
}
function close(){pvStop();dlgClose();$('#shop').classList.add('hidden');G.showHome()}
$('#bShop').onclick=()=>{G.initAudio();open('shop')};
$('#bColl').onclick=()=>{G.initAudio();open('coll')};
G.onTryEnd=()=>{G.showHome();open(UI.view)};
G.onMe=()=>{sync().then(()=>{if(shopOpen())render()}).catch(()=>{})};
document.addEventListener('keydown',e=>{if(e.key!=='Escape')return;if(dlgOpen())dlgClose();else if(shopOpen())close()});

// boot: apply what the server knows for a signed-in player (silent when it cannot be reached)
if(G.ME)sync().then(()=>{if(shopOpen())render()}).catch(()=>{});
sanitize();
// a good /ach/sync answer (it carries the owned list and equipment too): same rules as /shop/state
function apply(r){if(goodOwned(r)){applyServer(r);if(shopOpen())render()}}
window.PPLSHOP={apply,open,close,render,sync,claim,buy,equip,equipTheme,unequipTheme,setCombo,UI,get MODE(){return MODE},set MODE(v){MODE=v},get SRV(){return SRV}};
})();
