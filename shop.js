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
let MODE_KNOWN=!!G.APP||!!G.lsGet(LS+'mode')||/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);   // the web mode is certain only when the server said it, it was stored, or this is a local test host
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
// the 30% lock in game.js depends on the mode and on owning the full version: tell it when either changes
let lockKey='';
let MODE_TRIED=false;   // a /shop/state request has been answered or has failed at least once
const modeState=()=>MODE_KNOWN?'known':MODE_TRIED?'fail':'wait';   // 'wait': still asking; 'fail': asked and no usable answer (offline), the 30% lock cannot be decided
const lockOn=()=>MODE!=='test'&&MODE_KNOWN;   // the 30% lock: never on while the mode is unknown (first visit, offline)
function lockCheck(){const k=lockOn()+'|'+C.state.own.has('full');if(k!==lockKey){const first=lockKey==='';lockKey=k;if(!first)window.dispatchEvent(new Event('ppl-full'))}}
async function sync(){try{return await sync0()}finally{lockCheck();window.dispatchEvent(new Event('ppl-mode'))}}   // ppl-mode: the answer (or the failure) is in: a challenge card waiting for the mode updates its button
async function sync0(){
  if(busyT>Date.now()){MODE_TRIED=true;return null}   // slowed down (429): counts as no usable answer, not as still asking
  let r;try{r=await G.api('/shop/state',{pk:G.pkey()},6000)}catch(e){r=null}
  if(r&&(r._s===429||r.error==='slow')){busyT=Date.now()+65000}
  MODE_TRIED=true;
  if(r&&r._s>0&&typeof r.mode==='string'&&!G.APP&&(r.mode==='test'||r.mode==='web')){MODE=r.mode;MODE_KNOWN=true;G.lsSet(LS+'mode',MODE)}
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
    else if(r&&(r._s===403||r._s===400)){G.toast(TX('目前無法取得，請稍後再試'));return false}}
  for(const id of ids)S.own.add(id);save();return true   // no server (or no account yet): owned on this device; sent up when a nickname exists
}
async function buy(it){
  if(!it||it.how!=='buy')return;   // only what is for sale: level rewards (lv:N), achievement items and defaults are never bought
  if(MODE==='test'){const ok=await claim(it);if(ok){done(it)}return}
  if(MODE==='iap'){
    if(!window.PPLIAP||typeof window.PPLIAP.buy!=='function'){G.toast(TX('購買功能尚未就緒，請稍後再試'));return}
    if(unavail(it)){G.toast(TX('這個品項尚未開放'));return}
    let r=null,err=false;
    try{r=await window.PPLIAP.buy(it.pid)}catch(e){err=true}
    if(r&&r.ok&&goodOwned(r.state)){applyServer(r.state);lockCheck()}   // the verify answer carries the owned list: use it even if the sync below is held back
    await sync();
    if(err||!r||r===false){G.toast(TX('購買沒有完成'));render();return}
    if(r.noname)G.toast(TX('請先設定暱稱再購買'));
    else if(r.paid&&!r.ok){G.toast(r.bad?TX('已付款但驗證失敗，請稍後按「恢復購買」或聯絡我們'):TX('已付款，購買紀錄稍後會自動補上，請勿重複購買'))}   // the money is spent: never suggest paying again
    else if(r.ok){
      const st=r.results&&r.results[0]&&r.results[0].status;
      if(st==='taken')G.toast(TX('這筆購買已在 24 小時內轉移過，暫時無法再轉移'));
      else if(st==='revoked')G.toast(TX('這筆購買已退款'));
      else if(it.id==='full')done(it);
      else G.toast(TX('購買完成'))}
    else if(r.error==='off')G.toast(TX('目前無法驗證購買，請稍後再試'));
    else if(r.pending)G.toast(TX('購買等待核准中，核准後會自動取得'));
    else if(!r.cancelled)G.toast(TX('購買沒有完成'));
    render();return}
  webDialog();
}
function done(it){
  if(it.id==='full'){dlg(TX('✦ 已解鎖完整版'),TX('謝謝支持！每個星座後面的曲目已經開放挑戰。'),[{t:TX('好'),c:'pri'}],true);window.dispatchEvent(new Event('ppl-full'))}

  render();
}
async function restore(){
  if(MODE==='iap'){
    if(!window.PPLIAP||typeof window.PPLIAP.restore!=='function'){G.toast(TX('恢復購買尚未就緒'));return}
    try{const r=await window.PPLIAP.restore();   // the server's answer: {error:'off'} when it cannot verify; a result's status 'moved' = it was bought by another player and now belongs to this one
      const res=r&&Array.isArray(r.results)?r.results:Array.isArray(r)?r:[];
      const n=st=>res.filter(x=>x&&x.status===st).length,good=n('granted')+n('dup')+n('moved');
      if(r&&r.noname)G.toast(TX('請先設定暱稱再恢復購買'));
      else if(r&&r.error==='off')G.toast(TX('目前無法驗證購買，請稍後再試'));
      else if(r&&r.ok===false)G.toast(TX('恢復購買沒有完成'));
      else{
        const m=[];
        if(good)m.push(n('moved')?TX('已恢復購買（購買已轉移到這個玩家）'):TX('已恢復購買'));
        if(n('taken'))m.push(TX('{n} 筆購買已在 24 小時內轉移過，暫時無法恢復',{n:n('taken')}));
        if(n('bad'))m.push(TX('{n} 筆驗證失敗，請稍後再試或聯絡我們',{n:n('bad')}));
        if(!m.length)m.push(res.length?TX('沒有可恢復的購買'):TX('沒有找到可恢復的購買'));
        G.toast(m.join(TX('；')))}}catch(e){G.toast(TX('恢復購買沒有完成'))}
    await sync();render();return}
  if(MODE==='test'){G.toast(TX('測試期間所有外觀免費取得，不需要恢復購買。'));return}
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
const SIDE=[['full',TX('完整版')],['theme',TX('主題套組')],['single',TX('單件外觀')],['vis',TX('名牌與頭像')],['emote',TX('對戰表情')],['share',TX('分享圖外框')]];   // no sponsoring (decided 2026-11-16): the tab and the sponsor-only rewards are hidden
const SUBS={single:[['orb',TX('光球')],['trail',TX('尾跡')],['hit',TX('打擊特效')],['frame',TX('框線')],['bg',TX('背景')]],vis:[['plate',TX('名牌框')],['avatar',TX('頭像')],['title',TX('稱號')]]};
const UI={view:'shop',cat:'theme',sub:{single:'orb',vis:'plate'},sel:{}};
const catOf=()=>UI.cat==='single'||UI.cat==='vis'?UI.sub[UI.cat]:UI.cat;
const shopOpen=()=>!$('#shop').classList.contains('hidden');
const esc=C.esc;
const unavail=it=>MODE==='iap'&&!!it.pid&&!!window.PPLIAP&&typeof window.PPLIAP.has==='function'&&window.PPLIAP.has(it.pid)===false;   // not on sale in the App Store
const priceTxt=it=>MODE==='test'?TX('免費'):esc((MODE==='iap'&&window.PPLIAP&&typeof window.PPLIAP.price==='function'&&window.PPLIAP.price(it.pid))||'NT$'+it.price);   // the store's text goes into innerHTML: escaped

function listFor(cat){
  let l=C.items.filter(i=>i.cat===cat&&(i.how!=='sponsor'||isOwn(i))&&(!i.retired||isOwn(i)));   // a retired title (no longer given by any achievement) is only listed for those who own it
  if(UI.view==='coll')l=l.filter(isOwn);
  if(cat==='title'||cat==='avatar'||cat==='plate')l=l.slice().sort((a,b)=>(isOwn(b)-isOwn(a)));
  return l}
function statusOf(it){   // [css class, text]
  if(isEq(it))return['eq',TX('使用中')];
  if(isOwn(it))return['own',TX('已擁有')];
  if(it.how==='buy')return['pay',priceTxt(it)];
  if(it.how==='sponsor')return['ach',TX('贊助取得')];
  if(it.how==='invite')return['ach',TX('邀請好友')];
  if(it.how.indexOf('ach:')===0)return['ach',TX('成就')];
  if(it.how.indexOf('lv:')===0)return['ach','Lv '+it.how.slice(3)];
  return['own',TX('預設')]}

// ---------------------------------------------------------------- render
function sideBtn(k,t){
  const full=k==='full'&&UI.view==='shop'&&!isOwn(C.byId.full)?'<em>'+priceTxt(C.byId.full)+'</em>':'';
  return '<button data-k="'+k+'" class="'+(UI.cat===k?'on':'')+'">'+t+full+'</button>'}
function render(){
  if(!shopOpen())return;
  const coll=UI.view==='coll';
  $('#shT').textContent=coll?TX('收藏'):TX('商城');$('#shMy').textContent=coll?TX('商城'):TX('收藏');$('#shRes').hidden=coll;
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
  else if(cat==='plate')vis='<div class="ctr">'+C.plateHTML(it.id,C.state.eq.avatar,TX('小光'),'',22)+'</div>';
  else if(cat==='avatar')vis='<div class="ctr">'+C.avHTML(C.avSpec(it.id,2),44)+'</div>';
  else if(cat==='title')vis='<div class="ctr">'+C.titleHTML(it.id)+'</div>';
  else if(cat==='emote')vis='<div class="ctr" style="font-size:12px;color:#cfd5f5;text-align:center;line-height:1.5"><span>'+C.emo(it.list.slice(0,3).join(TX('　')))+'</span></div>';
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
    g.innerHTML='<div class="shFull"><div class="ic">'+C.emo('🌌')+'</div><div style="flex:1">'+TX('<b>完整版　{price}</b><br>解除每個星座 30% 的上限：71 首全部可以過關解鎖（免費版 27 首）。之後新增的正式曲目也包含在內。一次買斷，不訂閱、沒有廣告。',{price:MODE==='test'?TX('測試期間免費'):priceTxt(f)})+'</div>'
      +(own?'<span class="pr own">'+TX('已擁有')+'</span>':unavail(f)?'<button disabled>'+TX('尚未開放')+'</button>':'<button class="gold" data-buy="full">'+(MODE==='test'?TX('取得'):TX('購買'))+'</button>')+'</div>'
      +'<div class="shNote">'+TX('獎勵星座和音符座一律免費，只要玩就能取得。')+'</div>';return}
  if(UI.cat==='sponsor'){
    g.innerHTML=C.items.filter(i=>i.cat==='sponsor').map(it=>{const ic=C.emo({'30':'☕','90':'🎵','300':'🎹'}[it.k]||'✦'),nm=it.name;
      const sub=TXO({'30':'贊助者稱號「點燈人」','90':'稱號＋金冠頭像','300':'稱號＋金冠＋金色名牌框「燈塔」'})[it.k]||it.desc;
      return '<div class="shIt shSp"><div class="ic">'+ic+'</div><div class="nm" style="text-align:center">'+esc(nm)+'</div><small style="margin:3px 0 6px">'+esc(sub)+'</small>'
        +(MODE==='test'?'<button disabled>'+TX('App 版開放')+'</button>':unavail(it)?'<button disabled>'+TX('尚未開放')+'</button>':'<button class="gold" data-buy="'+it.id+'">'+priceTxt(it)+'</button>')+'</div>'}).join('')
      +'<div class="shNote">'+TX('贊助不會讓遊戲變簡單，也不影響排行榜，只會讓別人看到你支持了這款遊戲。可以重複贊助，稱號與外觀只會給一次。')+(MODE==='test'?TX('<br><b>測試期間不開放贊助</b>（贊助是真實付費，App 上架後才能買）。'):'')+'</div>';return}
  const l=listFor(catOf());
  if(UI.cat==='theme'&&coll)l.unshift(null);
  if(!l.length){g.innerHTML='<div class="shEmpty">'+(coll?TX('還沒有這類外觀，到商城看看。'):TX('沒有品項'))+'</div>';return}
  g.innerHTML=l.map(it=>it?cell(it):'<button class="shIt'+(UI.sel.theme==='_def'?' sel':'')+'" data-id="_def"><div class="ctr" style="font-size:12px;color:#cfd5f5">'+TX('全部用預設')+'</div><span class="row"><span class="nm">'+TX('預設外觀')+'</span><span class="pr '+(C.state.themeCol===''&&C.look().allDef?'eq':'own')+'">'+(C.state.themeCol===''&&C.look().allDef?TX('使用中'):TX('已擁有'))+'</span></span></button>').join('');
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
  if(UI.cat==='sponsor'){p.innerHTML='<div class="t">'+TX('謝謝你')+'</div><div class="d">'+TX('贊助不會讓遊戲變簡單，也不影響排行榜。稱號與外觀只會給一次，之後的贊助是純粹的支持。')+'</div>';return}
  if(UI.cat==='full'){const f=C.byId.full;p.innerHTML='<div class="t">'+TX('買了之後')+'</div><div class="d">'+TX('每個星座 30% 以後的曲目，標籤從「完整版」變成「通過上一首後開放」，照樣一首一首解鎖。')+'</div>'+(isOwn(f)?'<div class="d" style="color:#8fe388">'+TX('你已擁有完整版。')+'</div>':'');return}
  if(it==='def'){p.innerHTML='<div class="big" id="pvC" style="aspect-ratio:19/9"></div><div class="t">'+TX('預設外觀')+'</div><div class="d">'+TX('光球、尾跡、打擊特效、框線、背景全部回到最初的樣子。')+'</div><div class="btns"><button class="pri" data-act="alldef">'+(C.look().allDef&&!C.state.themeCol?TX('使用中'):TX('使用'))+'</button></div>';
    const b=p.querySelector('.btns button');if(C.look().allDef&&!C.state.themeCol)b.disabled=true;
    const cv=document.createElement('canvas');cv.className='big';$('#pvC').replaceWith(cv);pvScene(cv,{});return}
  if(!it){p.innerHTML='<div class="d">'+TX('沒有可預覽的品項。')+'</div>';return}
  const cat=it.cat,vis=['theme','orb','trail','hit','frame','bg'].includes(cat);
  let top='';
  if(vis)top='<canvas class="big"></canvas>';
  else if(cat==='plate')top='<div class="bx">'+C.plateHTML(it.id,C.state.eq.avatar,TX('小光'),C.state.eq.title,28)+'</div>';
  else if(cat==='avatar')top='<div class="bx">'+C.avHTML(C.avSpec(it.id,2),56)+'</div>';
  else if(cat==='title')top='<div class="bx">'+C.plateHTML(C.state.eq.plate,C.state.eq.avatar,TX('小光'),it.id,26)+'</div>';
  else if(cat==='emote')top='<div class="bx" style="flex-direction:column;gap:3px;font-size:12px;line-height:1.4">'+it.list.map(t=>'<span>'+C.emo(t)+'</span>').join('')+'</div>';
  else if(cat==='share')top='<div class="bx"><span style="'+esc(it.css)+';border-radius:10px;padding:10px 26px;font-size:13px;font-weight:700">'+TX('我的成績 S')+'</span></div>';
  const own=isOwn(it),eq=isEq(it),[sc,st]=statusOf(it);
  let how='';
  if(!own){how=it.how==='buy'?(it.also?TX('也可由成就「{name}」取得',{name:esc(C.achName(it.also.slice(4)))}):''):it.how==='sponsor'?TX('贊助 NT$90 以上取得'):it.how==='invite'?TX('邀請好友獲得'):it.how.indexOf('lv:')===0?TX('達到 Lv {n} 獲得',{n:it.how.slice(3)}):TX('取得方式：{how}',{how:esc(C.howText(it))})}
  let keep='';
  if(UI.view==='coll'&&own&&it.id!==C.defaults[cat]&&it.id!=='theme.stars'&&(cat==='theme'||['orb','trail','hit'].includes(cat)))keep='<div class="kp"><span>'+TX('連擊變色')+'</span><button class="tog'+(keepOn(it)?' on':'')+'" data-act="keep" role="switch" aria-checked="'+keepOn(it)+'" aria-label="'+TX('連擊變色')+'"></button></div>';
  let b='';
  if(vis)b+='<button data-act="try">'+TX('試玩一首')+'</button>';
  if(own){
    if(eq&&(cat==='theme'))b+='<button data-act="off">'+TX('卸下（回到預設）')+'</button>';
    else if(eq&&cat!=='full'&&it.id!==C.defaults[cat]&&!(cat==='title'))b+='<button class="pri" disabled>'+TX('使用中')+'</button><button data-act="off">'+TX('卸下')+'</button>';
    else if(eq)b+='<button class="pri" disabled>'+TX('使用中')+'</button>'+(cat==='title'?'<button data-act="off">'+TX('卸下')+'</button>':'');
    else b+='<button class="pri" data-act="use">'+TX('使用')+'</button>';
  }else if(it.how==='buy'&&UI.view==='shop'){
    b+=MODE==='test'?'<button class="gold" data-act="buy">'+TX('取得')+'</button>':unavail(it)?'<button disabled>'+TX('尚未開放')+'</button>':'<button class="gold" data-act="buy">'+TX('購買 {price}',{price:priceTxt(it)})+'</button>';
  }else if(!own&&it.how!=='invite'){b+='<button disabled>'+(it.how==='sponsor'?TX('贊助取得'):it.how.indexOf('lv:')===0?TX('等級取得'):TX('成就取得'))+'</button>'}
  const priceLine=!own&&it.how==='buy'?'<div class="d" style="color:#ffd36b">'+(MODE==='test'?TX('測試期間免費'):priceTxt(it))+(it.cat==='theme'?TX('　（單買 {n} 件要 NT${price}）',{n:5,price:150}):'')+'</div>':'';
  p.innerHTML=top+'<div class="t">'+esc(it.name)+'</div><div class="d">'+C.emo(it.desc)+'</div>'+priceLine+(how?'<div class="d">'+how+'</div>':'')+(it.limited?'<div class="d" style="color:#c9b6ff">'+TX('限定')+'</div>':'')+keep+'<div class="btns">'+b+'</div>';
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
function webDialog(){dlg(TX('商城只在 App 版提供'),TX('完整版與外觀請在 iOS App 內購買。App 與網頁的購買暫時不互通，之後會提供帳號轉移。網頁版可以免費玩前 30% 的曲目。'),[{t:TX('知道了'),c:'pri'}])}

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
if(G.ME||!G.APP)sync().then(()=>{if(shopOpen())render()}).catch(()=>{});   // the web always asks once: without a nickname it only brings the mode
sanitize();
// a good /ach/sync answer (it carries the owned list and equipment too): same rules as /shop/state
function apply(r){if(goodOwned(r)){applyServer(r);lockCheck();if(shopOpen())render()}}
function openCat(cat){UI.cat=cat;open('shop')}   // the shop on one section (game.js: a locked song opens the full version)
lockCheck();
window.PPLSHOP={mode:()=>MODE,modeState,get KNOWN(){return MODE_KNOWN},lockOn,ownsFull:()=>C.state.own.has('full'),openCat,apply,open,close,render,sync,claim,buy,equip,equipTheme,unequipTheme,setCombo,UI,get MODE(){return MODE},get SRV(){return SRV}};
if(!G.APP&&/^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))Object.defineProperties(window.PPLSHOP,{   // test setters: local preview only (the 30% lock must not be switched off from the console of the live site)
  KNOWN:{get(){return MODE_KNOWN},set(v){MODE_KNOWN=!!v;MODE_TRIED=!v?false:MODE_TRIED}},
  MODE:{get(){return MODE},set(v){MODE=v}}});
})();
