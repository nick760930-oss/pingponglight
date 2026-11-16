/* PingPongLight in-app purchases (iOS app only): a thin bridge between shop.js and the native StoreKit 2 plugin (app/ios/App/App/PPLIAPPlugin.swift).
   Flow: native buy -> signed transaction (JWS) -> POST /iap/verify -> only when the server recorded it (granted/dup/moved/taken/revoked)
   the transaction is finished. A bad answer or no network leaves it unfinished: it comes back through unfinished() / the "tx" event next time.
   window.PPLIAP = { ready, has(pid), price(pid), buy(pid), restore() } (shop.js, "iap" mode). The web version never loads this (G.APP is false). */
(function(){
'use strict';
const G=window.PPLG,C=window.PPLC;if(!G||!C||!G.APP)return;
const cap=window.Capacitor;
const call=(m,o)=>cap&&cap.nativePromise?cap.nativePromise('PPLIAP',m,o||{}):Promise.reject(new Error('no bridge'));
const DONE=new Set(['granted','dup','moved','taken','revoked']);   // the server has dealt with it: safe to finish
const BATCH=16,LIMIT=80000;                                                   // the server takes at most 16 transactions per call
let prod=null;                                                     // Map pid -> displayPrice once the store answered; null = not known
const inflight=new Map();                                          // txid -> Promise of its outcome, while it is being verified

const pids=()=>C.items.filter(i=>i.pid).map(i=>i.pid);
async function loadProducts(){
  try{
    const r=await call('products',{ids:pids()});
    const m=new Map();for(const p of (r&&r.products)||[])if(p&&typeof p.id==='string')m.set(p.id,typeof p.displayPrice==='string'?p.displayPrice:'');
    prod=m;
  }catch(e){}   // unknown stays unknown: the shop then behaves as if every item could be bought
}

// Cut a list of transactions into batches the server accepts: at most 16 each and well under its body limit (90000 characters)
function chunks(list){
  const out=[];let cur=[],len=0;
  for(const j of list){const l=j.length+3;if(cur.length&&(cur.length>=BATCH||len+l>=LIMIT)){out.push(cur);cur=[];len=0}cur.push(j);len+=l}
  if(cur.length)out.push(cur);return out;
}
// POST the transactions to /iap/verify. -> { results, state } or { fail: <the server's answer>, results } when a call failed
async function verify(jws){
  const results=[];let state=null;
  for(const part of chunks(jws)){
    const r=await G.api('/iap/verify',{pk:G.pkey(),jws:part},15000);
    if(!r||r.error||r._s>=400||!Array.isArray(r.results))return{fail:r||{error:'net'},results,state};
    for(const x of r.results)results.push(x);
    if(r.state)state=r.state;
  }
  return{results,state};
}
async function fin(txid){try{await call('finish',{txid})}catch(e){}}

// Verify [{jws, txid}] and finish the ones the server accepted. -> one { r: the server's result | null, fail: the failed answer | null, state } per item, in order.
// A transaction already being verified (buy and unfinished/"tx" can meet) is not sent twice: the second caller waits for the first one's outcome.
async function processItems(items){
  const out=new Array(items.length),mine=[],waits=[];
  items.forEach((x,i)=>{
    if(!x||typeof x.jws!=='string'||!x.jws){out[i]={r:null,fail:{error:'bad'},state:null};return}
    const p=inflight.get(x.txid);
    if(p)waits.push(p.then(o=>{out[i]=o}));else mine.push(i);
  });
  if(mine.length){
    const run=verify(mine.map(i=>items[i].jws)).catch(()=>({fail:{error:'net'},results:[],state:null}));
    for(const [k,i] of mine.entries()){
      const txid=items[i].txid;
      const p=run.then(v=>({r:v.results[k]||null,fail:v.results[k]?null:(v.fail||{error:'net'}),state:v.state}));   // results are in the order sent
      inflight.set(txid,p);
      waits.push(p.then(o=>{out[i]=o;if(o.r&&DONE.has(o.r.status))fin(txid)}).then(()=>{inflight.delete(txid)}));
    }
  }
  await Promise.all(waits);
  return out;
}
function resync(){
  const S=window.PPLSHOP;if(!S||typeof S.sync!=='function')return;
  S.sync().then(()=>{if(typeof S.render==='function')S.render()}).catch(()=>{});
}

// Retrying: a 400 (bad request, no nickname) or 413 never gets better by repeating (no nickname: G.onMe runs it again later);
// other failures (no network, 429, 5xx, 'off') are retried with a growing wait: 1, 2, 4 ... up to 30 minutes
let retryT=0,retryMs=60000,running=false;
function failed(f){
  if(!f)return;
  if(f._s===400||f._s===413)return;
  clearTimeout(retryT);retryT=setTimeout(processUnfinished,retryMs);retryMs=Math.min(retryMs*2,1800000);
}
async function processUnfinished(){
  if(!G.ME||running)return;   // the server needs a nickname to know the player: they are kept until one exists (G.onMe below)
  running=true;
  try{
    let items=[];
    try{const r=await call('unfinished',{});items=(r&&r.items)||[]}catch(e){return}
    if(!items.length)return;
    const out=await processItems(items.map(x=>({jws:x.jws,txid:String(x.txid)})));
    const bad=out.find(o=>o.fail);
    if(bad)failed(bad.fail);else retryMs=60000;
    if(out.some(o=>o.r&&DONE.has(o.r.status)))resync();
  }finally{running=false}
}
function onTx(d){   // a purchase that finished outside the app (Ask to Buy approved, another device)
  if(!d||typeof d.jws!=='string'||!G.ME)return;
  processItems([{jws:d.jws,txid:String(d.txid)}]).then(out=>{const o=out[0];if(o.fail)failed(o.fail);else{retryMs=60000;resync()}}).catch(()=>{});
}

// -> { ok, paid, ... }: paid = the native payment went through (whatever the server says next: the shop must then never suggest paying again)
async function buy(pid){
  if(!G.ME)return{ok:false,noname:true};
  let r;try{r=await call('buy',{id:pid})}catch(e){return{ok:false,error:'native'}}
  if(!r||r.status==='cancelled')return{ok:false,cancelled:true};
  if(r.status==='pending')return{ok:false,pending:true};
  if(r.status!=='success'||typeof r.jws!=='string')return{ok:false,error:'native'};
  const o=(await processItems([{jws:r.jws,txid:String(r.txid)}]))[0];
  if(o.fail){failed(o.fail);return Object.assign({},o.fail,{ok:false,paid:true,unverified:true})}   // paid but not recorded yet: it stays unfinished and is sent again
  if(!DONE.has(o.r&&o.r.status))return{ok:false,paid:true,bad:true,error:'bad',results:[o.r],state:o.state};
  return{ok:true,paid:true,results:[o.r],state:o.state};
}
async function restore(){
  if(!G.ME)return{ok:false,noname:true};
  let jws=[];try{const r=await call('entitlements',{});jws=(r&&r.jws)||[]}catch(e){return{ok:false,error:'native'}}
  if(!jws.length)return{ok:true,results:[]};
  const v=await verify(jws);
  if(v.fail)return Object.assign({},v.fail,{ok:false});   // e.g. { error: 'off' }
  return{ok:true,results:v.results,state:v.state};
}

const ready=loadProducts();
window.PPLIAP={ready,
  has:pid=>prod?prod.has(pid):null,   // false only when the store answered and the product is not in it
  price:pid=>prod&&prod.get(pid)||'',
  buy,restore};

try{if(cap&&cap.addListener)cap.addListener('PPLIAP','tx',onTx);else if(cap&&cap.Plugins&&cap.Plugins.PPLIAP&&cap.Plugins.PPLIAP.addListener)cap.Plugins.PPLIAP.addListener('tx',onTx)}catch(e){}
const prevMe=G.onMe;
G.onMe=()=>{if(typeof prevMe==='function')prevMe();processUnfinished()};
ready.then(()=>{processUnfinished();const S=window.PPLSHOP;if(S&&S.render&&document.querySelector('#shop')&&!document.querySelector('#shop').classList.contains('hidden'))S.render()});
})();
