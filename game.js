(()=>{
'use strict';
const $=s=>document.querySelector(s);
let errShown=0;
function showErr(e){
  try{console.error(e)}catch(_){}
  if(errShown++>0)return;
  const el=$('#err');if(!el)return;
  $('#errT').textContent='發生錯誤，請截圖回報：'+String((e&&(e.message||e))||e).slice(0,160);el.style.display='block';
  $('#errR').onclick=()=>location.reload();
}
addEventListener('error',ev=>{if(ev&&ev.message&&!/ResizeObserver/.test(ev.message))showErr(ev.error||ev.message)});
const cv=$('#c'),ctx=cv.getContext('2d');
let W=0,H=0,dpr=1,rscale=Math.min(window.devicePixelRatio||1,1.75);
const rand=(a,b)=>a+Math.random()*(b-a);
let RNG=Math.random;const srand=(a,b)=>a+RNG()*(b-a);   // obstacles / items / ball starts: seeded in a duel so both phones get the same
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
function lsGet(k){try{return localStorage.getItem(k)}catch(e){return null}}
function lsSet(k,v){try{localStorage.setItem(k,v)}catch(e){}}
function rr(x,px,py,w,h,r){x.beginPath();x.moveTo(px+r,py);x.arcTo(px+w,py,px+w,py+h,r);x.arcTo(px+w,py+h,px,py+h,r);x.arcTo(px,py+h,px,py,r);x.arcTo(px,py,px+w,py,r);x.closePath()}

/* ================= audio =================
   Rhythm-game style mix: the BACKING (everything except the melody line) plays continuously and quietly;
   the MELODY is the foreground voice and only sounds when the player hits the matching beat. */
let AC=null,master=null,wet=null,useAC=false,busMel=null,busBk=null,busFx=null,bkLP=null,melSend=null;
const RM=!!(window.matchMedia&&matchMedia('(prefers-reduced-motion: reduce)').matches);
const SET=Object.assign({mel:80,bk:80,fx:80,lowFx:RM,vib:true,lat:null,ml:true},(()=>{try{return JSON.parse(lsGet('ppl-set')||'{}')}catch(e){return{}}})());
function saveSet(){lsSet('ppl-set',JSON.stringify(SET))}
function applyVol(){if(!AC)return;busMel.gain.value=SET.mel/80;busBk.gain.value=SET.bk/80;busFx.gain.value=SET.fx/80}
// audio latency compensation (s): sounds are scheduled this much earlier so they are HEARD on the beat
function latS(){if(SET.lat!=null)return clamp(SET.lat,-100,400)/1000;if(!AC)return 0;return clamp((AC.outputLatency||AC.baseLatency||0),0,.3)}
// the app shell cannot save a downloaded file: offer the score card only where the system share sheet takes images
function shareOK(){if(!APP)return true;try{return !!(window.Capacitor&&Capacitor.isPluginAvailable&&Capacitor.isPluginAvailable('Share')&&Capacitor.isPluginAvailable('Filesystem'))}catch(e){return false}}
function vib(p){if(!SET.vib)return;try{if(navigator.vibrate)navigator.vibrate(p)}catch(e){}}
try{if(navigator.audioSession)navigator.audioSession.type='playback'}catch(e){}   // iOS 16.4+: Web Audio keeps playing with the silent switch on
let silentEl=null;
function wavUri(){   // 0.25 s of silence as a data URI (keeps iOS audio session in "playback" mode)
  const n=2000,b=new Uint8Array(44+n),v=new DataView(b.buffer),w=(o,t)=>{for(let i=0;i<t.length;i++)b[o+i]=t.charCodeAt(i)};
  w(0,'RIFF');v.setUint32(4,36+n,true);w(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);w(36,'data');v.setUint32(40,n,true);
  for(let i=0;i<n;i++)b[44+i]=128;
  let s='';for(const x of b)s+=String.fromCharCode(x);return 'data:audio/wav;base64,'+btoa(s);
}
// running inside the store app (Capacitor shell): no browser chrome, no service worker, links point at the website
const APP=location.protocol==='capacitor:'||!!(window.Capacitor&&window.Capacitor.isNativePlatform&&window.Capacitor.isNativePlatform());
const SITE='https://pingponglight.vercel.app/';
const isIOS=/iPad|iPhone|iPod/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
function stopSilent(){try{if(silentEl){silentEl.pause();silentEl.removeAttribute('src');silentEl.load();silentEl=null}}catch(e){}}
function unlockAudio(){
  let ses=false;try{if(navigator.audioSession){navigator.audioSession.type='playback';ses=true}}catch(e){}
  // iPhone silent-switch workaround only; elsewhere an <audio> element would create a media notification
  if(isIOS&&!ses){try{if(!silentEl){silentEl=new Audio(wavUri());silentEl.loop=true;silentEl.volume=1;silentEl.setAttribute('playsinline','')}
      const p=silentEl.play();if(p&&p.catch)p.catch(()=>{})}catch(e){}}
  if(AC){
    if(AC.state!=='running'&&AC.resume){const p=AC.resume();if(p&&p.catch)p.catch(()=>{})}
    try{const bf=AC.createBuffer(1,1,22050),src=AC.createBufferSource();src.buffer=bf;src.connect(AC.destination);src.start(0)}catch(e){}
  }
}
function audioStatus(){
  const el=$('#aud');if(!el)return;
  if(!AC){el.textContent='';return}
  el.textContent=AC&&AC.state==='running'?'聲音已啟用':'聲音未啟用：請點一下畫面，並確認裝置未開啟靜音。';
  el.style.color=AC&&AC.state==='running'?'#7cf0ff':'#ffb86b';
}
let acStale=false,acWatch={t:-1,w:0};
// iOS: after switching apps / an interruption the context can report "running" yet stay silent;
// such a context is closed and rebuilt on the next button press (never in the middle of a run)
function resetAudio(){   // decoded samples (AudioBuffers) stay valid across contexts
  try{if(AC&&AC.close&&AC.state!=='closed'){const p=AC.close();if(p&&p.catch)p.catch(()=>{})}}catch(e){}
  AC=null;master=wet=busMel=busBk=busFx=bkLP=melSend=null;mlFx=-1;noiseBuf=null;live.length=0;acStale=false;acWatch={t:-1,w:0};
}
function initAudio(force){
  if(AC&&(force||acStale||AC.state==='closed'||AC.state==='interrupted')&&(st!=='play'||paused))resetAudio();
  if(AC){unlockAudio();return}
  try{
    AC=new(window.AudioContext||window.webkitAudioContext)();
    master=AC.createGain();master.gain.value=.55;
    const comp=AC.createDynamicsCompressor();
    comp.threshold.value=-16;comp.knee.value=10;comp.ratio.value=3.5;comp.attack.value=.004;comp.release.value=.25;
    const lim=AC.createDynamicsCompressor();lim.threshold.value=-3;lim.knee.value=0;lim.ratio.value=20;lim.attack.value=.001;lim.release.value=.08;
    const out=AC.createGain();out.gain.value=.72;   // compressors add automatic make-up gain; trim it back
    const sat=AC.createWaveShaper(),cv2=new Float32Array(1025);   // soft clipper: transparent below 0.8, smooth above
    for(let i=0;i<1025;i++){const x=i/256-2,a=Math.abs(x);cv2[i]=Math.sign(x)*(a<.8?a:.8+.2*Math.tanh((a-.8)/.2))}
    sat.curve=cv2;
    master.connect(comp);comp.connect(lim);lim.connect(out);out.connect(sat);sat.connect(AC.destination);
    // small-hall reverb (generated impulse response) instead of a slap-back echo
    wet=AC.createConvolver();wet.buffer=hallIR(2.2);const wOut=AC.createGain();wOut.gain.value=.85;wet.connect(wOut);wOut.connect(master);
    busMel=AC.createGain();busBk=AC.createGain();busFx=AC.createGain();
    // backing passes a low-pass so music layer 0 can sound distant; the melody's reverb send grows at layer 3
    bkLP=AC.createBiquadFilter();bkLP.type='lowpass';bkLP.Q.value=-3.01;bkLP.frequency.value=AC.sampleRate/2;busBk.connect(bkLP);
    for(const[b,send]of[[busMel,.3],[bkLP,.2],[busFx,.25]]){b.connect(master);const sg=AC.createGain();sg.gain.value=send;b.connect(sg);sg.connect(wet);if(b===busMel)melSend=sg}
    applyVol();
    AC.onstatechange=audioStatus;
  }catch(e){AC=null}
  unlockAudio();
}
const live=[];
function hallIR(sec){   // stereo noise with an exponential tail, softened by a one-pole low-pass
  const r=AC.sampleRate,n=Math.floor(r*sec),b=AC.createBuffer(2,n,r);
  for(let c=0;c<2;c++){const d=b.getChannelData(c);let y=0;
    for(let i=0;i<n;i++){const x=Math.random()*2-1;y+=.3*(x-y);const k=i/n;d[i]=y*Math.pow(1-k,3.2)*Math.min(1,i/(r*.012))}}
  return b;
}
function track(g,end){const now=AC.currentTime;for(let i=live.length-1;i>=0;i--)if(live[i].end<now-.5)live.splice(i,1);live.push({g,end})}
// piano-like tone: harmonic partials that start together and decay at different rates (upper ones faster)
function pluck(f,t,hold,vol,parts,decay,dest,cents){
  const g=AC.createGain();g.gain.value=vol;g.connect(dest);
  const end=t+hold;
  for(const[m,a]of parts){
    const o=AC.createOscillator(),og=AC.createGain();o.type='sine';o.frequency.value=f*m*(1+.00035*m*m);if(cents)o.detune.value=cents;
    const tc=decay/Math.pow(m,.75);
    og.gain.setValueAtTime(0,t);og.gain.linearRampToValueAtTime(a,t+.005);og.gain.setTargetAtTime(0,t+.005,tc);
    og.gain.setTargetAtTime(0,end,.09);
    o.connect(og);og.connect(g);o.start(t);o.stop(end+.6);
  }
  track(g,end+.4);
}
const P_LEAD=[[1,1],[2,.42],[3,.17],[4,.07]],P_BK=[[1,1],[2,.28],[3,.08]],P_BASS=[[1,1],[2,.55],[3,.3],[4,.12]];
/* ---- sampled instruments: real recordings (Salamander piano, FluidR3 GM), one sample every 3 semitones ----
   g: loudness match, rel: release after the note ends, lo/hi: natural range (notes outside fold by octaves), pan */
const INST={
  piano:{g:.67,rel:.35,lo:27,hi:102},violin:{g:2.2,rel:.22,lo:55,hi:100},viola:{g:2.05,rel:.22,lo:48,hi:88},
  cello:{g:2.25,rel:.25,lo:36,hi:76},strings:{g:2.1,rel:.3,lo:36,hi:96},flute:{g:1.1,rel:.12,lo:60,hi:96},
  recorder:{g:1.05,rel:.1,lo:60,hi:96},guitar:{g:1.8,rel:.45,lo:40,hi:84},organ:{g:1.5,rel:.12,lo:36,hi:96},
  choir:{g:2.2,rel:.3,lo:48,hi:84},trumpet:{g:1.6,rel:.1,lo:52,hi:88},clarinet:{g:.82,rel:.1,lo:50,hi:94},pizz:{g:1.3,rel:.3,lo:28,hi:88}};
// which instrument plays which part of each piece (lead = melody, bk = accompaniment, bass = accompaniment below E3, ctr = counter-melody)
const INSTMAP={green:{lead:'flute',bk:'guitar'},canon:{lead:'violin',bk:'strings',bass:'cello'},prelude:{lead:'piano',bk:'piano'},
  minuetg:{lead:'piano',bk:'piano'},spring:{lead:'violin',bk:'strings',bass:'cello'},air:{lead:'violin',bk:'strings',bass:'cello'},
  hallelujah:{lead:'choir',bk:'choir',bass:'cello'},twinkle:{lead:'piano',bk:'piano'},turkish:{lead:'piano',bk:'piano'},
  nacht:{lead:'violin',bk:'viola',bass:'cello'},auld:{lead:'flute',bk:'guitar'},k545:{lead:'piano',bk:'piano'},moon:{lead:'piano',bk:'piano'},
  fifth:{lead:'strings',bk:'strings',bass:'cello'},elise:{lead:'piano',bk:'piano'},silent:{lead:'choir',bk:'guitar',ctr:'choir'},
  ode:{lead:'violin',bk:'strings',bass:'cello',ctr:'viola'},schubert:{lead:'violin',bk:'piano'},nocturne:{lead:'piano',bk:'piano'},
  grace:{lead:'flute',bk:'organ'},traum:{lead:'piano',bk:'piano'},wedding:{lead:'organ',bk:'organ'},minute:{lead:'piano',bk:'piano'},
  gounod:{lead:'violin',bk:'piano'},danube:{lead:'violin',bk:'strings',bass:'cello'},lullaby:{lead:'recorder',bk:'guitar'},
  carmen:{lead:'trumpet',bk:'strings',bass:'cello'},mountain:{lead:'clarinet',bk:'pizz'},gymno:{lead:'piano',bk:'piano'},
  entertainer:{lead:'piano',bk:'piano'},clair:{lead:'piano',bk:'piano'}};
const SAMP={},SGAIN=5;   // samples are recorded quieter than the synth voices
function decodeAB(ab){return new Promise((res,rej)=>{const p=AC.decodeAudioData(ab,res,rej);if(p&&p.then)p.then(res,rej)})}
function trimLead(buf){   // MP3 decoders may leave encoder padding: start every sample exactly at its attack
  const d=buf.getChannelData(0);let pk=0;for(let i=0;i<d.length;i+=4)pk=Math.max(pk,Math.abs(d[i]));
  let i=0;const th=pk*.004;while(i<d.length&&Math.abs(d[i])<th)i++;i=Math.max(0,i-44);
  if(i<32)return buf;
  const nb=AC.createBuffer(1,buf.length-i,buf.sampleRate);nb.getChannelData(0).set(d.subarray(i));return nb;
}
function loadInst(name){
  if(SAMP[name])return SAMP[name].p;
  const I=INST[name],S=SAMP[name]={buf:{},n:0,total:0,ready:false};
  const ms=[];for(let m=I.lo-2;m<=I.hi+2;m++)if(m%3===0)ms.push(m);S.total=ms.length;
  S.p=Promise.all(ms.map(m=>fetch('inst/'+name+'/'+m+'.mp3').then(r=>r.ok?r.arrayBuffer():Promise.reject(r.status))
      .then(ab=>AC?decodeAB(ab):Promise.reject('no audio')).then(b=>{S.buf[m]=trimLead(b);S.n++}).catch(()=>{S.n++})))
    .then(()=>{S.ready=Object.keys(S.buf).length>S.total*.8;if(!S.ready)delete SAMP[name]});   // a failed load is retried next time
  return S.p;
}
const instMap=s=>s&&(INSTMAP[s.key]||s.inst);
function songInsts(s){const m=instMap(s);return m?[...new Set(Object.values(m))]:[]}
let instLoad={busy:false,n:0,total:0};
function preloadSong(s){
  if(!AC||!s)return Promise.resolve();
  const L=songInsts(s);if(!L.length)return Promise.resolve();
  instLoad={busy:true,n:0,total:0,key:s.key};
  const tick2=()=>{let n=0,t=0;for(const k of L){const S=SAMP[k];if(S){n+=S.n;t+=S.total}}instLoad.n=n;instLoad.total=t};
  const iv=setInterval(tick2,120);
  return Promise.race([Promise.all(L.map(loadInst)),new Promise(r=>setTimeout(r,12000))]).then(()=>{clearInterval(iv);tick2();if(instLoad.key===s.key)instLoad.busy=false});
}
const PAN={lead:0,bk:-.18,bass:.16,ctr:.22};
function playInst(name,role,midi,t,hold,vol,cents,dest){
  const S=SAMP[name];if(!S||!S.ready)return false;
  const I=INST[name];while(midi>I.hi)midi-=12;while(midi<I.lo)midi+=12;
  let m0=Math.round(midi/3)*3;if(!S.buf[m0]){m0=+Object.keys(S.buf).reduce((a,b)=>Math.abs(b-midi)<Math.abs(a-midi)?b:a)}
  const buf=S.buf[m0];if(!buf)return false;
  const src=AC.createBufferSource(),g=AC.createGain();src.buffer=buf;src.playbackRate.value=Math.pow(2,(midi-m0)/12);
  if(cents&&src.detune)src.detune.value=cents;
  const end=t+Math.min(hold,buf.duration/src.playbackRate.value-.05);
  g.gain.setValueAtTime(vol*I.g*SGAIN*(role==='lead'?1:1.15),t);g.gain.setTargetAtTime(0,end,I.rel/3);
  let out=g;if(AC.createStereoPanner&&PAN[role]){const pn=AC.createStereoPanner();pn.pan.value=PAN[role];g.connect(pn);out=pn}
  src.connect(g);out.connect(dest||(role==='lead'?busMel:busBk));src.start(t);src.stop(end+I.rel+.1);
  track(g,end+I.rel);return true;
}
function instOf(role){const m=instMap(song);if(!m||st==='home'||st==='menu')return null;return role==='ctr'?(m.ctr||m.bk):role==='bass'?(m.bass||m.bk):m[role]}
function voice(midi,when,dur,vol,cents,lead,bus){
  if(!AC)return;
  if(!bus){   // pieces with real-instrument samples
    const role=lead?'lead':(midi<52?'bass':'bk'),nm=instOf(role);
    if(nm&&playInst(nm,role,midi,AC.currentTime+Math.max(0,when),clamp(dur*1.05,.12,3),lead?vol*.62:vol,cents))return;
  }
  const f=440*Math.pow(2,(midi-69)/12),t=AC.currentTime+Math.max(0,when);
  if(!lead){   // backing: soft piano; low notes get extra harmonics so phone speakers can reproduce them
    const hold=clamp(dur*1.05,.18,2.4);
    pluck(f,t,hold,vol,midi<52?P_BASS:P_BK,midi<52?1.1:.8,bus||busBk,0);return;
  }
  const hold=clamp(dur*1.1,.22,2.4);
  if(LEADTYPE==='triangle'){pluck(f,t,hold,vol*.62,P_LEAD,1.0,bus||busMel,cents);return}
  // original tracks: filtered saw / square synth lead with a short filter sweep
  const g=AC.createGain(),lp=AC.createBiquadFilter(),o=AC.createOscillator(),o2=AC.createOscillator();
  lp.type='lowpass';lp.Q.value=.7;lp.frequency.setValueAtTime(Math.min(8000,f*7),t);lp.frequency.setTargetAtTime(Math.min(5000,f*2.6),t+.01,.12);
  o.type=o2.type=LEADTYPE;o.frequency.value=o2.frequency.value=f;o.detune.value=(cents||0)-5;o2.detune.value=(cents||0)+5;
  const a=vol*.4;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(a,t+.006);g.gain.setTargetAtTime(a*.6,t+.01,.15);g.gain.setTargetAtTime(0,t+hold,.07);
  o.connect(lp);o2.connect(lp);lp.connect(g);g.connect(bus||busMel);o.start(t);o2.start(t);o.stop(t+hold+.5);o2.stop(t+hold+.5);
  track(g,t+hold+.3);
}
function cvoice(midi,when,dur,vol){   // counter-melody: soft, rounder timbre, always under the melody
  if(!AC)return;
  {const nm=instOf('ctr');if(nm&&playInst(nm,'ctr',midi,AC.currentTime+Math.max(0,when),clamp(dur*1.05,.12,3),vol*.9,0))return}
  const f=440*Math.pow(2,(midi-69)/12),t=AC.currentTime+Math.max(0,when),d=Math.max(.2,Math.min(dur*1.15,2.4));
  const g=AC.createGain(),lp=AC.createBiquadFilter();lp.type='lowpass';lp.frequency.value=Math.min(5000,f*4);
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vol,t+.025);g.gain.setTargetAtTime(vol*.55,t+.05,.25);g.gain.setTargetAtTime(.0001,t+d*.8,d*.12+.03);
  for(const[m,type,a]of[[1,'triangle',1],[2,'sine',.22]]){const o=AC.createOscillator(),og=AC.createGain();o.type=type;o.frequency.value=f*m;og.gain.value=a;o.connect(og);og.connect(lp);o.start(t);o.stop(t+d+.4)}
  lp.connect(g);g.connect(busBk);
  live.push({g,end:t+d});
}
function cutAll(){
  if(!AC)return;const now=AC.currentTime;
  for(const v of live)if(v.end>now){try{v.g.gain.cancelScheduledValues(now);v.g.gain.setTargetAtTime(.0001,now,.025)}catch(e){}}
  live.length=0;
}
/* ---- menu music: an original slow piano piece (D major, 72 BPM, 8-bar loop) for the home, song-select and duel-lobby screens.
   It fades in after the first tap (browsers only allow sound after one), fades out when a run, the tutorial or calibration
   starts, and follows the backing-volume setting. The melody joins on the 2nd and 3rd pass and the arpeggio varies per pass. */
const HM={g:null,on:false,next:0,step:0,loop:0},HM_E=60/72/2;   // one step = an eighth note
const HM_CH=[[50,[62,66,69,73]],[47,[62,66,69,71]],[43,[62,66,67,71]],[45,[62,64,69,71]],
  [42,[61,64,66,69]],[47,[62,66,69,71]],[40,[62,64,67,71]],[45,[61,64,67,69]]];   // [bass, voicing]: Dmaj7 Bm7 Gmaj7 Asus F#m7 Bm7 Em7 A7
const HM_MEL=[[[0,78,3],[3,76,1],[4,73,4]],[[0,74,4],[4,73,2],[6,71,2]],[[0,71,3],[3,74,1],[4,78,4]],[[0,76,6],[6,73,2]],
  [[0,73,3],[3,71,1],[4,69,4]],[[0,74,3],[3,73,1],[4,71,4]],[[0,71,2],[2,74,2],[4,79,4]],[[0,78,4],[4,76,4]]];   // [eighth, midi, length]
const HM_ARP=[[0,1,2,3,2,1,2,3],[0,2,1,3,0,2,3,1],[3,2,1,0,1,2,3,2]];
const homeWant=()=>!!AC&&AC.state==='running'&&(st==='home'||st==='menu')&&!PV.s&&mode!=='tut'&&!document.hidden&&$('#cal').classList.contains('hidden');
function hNote(midi,t,hold,vol){   // piano sample when loaded, soft synth piano otherwise
  const S=SAMP.piano;
  if(S&&S.ready){const I=INST.piano;let m0=Math.round(midi/3)*3;if(!S.buf[m0])m0=+Object.keys(S.buf).reduce((a,b)=>Math.abs(b-midi)<Math.abs(a-midi)?b:a);
    const buf=S.buf[m0];if(buf){const src=AC.createBufferSource(),g=AC.createGain();src.buffer=buf;src.playbackRate.value=Math.pow(2,(midi-m0)/12);
      const end=t+Math.min(hold,buf.duration/src.playbackRate.value-.05);g.gain.setValueAtTime(vol*I.g*SGAIN,t);g.gain.setTargetAtTime(0,end,I.rel/3);
      src.connect(g);g.connect(HM.g);src.start(t);src.stop(end+I.rel+.1);return}}
  pluck(440*Math.pow(2,(midi-69)/12),t,hold,vol,midi<52?P_BASS:P_BK,midi<52?1.1:.9,HM.g,0);
}
function hPad(notes,t,dur){   // quiet sustained chord underneath
  const g=AC.createGain(),lp=AC.createBiquadFilter();lp.type='lowpass';lp.frequency.value=900;
  g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(.035,t+1.1);g.gain.setTargetAtTime(0,t+dur-.3,.5);
  for(const m of notes){const o=AC.createOscillator();o.type='triangle';o.frequency.value=440*Math.pow(2,(m-12-69)/12);o.detune.value=(m%2?4:-4);o.connect(lp);o.start(t);o.stop(t+dur+2.5)}
  lp.connect(g);g.connect(HM.g);
}
function homeStep(k,t){
  const bar=k>>3,e=k&7,[bass,v]=HM_CH[bar],mel=HM.loop%3!==0;
  if(e===0){hNote(bass,t,HM_E*4,.34);hPad(v,t,HM_E*8)}else if(e===4)hNote(bass+7,t,HM_E*3,.2);
  hNote(v[HM_ARP[HM.loop%3][e]],t,HM_E*1.6,(e%4===0?.2:.14)*(mel?.75:1));
  if(mel)for(const[n,m,l]of HM_MEL[bar])if(n===e)hNote(m,t,HM_E*l,.36);
}
function homeTick(){
  if(!AC)return;
  if(!HM.g||HM.g.context!==AC){HM.g=AC.createGain();HM.g.gain.value=0;HM.g.connect(busBk);HM.on=false}
  const want=homeWant(),now=AC.currentTime;
  if(want!==HM.on){HM.on=want;HM.g.gain.cancelScheduledValues(now);HM.g.gain.setTargetAtTime(want?.55:0,now,want?.9:.12);   // ~5 dB under gameplay music
    if(want){HM.next=now+.2;HM.step=0;HM.loop=0;loadInst('piano')}}
  if(!HM.on)return;
  if(HM.next<now-.1)HM.next=now+.05;   // timer was throttled: skip ahead instead of bursting notes
  while(HM.next<now+.6){homeStep(HM.step,HM.next);HM.next+=HM_E;if(++HM.step>=64){HM.step=0;HM.loop++}}
}
setInterval(homeTick,150);
/* ---- song preview: a piece tapped on the select screen plays quietly from its first tune note for PV_LEN seconds, with its own
   instruments (synth until the samples arrive); the menu music steps aside meanwhile and comes back afterwards */
const PV={g:null,s:null,n:null,i:0,t0:0,stop:0,tok:0},PV_LEN=20;
const pvWant=()=>!!AC&&AC.state==='running'&&st==='menu'&&mode==='normal'&&!$('#menu').classList.contains('hidden')&&!document.hidden;
function pvEnd(){
  if(PV.g&&AC){const g=PV.g,now=AC.currentTime;g.gain.cancelScheduledValues(now);g.gain.setTargetAtTime(0,now,.12);setTimeout(()=>{try{g.disconnect()}catch(e){}},1500)}
  PV.g=null;PV.s=null;PV.n=null;PV.tok++;
}
function pvPlay(s){
  pvEnd();if(!AC||!s||!s.n||!pvWant())return;
  const tok=PV.tok;PV.s=s;   // claims the music slot now, so the menu music fades while the samples load
  Promise.race([preloadSong(s),new Promise(r=>setTimeout(r,1500))]).then(()=>{
    if(tok!==PV.tok||!pvWant()){if(tok===PV.tok)pvEnd();return}
    const n=s.n.filter(x=>x[3]!==2).sort((a,b)=>a[0]-b[0]),m=n.find(x=>x[3]===1),off=m?Math.max(0,m[0]-40):0,now=AC.currentTime;
    PV.n=n;PV.i=n.findIndex(x=>x[0]>=off);if(PV.i<0)PV.i=n.length;
    PV.t0=now+.25-off/100;PV.stop=off+PV_LEN*100;
    const g=PV.g=AC.createGain();g.gain.setValueAtTime(0,now);g.gain.setTargetAtTime(.6,now,.3);g.gain.setTargetAtTime(0,PV.t0+PV.stop/100-2,.6);g.connect(busBk);
  });
}
function pvNote(x){
  const k=x[3],role=k===1?'lead':k===3?'ctr':x[2]<52?'bass':'bk',m=instMap(PV.s),t=PV.t0+x[0]/100,hold=clamp(x[1]/100*1.05,.15,2.4);
  const nm=m&&(role==='ctr'?(m.ctr||m.bk):role==='bass'?(m.bass||m.bk):m[role]),vol=k===1?.36:.2;
  if(nm&&playInst(nm,role,x[2],t,hold,k===1?vol*.62:vol,0,PV.g))return;
  pluck(440*Math.pow(2,(x[2]-69)/12),t,hold,vol,k===1?P_LEAD:x[2]<52?P_BASS:P_BK,x[2]<52?1.1:.9,PV.g,0);
}
function pvTick(){
  if(!PV.s)return;
  if(!pvWant()){pvEnd();return}
  if(!PV.n||!PV.g)return;
  const now=AC.currentTime;
  if(now>PV.t0+PV.stop/100+.5){pvEnd();return}
  while(PV.i<PV.n.length){const x=PV.n[PV.i],t=PV.t0+x[0]/100;if(t>now+.6||x[0]>PV.stop)break;if(t>=now-.05)pvNote(x);PV.i++}
}
setInterval(pvTick,150);
// the first tap anywhere on a menu screen enables sound, so the menu music can start
// (pointerup/click: on touch screens a pointerdown does not count as a gesture that may start audio)
function menuWake(){if(st!=='home'&&st!=='menu')return;if(!AC)initAudio();else if(AC.state!=='running')unlockAudio()}
for(const ev of ['pointerdown','pointerup','click'])document.addEventListener(ev,menuWake,{capture:true,passive:true});
let noiseBuf=null;
function noise(){if(!noiseBuf){const n=AC.sampleRate*.4,b=AC.createBuffer(1,n,AC.sampleRate),d=b.getChannelData(0);for(let i=0;i<n;i++)d[i]=Math.random()*2-1;noiseBuf=b}return noiseBuf}
function drum(kind,when){      // 36 kick, 38 snare, 42 hi-hat
  if(!AC)return;const t=AC.currentTime+Math.max(0,when);
  if(kind===36){
    const o=AC.createOscillator(),g=AC.createGain();o.type='sine';o.frequency.setValueAtTime(150,t);o.frequency.exponentialRampToValueAtTime(42,t+.12);
    g.gain.setValueAtTime(.5,t);g.gain.exponentialRampToValueAtTime(.001,t+.2);o.connect(g);g.connect(busBk);o.start(t);o.stop(t+.22);live.push({g,end:t+.22});
  }else{
    const s=AC.createBufferSource(),f=AC.createBiquadFilter(),g=AC.createGain();s.buffer=noise();
    if(kind===38){f.type='bandpass';f.frequency.value=1900;g.gain.setValueAtTime(.3,t);g.gain.exponentialRampToValueAtTime(.001,t+.14);
      const o=AC.createOscillator(),og=AC.createGain();o.type='triangle';o.frequency.value=190;og.gain.setValueAtTime(.18,t);og.gain.exponentialRampToValueAtTime(.001,t+.09);o.connect(og);og.connect(busBk);o.start(t);o.stop(t+.1)}
    else{f.type='highpass';f.frequency.value=7500;g.gain.setValueAtTime(.1,t);g.gain.exponentialRampToValueAtTime(.001,t+.05)}
    s.connect(f);f.connect(g);g.connect(busBk);s.start(t);s.stop(t+.16);live.push({g,end:t+.16});
  }
}
let LEADTYPE='triangle';
function tick(when,vol){
  if(!AC)return;const t=AC.currentTime+Math.max(0,when),o=AC.createOscillator(),g=AC.createGain();
  o.type='sine';o.frequency.value=1400;g.gain.setValueAtTime(0,t);g.gain.linearRampToValueAtTime(vol||.1,t+.003);g.gain.exponentialRampToValueAtTime(.0005,t+.07);
  o.connect(g);g.connect(busFx);o.start(t);o.stop(t+.1);
}
// timing error (seconds, negative = early) -> detune in cents: early = flat, late = sharp
function centsOf(e){const a=Math.abs(e);return a<.035?0:Math.sign(e)*Math.min(18,(a-.035)/.115*18)}   // subtle: the tune must stay pleasant
const pitchTxt=c=>Math.abs(c)<6?'音準正確':(c<0?'♭ ':'♯ ')+Math.abs(Math.round(c))+'¢';

/* ================= songs ================= */
const SD=window.SONGDATA||{};
const ORDER=window.SONGORDER||Object.keys(SD);
const SONGS=ORDER.filter(k=>SD[k]).map(k=>Object.assign({key:k},SD[k]));
// constellations: groups of songs in play order. They shape the star map and the song list, and songs unlock
// within each constellation. A song listed nowhere joins the last constellation.
const CONS_DEF=window.SONGCONS||[
  ['古老旋律座',['green','twinkle','auld','grace','silent']],
  ['巴洛克座',['canon','prelude','minuetg','spring','air','hallelujah']],
  ['古典座',['turkish','nacht','k545','moon','fifth','elise','ode']],
  ['浪漫座',['schubert','traum','nocturne','wedding','minute','gounod','danube','lullaby']],
  ['晚浪漫與印象座',['carmen','mountain','gymno','entertainer','clair']],
  ['霓虹座',['neon','pixel','velvet']]];
const CONS=(()=>{
  const used=new Set(),out=[];
  for(const[name,keys]of CONS_DEF){const ii=[];for(const k of keys){const i=SONGS.findIndex(x=>x.key===k);if(i>=0&&!used.has(i)){used.add(i);ii.push(i)}}if(ii.length)out.push({name,ii})}
  const rest=SONGS.map((_,i)=>i).filter(i=>!used.has(i));
  if(rest.length){if(out.length)out[out.length-1].ii.push(...rest);else out.push({name:'星空',ii:rest})}
  return out;
})();
const CON_OF=[];CONS.forEach((c,k)=>c.ii.forEach((i,j)=>{CON_OF[i]=[k,j]}));
if(!SONGS.length)setTimeout(()=>showErr('曲目資料載入失敗，請確認網路後重新載入。'),0);
const songHue=i=>(i*53+200)%360;
let song=SONGS[0],melList=[],bkList=[],bkV=[],tg=[];
// beat picking: within [gap, 1.6*gap] after the previous target prefer long notes, local peaks and phrase onsets
function pickTargets(mel,gap){
  const out=[];let last=-1e9,i=0;
  while(i<mel.length){
    const t0=mel[i][0]/100;
    if(t0-last<gap){i++;continue}
    if(!out.length){out.push(i);last=t0;i++;continue}
    let best=i,bs=-1e9;
    for(let j=i;j<mel.length;j++){
      const t=mel[j][0]/100;if(j>i&&t>last+gap*1.6)break;
      const pv=mel[j-1],nx=mel[j+1];
      const peak=(!pv||mel[j][2]>=pv[2])&&(!nx||mel[j][2]>=nx[2])?1:0;
      const onset=pv?Math.min(.6,t-pv[0]/100):.6;
      const sc=Math.min(1,mel[j][1]/100)+.25*peak+.35*onset-.5*(t-last-gap)/gap;
      if(sc>bs){bs=sc;best=j}
    }
    out.push(best);last=mel[best][0]/100;i=best+1;
  }
  return out;
}
const STARS=SONGS.map(s=>{const m=s.n.filter(n=>n[3]===1).length/Math.max(1,s.dur);return m<1?1:m<2?2:m<3?3:m<4.5?4:5});
const starTxt=n=>'★'.repeat(n)+'☆'.repeat(5-n);
// when the tune rests or holds one note for long (Canon's slow voice, long intros), lend the top accompaniment line
// to the player so the beats keep flowing; those notes then ring only when hit, like the tune itself
const FILL_GAP=160,FILL_EDGE=30,FILL_MIN=25,FILL_LOW=55;   // centiseconds, MIDI pitch
// a held tune note of the same pitch would make the lent note sound like the tune stuttering
const ringing=(t,p)=>melList.some(n=>n[2]===p&&n[0]<=t&&t<n[0]+n[1]);
function lendTop(){
  const on=[0,...melList.map(n=>n[0])],take=new Set();   // the song start counts as an edge, so silent intros fill too
  for(let g=0;g+1<on.length;g++){
    const a=on[g],b=on[g+1];if(b-a<=FILL_GAP)continue;
    let last=-1e9;
    for(let j=0;j<bkList.length;j++){
      const t=bkList[j][0];if(t<a+(g?FILL_EDGE:0)||t>b-FILL_EDGE||bkList[j][3]!==0)continue;
      let top=j;for(let k=j+1;k<bkList.length&&bkList[k][0]-t<=3;k++)if(bkList[k][3]===0&&bkList[k][2]>bkList[top][2])top=k;   // top note of the chord
      if(bkList[top][2]<FILL_LOW||t-last<FILL_MIN||ringing(t,bkList[top][2]))continue;
      take.add(top);last=t;
    }
  }
  if(!take.size)return;
  melList=melList.concat([...take].map(i=>bkList[i])).sort((x,y)=>x[0]-y[0]||y[2]-x[2]);
  bkList=bkList.filter((_,i)=>!take.has(i));
}
function prepare(s){
  melList=[];bkList=[];
  for(const n of s.n)(n[3]===1?melList:bkList).push(n);
  lendTop();
  // chords: notes struck together share the loudness so dense accompaniment never swamps the tune
  bkV=new Float32Array(bkList.length);
  for(let i=0;i<bkList.length;i++){
    if(bkList[i][3]!==0){bkV[i]=1;continue}
    let c=1;const t0=bkList[i][0];
    for(let j=i-1;j>=0&&t0-bkList[j][0]<=3;j--)if(bkList[j][3]===0)c++;
    for(let j=i+1;j<bkList.length&&bkList[j][0]-t0<=3;j++)if(bkList[j][3]===0)c++;
    bkV[i]=Math.max(.4,1/Math.sqrt(c));
  }
  tg=pickTargets(melList,D.gap).map(i=>({t:melList[i][0]/100,mi:i,mend:0}));
  if(mode==='tut')tg=tg.slice(0,TUTN);
  tg.forEach((x,i)=>{x.mend=i+1<tg.length?tg[i+1].mi:melList.length});
}

/* ================= state ================= */
let FR={x:0,y:0,w:0,h:0},BR=9,BR0=9,V0=420,HR=50,portrait=false;
function sizeFor(){BR=BR0*(D&&D.bm||1);HR=Math.max(46,BR0*5.5)*(D&&D.hm||1)}   // ball and touch size follow the difficulty
const HRe=()=>HR*(rangeT>0?rangeMul:1)*(DU.shrinkT>0?.7:1);
/* online duel state */
const DU={ws:null,code:'',you:0,host:0,players:[],cfg:{song:'',di:1,pub:false,max:6,vote:false,qm:false},votes:{},auto:0,phase:'lobby',off:0,pings:[],seed:1,startAt:0,
  board:[],names:{},n:1,rank:0,rankT:0,res:null,myFin:null,left:false,joined:false,pstreak:0,fogT:0,shrinkT:0,sprint:false,banner:null,prevDi:null,ready:false,
  lob:{di:-1,max:4},matching:false,roomsIv:0,roomsTok:0,autoIv:0,pingIv:0,note:''};
(()=>{const d=parseInt(lsGet('ppl-qdi')||'',10),m=parseInt(lsGet('ppl-qmax')||'',10);if(d>=-1&&d<5)DU.lob.di=d;if([4,6,8].includes(m))DU.lob.max=m})();
let mode='normal',D=null,life=100,resumeCD=0,lastRes=null,freezeG=0;
const TUTN=20,TUTD={n:'教學',nb:1,gap:1.25,spd:.9,dmg:0,bm:1.4,hm:1.4,wm:1.3,ob:.5,noSmall:1};
let st='home',si=0,offset=0,nt=0,resolved=0,nb=1,bi=0,tickQ=[],endAt=0,paused=false,exitT=0;
let score=0,combo=0,maxCombo=0,tierCount=[0,0,0,0],time=0,ts=1,gAC=0,gT=0,cp={ti:0,score:0},lastCents=0,lastP=.5,pSrc='none';
let balls=[],bumps=[],items=[],rings=[],floats=[],parts=[],aims=[],missCount=0,runFrom=0;
let shake=0,flash={a:0,hue:0},easeT=0,starT=0,shield=0,rangeT=0,rangeMul=1,edgeGlow=[0,0,0,0],edgeHue=[0,0,0,0],spawnT=4,itemT=8;
const LEADIN=2.6,CPN=25;
// Difficulties. The index is what records, the leaderboard and duels store, so 0-2 keep their old meaning and new ones are added
// at the end; DORD is the order shown to players and LVL the rank of each (0 = easiest) used for star colours.
//   bm: ball size, hm: touch radius, wm: hit window (all × the base), side: a tap anywhere on the ball's half counts,
//   ob: obstacle amount, noSmall: no "smaller touch range" item. Tuned with an analysis of every song on an iPhone in landscape.
//   Keep it on one line: server/scripts/charts.mjs reads it from here.
const DIFFS=[{n:'簡單',nb:1,gap:1.0,spd:1.0,dmg:15,bm:1.4,hm:1.6,wm:1.5,ob:.5,noSmall:1},{n:'普通',nb:2,gap:.6,spd:1.0,dmg:20,bm:1.25,hm:1.25,wm:1.15,ob:1},{n:'困難',nb:2,gap:.45,spd:1.1,dmg:28,bm:1.1,hm:1.1,wm:1.05,ob:1},{n:'入門',nb:1,gap:1.3,spd:.9,dmg:10,bm:1.5,hm:1.3,wm:1.7,side:1,ob:0,noSmall:1},{n:'專家',nb:3,gap:.3,spd:1.25,dmg:34,ob:1}];
const DORD=[3,0,1,2,4],LVL=[1,2,3,0,4],BALLS=['','單球','雙球','三球'];
/* music layers: the accompaniment grows with unbroken good hits; a miss drops one layer */
const ML_STEP=[10,15,25],ML_NAME=['微光','明亮','輝映','星耀'],ML_HUE=[225,185,265,48],ML_TIP=['','和聲與鼓組加入','加入副旋律','主旋律加入高八度鐘聲'];
let mlv=0,mgrow=0,mlBan=null,mlFx=-1;
const mlOn=()=>SET.ml!==false&&mode!=='tut';
const mlFull=()=>!mlOn()||st!=='play';        // layering off (or not playing): the full accompaniment, as before
function mlSet(v,up){
  mlv=v;mgrow=0;
  mlBan={text:'音樂層次 · '+ML_NAME[v],tip:up?ML_TIP[v]:'',hue:ML_HUE[v],up,t:1.5,max:1.5};
  if(up){edgeGlow[1]=edgeGlow[3]=1;edgeHue[1]=edgeHue[3]=ML_HUE[v];flash.a=Math.max(flash.a,.12);flash.hue=ML_HUE[v]}
  hud();
}
function mlTick(){   // backing filter + melody reverb follow the layer (only touched when it changes)
  if(!AC||!bkLP||!melSend)return;
  const full=mlFull(),k=full?1:mlv;
  if(k===mlFx)return;mlFx=k;
  const now=AC.currentTime;
  bkLP.frequency.cancelScheduledValues(now);bkLP.frequency.setTargetAtTime(!full&&mlv<1?1300:AC.sampleRate/2,now,.25);   // at Nyquist the filter is exactly transparent
  melSend.gain.cancelScheduledValues(now);melSend.gain.setTargetAtTime(!full&&mlv>=3?.48:.3,now,.3);
}
let di=(v=>isNaN(v)?1:Math.min(DIFFS.length-1,Math.max(0,v)))(parseInt(lsGet('pmb6-di')||'1',10)),SPD=1;
D=DIFFS[di];
// records are keyed by song id (not level number) so adding songs never shifts them
const KEY_SC=(i,d)=>'ppl-sc-'+SONGS[i].key+'-'+d,KEY_RK=(i,d)=>'ppl-rk-'+SONGS[i].key+'-'+d,KEY_CL=i=>'ppl-cl-'+SONGS[i].key;
(function migrate(){   // one-time copy of the old level-number records (original 21-level order)
  if(lsGet('ppl-mig1'))return;
  const OLD=['green','prelude','twinkle','turkish','nacht','moon','fifth','elise','silent','ode','schubert','traum','minute','gounod','mountain','gymno','entertainer','clair','neon','pixel','velvet'];
  OLD.forEach((k,i)=>{if(!SONGS.some(s=>s.key===k))return;
    if(lsGet('pmb6c-'+i))lsSet('ppl-cl-'+k,'1');
    for(let d=0;d<3;d++){const a=lsGet('pmb6-'+i+'-'+d),r=lsGet('pmb6r-'+i+'-'+d);if(a)lsSet('ppl-sc-'+k+'-'+d,a);if(r)lsSet('ppl-rk-'+k+'-'+d,r)}});
  lsSet('ppl-mig1','1');
})();
const cleared=i=>!!lsGet(KEY_CL(i));
const LOCKS=false;   // testing phase: every level is open
const conCleared=k=>CONS[k].ii.reduce((a,i)=>a+(cleared(i)?1:0),0);
const unlocked=i=>{if(!LOCKS)return true;const c=CON_OF[i];return !c||c[1]<3+conCleared(c[0])};   // first 3 of each constellation are open; each song cleared there opens one more
const TIERS=[
  {n:'完美',hue:48,m:3,ring:3,part:28,shake:5,vol:.4},
  {n:'極佳',hue:185,m:2,ring:2,part:15,shake:3,vol:.37},
  {n:'良好',hue:125,m:1.2,ring:1,part:6,shake:1.5,vol:.34},
  {n:'尚可',hue:225,m:1,ring:1,part:0,shake:0,vol:.3}
];
const tierOf=a=>a<.045?0:a<.09?1:a<.15?2:3;      // |seconds| away from the beat
const G=()=>useAC?AC.currentTime-gAC:gT;
const GB=()=>simG!=null?simG:G();               // physics clock: the current sub-step's time          // game clock (seconds; first beat arrives at LEADIN)
const timeOf=t=>(t-offset)/SPD+LEADIN;                  // song time -> game clock
const tT=i=>timeOf(tg[i].t);
const sideOf=i=>(Math.floor(i/nb)+(i%nb))%2?3:1;  // 1 = right line, 3 = left line (alternate thumbs)
const hueNow=()=>(songHue(si)+(tg.length?resolved/tg.length:0)*140)%360;
const LEAD=v=>Math.max(BR0*5,(v||0)*.13)*(easeT>0?1.6:1)*(D&&D.wm||1),GRACE=v=>Math.max(BR0*5,(v||0)*.11)*(easeT>0?1.6:1)*(D&&D.wm||1);

function safeIns(){const c=getComputedStyle($('#safe'));return{t:parseFloat(c.paddingTop)||0,r:parseFloat(c.paddingRight)||0,b:parseFloat(c.paddingBottom)||0,l:parseFloat(c.paddingLeft)||0}}
let layoutRetry=0;
function viewSize(){   // some browsers briefly report 0 during fullscreen / rotation changes
  const vv=window.visualViewport,c=[[vv&&vv.width,vv&&vv.height],[innerWidth,innerHeight],[DE.clientWidth,DE.clientHeight]];
  for(const[w,h]of c)if(w>=50&&h>=50)return[Math.round(w),Math.round(h)];
  return null;
}
let vpT=-1e9;
function vpCheck(){
  const o=typeof window.orientation==='number'?Math.abs(window.orientation)===90:(screen.orientation&&/landscape/.test(screen.orientation.type||''));
  const vv=window.visualViewport,w=innerWidth,h=innerHeight;
  const off=(o===true&&w<h)||(o===false&&w>h*1.05&&Math.min(screen.width,screen.height)<700)||(vv&&vv.scale&&Math.abs(vv.scale-1)>.01);
  if(!off||performance.now()-vpT<1500)return;
  vpT=performance.now();const m=document.querySelector('meta[name=viewport]');if(!m)return;const c=m.getAttribute('content');
  m.setAttribute('content',c.replace('initial-scale=1','initial-scale=1.01'));
  requestAnimationFrame(()=>{m.setAttribute('content',c);setTimeout(layout,60)});
}
function layout(){
  const sz=viewSize();
  if(!sz){clearTimeout(layoutRetry);layoutRetry=setTimeout(layout,150);return}
  dpr=rscale;
  W=sz[0];H=sz[1];
  cv.width=W*dpr;cv.height=H*dpr;
  portrait=H>W*1.05;
  $('#rot').classList.toggle('hidden',!portrait);
  const sa=safeIns(),hb=$('#hud').getBoundingClientRect().bottom||0,top=Math.max(hb+6,Math.max(60,Math.min(70,H*.15))+sa.t*.5),bot=Math.max(12,H*.04)+sa.b;
  const side=Math.max(24,W*.04)+Math.max(sa.l,sa.r),rp=mode==='duel'?Math.round(Math.min(200,Math.max(150,W*.2))):0;   // room on the right for the standings in a race
  FR.w=Math.min(W-side*2-rp,900);FR.h=Math.min(H-top-bot,FR.w*.5);FR.w=Math.min(FR.w,FR.h*2.4);
  FR.x=Math.round((W-rp-FR.w)/2);FR.y=Math.round(top+(H-top-bot-FR.h)/2);
  BR0=Math.max(8,Math.min(FR.w,FR.h)*.032);V0=FR.w*.55;sizeFor();
  for(const b of balls){b.x=clamp(b.x,FR.x+BR,FR.x+FR.w-BR);b.y=clamp(b.y,FR.y+BR,FR.y+FR.h-BR)}
  if(mode==='duel')mpLadPlace();
}

/* ================= run control ================= */
function hud(){
  $('#score').textContent=score.toLocaleString();
  if(mode==='duel'){const top=Math.max(score,...DU.board.map(b=>b.s)),o=DU.board[0],tot=score+(o?o.s:0);$('#pf').style.width=(top?score/top*100:100)+'%';duelSub()}   // 2 players: tug of war; more: share of the leader's score
  else $('#pf').style.width=(tg.length?resolved/tg.length*100:0)+'%';
  const lf=$('#life');lf.style.width=life+'%';lf.classList.toggle('low',life<35);
  $('#combo').innerHTML=(mlOn()&&st==='play'?'<span class="mlv" style="--c:hsl('+ML_HUE[mlv]+',90%,'+(mlv?68:62)+'%)">'+[0,1,2,3].map(i=>'<i'+(i<=mlv?' class="on"':'')+'></i>').join('')+'</span>'+ML_NAME[mlv]+' · ':'')+(combo>1?'連擊 '+combo+' · ':'')+resolved+' / '+tg.length+(rangeT>0?(rangeMul>1?' · 範圍放大':' · 範圍縮小'):'')+(starT>0?' · 分數×2':'')+(shield?' · 護盾':'');
}
function newBall(ti){
  const s=sideOf(ti),dy=srand(-.35,.35),l=Math.hypot(1,dy);
  return{x:FR.x+FR.w*(s===1?srand(.25,.4):srand(.6,.75)),y:FR.y+FR.h*(nb===3?[.2,.5,.8][ti%3]:nb===2?(ti%2?.7:.3):.5),dx:(s===1?1:-1)/l,dy:dy/l,v:0,pop:0,ti,side:s,win:null,trail:[],sq:0,sqn:0,laps:0,away:false};
}
function startRun(from){
  from=from||0;$('#sky').classList.add('hidden');$('#lbv').classList.add('hidden');
  if(mode==='tut'){D=TUTD;si=SONGS.findIndex(s=>s.key==='twinkle');if(si<0)si=0}
  else D=DIFFS[di];
  RNG=mode==='duel'?mulberry32(DU.seed):Math.random;
  DU.pstreak=0;DU.fogT=0;DU.shrinkT=0;DU.sprint=false;DU.myFin=null;DU.lastS=0;
  sizeFor();song=SONGS[si];LEADTYPE=song.lead||'triangle';SPD=D.spd;nb=D.nb;prepare(song);
  from=Math.min(from,Math.max(0,tg.length-1));
  offset=from>0?tg[from].t-.02:0;
  bi=bkList.findIndex(n=>n[0]/100>=offset);if(bi<0)bi=bkList.length;
  resolved=from;nt=from+nb;score=from?cp.score:0;if(!from)cp={ti:0,score:0};
  combo=0;maxCombo=0;tierCount=[0,0,0,0];shake=0;exitT=0;easeT=0;starT=0;shield=0;rangeT=0;rangeMul=1;paused=false;resumeCD=0;life=100;missCount=0;runFrom=from;flash.a=0;edgeGlow=[0,0,0,0];
  bumps=[];items=[];rings=[];floats=[];parts=[];aims=[];spawnT=5;itemT=9;tickQ=[];cutAll();mlv=0;mgrow=0;mlBan=null;
  balls=[];for(let j=0;j<nb;j++)if(from+j<tg.length)balls.push(newBall(from+j));
  RUN=mode==='normal'&&!from&&ME?{log:new Array(tg.length).fill(null),ok:true,ticket:null,key:song.key,d:di}:null;   // only full solo runs can enter the leaderboard
  endAt=mode==='tut'?timeOf(tg[tg.length-1].t)+2:timeOf(song.dur)+1.2;
  st='ready';hudShow(true);preloadSong(song);
  $('#sub').textContent=(mode==='tut'?'新手教學':'第 '+(si+1)+' 關')+' · 《'+song.name+'》 · '+D.n+' · '+tg.length+' 拍'+(nb>1?' · '+BALLS[nb]:'')+(from?' · 自第 '+(from+1)+' 拍':'');
  hud();
  for(const o of['#home','#menu','#end','#pause','#set','#cal'])$(o).classList.add('hidden');
}
// long gaps (intros, rests): instead of crawling, the ball makes silent extra round trips and still lands on the beat
const lineOf=b=>b.side===1?FR.x+FR.w:FR.x,farOf=b=>b.side===1?FR.x+BR:FR.x+FR.w-BR;
function planLaps(b){
  b.away=false;b.laps=0;if(b.ti<0)return;
  const tau=tT(b.ti)-GB();if(tau<=0)return;
  const dX=(lineOf(b)-b.x)*(b.side===1?1:-1),adx=Math.max(.3,Math.abs(b.dx)),W2=FR.w-2*BR;
  while(b.laps<40&&(dX+2*W2*b.laps)/adx/tau<.35*V0)b.laps++;
}
function ballWant(b){
  const tau=Math.max(.04,tT(b.ti)-GB()),lineX=lineOf(b),fx=farOf(b),W2=FR.w-2*BR;
  const remX=(b.away?Math.abs(b.x-fx)+Math.abs(lineX-fx):(lineX-b.x)*(b.side===1?1:-1))+2*W2*(b.laps||0);
  const raw=remX/Math.max(.3,Math.abs(b.dx))/tau;
  return clamp(raw,.2*V0,8*V0);   // time left until the note / distance left: a longer detour simply means a faster ball
}
async function launch(){
  st='starting';
  initAudio();
  if(AC&&AC.state!=='running'&&AC.resume){try{await Promise.race([AC.resume(),new Promise(r=>setTimeout(r,900))])}catch(e){}}
  useAC=!!(AC&&AC.state==='running');
  if(useAC)gAC=AC.currentTime+.08;else gT=-.08;
  tickQ=[LEADIN-1.5,LEADIN-1,LEADIN-.5];
  for(const b of balls){planLaps(b);b.vr=0;b.v=ballWant(b);b.vr=b.v}
  st='play';audioStatus();setMedia(true);hud();
  if(RUN&&!RUN.ticket)RUN.ticket=api('/lb/start',{song:RUN.key,d:RUN.d}).then(j=>typeof j.run==='string'?j.run:{e:j.error||'net'});   // the server's signed start time
}

/* ================= input ================= */
// pressure: real pressure if the device reports it, else contact size; normalised against what this player produces
const pw=[];
function pressureOf(e){
  let raw=null;
  if(e.pointerType&&e.pointerType!=='mouse'){
    if(e.pressure>0&&e.pressure!==.5&&e.pressure!==1){raw=e.pressure;pSrc='pressure'}
    else if(e.width>1&&e.height>1){raw=Math.max(e.width,e.height);pSrc='contact size'}
  }
  if(raw==null){pSrc='none';return .5}
  pw.push(raw);if(pw.length>40)pw.shift();
  const s=pw.slice().sort((a,b)=>a-b),lo=s[Math.floor(s.length*.1)],hi=s[Math.floor(s.length*.9)];
  if(hi-lo<=1e-6||pw.length<4)return .5;
  return clamp((raw-lo)/(hi-lo),0,1);
}
function tap(x,y,e){
  if(AC)unlockAudio();else initAudio();   // never rebuild audio here: pointerdown is not an audio gesture on iOS
  if(portrait)return;
  if(paused)return;
  if(st==='starting'||st==='ready')return;  // the run starts on "click" (see below)
  if(st!=='play')return;
  let best=null,bd=1e9;
  for(const b of balls){if(!b.win)continue;const d=Math.hypot(b.x-x,b.y-y);if(d<=HRe()&&d<bd){bd=d;best=b}}
  if(!best&&D&&D.side){const half=x>FR.x+FR.w/2?1:3;for(const b of balls){if(!b.win||b.side!==half)continue;const d=Math.abs(b.y-y);if(d<bd){bd=d;best=b}}}   // 入門: anywhere on the ball's half
  rings.push({x,y,r0:6,life:.3,max:.3,hue:best?hueNow():220,w:1.5});     // visual only; a wrong tap makes no sound
  if(!best)return;
  if(RUN&&e&&e.isTrusted===false)RUN.ok=false;   // a tap made by a script, not a finger: this run stays off the leaderboard
  const p=pressureOf(e);lastP=p;
  bounce(best,x,y,p);
}
cv.addEventListener('pointerdown',e=>{e.preventDefault();tap(e.clientX,e.clientY,e)});
cv.addEventListener('click',()=>{if(mode==='duel'){initAudio();return}if(st==='ready'&&!paused&&!portrait&&!instLoad.busy){initAudio();launch()}});   // click = a valid audio gesture on iOS
function setMedia(on){
  try{
    if(!navigator.mediaSession)return;
    if(on&&window.MediaMetadata){navigator.mediaSession.metadata=new MediaMetadata({title:'PingPongLight',artist:'節奏彈球遊戲',artwork:[{src:'icon-512.png',sizes:'512x512',type:'image/png'}]});navigator.mediaSession.playbackState='playing'}
    else{navigator.mediaSession.playbackState='none';navigator.mediaSession.metadata=null}
    navigator.mediaSession.setActionHandler('pause',pauseGame);
    navigator.mediaSession.setActionHandler('play',resumeGame);
  }catch(e){}
}
// pause: silence everything already scheduled and rewind the backing scheduler, so nothing plays out of sync on resume
function holdMusic(){
  cutAll();freezeG=G();
  const t=offset+(freezeG-LEADIN)*SPD;bi=bkList.findIndex(n=>n[0]/100>=t-.01);if(bi<0)bi=bkList.length;
}
function pauseGame(){
  if(mode==='duel')return;
  if(st==='ready'||st==='starting'){if(!paused){paused=true;resumeCD=0;showPauseMenu()}return}
  if(st!=='play'||(paused&&!resumeCD))return;
  holdMusic();paused=true;resumeCD=0;
  if(AC&&AC.state==='running'&&AC.suspend){try{const q=AC.suspend();if(q&&q.catch)q.catch(()=>{})}catch(e){}}
  showPauseMenu();
}
function showPauseMenu(){$('#bSkip').style.display=mode==='tut'?'':'none';$('#pause').classList.remove('hidden')}
function resumeGame(){   // audio resumes inside the tap (iOS needs a gesture); the game clock stays frozen during the count-in
  if(!paused||resumeCD)return;
  if(st!=='play'){paused=false;$('#pause').classList.add('hidden');return}
  $('#pause').classList.add('hidden');resumeCD=1.5;
  unlockAudio();if(AC&&AC.resume){const p=AC.resume();if(p&&p.catch)p.catch(()=>{})}
}
function doResume(){resumeCD=0;paused=false;unlockAudio();if(AC&&AC.resume){const p=AC.resume();if(p&&p.catch)p.catch(()=>{})}}
function hushAll(){
  if(mode==='duel'&&st==='play'){over('離開遊戲');}
  if(st==='play'){if(!paused||resumeCD)holdMusic();paused=true;resumeCD=0;showPauseMenu()}
  cutAll();stopSilent();
  if(AC&&AC.state==='running'&&AC.suspend){try{AC.suspend()}catch(e){}}
  try{if(navigator.mediaSession){navigator.mediaSession.playbackState='none';navigator.mediaSession.metadata=null}}catch(e){}
}
document.addEventListener('visibilitychange',()=>{
  if(document.hidden)hushAll();
  else{try{if(navigator.audioSession)navigator.audioSession.type='playback'}catch(e){}if(isIOS)acStale=true}
});
addEventListener('pagehide',hushAll);

/* ---- fullscreen + no scroll / zoom / long-press ---- */
const DE=document.documentElement;
const inFs=()=>document.fullscreenElement||document.webkitFullscreenElement;
async function goFs(){
  try{if(!inFs()){const r=DE.requestFullscreen||DE.webkitRequestFullscreen;if(r)await r.call(DE,{navigationUI:'hide'})}}catch(e){}
  try{if(screen.orientation&&screen.orientation.lock)await screen.orientation.lock('landscape')}catch(e){}
}
async function toggleFs(){
  if(inFs()){try{(document.exitFullscreen||document.webkitExitFullscreen).call(document)}catch(e){}}
  else await goFs();
}
['gesturestart','gesturechange','gestureend'].forEach(t=>document.addEventListener(t,e=>e.preventDefault()));
function inScroller(el){for(;el&&el!==document.body&&el.nodeType===1;el=el.parentElement){const c=getComputedStyle(el);if(/(auto|scroll)/.test(c.overflowY+c.overflowX)&&(el.scrollHeight>el.clientHeight+1||el.scrollWidth>el.clientWidth+1))return true}return false}
document.addEventListener('touchmove',e=>{if(!(e.target.closest&&e.target.closest('.card,.ddp'))&&!inScroller(e.target))e.preventDefault()},{passive:false});
document.addEventListener('touchstart',e=>{if(e.touches.length>1&&!(e.target.closest&&e.target.closest('.card,.ddp')))e.preventDefault()},{passive:false});
// no dblclick listener: on iOS any dblclick handler makes every tap wait ~350 ms for a possible double tap (zoom is already off via touch-action)
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('selectstart',e=>{if(!(e.target.closest&&e.target.closest('input,select,textarea')))e.preventDefault()});
document.addEventListener('wheel',e=>{if(e.ctrlKey||!(e.target.closest&&e.target.closest('.card,.ddp'))&&!inScroller(e.target))e.preventDefault()},{passive:false});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&['+','-','=','0'].includes(e.key))e.preventDefault();
  else if(e.key==='Escape'||e.key==='p'||e.key==='P'){if(st==='play'){if(paused&&!resumeCD)resumeGame();else pauseGame()}}});
const standalone=APP||!!(navigator.standalone||(window.matchMedia&&matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches));
if(!(DE.requestFullscreen||DE.webkitRequestFullscreen)&&!standalone)$('#fsHint').style.display='block';

/* ================= game logic ================= */
function burst(x,y,hue,n,sp,life){
  if(SET.lowFx)n=Math.round(n*.3);
  for(let i=0;i<n;i++){const a=rand(0,6.283),v=rand(.3,1)*sp;parts.push({x:x,y:y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,life:rand(.4,1)*life,max:life,hue:hue+rand(-18,18),r:rand(1.2,3)})}
}
function nextPitch(){const t=tg[Math.min(tg.length-1,Math.max(0,resolved))];return melList[t.mi][2]}
function keyBell(vol){if(!AC)return;const p=nextPitch()+12;pluck(440*Math.pow(2,(p-69)/12),AC.currentTime,.5,vol*.7,[[1,1],[3,.12]],.5,busFx,0)}   // in-key accent (never a clash)
// an obstacle hit plays the chord the backing is on right now, in the backing instrument: it blends into the accompaniment
function harmNote(vol){
  if(!AC)return;
  const t=(G()-LEADIN)*SPD+offset;let j=Math.min(bi,bkList.length)-1;
  while(j>=0&&(bkList[j][3]!==0||bkList[j][0]/100>t))j--;
  if(j<0){keyBell(vol*.6);return}
  let p=bkList[j][2];for(let k=j-1;k>=0&&bkList[j][0]-bkList[k][0]<=3;k--)if(bkList[k][3]===0)p=Math.max(p,bkList[k][2]);   // top of that chord
  while(p<60)p+=12;while(p>76)p-=12;
  voice(p,0,.45,vol,0,false);
}
function playMel(ti,cents,vol){
  const t=tg[ti],Gn=G(),L=latS();
  for(let i=t.mi;i<t.mend;i++){
    const n=melList[i],w=timeOf(n[0]/100)-Gn;
    if(w<-.05&&i>t.mi)continue;                    // notes already in the past are dropped
    voice(n[2],Math.max(0,w-L),n[1]/100/SPD,vol,cents,true);
    if(AC&&!mlFull()&&mlv>=3){const p=n[2]+12;pluck(440*Math.pow(2,(p-69)/12),AC.currentTime+Math.max(0,w-L),clamp(n[1]/100/SPD,.25,1.2),vol*.28,[[1,1],[3,.12]],.6,busMel,cents)}   // layer 3: octave bell
  }
}
function resolveTarget(b){
  resolved++;
  b.ti=nt<tg.length?nt++:-1;
  if(b.ti>=0)b.side=sideOf(b.ti);
  if(resolved%CPN===0&&resolved<tg.length)cp={ti:resolved,score};
  hud();
}
function bounce(b,tx,ty,p){
  const e=G()-tT(b.ti),ae=Math.abs(e),ti=tierOf(ae),T=TIERS[ti];
  const cents=centsOf(e);lastCents=cents;
  const old=b.side,nx=old===1?-1:1;
  const off=clamp((b.y-ty)/HRe(),-1,1),th=(.45+.75*p)*off;      // touch above the ball -> ball goes down; harder = bigger turn
  b.dx=nx*Math.cos(th);b.dy=Math.sin(th);
  const lineX=old===1?FR.x+FR.w:FR.x;b.x=lineX+nx*BR*.3;
  aims.push({x1:b.x,y1:b.y,x2:tx,y2:ty,life:.4,max:.4,hue:T.hue});
  b.win=null;b.sq=1;b.sqn=old;
  playMel(b.ti,cents,T.vol);                                   // melody is heard ONLY on a correct hit
  tierCount[ti]++;combo=ti<=2?combo+1:0;life=Math.min(100,life+[3,2,1,0][ti]);if(ti===0)vib(12);maxCombo=Math.max(maxCombo,combo);
  if(mlOn()&&ti<=2&&mlv<3&&++mgrow>=ML_STEP[mlv])mlSet(mlv+1,true);   // "尚可" neither counts nor breaks the climb
  const sf=Math.pow(Math.max(.3,b.v/V0),1.1),base=Math.round((100*T.m*sf*(1+.3*p)*(starT>0?2:1))*(mode==='duel'&&DU.sprint?2:1)),pts=base+combo*5;
  if(RUN&&b.ti<RUN.log.length)RUN.log[b.ti]=[Math.max(-400,Math.min(400,Math.trunc(e*1000))),base];   // ms toward zero keeps the same timing tier as here
  score+=pts;
  const hue=T.hue,fx=b.x+nx*40,fy=b.y;
  floats.push({x:fx,y:fy-6,text:T.n,hue,life:.9,max:.9,size:ti===0?1.5:ti===1?1.25:1});
  floats.push({x:fx,y:fy+14,text:'+'+pts+' · '+pitchTxt(cents)+' · 力道 '+Math.round(p*100)+'%',hue,life:.9,max:.9,size:.7});
  for(let i=0;i<T.ring;i++)rings.push({x:b.x,y:b.y,r0:BR*(1+i*.4),life:.5+i*.12,max:.5+i*.12,hue:hue+i*20,w:4-i*.8});
  burst(b.x,b.y,hue,T.part,BR*16,.8);
  shake=Math.max(shake,T.shake);
  const ei=old;edgeGlow[ei]=ti===0?1:ti===1?.75:ti===2?.5:.3;edgeHue[ei]=hue;
  if(ti===0){flash.a=.18;flash.hue=hue}
  resolveTarget(b);
  if(b.ti>=0){planLaps(b);b.vr=0;b.v=ballWant(b);b.vr=b.v}
  if(mode==='duel')duelHit(ti);
}
function miss(b){
  missCount++;combo=0;
  if(mlOn()){if(mlv>0)mlSet(mlv-1,false);else mgrow=0}
  const old=b.side,nx=old===1?-1:1,sh=shield>0;
  if(sh)shield--;else life=Math.max(0,life-(D.dmg||0));   // a plain miss stays silent
  vib(sh?20:[40,30,40]);
  floats.push({x:b.x+nx*40,y:b.y,text:sh?'護盾抵銷':'失誤',hue:sh?190:350,life:1,max:1,size:1.2});
  const hue=sh?190:350;
  rings.push({x:b.x,y:b.y,r0:BR,life:.7,max:.7,hue,w:5});burst(b.x,b.y,hue,24,BR*14,.8);
  if(mode==='duel')duelHit(4);
  if(life<=0){hud();vib(120);over('生命值歸零');return}
  if(!sh){shake=Math.max(shake,6);flash.a=.14;flash.hue=350}
  const lineX=old===1?FR.x+FR.w:FR.x,a=rand(-.5,.5);       // the ball comes back into play
  b.x=lineX+nx*BR*.3;b.dx=nx*Math.cos(a);b.dy=Math.sin(a);b.win=null;
  resolveTarget(b);if(b.ti>=0){planLaps(b);b.vr=0;b.v=ballWant(b);b.vr=b.v}
}
function bumpH(o){
  if(o.age<.35)return 0;                                       // telegraph phase
  const g=Math.min(1,(o.age-.35)/.22),e=1+2.2*Math.pow(g-1,3)+1.2*Math.pow(g-1,2);   // quick pop with overshoot
  const out=o.age>o.life?Math.max(0,1-(o.age-o.life)/.4):1;
  return o.Rm*Math.max(0,e)*out;
}
function spawnBump(){
  for(let tries=0;tries<12;tries++){
    const x=FR.x+FR.w*srand(.2,.8),y=FR.y+FR.h*srand(.14,.86);let ok=true;
    for(const b of balls)if(Math.hypot(b.x-x,b.y-y)<FR.h*.35)ok=false;
    for(const o of bumps)if(Math.hypot(o.x-x,o.y-y)<FR.h*.4)ok=false;
    const Rm=Math.min(FR.w,FR.h)*srand(.07,.12);
    for(const it of items)if(Math.hypot(it.x-x,it.y-y)<itemGap(Rm))ok=false;   // never on top of / hugging an item
    if(ok){bumps.push({x,y,Rm,age:0,life:srand(3.2,5.5)});return}
  }
}
// an item must stay reachable: keep it clear of an obstacle's full (overshooting) radius plus a ball's width and some room
const itemGap=Rm=>Rm*1.3+BR*2+17+30;
function spawnItem(){
  const r=RNG(),type=r<.3?'big':r<.5?(D&&D.noSmall?'big':'small'):r<.78?'star':(shield>=2?'star':'shield');
  for(let tries=0;tries<16;tries++){
    const x=FR.x+FR.w*srand(.25,.75),y=FR.y+FR.h*srand(.2,.8);
    if(bumps.every(o=>Math.hypot(o.x-x,o.y-y)>=itemGap(o.Rm))){items.push({x,y,type,age:0,life:7});return}
  }
}
const ITEM_HUE={big:165,small:340,star:50,shield:190};
const RANKS=['D','C','B','A','S'],RANK_COL={S:'#ffd36b',A:'#7cf0ff',B:'#8fe388',C:'#c9b6ff',D:'#9aa3c7'};
function jingleWin(rank){
  initAudio();cutAll();
  const n={S:7,A:6,B:5,C:4,D:3}[rank],arp=[60,64,67,72,76,79,84].slice(0,n);
  arp.forEach((p,i)=>voice(p,.05+i*.11,1.1,.3,0,true,busFx));
  const t=.05+arp.length*.11;
  [48,60,64,67,72].forEach((p,i)=>voice(p,t,1.8,i?.2:.26,0,i?true:false,busFx));
  if(rank==='S'){voice(91,t+.05,1.2,.12,0,true,busFx);voice(96,t+.18,1.2,.1,0,true,busFx)}
}
function jingleLose(){
  initAudio();cutAll();
  [67,64,60].forEach((p,i)=>voice(p,.05+i*.3,1,.22,0,true,busFx));voice(48,.05,1.8,.18,0,false,busFx);
}
function countUp(el,to){const t0=performance.now();(function f(n){const k=Math.min(1,(n-t0)/900);el.textContent=Math.round(to*k*(2-k)).toLocaleString();if(k<1)requestAnimationFrame(f)})(t0)}
function showResult(ok,msg){
  hud();   // st is no longer 'play': clears the music-layer meter behind the result card
  const N=Math.max(1,tg.length-runFrom),hits=tierCount[0]+tierCount[1]+tierCount[2]+tierCount[3],played=Math.max(1,hits+missCount);
  const w=tierCount[0]+tierCount[1]*.8+tierCount[2]*.5+tierCount[3]*.25,acc=w/(ok?N:played);
  const rank=acc>=.95&&missCount===0?'S':acc>=.85?'A':acc>=.7?'B':acc>=.5?'C':'D';
  const kS=KEY_SC(si,di),kR=KEY_RK(si,di),prev=parseInt(lsGet(kS)||'0',10);
  const newBest=ok&&mode==='normal'&&score>prev;
  const skyB=ok&&mode==='normal'?starOf(si):null,skyC=CON_OF[si]?CONS[CON_OF[si][0]]:null,skyCB=!!skyC&&skyDone(skyC);
  if(mode==='tut'){lsSet('ppl-tut','1')}
  else if(ok&&mode==='normal'){
    lsSet(KEY_CL(si),'1');
    if(newBest)lsSet(kS,String(score));
    const pr=lsGet(kR);if(!pr||RANKS.indexOf(rank)>RANKS.indexOf(pr))lsSet(kR,rank);
    cp={ti:0,score:0};
  }
  $('#rk').textContent=mode==='tut'?'教學完成':(ok?'通關':'失敗');
  $('#rt').textContent=(mode==='tut'?'新手教學':'第 '+(si+1)+' 關')+' · 《'+song.name+'》· '+D.n;
  lastRes={ok,rank,score,acc,maxCombo,name:song.name,label:$('#rt').textContent};
  const rk=$('#rank');rk.textContent=ok?rank:'失敗';rk.style.color=ok?RANK_COL[rank]:'#ff7a93';rk.style.fontSize=ok?'':'clamp(40px,11vh,64px)';
  $('#rnew').innerHTML=newBest?'<span class="badge">新紀錄</span>':(ok?'':'<span class="sub">'+(msg||'')+'</span>');
  const row=(l,v,c)=>'<tr><td style="color:'+(c||'inherit')+'">'+l+'</td><td>'+v+'</td></tr>';
  $('#rtab').innerHTML=row('完美',tierCount[0],'#ffd36b')+row('極佳',tierCount[1],'#7cf0ff')+row('良好',tierCount[2],'#8fe388')+row('尚可',tierCount[3],'#9aa3c7')+row('失誤',missCount,'#ff7a93')
    +row('最高連擊',maxCombo)+row('精準度',Math.round(acc*100)+'%')+row('完成度',Math.min(resolved,tg.length)-runFrom+' / '+N);
  if(ok&&mode==='normal'&&!runFrom){const bp=Math.floor(acc*10000),kA=KEY_AC(si,di);if(bp>(parseInt(lsGet(kA)||'0',10)||0))lsSet(kA,String(bp))}
  const rs=$('#rsky');rs.hidden=true;rs.textContent='';
  if(skyB){const a=starOf(si),full=!!skyC&&!skyCB&&skyDone(skyC);
    rs.textContent=full?'✦ '+skyC.name+'完成':!skyB.lit?'✦ 《'+song.name+'》在星空中亮起了':(a.d>skyB.d||a.r>skyB.r)?'✦ 《'+song.name+'》在星空中更亮了':'';
    rs.hidden=!rs.textContent;
    if(full)setTimeout(()=>{if(AC&&!$('#end').classList.contains('hidden'))[62,66,69,74].forEach((p,k)=>voice(p,k*.06,1.6,.12,0,true,busFx))},1500)}
  countUp($('#rscore'),score);
  const hasNext=mode==='tut'||(mode==='normal'&&ok&&si+1<SONGS.length&&unlocked(si+1));
  $('#bNext').style.display=hasNext?'':'none';$('#bNext').textContent=mode==='tut'?'開始第 1 關':'下一關';
  $('#bShare').style.display=mode==='tut'||!ok||!shareOK()?'none':'';
  const cb=$('#bCont');if(!ok&&cp.ti>0){cb.style.display='';cb.textContent='從第 '+(cp.ti+1)+' 拍繼續'}else cb.style.display='none';
  $('#end').classList.toggle('duel',mode==='duel');
  if(mode==='duel')duelFinish(ok,rank,acc);
  else for(const id of['bRetry','bSel'])$('#'+id).style.display='';
  $('#end').classList.remove('hidden');
  const rl=$('#rlb');rl.hidden=true;
  if(ok&&mode==='normal'&&!runFrom){if(RUN&&RUN.ok)lbSubmit(RUN);else if(!ME){rl.hidden=false;$('#rlbT').textContent='設定暱稱後，通關成績將列入排行榜';const b=$('#rlbB');b.textContent='設定暱稱';b.hidden=false}}
  RUN=null;
  if(ok)jingleWin(rank);else jingleLose();
}
function over(msg){
  $('#pause').classList.add('hidden');setMedia(false);st='over';exitT=1.2;cutAll();
  setTimeout(()=>{if(st==='over')showResult(false,msg)},1000);
}
function win(){
  setMedia(false);st='done';
  setTimeout(()=>{if(st==='done')showResult(true)},500);
}
function hudShow(v){$('#hud').style.visibility=v?'visible':'hidden';$('#bSkipH').style.display=v&&mode==='tut'?'':'none';$('#bPause').style.display=mode==='duel'?'none':'';$('#prog').classList.toggle('duel',v&&mode==='duel')}
function showHome(){if(RSEL&&RSEL.on)mpSelOff();howClose();mode='normal';setMedia(false);hudShow(false);st='home';cutAll();balls=[];tg=[];resolved=0;hud();$('#menu').classList.add('hidden');$('#end').classList.add('hidden');$('#sky').classList.add('hidden');$('#lbv').classList.add('hidden');$('#frv').classList.add('hidden');$('#home').classList.remove('hidden');skyBadge();audioStatus();frBadge();layout()}
function showSelect(){mode='normal';setMedia(false);hudShow(false);st='menu';cutAll();balls=[];buildChips();$('#home').classList.add('hidden');$('#end').classList.add('hidden');$('#lbv').classList.add('hidden');$('#menu').classList.remove('hidden');selScroll()}

/* ================= update ================= */
function wallFx(b,e){rings.push({x:b.x,y:b.y,r0:BR*.5,life:.3,max:.3,hue:hueNow()+80,w:1.5});edgeGlow[e]=Math.max(edgeGlow[e],.18);edgeHue[e]=hueNow()}
function stepFree(b,dt){b.x+=b.dx*b.v*dt;b.y+=b.dy*b.v*dt}
function trailStep(b){const last=b.trail[b.trail.length-1];
  if(!last||Math.hypot(b.x-last.x,b.y-last.y)>BR*.45){b.trail.push({x:b.x,y:b.y});if(b.trail.length>20)b.trail.shift()}
  else if(b.trail.length>4)b.trail.shift()}
function updateBall(b,dt){
  if(b.pop<1)b.pop=Math.min(1,b.pop+dt*3);
  if(b.sq>0)b.sq=Math.max(0,b.sq-dt*6);
  if(b.ti<0){                                     // no more targets: drift and fade
    b.v=Math.max(b.v,V0*.5);stepFree(b,dt);trailStep(b);
    if(b.y<FR.y+BR){b.y=FR.y+BR;b.dy=Math.abs(b.dy)}else if(b.y>FR.y+FR.h-BR){b.y=FR.y+FR.h-BR;b.dy=-Math.abs(b.dy)}
    if(b.x<FR.x+BR){b.x=FR.x+BR;b.dx=Math.abs(b.dx)}else if(b.x>FR.x+FR.w-BR){b.x=FR.x+FR.w-BR;b.dx=-Math.abs(b.dx)}
    return;
  }
  // speed is recomputed every step from the path still to travel and the time left: it lands exactly on the beat
  if(tT(b.ti)-GB()>.05||b.v<1)b.v=ballWant(b);   // in the last 50 ms keep the (already exact) speed instead of creeping toward the line
  b.x+=b.dx*b.v*dt;b.y+=b.dy*b.v*dt;
  trailStep(b);
  // top / bottom walls and the far side line are plain walls (silent)
  if(b.y<FR.y+BR){b.y=FR.y+BR;b.dy=Math.abs(b.dy);wallFx(b,0)}
  else if(b.y>FR.y+FR.h-BR){b.y=FR.y+FR.h-BR;b.dy=-Math.abs(b.dy);wallFx(b,2)}
  if(b.side===1&&b.x<FR.x+BR){b.x=FR.x+BR;b.dx=Math.abs(b.dx);wallFx(b,3);if(b.away)b.away=false;else planLaps(b)}
  else if(b.side===3&&b.x>FR.x+FR.w-BR){b.x=FR.x+FR.w-BR;b.dx=-Math.abs(b.dx);wallFx(b,1);if(b.away)b.away=false;else planLaps(b)}
  if(b.laps>0&&!b.away){   // waiting lap: the target line acts as a silent wall
    if(b.side===1&&b.x>FR.x+FR.w-BR){b.x=FR.x+FR.w-BR;b.dx=-Math.abs(b.dx);b.laps--;b.away=true;wallFx(b,1)}
    else if(b.side===3&&b.x<FR.x+BR){b.x=FR.x+BR;b.dx=Math.abs(b.dx);b.laps--;b.away=true;wallFx(b,3)}
  }
  // obstacles pop up in the field: reflect (never reversing toward the wrong side), no sound
  for(const o of bumps){
    const h=bumpH(o);if(h<4)continue;
    const dx=b.x-o.x,dy=b.y-o.y,d=Math.hypot(dx,dy)||1;
    if(d<h+BR){
      const nx=dx/d,ny=dy/d,dot=b.dx*nx+b.dy*ny;
      if(dot<0){const rx=b.dx-2*dot*nx,ry=b.dy-2*dot*ny;b.dx=.45*b.dx+.55*rx;b.dy=.45*b.dy+.55*ry;const l=Math.hypot(b.dx,b.dy)||1;b.dx/=l;b.dy/=l}   // mild deflection
      b.x=o.x+nx*(h+BR+1);b.y=o.y+ny*(h+BR+1);
      b.win=null;shake=Math.max(shake,5);flash.a=.16;flash.hue=345;harmNote(.1);
      burst(b.x,b.y,345,14,BR*14,.6);
      rings.push({x:b.x,y:b.y,r0:BR,life:.4,max:.4,hue:345,w:3},{x:o.x,y:o.y,r0:h,life:.3,max:.3,hue:350,w:3});
    }
  }
  const want=(b.side===1?1:-1)*(b.away?-1:1);
  if(b.dx*want<.5){b.dx=.5*want;const l=Math.hypot(b.dx,b.dy);b.dx/=l;b.dy/=l}
  // items
  for(let i=items.length-1;i>=0;i--){
    const it=items[i];
    if(Math.hypot(b.x-it.x,b.y-it.y)<BR+17){
      items.splice(i,1);const hue=ITEM_HUE[it.type];let txt;
      if(it.type==='big'){rangeT=9;rangeMul=1.7;txt='點擊範圍放大'}
      else if(it.type==='small'){rangeT=9;rangeMul=.6;txt='點擊範圍縮小'}
      else if(it.type==='star'){starT=8;txt='分數 ×2'}
      else{shield=Math.min(2,shield+1);txt='護盾 +1'}
      hud();burst(it.x,it.y,hue,22,BR*16,.9);flash.a=.2;flash.hue=hue;
      rings.push({x:it.x,y:it.y,r0:8,life:.6,max:.6,hue,w:4},{x:it.x,y:it.y,r0:6,life:.8,max:.8,hue:hue+25,w:3});
      floats.push({x:it.x,y:it.y-18,text:txt,hue,life:1,max:1,size:1.2});
      keyBell(.1);
    }
  }
  // hit window around the target line
  const lineX=b.side===1?FR.x+FR.w:FR.x,depth=b.side===1?b.x-lineX:lineX-b.x;
  if(!b.away&&!b.laps&&depth>-LEAD(b.v)){b.win={edge:b.side,depth};if(depth>GRACE(b.v))miss(b)}else b.win=null;
}
function update(dt){
  time+=dt;
  mlTick();if(mlBan&&!paused&&!portrait&&(mlBan.t-=dt)<=0)mlBan=null;
  shake=Math.max(0,shake-dt*22);flash.a=Math.max(0,flash.a-dt*.6);
  for(let i=0;i<4;i++)edgeGlow[i]=Math.max(0,edgeGlow[i]-dt*2.2);
  for(let i=rings.length-1;i>=0;i--){rings[i].life-=dt;if(rings[i].life<=0)rings.splice(i,1)}
  for(let i=floats.length-1;i>=0;i--){floats[i].life-=dt;if(floats[i].life<=0)floats.splice(i,1)}
  for(let i=aims.length-1;i>=0;i--){aims[i].life-=dt;if(aims[i].life<=0)aims.splice(i,1)}
  for(let i=parts.length-1;i>=0;i--){const p=parts[i];p.life-=dt;if(p.life<=0){parts.splice(i,1);continue}p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=.96;p.vy*=.96}
  if(st==='over'&&exitT>0){exitT-=dt;for(const b of balls)stepFree(b,dt);return}
  if(paused&&resumeCD>0&&st==='play'){
    if(useAC)gAC=AC.currentTime-freezeG;           // keep the game clock still while the audio clock runs
    resumeCD-=dt;if(resumeCD<=0){if(useAC)gAC=AC.currentTime-freezeG;doResume()}return}
  if(st==='ready')for(const b of balls)if(b.pop<1)b.pop=Math.min(1,b.pop+dt*3);   // ball visible while waiting for the first tap
  if(st!=='play'||paused||portrait)return;
  if(!useAC)gT+=dt;
  const Gn=G();
  // count-in ticks and the continuous backing track
  const L=latS();
  while(tickQ.length&&tickQ[0]-L<Gn+.3){const w=tickQ.shift()-Gn-L;tick(Math.max(0,w),.1)}
  while(bi<bkList.length&&timeOf(bkList[bi][0]/100)-L<Gn+1){
    const n=bkList[bi++],t0=timeOf(n[0]/100),w=t0-Gn-L;if(t0>endAt-.8)continue;
    if(w>-.05){const k=n[3],full=mlFull();
      if(k===2){if(full||mlv>=1||n[2]===36)drum(n[2],Math.max(0,w))}                  // layer 0 keeps only the kick
      else if(k===3){if(full||mlv>=2)cvoice(n[2],Math.max(0,w),n[1]/100/SPD,.12)}      // counter-melody from layer 2
      else voice(n[2],Math.max(0,w),n[1]/100/SPD,.16*bkV[bi-1]*(full||mlv>=1||n[2]<52?1:.45),0,false)}}   // layer 0: harmony soft, bass full
  if(rangeT>0){rangeT-=dt;if(rangeT<=0){rangeMul=1;hud()}}
  if(mode==='duel'){if(DU.fogT>0)DU.fogT-=dt;if(DU.shrinkT>0){DU.shrinkT-=dt;if(DU.shrinkT<=0)hud()}
    if(!DU.sprint&&tg.length&&resolved>=tg.length*.8){DU.sprint=true;mpBanner('info','最後衝刺','分數 ×2','#ffd36b',true);flash.a=.25;flash.hue=48;hud()}}
  if(starT>0){starT-=dt;if(starT<=0)hud()}
  const prog=tg.length?resolved/tg.length:0;
  const bm=D&&D.ob!=null?D.ob:1,tut=mode==='tut';
  spawnT-=dt;if(spawnT<=0&&Gn>LEADIN&&bm>0&&(!tut||resolved>=12)){if(bumps.length<(tut?1:(1+Math.floor(prog*3))*bm))spawnBump();spawnT=Math.max(1.8,4.5-prog*2.6)/bm*srand(.8,1.2)}
  itemT-=dt;if(itemT<=0&&Gn>LEADIN&&!tut){if(items.length<1)spawnItem();itemT=srand(8,12)}
  for(let i=bumps.length-1;i>=0;i--){const o=bumps[i];o.age+=dt;if(o.age>o.life+.4)bumps.splice(i,1)}
  for(let i=items.length-1;i>=0;i--){const it=items[i];it.age+=dt;if(it.age>it.life)items.splice(i,1)}
  for(const b of balls){updateBall(b,dt);if(st!=='play')return}
  if(resolved>=tg.length&&Gn>endAt)win();
}

/* ================= draw ================= */
const stars=(()=>{let s=7;const r=()=>{s=(s*16807)%2147483647;return s/2147483647};return Array.from({length:90},()=>({x:r(),y:r(),r:r()*1.4+.3,p:r()*6.28}))})();
let bgC=null,bgKey='';
function paintBG(x,h){
  const g=x.createRadialGradient(W/2,H*.5,0,W/2,H*.5,Math.max(W,H)*.8);g.addColorStop(0,'#10173a');g.addColorStop(1,'#04050d');
  x.fillStyle=g;x.fillRect(0,0,W,H);
  x.save();x.globalCompositeOperation='lighter';
  const b=x.createRadialGradient(W*.15,H*.3,0,W*.15,H*.3,Math.max(W,H)*.5);b.addColorStop(0,`hsla(${h},80%,50%,.10)`);b.addColorStop(1,'transparent');x.fillStyle=b;x.fillRect(0,0,W,H);
  const b2=x.createRadialGradient(W*.88,H*.75,0,W*.88,H*.75,Math.max(W,H)*.5);b2.addColorStop(0,`hsla(${(h+140)%360},80%,50%,.09)`);b2.addColorStop(1,'transparent');x.fillStyle=b2;x.fillRect(0,0,W,H);
  x.restore();
  x.fillStyle='#cfe0ff';for(const s of stars){x.globalAlpha=.3+.3*((s.p*7)%1);x.beginPath();x.arc(s.x*W,s.y*H,s.r,0,6.283);x.fill()}
  x.globalAlpha=1;
}
function drawBG(x){   // rendered once per size/hue step, then blitted
  const h=hueNow(),key=W+'x'+H+'/'+Math.round(h/8);
  if(W<1||H<1)return;
  if(!bgC||key!==bgKey){bgKey=key;bgC=document.createElement('canvas');bgC.width=W;bgC.height=H;paintBG(bgC.getContext('2d'),h)}
  x.drawImage(bgC,0,0);
}
const hsl=(h,a,l)=>`hsla(${h},100%,${l||65}%,${a})`;
function gline(x,a,b,c,d,h,al,w){x.lineWidth=w*2.8;x.strokeStyle=hsl(h,al*.28,62);seg(x,a,b,c,d);x.lineWidth=w;x.strokeStyle=hsl(h,al,70);seg(x,a,b,c,d)}   // cheap glow (no shadowBlur)
const sprites={};
function sprite(h){
  const k=Math.round(h/12)%30;if(sprites[k])return sprites[k];
  const c=document.createElement('canvas');c.width=c.height=128;const x=c.getContext('2d');
  const g=x.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,'rgba(255,255,255,.95)');g.addColorStop(.25,`hsla(${k*12},100%,66%,.7)`);g.addColorStop(1,'transparent');
  x.fillStyle=g;x.fillRect(0,0,128,128);return sprites[k]=c;
}
function edgeLine(e){return e===0?[FR.x,FR.y,FR.x+FR.w,FR.y]:e===1?[FR.x+FR.w,FR.y,FR.x+FR.w,FR.y+FR.h]:e===2?[FR.x,FR.y+FR.h,FR.x+FR.w,FR.y+FR.h]:[FR.x,FR.y,FR.x,FR.y+FR.h]}
function seg(x,a,b,c,d){x.beginPath();x.moveTo(a,b);x.lineTo(c,d);x.stroke()}
function drawField(x){
  const h=hueNow(),R=FR;
  rr(x,R.x,R.y,R.w,R.h,10);x.fillStyle='rgba(10,14,40,.55)';x.fill();
  if(flash.a>0){rr(x,R.x,R.y,R.w,R.h,10);x.fillStyle=`hsla(${flash.hue},100%,60%,${flash.a*(SET.lowFx?.3:1)})`;x.fill()}
  // frame: top/bottom are walls (dim); the two thumb lines are bright
  x.save();x.lineCap='round';
  x.lineWidth=2;x.strokeStyle='rgba(150,170,255,.35)';seg(x,R.x,R.y,R.x+R.w,R.y);seg(x,R.x,R.y+R.h,R.x+R.w,R.y+R.h);
  gline(x,R.x,R.y,R.x,R.y+R.h,h,.9,3);gline(x,R.x+R.w,R.y,R.x+R.w,R.y+R.h,h,.9,3);
  x.restore();
  // the line the next beat will arrive at
  if(st==='play'||st==='ready')for(const b of balls){
    if(b.ti<0)continue;
    const tau=tT(b.ti)-G(),a=st==='ready'?.5:clamp(1.3-tau,0,1)*(.4+.3*Math.sin(time*10)),l=edgeLine(b.side);
    if(a<=0)continue;
    x.save();x.globalCompositeOperation='lighter';x.lineCap='round';gline(x,l[0],l[1],l[2],l[3],190+tau*40,a,7);x.restore();
  }
  x.save();x.globalCompositeOperation='lighter';x.lineCap='round';
  for(let e=0;e<4;e++)if(edgeGlow[e]>0){const l=edgeLine(e);gline(x,l[0],l[1],l[2],l[3],edgeHue[e],edgeGlow[e],6)}
  x.restore();
}
function drawBumps(x){
  x.save();rr(x,FR.x,FR.y,FR.w,FR.h,10);x.clip();
  for(const o of bumps){
    if(o.age<.35){   // telegraph: a shrinking dashed ring just before it pops up
      const k=o.age/.35;x.save();x.strokeStyle=`hsla(340,100%,75%,${.35+.5*k})`;x.lineWidth=2;x.setLineDash([5,5]);
      x.beginPath();x.arc(o.x,o.y,o.Rm*(1.7-.7*k),0,6.283);x.stroke();x.restore();continue;
    }
    const h=bumpH(o);if(h<1)continue;
    const a=o.age>o.life?.6:1;
    const g=x.createRadialGradient(o.x,o.y,h*.2,o.x,o.y,h*1.4);
    g.addColorStop(0,`hsla(340,95%,60%,${.85*a})`);g.addColorStop(.7,`hsla(330,90%,45%,${.55*a})`);g.addColorStop(1,'transparent');
    x.fillStyle=g;x.beginPath();x.arc(o.x,o.y,h*1.4,0,6.283);x.fill();
    x.lineWidth=7;x.strokeStyle=`hsla(340,100%,70%,${.22*a})`;x.beginPath();x.arc(o.x,o.y,h,0,6.283);x.stroke();
    x.lineWidth=2.5;x.strokeStyle=`hsla(340,100%,75%,${a})`;x.beginPath();x.arc(o.x,o.y,h,0,6.283);x.stroke();
  }
  x.restore();
}
function drawItems(x){
  for(const it of items){
    const p=.5+.5*Math.sin(time*5+it.x),a=it.age>it.life-1.5?(.4+.6*Math.abs(Math.sin(time*12))):1,hue=ITEM_HUE[it.type];
    x.save();x.globalAlpha=a;x.translate(it.x,it.y);
    const g=x.createRadialGradient(0,0,0,0,0,26+p*4);g.addColorStop(0,`hsla(${hue},100%,65%,.55)`);g.addColorStop(1,'transparent');
    x.globalCompositeOperation='lighter';x.fillStyle=g;x.beginPath();x.arc(0,0,26+p*4,0,6.283);x.fill();
    x.globalCompositeOperation='source-over';x.lineWidth=2.5;x.strokeStyle=`hsl(${hue},100%,72%)`;x.fillStyle=x.strokeStyle;
    x.beginPath();x.arc(0,0,13,0,6.283);x.stroke();
    if(it.type==='big'){x.beginPath();x.arc(0,0,5,0,6.283);x.stroke();x.beginPath();x.moveTo(-9,0);x.lineTo(-6,0);x.moveTo(9,0);x.lineTo(6,0);x.moveTo(0,-9);x.lineTo(0,-6);x.moveTo(0,9);x.lineTo(0,6);x.stroke()}
    else if(it.type==='small'){x.beginPath();x.moveTo(-6,0);x.lineTo(6,0);x.stroke();x.beginPath();x.moveTo(-9,-4);x.lineTo(-5,0);x.lineTo(-9,4);x.moveTo(9,-4);x.lineTo(5,0);x.lineTo(9,4);x.stroke()}
    else if(it.type==='star'){x.beginPath();for(let i=0;i<10;i++){const r=i%2?3.5:8,an=-Math.PI/2+i*Math.PI/5;x.lineTo(Math.cos(an)*r,Math.sin(an)*r)}x.closePath();x.fill()}
    else{x.beginPath();x.moveTo(0,-7);x.lineTo(6,-3);x.lineTo(5,4);x.lineTo(0,8);x.lineTo(-5,4);x.lineTo(-6,-3);x.closePath();x.stroke()}
    x.restore();
  }
}
/* ---- ball look: colour by combo tier (white, green, blue, purple, orange, red, rainbow), gold while score x2 is active ---- */
const BFX={TIERS:[{c:0,h:210,s:0},{c:10,h:135,s:100},{c:20,h:205,s:100},{c:35,h:272,s:100},{c:50,h:24,s:100},{c:75,h:356,s:100},{c:100,h:-1,s:100}],GH:46,glow:new Map(),star:null};
BFX.tier=c=>{let k=0;for(let i=0;i<BFX.TIERS.length;i++)if(c>=BFX.TIERS[i].c)k=i;return k};
// gold blinks back to the tier colour in its last 1.5 s; the phase uses the remaining time only (about 1.3 Hz speeding up to 3.7 Hz); no blinking with reduced effects
BFX.target=(combo,starT,time,low)=>{const k=BFX.tier(combo),T=BFX.TIERS[k],rb=T.h<0;let g=0,bl=false;
  if(starT>0){if(starT>1.5||low)g=1;else{const u=1.5-starT;g=Math.sin(u*(8+u*5))>0?1:0;bl=true}}
  return{h:rb?(time*90)%360:T.h,k,g,rb,bl,sat:T.s}};
BFX.mix=(a,b,t)=>{let d=((b-a+540)%360)-180;return(a+d*t+360)%360};
BFX.rgb=(h,s,l)=>{h=(h%360+360)%360;s/=100;l/=100;const a=s*Math.min(l,1-l),f=n=>{const k=(n+h/30)%12;return 255*(l-a*Math.max(-1,Math.min(k-3,9-k,1)))};return[f(0),f(8),f(4)]};
// tier colour to gold by way of warm white, so the blend never passes through another tier's hue
BFX.col=(h,sat,lit,g)=>{const c=BFX.rgb(h,sat,lit);if(g<=0)return c;const W=[255,248,236],G=g<.5?W:BFX.rgb(BFX.GH,100,Math.min(90,lit+4)),A=g<.5?c:W,t=g<.5?g*2:g*2-1;return[A[0]+(G[0]-A[0])*t,A[1]+(G[1]-A[1])*t,A[2]+(G[2]-A[2])*t]};
BFX.css=(c,a)=>'rgba('+(c[0]|0)+','+(c[1]|0)+','+(c[2]|0)+','+(a<.001?0:a.toFixed(3))+')';
BFX.state=()=>({h:210,g:0,sp:[],ph:0,sat:0,t:0});
// glow body as a cached sprite per (quantised) colour; the gold glint is one cached sprite rotated
BFX.glowOf=c=>{const q=v=>Math.round(v/24)*24,k=q(c[0])+','+q(c[1])+','+q(c[2]);let e=BFX.glow.get(k);if(e)return e;
  if(BFX.glow.size>240)BFX.glow.clear();e=document.createElement('canvas');e.width=e.height=128;const x=e.getContext('2d'),C=[q(c[0]),q(c[1]),q(c[2])];
  const g=x.createRadialGradient(64,64,0,64,64,64);g.addColorStop(0,'rgba(255,255,255,.95)');g.addColorStop(.22,BFX.css(C,.75));g.addColorStop(.55,BFX.css(C,.18));g.addColorStop(1,'rgba(0,0,0,0)');
  x.fillStyle=g;x.fillRect(0,0,128,128);BFX.glow.set(k,e);return e};
BFX.starOf=()=>{if(BFX.star)return BFX.star;const e=document.createElement('canvas');e.width=e.height=256;const x=e.getContext('2d');x.translate(128,128);
  for(let i=0;i<4;i++){x.rotate(Math.PI/2);const gr=x.createLinearGradient(0,0,128,0);gr.addColorStop(0,'rgba(255,236,170,.6)');gr.addColorStop(1,'rgba(255,236,170,0)');x.fillStyle=gr;x.beginPath();x.moveTo(0,-7);x.lineTo(128,0);x.lineTo(0,7);x.fill()}
  return BFX.star=e};
// one frame for one ball: s = its fx state, b = {x,y,trail}, r = radius, o = {combo,starT}, boost = music layer 3 (brighter, wider trail)
BFX.draw=(x,s,b,r,o,dt,time,low,boost)=>{
  const T=BFX.target(o.combo,o.starT,time,low);s.h=BFX.mix(s.h,T.h,Math.min(1,dt*6));s.sat+=(T.sat-s.sat)*Math.min(1,dt*6);s.g+=(T.g-s.g)*Math.min(1,dt*(T.bl?30:10));
  const g=s.g,lvl=Math.min(6,Math.round(T.k*.67)+(g>.5?1:0)),L=60+18*(1-s.sat/100),span=T.rb?-330*(1-g)-18*g:-18;
  const tr=b.trail,n=tr.length;x.save();x.globalCompositeOperation='lighter';x.lineCap='round';x.lineJoin='round';
  // ribbon trail: tapered passes along a smoothed path (soft halo, colour body, hot core)
  const pass=(wm,al,lit)=>{for(let i=1;i<n;i++){const f=i/n,e=Math.pow(f,1.35);x.strokeStyle=BFX.css(BFX.col(s.h+(1-f)*span,s.sat,lit,g),al*e);x.lineWidth=r*wm*e;
      const p=tr[i-1],q=tr[i],m=tr[i+1]||b;x.beginPath();x.moveTo((p.x+q.x)/2,(p.y+q.y)/2);x.quadraticCurveTo(q.x,q.y,(q.x+m.x)/2,(q.y+m.y)/2);x.stroke()}};
  const bw=boost?1.25:1,ba=boost?1.3:1;
  if(!low)pass((3.2+lvl*.35)*bw,.16*ba,L);pass(1.6*bw,Math.min(1,.55*ba),L+6);pass(.55*bw,.9,90);
  // sparks shed behind the ball: more at higher tiers, glints in gold (none with reduced effects)
  if(!low){s.ph+=[5,8,11,15,20,26,32][lvl]*(1+g*.6)*dt;
    while(s.ph>=1){s.ph--;const a=Math.random()*6.283,v=r*(.6+Math.random()*1.8),rh=T.rb&&Math.random()>g;
      s.sp.push({x:b.x+Math.cos(a)*r*.6,y:b.y+Math.sin(a)*r*.6,vx:Math.cos(a)*v,vy:Math.sin(a)*v-r*.3,l:0,m:.45+Math.random()*.5,c:BFX.col(rh?Math.random()*360:s.h+(Math.random()-.5)*30,rh?100:s.sat,80,rh?0:g),st:g>.5&&Math.random()<.45})}}
  let w=0;for(const p of s.sp){p.l+=dt;if(p.l>=p.m)continue;p.x+=p.vx*dt;p.y+=p.vy*dt;p.vx*=.96;p.vy=p.vy*.96+r*.9*dt;s.sp[w++]=p}
  s.sp.length=Math.min(w,160);
  for(const p of s.sp){const a=1-p.l/p.m,tw=.6+.4*Math.sin(time*30+p.x);x.fillStyle=BFX.css(p.c,a*tw);
    if(p.st){const z=r*.55*a;x.beginPath();x.moveTo(p.x,p.y-z);x.lineTo(p.x+z*.22,p.y-z*.22);x.lineTo(p.x+z,p.y);x.lineTo(p.x+z*.22,p.y+z*.22);x.lineTo(p.x,p.y+z);x.lineTo(p.x-z*.22,p.y+z*.22);x.lineTo(p.x-z,p.y);x.lineTo(p.x-z*.22,p.y-z*.22);x.fill()}
    else{x.beginPath();x.arc(p.x,p.y,r*(.1+.16*a),0,6.283);x.fill()}}
  const c=BFX.col(s.h,s.sat,L+6,g);x.drawImage(BFX.glowOf(c),b.x-r*3.8,b.y-r*3.8,r*7.6,r*7.6);
  // orbiting motes from purple (three from red), a breathing ring from orange
  if(T.k>=3&&!low){const k=T.k>=5?3:2,mc=BFX.css(BFX.col(s.h+40,s.sat,82,g),.9);x.fillStyle=mc;for(let i=0;i<k;i++){const a=time*4.2+i*6.283/k,R=r*(1.75+.15*Math.sin(time*3+i));
      x.beginPath();x.arc(b.x+Math.cos(a)*R,b.y+Math.sin(a)*R*.85,r*.22,0,6.283);x.fill()}}
  if(T.k>=4){x.strokeStyle=BFX.css(BFX.col(s.h,s.sat,78,g),low?.4:.38+.14*Math.sin(time*6));x.lineWidth=1.6;x.beginPath();x.arc(b.x,b.y,r*(low?2.3:2.3+.12*Math.sin(time*5)),0,6.283);x.stroke()}
  // gold: four-ray glint behind the ball (still with reduced effects)
  if(g>.05){x.save();x.globalAlpha=g;x.translate(b.x,b.y);if(!low)x.rotate(time*.8);x.drawImage(BFX.starOf(),-r*4.2,-r*4.2,r*8.4,r*8.4);x.restore()}
  x.restore();
};
function drawBalls(x){
  for(const b of balls){
    const sc=b.pop<1?(1-Math.pow(1-b.pop,3)):1,r=BR*sc;
    if(!b.fx){b.fx=BFX.state();const q=BFX.target(combo,starT,time,SET.lowFx);b.fx.h=q.h;b.fx.sat=q.sat;b.fx.g=q.g;b.fx.t=time}
    const dt=paused?0:clamp(time-b.fx.t,0,.1);b.fx.t=time;
    {const now=performance.now(),mv=b.fx.lx!==b.x||b.fx.ly!==b.y;b.fx.lx=b.x;b.fx.ly=b.y;   // a ball that stopped (song over) lets its trail shrink away instead of freezing into a line
      if(mv||paused)b.fx.st=now;else if(now-b.fx.st>40&&b.trail.length){b.trail.shift();b.fx.st=now}}
    BFX.draw(x,b.fx,b,r,{combo,starT},dt,time,SET.lowFx,!mlFull()&&mlv>=3);
    x.save();x.translate(b.x,b.y);
    if(b.sq>0){const horiz=b.sqn===1||b.sqn===3,s=b.sq*.35;x.scale(horiz?1-s:1+s*.6,horiz?1+s*.6:1-s)}
    x.fillStyle=b.fx.g>.5?'#fff8e0':'#fff';x.beginPath();x.arc(0,0,r*.7,0,6.283);x.fill();x.restore();
    if(shield>0){x.strokeStyle=`hsla(165,100%,70%,${.5+.3*Math.sin(time*8)})`;x.lineWidth=2;x.beginPath();x.arc(b.x,b.y,BR*1.9,0,6.283);x.stroke()}
    if(b.ti>=0&&(st==='play'||st==='ready')){
      const tau=tT(b.ti)-G();
      if(b.win){   // inside the hit window: the beat ring has closed; colour shows how close to the beat
        const u=clamp((b.win.depth+LEAD(b.v))/(LEAD(b.v)+GRACE(b.v)),0,1);
        x.strokeStyle=`hsla(${120*(1-u)},100%,60%,.25)`;x.lineWidth=9;x.beginPath();x.arc(b.x,b.y,BR*2.2,0,6.283);x.stroke();
        x.strokeStyle=`hsl(${120*(1-u)},100%,60%)`;x.lineWidth=3.5;x.beginPath();x.arc(b.x,b.y,BR*2.2,0,6.283);x.stroke();
        x.strokeStyle='rgba(255,255,255,.18)';x.lineWidth=1.5;x.setLineDash([4,5]);x.beginPath();x.arc(b.x,b.y,HRe(),0,6.283);x.stroke();x.setLineDash([]);   // where to touch
      }else if(st==='play'){
        const k=clamp(tau/1.2,0,1);   // approach ring: shrinks onto the ball exactly on the beat
        x.strokeStyle=`hsla(${190+k*60},100%,75%,${.25+.5*(1-k)})`;x.lineWidth=2;
        x.beginPath();x.arc(b.x,b.y,BR*2.2+BR*8*k,0,6.283);x.stroke();
      }
    }
  }
}
function drawFx(x){
  x.save();x.globalCompositeOperation='lighter';
  for(const r of rings){const a=r.life/r.max,rad=r.r0+(1-a)*BR*5;x.strokeStyle=`hsla(${r.hue},100%,70%,${a*.8})`;x.lineWidth=Math.max(.5,r.w*a);x.beginPath();x.arc(r.x,r.y,rad,0,6.283);x.stroke()}
  for(const p of parts){const a=p.life/p.max;x.fillStyle=`hsla(${p.hue},100%,70%,${a})`;x.beginPath();x.arc(p.x,p.y,p.r*(.5+a),0,6.283);x.fill()}
  for(const a of aims){const q=a.life/a.max;x.strokeStyle=`hsla(${a.hue},100%,75%,${q*.7})`;x.lineWidth=2;x.setLineDash([6,6]);x.beginPath();x.moveTo(a.x1,a.y1);x.lineTo(a.x2,a.y2);x.stroke();x.setLineDash([]);x.beginPath();x.arc(a.x2,a.y2,8*(2-q),0,6.283);x.stroke()}
  x.restore();
  x.textAlign='center';x.textBaseline='middle';
  for(const f of floats){
    const a=f.life/f.max;x.globalAlpha=Math.min(1,a*1.6);x.fillStyle=`hsl(${f.hue},100%,75%)`;
    x.font='800 '+Math.round(Math.max(13,BR*1.6)*(f.size||1))+'px "Noto Sans TC",sans-serif';
    x.fillText(f.text,clamp(f.x,FR.x+70,FR.x+FR.w-70),clamp(f.y,FR.y+16,FR.y+FR.h-16)-(1-a)*26);
  }
  x.globalAlpha=1;
}
function attractPos(t){const p=(t*.6)%2,u=p<1?p:2-p,e=u*u*(3-2*u);return[FR.x+BR+e*(FR.w-2*BR),FR.y+FR.h/2+Math.sin(t*2.1)*FR.h*.28]}
function drawAttract(x){
  const h=(200+time*12)%360;
  x.save();x.lineCap='round';
  gline(x,FR.x,FR.y,FR.x,FR.y+FR.h,h,.8,3);gline(x,FR.x+FR.w,FR.y,FR.x+FR.w,FR.y+FR.h,h,.8,3);
  x.globalAlpha=.25;x.strokeStyle='#96aaff';x.lineWidth=2;seg(x,FR.x,FR.y,FR.x+FR.w,FR.y);seg(x,FR.x,FR.y+FR.h,FR.x+FR.w,FR.y+FR.h);x.globalAlpha=1;
  x.globalCompositeOperation='lighter';
  for(let k=10;k>=0;k--){const q=attractPos(time-k*.028),a=k?(1-k/11)*.5:1,r=BR*3.6;x.globalAlpha=a;x.drawImage(sprite(h),q[0]-r,q[1]-r,r*2,r*2)}
  x.restore();x.fillStyle='#fff';const b=attractPos(time);x.beginPath();x.arc(b[0],b[1],BR*.7,0,6.283);x.fill();
}
function drawTut(ctx){
  if(!(mode==='tut'&&(st==='play'||st==='ready')))return;
  ctx.save();ctx.textAlign='center';ctx.textBaseline='alphabetic';
    const r=resolved,msg=r<4?'光球抵達亮起的框線時，觸碰光球。外圈縮到光球上的瞬間就是節拍。':r<8?'觸碰光球上方，球往下彈；觸碰光球下方，球往上彈。':r<12?'按得越用力（或指腹接觸面積越大），轉向越大。':r<16?'場中障礙只改變方向，光球會自動加速，準時抵達框線。':'教學中失誤不扣生命值；正式關卡失誤會扣生命值。';
    ctx.fillStyle='rgba(4,5,13,.45)';
    ctx.font='700 15px "Noto Sans TC",sans-serif';const mw=Math.min(FR.w-16,ctx.measureText(msg).width+28);
    rr(ctx,W/2-mw/2,FR.y+8,mw,30,15);ctx.fill();ctx.fillStyle='#ffd36b';ctx.fillText(msg,W/2,FR.y+28,mw-16);
    ctx.restore();
}
function draw(){
  ctx.setTransform(dpr,0,0,dpr,0,0);
  drawBG(ctx);
  ctx.save();
  if(shake>0&&!SET.lowFx)ctx.translate(rand(-shake,shake)*.5,rand(-shake,shake)*.5);
  if(st==='home')drawAttract(ctx);
  else if(st!=='menu'){drawField(ctx);drawTut(ctx);drawBumps(ctx);drawItems(ctx);drawBalls(ctx);drawFx(ctx)}
  ctx.restore();
  ctx.textAlign='center';ctx.textBaseline='alphabetic';
  if(st==='ready'&&mode==='duel'){const left=Math.max(0,(DU.startAt-duelNow())/1000);ctx.fillStyle='#e8ecff';ctx.font='800 22px "Noto Sans TC",sans-serif';ctx.fillText(DU.n+' 人對戰'+'　即將開始 '+Math.ceil(left),FR.x+FR.w/2,FR.y+FR.h/2+BR*6);
    if(instLoad.busy){ctx.fillStyle='#8a93c0';ctx.font='400 13px "Noto Sans TC",sans-serif';ctx.fillText('載入樂器音色⋯ '+(instLoad.total?Math.round(instLoad.n/instLoad.total*100):0)+'%',W/2,FR.y+FR.h/2+BR*6+24)}}
  else if(st==='ready'&&instLoad.busy){ctx.fillStyle='#e8ecff';ctx.font='700 19px "Noto Sans TC",sans-serif';ctx.fillText('載入樂器音色⋯ '+(instLoad.total?Math.round(instLoad.n/instLoad.total*100):0)+'%',W/2,FR.y+FR.h/2+BR*6)}
  else if(st==='ready'){ctx.fillStyle='#e8ecff';ctx.font='700 19px "Noto Sans TC",sans-serif';ctx.fillText('點擊畫面開始（含 3 拍預備）',W/2,FR.y+FR.h/2+BR*6);ctx.fillStyle='#8a93c0';ctx.font='400 13px "Noto Sans TC",sans-serif';ctx.fillText('光球將於節拍抵達亮起的框線，請於節拍觸碰光球。',W/2,FR.y+FR.h/2+BR*6+24)}
  if(st==='play'&&G()<LEADIN&&!paused){const n=Math.ceil((LEADIN-G())/.5);if(n<=3&&n>=1){ctx.fillStyle='rgba(232,236,255,.55)';ctx.font='800 '+Math.round(Math.min(FR.h*.3,90))+'px "Noto Sans TC",sans-serif';ctx.fillText(String(n),W/2,FR.y+FR.h*.62)}}
  if(st==='play'&&AC&&AC.state!=='running'&&!paused){ctx.fillStyle='#ffb86b';ctx.font='700 15px "Noto Sans TC",sans-serif';ctx.fillText('聲音未啟用：請點擊畫面，並確認裝置未開啟靜音。',W/2,FR.y+FR.h-12)}
  if(mode==='duel'&&(st==='play'||st==='over'||st==='done'))drawDuel(ctx);
  if(mlBan&&st==='play'){const b=mlBan,k=b.t/b.max,fs=Math.round(Math.min(b.up?24:18,FR.h*(b.up?.08:.06))),y=FR.y+FR.h*.44-(1-k)*10;   // music layer change
    ctx.globalAlpha=Math.min(1,k*2.5)*(b.up?1:.7);ctx.font=(b.up?'700 ':'400 ')+fs+'px "Noto Sans TC",sans-serif';
    ctx.fillStyle=b.up?`hsl(${b.hue},100%,80%)`:'#8a93c0';if(b.up&&!SET.lowFx){ctx.shadowColor=`hsl(${b.hue},100%,60%)`;ctx.shadowBlur=14}
    ctx.fillText(b.text,W/2,y);ctx.shadowBlur=0;
    if(b.tip){ctx.fillStyle='#8a93c0';ctx.font='400 '+Math.round(fs*.55)+'px "Noto Sans TC",sans-serif';ctx.fillText(b.tip,W/2,y+fs*.95)}
    ctx.globalAlpha=1}
  if(paused){ctx.fillStyle='rgba(4,5,13,.6)';ctx.fillRect(0,0,W,H);
    if(resumeCD>0){ctx.fillStyle='#e8ecff';ctx.font='800 '+Math.round(Math.min(FR.h*.3,90))+'px "Noto Sans TC",sans-serif';ctx.fillText(String(Math.ceil(resumeCD/.5)),W/2,FR.y+FR.h*.62)}}
}
let last=performance.now(),lastIdle=0,costEMA=0,fc=0,lastGs=0,lastNow=performance.now(),simG=null;
function frame(now){
  if(now-last<15){requestAnimationFrame(frame);return}                 // cap at ~60 fps (halves work on 120 Hz screens)
  const idle=(paused&&!resumeCD)||st==='menu'||st==='done'||(st==='over'&&exitT<=0&&!floats.length&&!rings.length&&!parts.length);
  if(idle&&now-lastIdle<250){requestAnimationFrame(frame);return}        // menus / end cards: redraw rarely
  if(idle)lastIdle=now;
  const t0=performance.now();
  let dt=Math.min(.05,(now-last)/1000)*ts;last=now;
  // while playing, the ball advances by the music clock's real elapsed time, so a stalled frame never leaves it behind the beat
  let g0=null;
  if(st==='play'&&!paused&&useAC){const g=G();g0=lastGs;dt=clamp(g-lastGs,0,.3);lastGs=g0+dt}else if(st==='play'&&!paused)dt=Math.min(.3,(now-lastNow)/1000)*ts;
  if(!(st==='play'&&!paused&&useAC))lastGs=st==='play'?G():0;lastNow=now;
  try{
    if(fc%60===0&&AC&&AC.state==='running'){const w=performance.now();if(acWatch.t===AC.currentTime&&w-acWatch.w>800)acStale=true;if(acWatch.t!==AC.currentTime)acWatch={t:AC.currentTime,w}}
    if(++fc%30===0){const sz=viewSize();if(sz&&(Math.abs(sz[0]-W)>2||Math.abs(sz[1]-H)>2))layout()}   // missed resize events
    const n=Math.max(1,Math.ceil(dt/(1/120))),h=dt/n;      // sub-steps keep the motion smooth and collisions exact
    for(let i=0;i<n;i++){if(g0!=null)simG=g0+h*(i+1);update(h)}   // each sub-step sees its own point in time
    simG=null;
    draw();
  }catch(e){showErr(e)}                                     // one bad frame must never stop the loop
  costEMA=costEMA*.9+(performance.now()-t0)*.1;
  if(fc%90===0&&costEMA>10&&rscale>1){rscale=Math.max(1,rscale-.25);layout()}   // adaptive resolution if drawing is expensive
  requestAnimationFrame(frame);
}

/* ================= online multiplayer (2-8 players) ================= */
// v2 rooms: server/src/arena.js, protocol in docs/multiplayer-protocol.md. Everyone plays the same song with the same seed
// from the same server-timed start; only scores travel, so network delay never touches the feel of a hit.
// The server address is fixed. A ?duel= override is honoured only on a local dev page and only for a local server,
// so a shared link can never point players at someone else's server.
const DUEL_URL=(()=>{if(location.protocol!=='http:'||!/^(localhost|127\.0\.0\.1)$/.test(location.hostname))return 'https://pingponglight-duel.nick760930.workers.dev';
  try{const q=new URLSearchParams(location.search).get('duel');if(q&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(q))return q}catch(e){}
  return 'http://'+location.hostname+':8787'})();
// Everything from the network is untrusted: escape before HTML, clamp numbers, whitelist enums.
const esc=s=>String(s==null?'':s).replace(/[&<>"'`]/g,c=>'&#'+c.charCodeAt(0)+';');
const dInt=(v,lo,hi)=>{v=Math.floor(Number(v));return Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):lo};
const dName=v=>String(v==null?'':v).replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\]/g,'').trim().slice(0,12);
const dKey=v=>typeof v==='string'&&/^[a-z0-9]{2,16}$/.test(v)?v:'';
const dCode=v=>String(v||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
const songIdx=k=>k?SONGS.findIndex(s=>s.key===k):-1;
const DRANKS=['S','A','B','C','D','—'],DATK=['bump','shrink','fog'],MP_MAX=8;
// Inbound budget for the high-rate messages only (scoreboard / attacks): a flooding peer cannot stall the game loop.
// Control messages (room, start, res, left, pong) always pass, so a burst after the page was frozen never loses them.
const DIN={tok:60,t:0};
function dAllow(t){if(t!=='board'&&t!=='atk')return true;const now=performance.now();DIN.tok=Math.min(60,DIN.tok+(now-DIN.t)/1000*30);DIN.t=now;if(DIN.tok>=1){DIN.tok--;return true}return false}
const duelNow=()=>Date.now()+DU.off;
function dsend(o){try{if(DU.ws&&DU.ws.readyState===1)DU.ws.send(JSON.stringify(o))}catch(e){}}
function dmsg(t){$('#dMsg').textContent=t||'';$('#rnote').textContent=t||''}
const mpHost=()=>DU.you===DU.host&&!DU.cfg.qm;
const mpName=i=>{const p=DU.players.find(q=>q.i===i);return p?p.name:(DU.names&&DU.names[i])||'玩家'};
async function mget(path){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),8000);let r;try{r=await fetch(DUEL_URL+path,{signal:c.signal})}finally{clearTimeout(t)}if(r.status===429)throw new Error('slow');if(!r.ok)throw new Error('http');
  const j=await r.json();if(!j||typeof j!=='object')throw new Error('bad');return j;
}
const mpErr=e=>dmsg(e&&e.message==='slow'?'操作太頻繁，請稍等 1 分鐘後再次嘗試。':'無法連線到對戰伺服器，請稍後再試。');

/* ---- lobby: quick match + public rooms ---- */
function duelOpen(){if(!ME){nickOpen('duel');return}initAudio();$('#home').classList.add('hidden');$('#duel').classList.remove('hidden');$('#dName').value=ME.name;duelView()}
function duelView(){
  clearInterval(DU.roomsIv);
  if(DU.ws&&DU.code&&DU.joined){mpSelOpen();return}
  mpLobbyUI();mpRooms();DU.roomsIv=setInterval(()=>{if(!$('#duel').classList.contains('hidden')&&!DU.ws&&!document.hidden)mpRooms()},10000);
}
const Q_MAX=[[4,'最多 4 人'],[6,'最多 6 人'],[8,'最多 8 人']];
function mpLobbyUI(){
  const L=DU.lob;
  $('#qDi').innerHTML=[-1,...DORD].map(d=>'<button class="chip'+(d===L.di?' sel':'')+'" data-d="'+d+'">'+(d<0?'不限':DIFFS[d].n)+'</button>').join('');
  $('#qMax').innerHTML=Q_MAX.map(([m,t])=>'<button class="chip'+(m===L.max?' sel':'')+'" data-m="'+m+'">'+t+'</button>').join('');
  $('#qGo').textContent=DU.matching?'配對中⋯':'開始配對';$('#qGo').disabled=!!DU.matching;
}
async function mpRooms(){
  const box=$('#dRooms'),t=++DU.roomsTok;
  try{
    const j=await mget('/m/rooms?space=1&di='+DU.lob.di);if(t!==DU.roomsTok)return;
    const R=(Array.isArray(j.rooms)?j.rooms:[]).slice(0,30).filter(r=>r&&typeof r==='object').map(r=>({code:dCode(r.code),host:dName(r.host)||'玩家',song:songIdx(dKey(r.song)),
      di:dInt(r.di,0,DIFFS.length-1),n:dInt(r.n,0,MP_MAX),max:dInt(r.max,2,MP_MAX),play:r.phase==='play',qm:r.qm===true})).filter(r=>r.code.length===4);
    box.innerHTML=R.length?R.map(r=>'<button class="rm'+(r.play||r.n>=r.max?' off':'')+'" data-code="'+r.code+'"><span class="nm">'+esc(r.qm?'快速配對房':r.host+' 的房間')+'</span>'
      +'<span class="mt">'+(r.play?'比賽中':r.song>=0?'《'+esc(SONGS[r.song].name)+'》':'選曲中')+'</span><b style="color:'+SKY_C[LVL[r.di]]+'">'+DIFFS[r.di].n+'</b><span class="n">'+r.n+'/'+r.max+'</span></button>').join('')
      :'<div class="lbmsg">目前沒有符合條件的公開房間。可以按「開始配對」，或自己建立房間。</div>';
  }catch(e){if(t===DU.roomsTok&&!(e&&e.message==='slow'&&box.querySelector('.rm')))box.innerHTML='<div class="lbmsg">'+(e&&e.message==='slow'?'查詢太頻繁，稍後會自動更新。':'目前無法連線至對戰伺服器。')+'</div>'}
}
async function mpMatch(){
  initAudio();if(DU.matching)return;DU.matching=true;mpLobbyUI();dmsg('尋找房間中⋯');
  try{const j=await mget('/m/match?di='+DU.lob.di+'&max='+DU.lob.max);const c=dCode(j.code);if(c.length!==4)throw new Error('bad');duelJoin(c)}
  catch(e){mpErr(e)}
  DU.matching=false;mpLobbyUI();
}
async function duelCreate(){
  initAudio();if(DU.creating)return;DU.creating=true;dmsg('建立房間中⋯');   // one request at a time: a double tap would make two rooms
  try{const j=await mget('/m/new?pub=1&max=6&di='+di);const c=dCode(j.code);if(c.length!==4)throw new Error('bad');duelJoin(c)}
  catch(e){mpErr(e)}
  DU.creating=false;
}
function duelJoin(code,onOpen){
  initAudio();code=dCode(code);
  if(code.length!==4){dmsg('請輸入 4 碼房號。');return}
  duelClose(true);dmsg('連線中⋯');
  let ws;try{ws=new WebSocket(DUEL_URL.replace(/^http/,'ws')+'/m/ws/'+code)}catch(e){dmsg('無法連線到對戰伺服器。');return}
  DU.ws=ws;DU.code=code;DU.left=false;DU.pings=[];DU.joined=false;
  ws.onopen=()=>{dmsg('');dsend({t:'hello',name:ME?ME.name:''});for(let k=0;k<6;k++)setTimeout(()=>dsend({t:'ping',c:Date.now()}),k*250);if(onOpen)onOpen()};
  ws.onmessage=e=>{if(DU.ws!==ws||typeof e.data!=='string'||e.data.length>8192)return;
    let d;try{d=JSON.parse(e.data)}catch(_){return}if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.t!=='string'||!dAllow(d.t))return;
    try{duelOn(d)}catch(err){}};
  ws.onclose=ev=>{if(DU.ws!==ws)return;DU.ws=null;ddClose();
    if(mode==='duel'&&st==='play'){DU.left=true;clearInterval(DU.pingIv);clearInterval(DU.autoIv);mpBanner('info','與伺服器的連線中斷','','#ff6f95',true);return}
    const was=DU.joined;DU.code='';DU.players=[];DU.joined=false;clearInterval(DU.pingIv);clearInterval(DU.autoIv);
    const m=!was?'無法加入：房間不存在、已滿、比賽進行中，或操作太頻繁。':'與房間的連線已中斷。';
    if(RSEL.on){mpSelBack(m);return}
    if(!$('#end').classList.contains('hidden')){if(mode==='duel'){duelResult();mpEndNote()}return}
    if(!$('#duel').classList.contains('hidden'))duelView();
    dmsg(m)};
  clearInterval(DU.pingIv);DU.pingIv=setInterval(()=>dsend({t:'ping',c:Date.now()}),5000);
}
function duelClose(silent){ddClose();DU.note='';DU.wantReady=false;clearInterval(DU.autoIv);clearTimeout(DU.cfgT);
  clearInterval(DU.pingIv);const w=DU.ws;DU.ws=null;DU.code='';DU.players=[];DU.phase='lobby';DU.joined=false;
  try{if(w)w.close()}catch(e){}if(!silent)duelView();
}
function duelLeave(){ddClose();mpLadOff();$('#end').classList.remove('duel');if(RSEL.on)mpSelOff();duelClose(true);clearInterval(DU.roomsIv);mpRestore();mode='normal';layout();$('#duel').classList.add('hidden');showHome()}

/* ---- messages ---- */
function duelOn(d){
  if(d.t==='pong'){const now=Date.now(),c=+d.c,sv=+d.s,rtt=now-c;if(!Number.isFinite(c)||!Number.isFinite(sv)||rtt<0||rtt>10000)return;DU.pings.push({rtt,off:sv-(c+rtt/2)});DU.pings.sort((a,b)=>a.rtt-b.rtt);DU.pings=DU.pings.slice(0,8);
    const best=DU.pings.slice(0,3);DU.off=best.reduce((a,p)=>a+p.off,0)/best.length;return}   // clock offset from the fastest round trips
  if(d.t==='room'){if(!Array.isArray(d.players))return;DU.joined=true;
    DU.you=dInt(d.you,0,MP_MAX-1);DU.host=dInt(d.host,0,MP_MAX-1);
    const seen=new Set();DU.players=d.players.slice(0,MP_MAX).filter(p=>p&&typeof p==='object').map(p=>({i:dInt(p.i,0,MP_MAX-1),name:dName(p.name)||'玩家',ready:p.ready===true,back:p.back===true,vote:dKey(p.vote)}))
      .filter(p=>!seen.has(p.i)&&seen.add(p.i)).sort((a,b)=>a.i-b.i);
    const cf=d.cfg&&typeof d.cfg==='object'?d.cfg:{};
    DU.cfg={song:dKey(cf.song),di:dInt(cf.di,0,DIFFS.length-1),pub:cf.pub===true,max:dInt(cf.max,2,MP_MAX),vote:cf.vote===true,qm:cf.qm===true};
    DU.votes={};if(d.votes&&typeof d.votes==='object'&&!Array.isArray(d.votes))for(const k of Object.keys(d.votes).slice(0,60))if(dKey(k)&&songIdx(k)>=0)DU.votes[k]=dInt(d.votes[k],0,MP_MAX);
    const at=d.auto&&typeof d.auto==='object'?+d.auto.at:NaN;DU.auto=Number.isFinite(at)?at:0;
    DU.phase=d.phase==='play'?'play':'lobby';
    const me=DU.players.find(p=>p.i===DU.you);DU.ready=!!(me&&me.ready);
    clearInterval(DU.autoIv);if(DU.auto)DU.autoIv=setInterval(()=>{if(!DU.auto||!DU.ws)clearInterval(DU.autoIv);else{mpRoomMsg();mpEndNote()}},500);
    if(DU.wantReady&&DU.phase==='lobby'){DU.wantReady=false;if(!DU.ready&&!DU.cfg.qm)dsend({t:'ready',v:true})}
    if(RSEL.on)mpRoomUI();else if(!$('#duel').classList.contains('hidden'))duelView();
    mpEndNote();return}
  if(d.t==='start'){if(mode==='duel'&&(st==='play'||st==='ready'))return;
    const at=+d.at,now=duelNow(),k=songIdx(dKey(d.song));
    if(k<0){dsend({t:'fin',s:0,ok:false,acc:0,rank:'—',mc:0});dmsg('房間選的曲目不在您目前的版本中，請更新遊戲後再加入。');return}
    duelStart({at:Number.isFinite(at)&&Math.abs(at-now)<15000?at:now+4500,seed:dInt(d.seed,0,4294967295),song:k,di:dInt(d.di,0,DIFFS.length-1)});return}
  if(d.t==='board'){if(mode!=='duel'||!Array.isArray(d.p))return;
    for(const r of d.p.slice(0,MP_MAX)){if(!Array.isArray(r))continue;const i=dInt(r[0],0,MP_MAX-1);if(i===DU.you)continue;
      let b=DU.board.find(x=>x.i===i);if(!b){b={i,name:mpName(i),s:0,c:0,l:100,j:-1,jt:0,fin:0,gone:false};DU.board.push(b)}
      const s0=b.s;b.s=dInt(r[1],0,1e8);b.c=dInt(r[2],0,1e5);b.l=dInt(r[3],0,100);const j=dInt(r[4],-1,4);if(j>=0&&(j!==b.j||r[1]!==b.ls)){b.j=j;b.jt=performance.now();mpLadHit(i,j,b.s-s0)}b.ls=r[1];b.fin=r[5]?1:0;
      b.out=b.l<=0||(b.fin&&r.length>6&&!r[6])}
    mpRankCheck();hud();if(DU.myFin&&!DU.res)duelResult();return}
  if(d.t==='atk'){const now=performance.now();if(!DATK.includes(d.k)||now-(DU.atkT||0)<1500)return;DU.atkT=now;duelAttacked(d.k,mpName(dInt(d.from,0,MP_MAX-1)));return}
  if(d.t==='res'){if(!Array.isArray(d.r))return;
    const seen=new Set();DU.res=d.r.slice(0,MP_MAX).filter(x=>x&&typeof x==='object').map(x=>({i:dInt(x.i,0,MP_MAX-1),name:dName(x.name)||'玩家',s:dInt(x.s,0,1e8),ok:x.ok===true,
      acc:Math.max(0,Math.min(100,+x.acc||0)),rank:DRANKS.includes(x.rank)?x.rank:'—',mc:dInt(x.mc,0,1e5)})).filter(x=>!seen.has(x.i)&&seen.add(x.i));
    if(DU.myFin){duelResult();mpEndNote()}return}
  if(d.t==='left'){const i=dInt(d.i,0,MP_MAX-1),b=DU.board.find(x=>x.i===i);if(b)b.gone=true;
    if(mode==='duel'&&st==='play'){mpBanner('info',mpName(i)+' 已離線','','#9aa3c7');mpLad()}if(DU.myFin&&!DU.res)duelResult();return}
}

/* ---- room: the single-player song page in "room mode" ---- */
// Same list, details, preview and difficulty buttons as single play. The room code and the host's settings sit on top,
// the seats and the ready button on the right. Tapping a song sets the room's song (host), casts a vote, or just previews.
var RSEL={on:false,song:''};   // var: read by showHome and the song page before this section has run
function mpLeadInfo(){   // the song the room would start with now, and whether that is a tie the server will draw from
  const C=DU.cfg;if(!C.vote)return{k:C.song,n:0,tie:[]};let n=0;
  for(const v of Object.values(DU.votes))n=Math.max(n,v);
  const top=n?Object.keys(DU.votes).filter(k=>DU.votes[k]===n):[];
  return{k:top[0]||C.song,n,tie:top.length>1?top:[]};
}
const mpLead=()=>mpLeadInfo().k;
function mpSelOpen(){
  if(RSEL.on){mpRoomUI();return}
  const C=DU.cfg,mine=(DU.players.find(p=>p.i===DU.you)||{}).vote,k=songIdx(C.vote&&mine?mine:mpLead());
  RSEL.on=true;RSEL.song=C.song;if(DU.prevDi==null){DU.prevDi=di;DU.prevSi=si}di=C.di;if(k>=0)si=k;
  $('#duel').classList.add('hidden');clearInterval(DU.roomsIv);$('#menu').classList.add('room');
  $('#bBack').textContent='‹ 離開房間';showSelect();mpRoomUI();
}
function mpRoomUI(){
  if(!RSEL.on)return;const C=DU.cfg,n=DU.players.length,host=mpHost();
  if(di!==C.di){di=C.di}
  if(!C.vote&&C.song!==RSEL.song){const k=songIdx(C.song);if(k>=0)si=k}   // the host picked a song: everyone's page follows
  RSEL.song=C.song;
  $('#selT').textContent=C.qm?'快速配對':C.vote?'投票選曲':host?'選擇房間曲目':'房間曲目';
  $('#rhd').innerHTML='房號<b>'+esc(DU.code)+'</b>'+(C.qm?'快速配對':C.pub?'公開':'私人')+' · '+n+' / '+C.max+' 人';
  for(const id of['dMax','dPub','dVote'])$('#'+id).hidden=!host;
  if(host){DMAX.set([2,3,4,5,6,7,8].filter(m=>m>=Math.max(2,n)).map(m=>({v:m,text:'上限 '+m+' 人'})),C.max);
    $('#dPub').textContent='公開';$('#dPub').classList.toggle('on',C.pub);$('#dVote').textContent='投票選曲';$('#dVote').classList.toggle('on',C.vote)}
  let h='';for(let k=0;k<C.max;k++){const p=DU.players[k];
    h+=p?'<div class="seat'+(p.i===DU.you?' me':'')+(p.ready&&!C.qm?' ok':'')+'"><span class="nm">'+esc(p.name)+'</span>'+(p.i===DU.host&&!C.qm?'<i>房主</i>':'')+'</div>'
      :'<div class="seat empty">空位</div>'}
  $('#rseats').innerHTML=h;
  const b=$('#bGo');b.hidden=C.qm;b.disabled=false;b.textContent=DU.ready?'取消準備':'準備';b.classList.toggle('pri',!DU.ready);
  buildChips();mpRoomMsg();
  const k=songIdx(C.song);if(k>=0)preloadSong(SONGS[k]);
}
function mpDetail(){   // extra line on the song details: what the room is going to play
  const C=DU.cfg,L=mpLeadInfo(),k=songIdx(L.k),nm=k>=0?'《'+esc(SONGS[k].name)+'》':'尚未選曲',me=(DU.players.find(p=>p.i===DU.you)||{}).vote;
  let t;
  if(C.vote)t=L.tie.length?'目前同票：'+L.tie.map(x=>esc(SONGS[songIdx(x)].name)).join('、')+'（開始時抽選）':L.n?'目前領先：'+nm+'（'+L.n+' 票）':'尚無人投票，未投票時以房主的曲目開始：'+nm;
  else t=SONGS[si]&&SONGS[si].key===C.song?'這是房間曲目':'房間曲目：'+nm;
  $('#sK').textContent+=C.vote&&SONGS[si]&&SONGS[si].key===me?' · 您投的曲目':'';
  $('#sM').insertAdjacentHTML('beforeend','<br><span style="color:#ffd36b">'+t+'</span>');
}
function mpTag(k){const v=DU.votes[k]||0,L=mpLeadInfo();
  return(k===DU.cfg.song&&!DU.cfg.vote?'<em class="rt">房間曲目</em>':'')+(DU.cfg.vote&&v?'<em class="rt">'+v+' 票'+(k===L.k&&!L.tie.length?' · 領先':L.tie.includes(k)?' · 同票':'')+'</em>':'')}
function mpVoters(k){if(!DU.cfg.vote)return'';const v=DU.players.filter(p=>p.vote===k).map(p=>esc(p.name));return v.length?'<span class="vt">'+v.join('、')+'</span>':''}
function mpPick(i){   // a tap on a song row in a room
  const C=DU.cfg,key=SONGS[i].key;
  if(C.qm)return;
  if(C.vote)dsend({t:'vote',song:key});else if(mpHost()&&key!==C.song)mpCfg({song:key});
}
function mpRoomMsg(){
  if(!RSEL.on)return;const C=DU.cfg,n=DU.players.length;
  if(DU.phase==='play'){dmsg('比賽進行中，等其他玩家完成後一起開始下一局。');return}
  if(C.qm){const s=DU.auto?Math.max(0,Math.ceil((DU.auto-duelNow())/1000)):0,nb=DU.players.filter(p=>p.back).length;dmsg(DU.auto?(nb>=C.max?'人數到齊，':'已有 '+nb+' 人，')+s+' 秒後開始':n>nb?'等待其他玩家回到房間（'+nb+' / '+n+'）⋯':'快速配對中，等待其他玩家加入⋯');return}
  const notReady=DU.players.filter(p=>!p.ready).length;
  dmsg(n<2?(DU.note||'等待其他玩家加入⋯ 可以按「邀請朋友」，或讓別人從公開房間加入。')
    :notReady?'還有 '+notReady+' 人未準備 · '+(C.vote?'全員準備後以最高票曲目開始':mpHost()?'點左側曲目即可更換':'房主選曲中')
    :'全員準備，即將開始⋯');
}
function mpCfg(o,again){const C=DU.cfg,m={t:'cfg',song:C.song,di:C.di,pub:C.pub,max:C.max,vote:C.vote,...o};dsend(m);
  // the server drops settings sent too fast; if the room has not changed a moment later, send once more
  clearTimeout(DU.cfgT);if(!again)DU.cfgT=setTimeout(()=>{if(DU.ws&&Object.keys(o).some(k=>DU.cfg[k]!==o[k]))mpCfg(o,true)},1500)}
$('#dPub').onclick=()=>mpCfg({pub:!DU.cfg.pub});
$('#dVote').onclick=()=>mpCfg({vote:!DU.cfg.vote});
function mpSelOff(){RSEL.on=false;$('#menu').classList.remove('room');$('#bGo').hidden=false;$('#bGo').classList.add('pri');$('#bGo').textContent='開始';$('#selT').textContent='選擇曲目';$('#bBack').textContent='‹ 返回';$('#rnote').textContent='';pvEnd()}
function mpRestore(){if(DU.prevDi!=null){di=DU.prevDi;DU.prevDi=null}if(DU.prevSi!=null){si=DU.prevSi;DU.prevSi=null}}
function mpSelBack(msg){   // room closed under us: back to the lobby
  mpSelOff();$('#menu').classList.add('hidden');mpRestore();
  $('#duel').classList.remove('hidden');duelView();if(msg)dmsg(msg)}
function mpSelGo(){initAudio();if(!DU.cfg.qm)dsend({t:'ready',v:!DU.ready})}

/* ---- the race ---- */
function duelStart(d){
  ddClose();DU.seed=d.seed>>>0||1;DU.startAt=d.at;if(DU.prevDi==null){DU.prevDi=di;DU.prevSi=si}
  if(RSEL.on)mpSelOff();
  DU.names={};for(const p of DU.players)DU.names[p.i]=p.name;
  DU.board=DU.players.filter(p=>p.i!==DU.you).map(p=>({i:p.i,name:p.name,s:0,c:0,l:100,j:-1,jt:0,fin:0,gone:false,out:false}));
  DU.n=DU.board.length+1;DU.res=null;DU.rank=0;DU.rankT=0;
  si=Math.max(0,Math.min(SONGS.length-1,d.song|0));di=d.di|0;mode='duel';
  for(const o of['#duel','#end','#menu'])$(o).classList.add('hidden');clearInterval(DU.roomsIv);
  layout();startRun(0);mpLadInit();
  const wait=()=>{if(mode!=='duel'||st!=='ready')return;const left=DU.startAt-duelNow();if(left<=12){launch();return}setTimeout(wait,Math.min(250,Math.max(1,left-10)))};
  wait();
}
// standings: everyone sorted by score, me included; players who are out drop to the bottom
function mpStand(){const me={i:DU.you,name:mpName(DU.you),s:score,c:combo,l:life,fin:DU.myFin?1:0,me:true,out:st==='over'||!!(DU.myFin&&!DU.myFin.ok)};
  return[me,...DU.board].sort((a,b)=>((a.out||a.gone)?1:0)-((b.out||b.gone)?1:0)||b.s-a.s||(a.me?-1:b.me?1:0))}
function mpRankCheck(){
  if(mode!=='duel')return;const S=mpStand(),r=S.findIndex(x=>x.me)+1;
  if(DU.rank&&r!==DU.rank&&st==='play'&&G()>LEADIN+2&&performance.now()-DU.rankT>1200){DU.rankT=performance.now();
    if(r<DU.rank){mpBanner('up','第 '+r+' 名','','#ffd36b');mpBurst();vib(15)}else mpBanner('down','第 '+r+' 名','','#8fb2ff')}
  DU.rank=r;mpLad();
}
const ATKN={bump:'障礙',shrink:'觸碰範圍縮小',fog:'迷霧'},ATKS={bump:' · 4 秒',shrink:' · 5 秒',fog:' · 3 秒'};
function duelHit(j){   // j: 0-3 tier, 4 miss
  const d=score-(DU.lastS||0);DU.lastS=score;
  dsend({t:'st',s:score,c:combo,l:life,r:resolved,j});
  mpLadHit(DU.you,j,d);
  if(j===0){if(++DU.pstreak>=10){DU.pstreak=0;const k=['bump','shrink','fog'][Math.floor(Math.random()*3)];dsend({t:'atk',k});
    const S=mpStand().filter(x=>x.me||!x.fin&&!x.gone),r=S.findIndex(x=>x.me),tg2=r>0?S[r-1]:S[1];   // the server sends it to the player just ahead (or 2nd when leading)
    mpBanner('atk',tg2?'牽制 '+(tg2.name||'玩家'):'牽制',ATKN[k],'#7cf0ff')}}
  else DU.pstreak=0;
  mpRankCheck();hud();
}
function duelAttacked(k,from){
  if(mode!=='duel'||st!=='play')return;
  if(shield>0){shield--;hud();mpBanner('info','護盾擋下牽制',from?'來自 '+from:'','#7cf0ff');return}
  vib([30,40,30]);flash.a=.2;flash.hue=320;
  if(k==='bump'){for(let t=0;t<12;t++){const x=FR.x+FR.w*rand(.3,.7),y=FR.y+FR.h*rand(.2,.8);if(balls.every(b=>Math.hypot(b.x-x,b.y-y)>FR.h*.3)){bumps.push({x,y,Rm:Math.min(FR.w,FR.h)*.11,age:0,life:4});break}}}
  else if(k==='shrink')DU.shrinkT=5;else DU.fogT=3.5;
  mpBanner('atk',from?'來自 '+from+' 的牽制':'受到牽制',ATKN[k]+ATKS[k],'#ff5fa2');
  const f=$('#mpFr');if(f.animate)f.animate([{opacity:1},{opacity:0}],{duration:600,easing:'ease-out'});hud();
}
function duelSub(){
  const S=mpStand(),r=S.findIndex(x=>x.me),me=S[r];let t;
  t='第 '+(r+1)+' 名 / '+S.length+(r>0?'　前一名差 '+(S[r-1].s-me.s).toLocaleString():S[1]?'　領先 '+(me.s-S[1].s).toLocaleString():'');
  $('#sub').textContent=t+(DU.shrinkT>0?'　［範圍縮小］':'');
}
/* ---- live standings (DOM, right of the field): energy bars with a sparkler tip, rank swaps, neighbour gaps ---- */
const MPC=['#ff9ad1','#8fb2ff','#7cffaa','#c58bff','#ffa86b','#7cf0ff','#ff6f95','#e6ecff'],RMO=matchMedia('(prefers-reduced-motion: reduce)');
const LAD={rows:{},on:false,geo:null,pool:[],pk:0,fz:0};
function mpLadInit(){
  const L=$('#mpLad');for(const k of Object.keys(LAD.rows))LAD.rows[k].el.remove();LAD.rows={};
  for(const e of L.querySelectorAll('.mpk,.mpsp'))e.remove();LAD.pool=[];
  LAD.on=true;L.hidden=!LAD.on;$('#mpBn').innerHTML='';
  if(!LAD.on){clearInterval(LAD.fz);mpLadPlace();return}
  LAD.link=document.createElement('div');LAD.link.className='mpk';L.append(LAD.link);
  for(let k=0;k<64;k++){const s=document.createElement('i');s.className='mpsp';L.appendChild(s);LAD.pool.push(s)}
  for(const p of[{i:DU.you,me:true},...DU.board])mpRow(p.i,!!p.me);
  mpLadPlace();mpLad();clearInterval(LAD.fz);if(!RMO.matches)LAD.fz=setInterval(mpFizz,80);
}
function mpRow(i,me){
  const r=document.createElement('div'),c=me?'#ffd36b':MPC[i%MPC.length];r.className='lrw'+(me?' me':'');r.style.setProperty('--c',c);r.style.setProperty('--pc',c);
  r.innerHTML='<span class="flash"></span><span class="rk"></span><span class="nm"></span><span class="ss">0</span><span class="jd"></span><span class="cb"></span>'+(me?'<span class="gp"></span>':'')+'<span class="bar"><i></i></span><span class="tip"></span>';
  r.querySelector('.nm').textContent=mpName(i);$('#mpLad').appendChild(r);
  return LAD.rows[i]={el:r,ss:r.querySelector('.ss'),c,prev:-1,pct:0,v:0,s:0,cb:-1,y:0};
}
function mpLadOff(){LAD.on=false;clearInterval(LAD.fz);$('#mpLad').hidden=true;$('#mpBn').innerHTML=''}
function mpLadPlace(){   // follows the field: called from layout()
  const sa=safeIns(),bn=$('#mpBn'),fr=$('#mpFr');
  Object.assign(bn.style,{left:FR.x+'px',width:FR.w+'px',top:(FR.y+8)+'px',height:'60px'});
  Object.assign(fr.style,{left:FR.x+'px',width:FR.w+'px',top:FR.y+'px',height:FR.h+'px'});
  if(!LAD.on)return;
  const x0=FR.x+FR.w+12,w=Math.min(170,W-x0-Math.max(8,sa.r+4)),hb=$('#hud').getBoundingClientRect().bottom||0,top=Math.max(sa.t+4,FR.y-18,hb+2),avail=H-top-Math.max(8,sa.b+4)-18,n=Object.keys(LAD.rows).length||1;
  const RH=Math.max(30,Math.min(50,Math.floor(avail/n))),rh=RH-6;
  LAD.geo={RH,rh,w,BW:w-38};
  const L=$('#mpLad');Object.assign(L.style,{left:x0+'px',top:top+'px',width:w+'px',height:(H-top)+'px'});L.classList.toggle('cmp',rh<40);
  for(const o of Object.values(LAD.rows)){o.el.style.width=w+'px';o.el.style.height=rh+'px'}
  mpLad();
}
function mpLad(){
  if(!LAD.on||!LAD.geo)return;const {RH,rh,BW}=LAD.geo,Y0=18,S=mpStand();
  const live=S.filter(e=>!e.out&&!e.gone),top=live.length?Math.max(...live.map(e=>e.s)):0,lo=live.length?Math.min(...live.map(e=>e.s))*.8:0;
  const mi=S.findIndex(e=>e.me);
  S.forEach((e,k)=>{const o=LAD.rows[e.i]||mpRow(e.i,!!e.me),r=o.el,out=!!(e.out||e.gone);
    o.y=Y0+k*RH;r.style.top=o.y+'px';r.querySelector('.rk').textContent=k+1;o.s=e.s;
    o.pct=out?0:top>lo?Math.max(4,(e.s-lo)/(top-lo)*100):4;
    r.querySelector('.bar i').style.width=o.pct+'%';r.querySelector('.tip').style.left=(30+BW*o.pct/100)+'px';
    r.classList.toggle('out',out);r.classList.toggle('fire',e.c>=20&&!out);
    const cb=e.c>=10&&!out?e.c:0;if(cb!==o.cb){o.cb=cb;r.querySelector('.cb').textContent=cb?'連擊 '+cb:''}
    if(out)r.querySelector('.ss').textContent=e.gone?'離線':'出局';
    if(o.prev>=0&&k!==o.prev&&r.animate&&!RMO.matches){const up=k<o.prev;
      r.animate([{boxShadow:up?'inset 0 0 0 2px #fff,0 0 22px 4px #ffcc4d':'inset 0 0 0 2px #ff4d7a,0 0 18px 3px #ff4d7a'},{boxShadow:'none'}],{duration:800,easing:'ease-out'});
      if(up)mpSparks(o,10)}
    o.prev=k});
  const me=S[mi],a=S[mi-1],b=S[mi+1]&&!S[mi+1].out&&!S[mi+1].gone?S[mi+1]:null,near=!!b&&!me.out&&me.s-b.s<800;
  const gp=LAD.rows[DU.you]&&LAD.rows[DU.you].el.querySelector('.gp');
  if(gp)gp.innerHTML=me.out?'':(a?'<span class="cool">差 '+(a.s-me.s).toLocaleString()+'</span>':'')+(b?'<span class="'+(near?'hot':'cool')+'">'+(near?'逼近 ':'後 ')+(me.s-b.s).toLocaleString()+'</span>':'');
  LAD.link.classList.toggle('on',near);if(near){LAD.link.style.top=(Y0+mi*RH+rh/2)+'px';LAD.link.style.height=RH+'px'}
  $('#mpHot').textContent=near?'· 纏鬥中':'';
}
function mpLadFrame(){   // rolling numbers, every frame while racing
  if(!LAD.on)return;
  for(const o of Object.values(LAD.rows)){if(o.el.classList.contains('out')||o.v===o.s)continue;
    o.v+=(o.s-o.v)*.25;if(Math.abs(o.s-o.v)<1)o.v=o.s;o.ss.textContent=Math.round(o.v).toLocaleString()}
}
const JN=['完美','極佳','良好','尚可','失誤'],JC=['#ffd36b','#7cf0ff','#7cffaa','#9aa3c7','#ff6f95'];
function mpLadHit(i,j,d){
  const o=LAD.rows[i];if(!LAD.on||!o||j<0||j>4||!o.el.animate)return;
  const jd=o.el.querySelector('.jd');jd.textContent=j<4&&d>0?'+'+d.toLocaleString()+' '+JN[j]:JN[j];jd.style.color=JC[j];
  jd.animate([{opacity:1,transform:'translateY(4px)'},{opacity:0,transform:'translateY(-6px)'}],{duration:600,easing:'ease-out'});
  const f=o.el.querySelector('.flash');f.style.background=JC[j];f.animate([{opacity:.2},{opacity:0}],{duration:350,easing:'ease-out'});
}
function mpSpark(x,y,dx,dy,c,ms,big){
  const s=LAD.pool[LAD.pk++%LAD.pool.length];if(!s||!s.animate)return;s.className='mpsp'+(big?' big':'');s.style.setProperty('--pc',c);s.style.left=x+'px';s.style.top=y+'px';
  s.animate([{opacity:1,transform:'translate(0,0)'},{opacity:0,transform:'translate('+dx+'px,'+dy+'px)'}],{duration:ms,easing:'ease-out'});
}
function mpFizz(){   // the sparkler: a few tiny sparks keep flying off every bar's tip
  if(!LAD.on||document.hidden||!LAD.geo||st!=='play')return;const {rh,BW}=LAD.geo;
  for(const o of Object.values(LAD.rows)){if(o.el.classList.contains('out'))continue;const x=30+BW*o.pct/100,y=o.y+rh-7;
    const a=-Math.PI*(.15+Math.random()*.7),d=6+Math.random()*14;mpSpark(x,y,Math.cos(a)*d-Math.random()*6,Math.sin(a)*d,o.c,250+Math.random()*300)}
}
function mpSparks(o,n){if(!LAD.geo)return;for(let k=0;k<n;k++){const a=Math.random()*6.28;mpSpark(20+Math.random()*(LAD.geo.w-40),o.y+LAD.geo.rh/2,Math.cos(a)*40,Math.sin(a)*26,o.c,600,true)}}
function mpBurst(){const o=LAD.rows[DU.you];if(!LAD.on||!o||!o.el.animate||RMO.matches)return;
  const b=document.createElement('i');b.className='mpsp big';b.style.cssText='left:16px;top:'+(o.y+LAD.geo.rh/2)+'px;width:10px;height:10px;margin:-5px 0 0 -5px;background:none;border:2px solid #ffd36b;box-shadow:none';
  $('#mpLad').appendChild(b);b.animate([{opacity:1,transform:'scale(1)'},{opacity:0,transform:'scale(14)'}],{duration:600,easing:'ease-out'}).onfinish=()=>b.remove()}
// neon banner on the field's top edge: rank up (gold, rises), rank down (blue, sinks), being slowed down / slowing someone
function mpBanner(kind,t,sub,c,long){
  const w=$('#mpBn');w.classList.toggle('long',!!long);
  w.innerHTML='<div class="'+kind+'" style="--c:'+c+'"><span class="line"></span><span class="t">'+esc(t)+'</span>'+(sub?'<span class="s">'+esc(sub)+'</span>':'')+'</div>';
  clearTimeout(DU.bnT);DU.bnT=setTimeout(()=>{w.innerHTML=''},long?2300:1500);
  if(w.animate&&!RMO.matches)w.animate([{transform:'translate(-3px,1px)'},{transform:'translate(3px,-1px)'},{transform:'translate(-1px,1px)'},{transform:'none'}],{duration:300});
}
function drawDuel(x){
  if(DU.fogT>0){   // fog covers the middle of the field; both lines stay visible
    const a=Math.min(1,DU.fogT/.5)*.82,g=x.createLinearGradient(FR.x,0,FR.x+FR.w,0);
    g.addColorStop(0,'rgba(40,30,70,0)');g.addColorStop(.18,`rgba(40,30,70,${a})`);g.addColorStop(.82,`rgba(40,30,70,${a})`);g.addColorStop(1,'rgba(40,30,70,0)');
    x.fillStyle=g;x.fillRect(FR.x,FR.y,FR.w,FR.h);
  }
  if(DU.sprint&&st==='play'){x.save();x.strokeStyle=`hsla(48,100%,60%,${.35+.25*Math.sin(time*8)})`;x.lineWidth=3;rr(x,FR.x-4,FR.y-4,FR.w+8,FR.h+8,12);x.stroke();x.restore()}
  mpLadFrame();
}

/* ---- results: one screen. Left: my place, score, podium. Right: everyone, my judgments, buttons ---- */
function duelFinish(ok,rank,acc){
  DU.myFin={s:score,ok,acc,rank:ok?rank:'—',mc:maxCombo};dsend({t:'fin',...DU.myFin});
  mpLadOff();
  $('#deK').textContent=DU.n+' 人對戰';$('#deS').textContent='《'+song.name+'》· '+D.n;
  $('#deMe').innerHTML='本局成績　完美<b>'+tierCount[0]+'</b>　極佳<b>'+tierCount[1]+'</b>　良好<b>'+tierCount[2]+'</b>　尚可<b>'+tierCount[3]+'</b>　失誤<b>'+missCount+'</b>　最高連擊<b>'+maxCombo+'</b>';
  duelResult();
}
const mpNm=x=>esc(x.name);
function mpEndBtns(on){$('#bAgain').disabled=!on;$('#bRoom').disabled=!on}
function duelResult(){
  const me=DU.myFin;if(!me)return;const R=DU.res,res=$('#deR'),sc=$('#deSc');
  const tr=(k,x,cls,c4,c5,c6)=>'<div class="dtr'+cls+'"><b>'+k+'</b><span>'+mpNm(x)+'</span><span class="r">'+x.s.toLocaleString()+'</span><span class="c">'+c4+'</span><span class="r">'+c5+'</span><span class="x">'+c6+'</span></div>';
  const hd='<div class="dtr hd"><span></span><span>玩家</span><span class="r">分數</span><span class="c">評級</span><span class="r">最高連擊</span><span class="x">差距</span></div>';
  if(!R){
    const lost=DU.left||!DU.ws,done=1+DU.board.filter(b=>b.fin||b.gone).length;
    res.className='dres sm';res.style.setProperty('--c',lost?'#ff6f95':'#7cf0ff');res.textContent=lost?'連線中斷':'等待其他玩家';
    sc.innerHTML='<b>'+me.s.toLocaleString()+'</b>'+(me.ok?'評級 '+esc(me.rank):'出局');$('#dePod').innerHTML='';
    const S=mpStand();
    $('#deT').innerHTML=hd+S.map((x,k)=>tr(k+1,x,(x.me?' me':'')+(x.gone||x.out?' out':''),x.me?(me.ok?esc(me.rank):'出局'):x.gone?'離線':x.fin?(x.out?'出局':'完成'):'比賽中',x.me?me.mc:x.fin?'':'—','')).join('');
    $('#deN').textContent=lost?'與伺服器的連線中斷，無法取得最終名次。':'其他玩家完成後顯示最終名次（'+done+' / '+DU.n+'）';
    mpEndBtns(false);
    // if the results never arrive, allow going back to the room after a while (the server accepts it after 20 s)
    clearTimeout(DU.waitT);if(!lost)DU.waitT=setTimeout(()=>{if(DU.myFin===me&&!DU.res&&DU.ws)mpEndBtns(true)},22000);return}
  const pos=R.findIndex(x=>x.i===DU.you)+1,m=R.find(x=>x.i===DU.you)||{s:me.s,ok:me.ok,acc:me.acc,rank:me.rank};
  let t;
  t=pos===1?'冠軍！':pos>0?'第 '+pos+' 名':'—';
  const col=t.startsWith('勝')||t==='冠軍！'?'#ffd36b':t==='平手'?'#7cf0ff':pos===2||pos===3?'#cfe6ff':'#8fb2ff';
  res.className='dres';res.style.setProperty('--c',col);res.textContent=t;
  sc.innerHTML='<b>'+m.s.toLocaleString()+'</b>'+(m.ok?'評級 '+esc(m.rank)+' · 精準 '+pct(Math.round(m.acc*10000)):'出局');
  const top=[R[1],R[0],R[2]];
  $('#dePod').innerHTML=top.map((x,k)=>x?'<div class="pc p'+[2,1,3][k]+'">'+mpNm(x)+'<div class="bk">'+[2,1,3][k]+'</div></div>':'<div class="pc"></div>').join('');
  const gone=new Set(DU.board.filter(b=>b.gone&&!b.fin).map(b=>b.i));
  $('#deT').innerHTML=hd+R.map((x,k)=>{const off=gone.has(x.i)&&!x.ok;return tr(k+1,x,(x.i===DU.you?' me':'')+(x.ok?'':' out'),off?'離線':x.ok?esc(x.rank):'出局',x.mc,x.i===DU.you?(x.ok?pct(Math.round(x.acc*10000)):''):x.ok?(x.s-m.s>0?'+':'')+(x.s-m.s).toLocaleString():'')}).join('');
  $('#deN').textContent='';mpEndNote();
  mpEndBtns(!!DU.ws);
  if(pos===1)vib([20,40,20,40,60]);
}
function mpEndNote(){   // on the result screen: who already went back for another round (quick match counts down once 2 are back)
  if($('#end').classList.contains('hidden')||mode!=='duel'||!DU.res)return;
  const C=DU.cfg,back=C.qm?DU.players.filter(p=>p.back&&p.i!==DU.you):[];   // only quick match tracks who is back
  if(!DU.ws){$('#deN').textContent='連線已中斷。';return}
  const s=DU.auto?Math.max(0,Math.ceil((DU.auto-duelNow())/1000)):0;
  $('#deN').textContent=back.length?back.map(p=>p.name).slice(0,3).join('、')+(back.length>3?' 等 '+back.length+' 人':'')+' 想再來一局'+(C.qm&&DU.auto?' · '+s+' 秒後開始':''):'';
}
function duelAgain(ready){
  $('#end').classList.add('hidden');$('#end').classList.remove('duel');hudShow(false);st='menu';balls=[];mode='normal';layout();mpLadOff();
  DU.wantReady=!!ready&&!DU.cfg.qm;dsend({t:'again'});
  if(DU.ws&&DU.code)mpSelOpen();else{mpRestore();$('#duel').classList.remove('hidden');duelView()}
}
$('#bDuel').onclick=()=>duelOpen();
navTap('#dNew',duelCreate);
navTap('#dGo',()=>duelJoin($('#dCode').value));
$('#dCode').addEventListener('keydown',e=>{if(e.key==='Enter')duelJoin($('#dCode').value)});
navTap('#qGo',mpMatch);
$('#qDi').onclick=e=>{const b=e.target.closest('button[data-d]');if(!b)return;DU.lob.di=+b.dataset.d;lsSet('ppl-qdi',String(DU.lob.di));mpLobbyUI();mpRooms()};
$('#qMax').onclick=e=>{const b=e.target.closest('button[data-m]');if(!b)return;DU.lob.max=+b.dataset.m;lsSet('ppl-qmax',String(DU.lob.max));mpLobbyUI()};
navTap('#rRef',()=>mpRooms());
$('#dRooms').onclick=e=>{const b=e.target.closest('button.rm');if(!b||b.classList.contains('off'))return;duelJoin(b.dataset.code)};
/* ---- game-styled dropdown: pill button + dark option panel (replaces the OS-drawn <select> list) ---- */
let DDopen=null;
function makeDD(host,label){
  const btn=document.createElement('button'),txt=document.createElement('span'),ar=document.createElement('i');
  btn.type='button';btn.className='ddb';btn.setAttribute('aria-haspopup','listbox');btn.setAttribute('aria-expanded','false');
  ar.textContent='▼';ar.setAttribute('aria-hidden','true');btn.append(txt,ar);host.appendChild(btn);
  const D={value:0,items:[],disabled:false,onchange:null,label,btn,
    set(items,v){D.items=items;D.value=v;const it=items.find(o=>o.v===v);txt.textContent=it?it.text:'';btn.setAttribute('aria-label',label+'，'+(it?it.text:''));
      if(DDopen&&DDopen.D===D)ddPlace()},   // the card layout may have moved (e.g. the opponent joined)
    setDisabled(x){D.disabled=!!x;btn.disabled=!!x;if(x&&DDopen&&DDopen.D===D)ddClose()}};
  btn.onclick=()=>{if(DDopen&&DDopen.D===D)ddClose();else ddOpen(D)};
  btn.addEventListener('keydown',e=>{if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();ddOpen(D)}});
  return D;
}
function ddOpen(D){
  ddClose();if(D.disabled||!D.items.length)return;
  const p=document.createElement('div');p.className='ddp';p.setAttribute('role','listbox');p.setAttribute('aria-label',D.label);
  for(const o of D.items){const b=document.createElement('div'),t=document.createElement('span');
    b.className='ddo'+(o.v===D.value?' on':'');b.setAttribute('role','option');b.setAttribute('aria-selected',String(o.v===D.value));b.tabIndex=-1;b.dataset.v=o.v;
    t.textContent=o.text;b.appendChild(t);if(o.note){const s=document.createElement('small');s.textContent=o.note;s.setAttribute('aria-label','最佳評級 '+o.note);b.appendChild(s)}
    b.onclick=()=>ddPick(o.v);p.appendChild(b)}
  p.addEventListener('keydown',ddKey);document.body.appendChild(p);
  D.btn.classList.add('open');D.btn.setAttribute('aria-expanded','true');DDopen={D,p};ddPlace();
  const cur=p.querySelector('.on')||p.firstChild;cur.focus({preventScroll:true});p.scrollTop=cur.offsetTop-(p.clientHeight-cur.offsetHeight)/2;
}
function ddPlace(){   // below the button, or above it when there is more room there; always inside the screen
  const {D,p}=DDopen,r=D.btn.getBoundingClientRect(),vh=innerHeight,vw=innerWidth,m=8,below=vh-r.bottom-m-6,above=r.top-m-6,up=below<160&&above>below;
  p.style.maxHeight=Math.max(60,Math.min(260,up?above:below))+'px';
  const w=Math.min(Math.max(r.width,220),vw-2*m);p.style.width=w+'px';p.style.left=Math.max(m,Math.min(vw-m-w,r.left+r.width/2-w/2))+'px';
  if(up){p.style.top='auto';p.style.bottom=(vh-r.top+6)+'px'}else{p.style.bottom='auto';p.style.top=(r.bottom+6)+'px'}
}
function ddPick(v){const D=DDopen.D;ddClose();D.btn.focus({preventScroll:true});if(v!==D.value){D.set(D.items,v);if(D.onchange)D.onchange(v)}}
function ddClose(){if(!DDopen)return;const {D,p}=DDopen;DDopen=null;p.remove();D.btn.classList.remove('open');D.btn.setAttribute('aria-expanded','false')}
function ddKey(e){
  const o=[...DDopen.p.children],i=o.indexOf(document.activeElement);
  if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();o[Math.max(0,Math.min(o.length-1,(i<0?0:i)+(e.key==='ArrowDown'?1:-1)))].focus()}
  else if(e.key==='Home'||e.key==='End'){e.preventDefault();o[e.key==='Home'?0:o.length-1].focus()}
  else if(e.key==='Enter'||e.key===' '){e.preventDefault();if(i>=0)ddPick(+o[i].dataset.v)}
  else if(e.key==='Escape'){e.preventDefault();e.stopPropagation();const b=DDopen.D.btn;ddClose();b.focus()}
  else if(e.key==='Tab'){DDopen.D.btn.focus({preventScroll:true});ddClose()}   // default Tab then moves on from the button
}
document.addEventListener('pointerdown',e=>{if(DDopen&&!DDopen.p.contains(e.target)&&!DDopen.D.btn.contains(e.target))ddClose()},true);
addEventListener('resize',ddClose);
document.addEventListener('scroll',e=>{if(DDopen&&!DDopen.p.contains(e.target))ddClose()},true);   // the card scrolled: the panel would drift off its button
const DMAX=makeDD($('#dMax'),'人數上限');   // in the song page's top bar while in a room
DMAX.onchange=v=>mpCfg({max:v});
navTap('#dShare',()=>{const u=(APP?SITE:location.origin+location.pathname)+'?room='+DU.code;shareText('邀請您在 PingPongLight 線上對戰，房號 '+DU.code,u,dmsg)});
navTap('#bAgain',()=>duelAgain(true));navTap('#bRoom',()=>duelAgain(false));navTap('#bLeave',duelLeave);
(function(){try{const r=new URLSearchParams(location.search).get('room');if(r){lsSet('ppl-tut','1');DU.pend=r.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);setTimeout(()=>{duelOpen();if(ME){$('#dCode').value=DU.pend;DU.pend=''}},50)}}catch(e){}})();

/* ================= menu ================= */
const mmss=t=>{t=Math.round(t);return Math.floor(t/60)+':'+String(t%60).padStart(2,'0')};
/* ================= online: nickname, leaderboard, friends ================= */
// No account: one random key per install identifies the player; the server keeps only its hash.
// Everything that comes back from the server is treated like duel messages: clamped, whitelisted, escaped.
const NET=DUEL_URL,PF=APP?((window.Capacitor&&Capacitor.getPlatform&&Capacitor.getPlatform())==='android'?'android':'ios'):'web';
function pkey(){let k=lsGet('ppl-pk');if(!/^[0-9a-f]{32}$/.test(k||'')){const a=new Uint8Array(16);crypto.getRandomValues(a);k=Array.from(a,b=>b.toString(16).padStart(2,'0')).join('');lsSet('ppl-pk',k)}return k}
let ME=(()=>{try{const m=JSON.parse(lsGet('ppl-me')||'null');return m&&Number.isInteger(m.id)&&typeof m.name==='string'&&m.name?{id:m.id,name:dName(m.name)}:null}catch(e){return null}})();
function setMe(m){ME=m;if(m)lsSet('ppl-me',JSON.stringify(m));else{try{localStorage.removeItem('ppl-me');localStorage.removeItem('ppl-fc')}catch(e){}}}
let RUN=null;   // this run's beat log: [timing error ms, base points] per beat, null = missed
async function api(path,body,ms){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),ms||8000);
  try{const r=await fetch(NET+path,{method:'POST',body:JSON.stringify(body),signal:c.signal});   // text body: no CORS preflight
    let j=null;try{j=await r.json()}catch(e){}
    return j&&typeof j==='object'&&!Array.isArray(j)?Object.assign(j,{_s:r.status}):{_s:r.status,error:'net'}}
  catch(e){return{_s:0,error:'net'}}finally{clearTimeout(t)}
}
const pct=bp=>(dInt(bp,0,10000)/100).toFixed(2)+'%';
const KEY_AC=(i,d)=>'ppl-ac-'+SONGS[i].key+'-'+d;
const HIDE=new Set((()=>{try{const a=JSON.parse(lsGet('ppl-hide')||'[]');return Array.isArray(a)?a.filter(Number.isInteger).slice(0,500):[]}catch(e){return[]}})());
const saveHide=()=>lsSet('ppl-hide',JSON.stringify([...HIDE]));
function capCall(pl,m,o){return window.Capacitor&&Capacitor.nativePromise?Capacitor.nativePromise(pl,m,o):Promise.reject(new Error('no bridge'))}
async function shareText(text,url,say){
  if(APP){capCall('Share','share',{title:'PingPongLight',text,url}).catch(()=>{});return}   // a cancelled share sheet is not an error worth showing
  try{if(navigator.share){await navigator.share({title:'PingPongLight',text,url});return}}catch(e){if(e&&e.name==='AbortError')return}
  try{await navigator.clipboard.writeText(text+' '+url);if(say)say('已複製，可貼上分享。')}catch(e){if(say)say(text+' '+url)}
}

/* ---- nickname: required before anything online; unique and filtered by the server ---- */
let nickMode='';
function nickOpen(m){
  nickMode=m||'first';$('#nkIn').value=ME?ME.name:(lsGet('ppl-name')||'');$('#nkMsg').textContent='';
  $('#nkK').textContent=nickMode==='first'?'歡迎來到 PingPongLight':'暱稱';
  $('#nkT').textContent=nickMode==='rename'?'變更暱稱':'請設定暱稱';
  const sk=$('#nkSkip');sk.hidden=false;sk.textContent=nickMode==='first'?'暫不設定，離線遊玩':'取消';
  $('#nick').classList.remove('hidden');setTimeout(()=>{try{$('#nkIn').focus({preventScroll:true})}catch(e){}},60);
}
async function nickGo(){
  const v=dName($('#nkIn').value).replace(/\s+/g,' '),msg=$('#nkMsg');
  if(!v){msg.textContent='請輸入暱稱。';return}
  const b=$('#nkGo');b.disabled=true;msg.textContent='確認中⋯';
  const j=await api('/lb/name',{pk:pkey(),name:v});b.disabled=false;
  if(j.ok){setMe({id:dInt(j.id,1,1e12),name:dName(j.name)||v});msg.textContent='';nickClose(true);return}
  if(j.error==='name')msg.textContent=j.why==='taken'?'此暱稱已有人使用，請更換。'+(IOS&&!standalone?'若這是您在主畫面遊戲使用的暱稱，請改從主畫面開啟遊戲。':''):j.why==='empty'?'暱稱須包含至少一個文字或數字。':'暱稱含有不當字詞，請更換。';
  else if(j.error==='slow')msg.textContent='操作太頻繁，請稍等 1 分鐘後再次嘗試。';
  else{msg.textContent=nickMode==='first'?'目前無法連線至伺服器。您可以先離線遊玩單人模式，下次開啟時再設定暱稱。':'目前無法連線至伺服器，請稍後再試。';$('#nkSkip').hidden=false}
}
function nickClose(done){
  $('#nick').classList.add('hidden');const m=nickMode;nickMode='';syncSet();
  if(!done)return;
  LBC.clear();frConnect();
  if(m==='duel'){duelOpen();if(DU.pend){$('#dCode').value=DU.pend;DU.pend=''}}
  else if(m==='friends')frOpen();
  else if(m==='result')$('#rlb').hidden=true;
}
$('#nkGo').onclick=nickGo;
$('#nkIn').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();nickGo()}});
$('#nkSkip').onclick=()=>nickClose(false);
async function netBoot(){
  if(FD.pend&&!ME){if(IOS&&!standalone){$('#fcC').textContent=fcode(FD.pend);$('#fcM').textContent='';$('#fcv').classList.remove('hidden')}else nickOpen('friends');return}
  if(!ME){nickOpen('first');return}
  const j=await api('/lb/me',{pk:pkey()});
  if(j.me===null){setMe(null);nickOpen('first');return}   // the server no longer knows this key (records deleted)
  if(j.me&&typeof j.me==='object'&&typeof j.me.name==='string')setMe({id:dInt(j.me.id,1,1e12),name:dName(j.me.name)||ME.name});
  frConnect();frBadge(true);
  if(FD.pend)frOpen();
}

/* ---- leaderboard ---- */
const LBC=new Map();   // board -> {t, v}; kept 30 s so browsing songs does not hit the server on every tap
function lbClean(j){
  const row=r=>({r:dInt(r.r,0,1e9),id:dInt(r.id,0,1e12),name:dName(r.name)||'玩家',acc:dInt(r.acc,0,10000),err:dInt(r.err,0,999),combo:dInt(r.combo,0,1e5),score:dInt(r.score,0,1e9),hidden:r.hidden===true});
  return{top:Array.isArray(j.top)?j.top.slice(0,100).filter(r=>r&&typeof r==='object').map(row):[],total:dInt(j.total,0,1e9),me:j.me&&typeof j.me==='object'?row(j.me):null};
}
async function lbGet(key,d,fresh){
  const k=key+'-'+d,c=LBC.get(k);if(!fresh&&c&&performance.now()-c.t<30000)return c.v;
  const j=await api('/lb/board',ME?{song:key,d,pk:pkey()}:{song:key,d});if(j.error)return null;
  const v=lbClean(j);LBC.set(k,{t:performance.now(),v});return v;
}
async function lbSubmit(R){
  const t=$('#rlbT'),b=$('#rlbB'),tok=lastRes;$('#rlb').hidden=false;b.hidden=true;t.textContent='成績上傳中⋯';
  const run=R.ticket?await R.ticket:{e:'net'};
  const j=typeof run==='string'?await api('/lb/submit',{run,pk:pkey(),log:R.log,pf:PF}):{error:run.e};
  if(lastRes!==tok)return;
  if(j.ok&&j.me&&typeof j.me==='object'&&!j.me.hidden){
    const k='ppl-lr-'+R.key+'-'+R.d,prev=dInt(lsGet(k),0,1e9),r=dInt(j.me.r,1,1e9);lsSet(k,String(r));LBC.delete(R.key+'-'+R.d);
    t.innerHTML='排行榜 <b>第 '+r+' 名</b>／共 '+dInt(j.total,1,1e9)+' 人'+(prev&&r<prev?'<em>↑ 上升 '+(prev-r)+' 名</em>':'')+(j.improved===false?' <span class="dim">（未超越您的最佳紀錄）</span>':'');
    b.textContent='查看排行榜';b.hidden=false;
  }else if(j.ok)t.textContent='您的暱稱遭多人檢舉，暫時不會顯示於排行榜';
  else{if(j.error==='noname')setMe(null);
    t.textContent=j.error==='noname'?'找不到您的暱稱，請至「設定」重新設定暱稱':j.error==='slow'?'操作太頻繁，本次成績未上傳':j.error==='net'||j._s===0||j._s>=500?'目前無法連線至伺服器，本次成績未列入排行榜':'本次成績無法驗證，未列入排行榜'}
}
$('#rlbB').onclick=()=>{if(!ME)nickOpen('result');else lbOpen(si,di)};
const LBV={i:0,d:0,open:-1,v:null};let lbTok=0;
function lbOpen(i,d){LBV.i=i;LBV.d=d;LBV.open=-1;$('#lbT').textContent='《'+SONGS[i].name+'》';lbSeg();$('#lbv').classList.remove('hidden');lbLoad()}
function lbSeg(){$('#lbD').innerHTML=DORD.map(k=>'<button data-d="'+k+'" class="'+(k===LBV.d?'on':'')+'">'+DIFFS[k].n+'</button>').join('')}
async function lbLoad(){
  const t=++lbTok,L=$('#lbL');L.innerHTML='<div class="lbmsg">載入中⋯</div>';$('#lbMe').hidden=true;
  const v=await lbGet(SONGS[LBV.i].key,LBV.d);if(t!==lbTok)return;
  if(!v){L.innerHTML='<div class="lbmsg">目前無法連線至伺服器，請稍後再試。</div>';return}
  LBV.v=v;lbRender();
}
const lbCells=(r,mine)=>'<span class="'+(r.r<=3?'m'+r.r:'')+'"><b>'+r.r+'</b></span><span class="nmc">'+esc(mine?'您（'+r.name+'）':r.name)+'</span><span><b>'+pct(r.acc)+'</b></span><span>'+r.score.toLocaleString()+'</span><span>'+r.combo+'</span>';
function lbRender(){
  const v=LBV.v,L=$('#lbL'),rows=v.top.filter(r=>!HIDE.has(r.id)||(ME&&r.id===ME.id));
  L.innerHTML=rows.length?rows.map(r=>{const mine=ME&&r.id===ME.id;
    return '<div class="lbrow">'+lbCells(r,mine)+(mine?'<span></span>':'<button class="more" data-id="'+r.id+'" aria-label="檢舉或隱藏 '+esc(r.name)+'">⋯</button>')+'</div>'
      +(LBV.open===r.id?'<div class="opt"><button data-rep="'+r.id+'">檢舉不雅暱稱</button><button data-hide="'+r.id+'">隱藏這位玩家</button><button data-x="1">取消</button></div>':'')}).join('')
    :'<div class="lbmsg">目前尚無紀錄。</div>';
  const M=$('#lbMe'),note=t=>'<span></span><span class="nmc" style="font-weight:400;color:#8a93c0">'+t+'</span><span></span><span></span><span></span><span></span>';
  M.hidden=false;
  M.innerHTML=!ME?note('設定暱稱後，通關成績將列入排行榜'):!v.me?note('通關此難度後，即會列入排行榜'):v.me.hidden?note('您的暱稱遭多人檢舉，暫時不會顯示'):lbCells(v.me,true)+'<span style="font-size:11px;color:#8a93c0">/'+v.total+'</span>';
}
$('#lbD').onclick=e=>{const b=e.target.closest('button[data-d]');if(!b)return;LBV.d=+b.dataset.d;LBV.open=-1;lbSeg();lbLoad()};
$('#lbL').onclick=async e=>{
  const b=e.target.closest('button');if(!b)return;const D=b.dataset;
  if(D.id){const id=+D.id;LBV.open=LBV.open===id?-1:id;lbRender();return}
  if(D.x){LBV.open=-1;lbRender();return}
  if(D.hide){HIDE.add(+D.hide);saveHide();LBV.open=-1;lbRender();return}
  if(D.rep){const id=+D.rep;if(!ME){b.textContent='設定暱稱後才能檢舉';return}b.disabled=true;b.textContent='送出中⋯';const j=await api('/lb/report',{id,pk:pkey()});b.textContent=j.ok?'已送出檢舉，感謝回報':'送出失敗';
    setTimeout(()=>{if(LBV.open===id){LBV.open=-1;lbRender()}},1300)}
};
function lbClose(){$('#lbv').classList.add('hidden');if(!$('#menu').classList.contains('hidden'))selDetail()}
$('#lbX').onclick=lbClose;
$('#lbv').addEventListener('click',e=>{if(e.target.id==='lbv')lbClose()});

/* ---- song select ---- */
let selF=0,selTok=0,selTm=0;
const rkOf=(i,d)=>{const r=lsGet(KEY_RK(i,d));return RANKS.includes(r)?r:''};
const durTxt=s=>{const t=Math.round(s.dur||0);return Math.floor(t/60)+' 分 '+String(t%60).padStart(2,'0')+' 秒'};
function buildChips(){
  const done=SONGS.map((_,i)=>!!rkOf(i,di)),n2=done.filter(Boolean).length,cnt=[SONGS.length,SONGS.length-n2,n2];
  document.querySelectorAll('#sTabs button').forEach((b,k)=>{b.classList.toggle('on',k===selF);b.setAttribute('aria-selected',String(k===selF));b.querySelector('b').textContent=cnt[k]});
  let h='';
  for(const C of CONS){
    const ii=C.ii.filter(i=>!selF||(RSEL&&RSEL.on)||(selF===2)===done[i]);if(!ii.length)continue;
    h+='<div class="era">'+esc(C.name)+'<small>'+C.ii.filter(i=>done[i]).length+' / '+C.ii.length+'</small><span class="eh"><span class="ehd">難度</span>評級</span></div>';
    for(const i of ii){const s=SONGS[i];
    const ul=unlocked(i),rk=rkOf(i,di);
    h+='<button class="sr'+(i===si?' on':'')+(ul||(RSEL&&RSEL.on)?'':' lock')+'" data-i="'+i+'"><span class="no">'+(CON_OF[i][1]+1)+'</span>'
      +'<span class="tx"><span class="nm">'+esc(s.name)+'</span><span class="mt">'+esc(s.year+' · '+s.composer)+'<i>'+starTxt(STARS[i])+'</i>'+(RSEL&&RSEL.on?mpTag(s.key):'')+'</span></span>'
      +(RSEL&&RSEL.on?mpVoters(s.key):'')+'<span class="pips" aria-label="已通關難度">'+DORD.map(d=>'<i class="'+(rkOf(i,d)?'l'+LVL[d]:'')+'"></i>').join('')+'</span>'
      +'<span class="rk"'+(rk?' style="color:'+RANK_COL[rk]+'"':'')+'>'+(rk||'—')+'</span></button>';
  }}
  $('#chips').innerHTML=h||'<div class="sempty">'+(selF===1?'此難度的曲目皆已通關，可改選其他難度挑戰。':'此難度尚無已通關的曲目。')+'</div>';
  selDetail();
}
function selScroll(){const on=$('#chips .sr.on');if(on)try{on.scrollIntoView({block:'center'})}catch(e){}}
function selDetail(){
  const i=si,s=SONGS[i];if(!s)return;
  $('#sK').textContent=CONS[CON_OF[i][0]].name+' · 第 '+(CON_OF[i][1]+1)+' 首 · '+s.year;$('#sN').textContent=s.name;
  $('#sM').innerHTML=esc(s.composer+' · '+durTxt(s))+'<i>'+starTxt(STARS[i])+'</i>';
  $('#diffs').innerHTML=DORD.map(k=>{const df=DIFFS[k];return'<button data-d="'+k+'" class="'+(k===di?'on':'')+'">'+df.n+'<small>'+BALLS[df.nb]+(df.spd>1?'·快':df.spd<1?'·慢':'')+'</small></button>'}).join('');
  const rk=rkOf(i,di),sc=parseInt(lsGet(KEY_SC(i,di))||'0',10)||0,ac=parseInt(lsGet(KEY_AC(i,di))||'0',10)||0;
  $('#sB').innerHTML=rk?'<span class="bk" style="color:'+RANK_COL[rk]+'">'+rk+'</span><span>'+(ac?'精準度 <b>'+pct(ac)+'</b> · ':'')+'最高分 <b>'+sc.toLocaleString()+'</b><br><span id="sRank"></span></span>'
    :'<span class="bk" style="color:#3c4370">—</span><span>此難度尚未通關<br><span id="sRank"></span></span>';
  if(RSEL&&RSEL.on){mpDetail();return}   // a room plays any song: no lock, no personal leaderboard here
  $('#bGo').disabled=!unlocked(i);
  const t=++selTok,mini=$('#sMini');mini.innerHTML='<p>排行榜載入中⋯</p>';
  clearTimeout(selTm);selTm=setTimeout(async()=>{   // wait for the player to settle on a song
    const v=await lbGet(s.key,di);if(t!==selTok)return;const r=$('#sRank');
    if(!v){mini.innerHTML='<p>離線中，暫時無法顯示排行榜</p>';return}
    const top=v.top.filter(x=>!HIDE.has(x.id)).slice(0,3);
    mini.innerHTML=top.length?top.map(x=>'<div><b class="m'+x.r+'">'+x.r+'</b><span>'+esc(x.name)+'</span><span>'+pct(x.acc)+'</span></div>').join(''):'<p>目前尚無紀錄</p>';
    if(r)r.innerHTML=v.me&&!v.me.hidden?'排行榜 <b style="color:#ffd36b">第 '+v.me.r+' 名</b>／共 '+v.total+' 人':'';
  },250);
}
$('#chips').onclick=e=>{const b=e.target.closest('.sr');if(!b)return;const i=+b.dataset.i,room=RSEL&&RSEL.on;if(!room&&!unlocked(i))return;
  if(room)mpPick(i);si=i;document.querySelectorAll('#chips .sr.on').forEach(x=>x.classList.remove('on'));b.classList.add('on');initAudio();preloadSong(SONGS[i]);selDetail();pvPlay(SONGS[i])};
$('#sTabs').onclick=e=>{const b=e.target.closest('button[data-f]');if(!b)return;selF=+b.dataset.f;buildChips();$('#chips').scrollTop=0};
$('#diffs').onclick=e=>{const b=e.target.closest('button[data-d]');if(!b||(RSEL&&RSEL.on&&!mpHost()))return;   // guests in a room see the room's level
  if(RSEL&&RSEL.on){if(+b.dataset.d!==DU.cfg.di)mpCfg({di:+b.dataset.d});return}di=+b.dataset.d;lsSet('pmb6-di',String(di));buildChips()};
$('#bLb').onclick=()=>lbOpen(si,di);

/* ---- friends: presence socket, list, invites ---- */
const FD={code:/^[A-Z0-9]{8}$/.test(lsGet('ppl-fc')||'')?lsGet('ppl-fc'):'',ws:null,iv:0,back:0,retry:0,last:'',list:null,poll:0,inv:null,open:-1,bt:-1e9,pend:''};
try{const u=new URL(location.href),c=(u.searchParams.get('fc')||'').toUpperCase().replace(/[^A-Z0-9]/g,'');if(c.length===8){FD.pend=c;lsSet('ppl-tut','1')}
  if(u.searchParams.has('fc')){u.searchParams.delete('fc');history.replaceState(null,'',u.pathname+u.search+u.hash)}}catch(e){}
const IOS=/iP(hone|ad|od)/.test(navigator.userAgent)||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1);
const frIsOpen=()=>!$('#frv').classList.contains('hidden');
const busyNow=()=>st==='play'||st==='ready'||st==='starting';
function frConnect(){
  if(!ME||FD.ws||document.hidden)return;clearTimeout(FD.retry);
  let ws;try{ws=new WebSocket(NET.replace(/^http/,'ws')+'/fr/ws')}catch(e){return}
  FD.ws=ws;FD.last='';
  ws.onopen=()=>{try{ws.send(JSON.stringify({t:'auth',pk:pkey()}))}catch(e){}};
  ws.onmessage=e=>{if(FD.ws!==ws||typeof e.data!=='string'||e.data.length>2048)return;let d;try{d=JSON.parse(e.data)}catch(_){return}
    if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.t!=='string')return;try{frOn(d)}catch(err){}};
  ws.onclose=e=>{if(FD.ws!==ws)return;FD.ws=null;if(!ME||document.hidden||e.code===1008)return;   /* 1008: unknown key, replaced by another device, or flooding */FD.back=Math.min(60000,(FD.back||2000)*2);FD.retry=setTimeout(frConnect,FD.back)};
}
function frDisconnect(){clearTimeout(FD.retry);const w=FD.ws;FD.ws=null;try{if(w)w.close()}catch(e){}}
function frSend(o){try{if(FD.ws&&FD.ws.readyState===1)FD.ws.send(JSON.stringify(o))}catch(e){}}
function frStatus(force){   // what friends see: home / choosing a song / playing / in a duel
  if(!FD.ws)return;const playing=busyNow()||st==='done'||st==='over';
  const s=mode==='duel'?'duel':playing?'play':!$('#duel').classList.contains('hidden')?'duel':!$('#menu').classList.contains('hidden')?'menu':'home';
  const sg=s==='play'&&mode!=='tut'&&song?song.key:null,k=s+'|'+sg;if(!force&&k===FD.last)return;FD.last=k;frSend({t:'st',s,song:sg});
}
document.addEventListener('visibilitychange',()=>{if(document.hidden)frDisconnect();else frConnect()});   // a closed or backgrounded game shows as offline
setInterval(()=>{frSend({t:'ping'})},30000);
setInterval(()=>{frStatus();if(FD.inv)invShow();else if($('#invT').dataset.k==='inv')$('#invT').hidden=true;if(!$('#home').classList.contains('hidden'))frBadge()},1000);
function frOn(d){
  if(d.t==='hi'){FD.back=0;frStatus(true);return}
  const who=f=>dName(f&&typeof f==='object'?f.name:'')||'好友';
  if(d.t==='inv'){if(d.v!==2){const f=d.from&&typeof d.from==='object'?d.from:{};toast(who(f)+' 邀請您對戰，但對方的遊戲版本較舊，請對方更新後再邀請');return}const room=String(d.room||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);if(room.length!==4)return;
    const f=d.from&&typeof d.from==='object'?d.from:{};
    FD.inv={id:dInt(f.id,0,1e12),name:who(f),room,song:SONGS.findIndex(x=>x.key===d.song),d:dInt(d.d,0,DIFFS.length-1),exp:Date.now()+55000};invShow();return}
  if(d.t==='invno'){toast(who(d.from)+' 目前無法接受邀請');return}
  if(d.t==='req'){toast(who(d.from)+' 想加您為好友');frBadge(true);if(frIsOpen())frLoad();return}
  if(d.t==='friend'){toast('已與 '+dName(d.name)+' 成為好友');frBadge(true);if(frIsOpen())frLoad();return}
}
let toastTm=0;
function toast(text){
  if(FD.inv)return;const T=$('#invT');T.dataset.k='note';$('#invA').textContent=text;$('#invB').textContent='';$('#invNo').hidden=true;$('#invOk').textContent='確定';
  T.hidden=busyNow();clearTimeout(toastTm);toastTm=setTimeout(()=>{if(T.dataset.k==='note')T.hidden=true},4500);
}
function invShow(){   // never over a run in progress: it appears when the run ends
  const v=FD.inv,T=$('#invT');if(!v)return;
  if(Date.now()>v.exp){FD.inv=null;T.hidden=true;return}
  if(busyNow()){if(T.dataset.k==='inv')T.hidden=true;return}
  T.dataset.k='inv';$('#invA').innerHTML='<b>'+esc(v.name)+'</b> 邀請您對戰';
  $('#invB').textContent=(v.song>=0?'《'+SONGS[v.song].name+'》· '+DIFFS[v.d].n+' · ':'')+'還有 '+Math.ceil((v.exp-Date.now())/1000)+' 秒';
  $('#invNo').hidden=false;$('#invOk').textContent='加入';T.hidden=false;
}
$('#invOk').onclick=()=>{const T=$('#invT');T.hidden=true;if(T.dataset.k!=='inv')return;const v=FD.inv;FD.inv=null;if(v&&Date.now()<=v.exp)frJoin(v)};
$('#invNo').onclick=()=>{const v=FD.inv;FD.inv=null;$('#invT').hidden=true;if(v)api('/fr/decline',{pk:pkey(),id:v.id})};
function frJoin(v){
  initAudio();if(mode==='duel'&&busyNow())return;
  for(const o of['#set','#cal','#frv','#lbv','#pause','#nick','#duel'])$(o).classList.add('hidden');
  if(DU.ws)duelClose(true);showHome();duelOpen();duelJoin(v.room);
}
const fcode=c=>c.slice(0,4)+'-'+c.slice(4);
const ago=ms=>{if(!ms)return '';const s=(Date.now()-ms)/1000;return s<3600?Math.max(1,Math.round(s/60))+' 分鐘前':s<86400?Math.round(s/3600)+' 小時前':Math.round(s/86400)+' 天前'};
function frOpen(){
  if(!ME){nickOpen('friends');return}
  initAudio();$('#home').classList.add('hidden');$('#frv').classList.remove('hidden');$('#frMsg').textContent='';FD.open=-1;
  $('#frCode').textContent=FD.code?fcode(FD.code):'⋯';
  api('/fr/me',{pk:pkey()}).then(j=>{if(typeof j.code==='string'&&/^[A-Z0-9]{8}$/.test(j.code)){FD.code=j.code;lsSet('ppl-fc',j.code);$('#frCode').textContent=fcode(j.code)}else if(!FD.code)$('#frCode').textContent=j.error==='noname'?'請先設定暱稱':'離線中'});
  if(FD.pend){$('#frIn').value=fcode(FD.pend);FD.pend='';$('#frMsg').textContent='已帶入好友碼，請按「送出」。'}
  frLoad();clearInterval(FD.poll);FD.poll=setInterval(()=>{if(frIsOpen()&&!document.hidden)frLoad()},15000);
}
function frClose(){clearInterval(FD.poll);showHome()}
async function frLoad(){
  const j=await api('/fr/list',{pk:pkey()});
  if(j.error){if(frIsOpen()&&!FD.list)$('#frList').innerHTML='<div class="lbmsg">'+(j.error==='noname'?'請先設定暱稱。':'目前無法連線至伺服器，請稍後再試。')+'</div>';return}
  const P=a=>Array.isArray(a)?a.slice(0,300).filter(x=>x&&typeof x==='object').map(x=>({id:dInt(x.id,0,1e12),name:dName(x.name)||'玩家',on:x.on===1||x.on===true,
    st:['home','menu','play','duel'].includes(x.st)?x.st:null,song:typeof x.song==='string'?x.song:null,seen:Number.isFinite(+x.seen)?+x.seen:0})):[];
  FD.list={friends:P(j.friends),incoming:P(j.incoming),outgoing:P(j.outgoing),blocked:P(j.blocked)};frBadgeSet();if(frIsOpen())frRender();
}
function frBadge(force){if(!ME)return;if(!force&&performance.now()-FD.bt<30000)return;FD.bt=performance.now();frLoad()}
function frBadgeSet(){const L=FD.list;if(!L)return;const on=L.friends.filter(f=>f.on).length,inc=L.incoming.length;$('#frN').textContent=(on?String(on):'')+(inc?(on?' · ':'')+inc+' 個邀請':'')}
function frRender(){
  const L=FD.list;if(!L)return;const busy=f=>f.st==='play'||f.st==='duel';
  const on=L.friends.filter(f=>f.on).length;$('#frOn').textContent=on?on+' 位在線上':'';
  const fs=L.friends.slice().sort((a,b)=>(b.on-a.on)||(busy(a)-busy(b))||a.name.localeCompare(b.name,'zh-Hant'));
  let h=fs.length?'':'<div class="lbmsg">尚無好友。請將左側的好友碼提供給朋友，或輸入朋友的好友碼。</div>';
  for(const f of fs){
    const sn=f.song?SONGS.find(x=>x.key===f.song):null,cls=!f.on?'':busy(f)?'busy':'on';
    const sub=!f.on?'離線'+(f.seen?' · '+ago(f.seen):''):f.st==='duel'?'對戰中 · 結束後即可邀請':f.st==='play'?'遊戲中'+(sn?' · 《'+sn.name+'》':'')+' · 結束後即可邀請':f.st==='menu'?'在線上 · 選曲中':'在線上';
    h+='<div class="fr"><span class="dot '+cls+'"></span><span class="tx"><span class="nm">'+esc(f.name)+'</span><span class="mt '+cls+'">'+esc(sub)+'</span></span>'
      +(f.on&&!busy(f)?'<button class="pri inv" data-inv="'+f.id+'">邀請對戰</button>':'')
      +'<button class="more" data-more="'+f.id+'" aria-label="'+esc(f.name)+' 的更多選項">⋯</button></div>';
    if(FD.open===f.id)h+='<div class="fopt"><button data-rm="'+f.id+'">刪除好友</button><button class="warn" data-bl="'+f.id+'">封鎖</button><button data-x="1">取消</button></div>';
  }
  if(L.outgoing.length){h+='<div class="fsec">等待對方接受</div>';for(const f of L.outgoing)h+='<div class="fr"><span class="dot"></span><span class="tx"><span class="nm">'+esc(f.name)+'</span><span class="mt">已送出好友邀請</span></span><button data-rm="'+f.id+'">取消</button></div>'}
  if(L.blocked.length){h+='<div class="fsec">已封鎖</div>';for(const f of L.blocked)h+='<div class="fr"><span class="dot"></span><span class="tx"><span class="nm">'+esc(f.name)+'</span></span><button data-ub="'+f.id+'">解除封鎖</button></div>'}
  $('#frList').innerHTML=h;
  const R=$('#frReq');R.hidden=!L.incoming.length;
  R.innerHTML=L.incoming.map(f=>'<div><span><b>'+esc(f.name)+'</b> 想加您為好友</span><button class="pri" data-acc="'+f.id+'">接受</button><button data-dec="'+f.id+'">略過</button></div>').join('');
}
async function frAct(path,body){const j=await api(path,Object.assign({pk:pkey()},body));$('#frMsg').textContent=j.error?(j.error==='net'?'目前無法連線至伺服器。':'操作失敗，請稍後再試。'):'';FD.open=-1;await frLoad()}
$('#frList').onclick=e=>{const b=e.target.closest('button');if(!b)return;const D=b.dataset;
  if(D.more){const id=+D.more;FD.open=FD.open===id?-1:id;frRender();return}
  if(D.x){FD.open=-1;frRender();return}
  if(D.rm){frAct('/fr/remove',{id:+D.rm});return}
  if(D.bl){frAct('/fr/block',{id:+D.bl});return}
  if(D.ub){frAct('/fr/unblock',{id:+D.ub});return}
  if(D.inv)frInvite(+D.inv,b)};
$('#frReq').onclick=e=>{const b=e.target.closest('button');if(!b)return;if(b.dataset.acc)frAct('/fr/respond',{id:+b.dataset.acc,accept:true});else if(b.dataset.dec)frAct('/fr/respond',{id:+b.dataset.dec,accept:false})};
$('#frAdd').onclick=async()=>{
  const c=$('#frIn').value.toUpperCase().replace(/[^A-Z0-9]/g,''),m=$('#frMsg');
  if(c.length!==8){m.textContent='好友碼是 8 個英文字母和數字。';return}
  m.textContent='送出中⋯';const j=await api('/fr/add',{pk:pkey(),code:c});
  m.textContent=j.friends?'已成為好友。':j.pending?'已送出邀請，等待對方接受。':({nocode:'找不到這個好友碼。',self:'這是您自己的好友碼。',already:'雙方已是好友。',full:'好友或待確認的邀請已達上限。',slow:'操作太頻繁，請稍等 1 分鐘後再次嘗試。',net:'目前無法連線至伺服器。'})[j.error]||'送出失敗，請稍後再試。';
  if(j.ok){$('#frIn').value='';frLoad()}
};
$('#frIn').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('#frAdd').click()}});
// feedback on the button itself, at once: the message line below can be off screen, and the share sheet takes a moment to open
function btnSay(b,t){b=$(b);clearTimeout(b._sayT);if(b._txt==null)b._txt=b.textContent;b.textContent=t;b._sayT=setTimeout(()=>{b.textContent=b._txt},1600)}
navTap('#frCopy',async()=>{if(!FD.code){btnSay('#frCopy','載入中⋯');return}const t=fcode(FD.code);btnSay('#frCopy','複製中⋯');try{await navigator.clipboard.writeText(t);btnSay('#frCopy','已複製 ✓');$('#frMsg').textContent='已複製好友碼。'}catch(e){btnSay('#frCopy','無法複製');$('#frMsg').textContent='無法複製，請直接提供給朋友：'+t}});
navTap('#frSend',()=>{if(!FD.code){btnSay('#frSend','載入中⋯');return}btnSay('#frSend','開啟分享⋯');shareText('邀請您在 PingPongLight 加我為好友，好友碼：'+fcode(FD.code),SITE+'?fc='+FD.code,t=>{$('#frMsg').textContent=t})});
$('#frPaste').hidden=!(navigator.clipboard&&navigator.clipboard.readText);
$('#frPaste').onclick=async()=>{const m=$('#frMsg');let t='';try{t=await navigator.clipboard.readText()}catch(e){m.textContent='無法讀取剪貼簿，請手動輸入好友碼。';return}
  const c=(String(t).toUpperCase().match(/\b([A-Z0-9]{4})-?([A-Z0-9]{4})\b/)||[]);if(!c[0]){m.textContent='剪貼簿中沒有好友碼。';return}
  $('#frIn').value=c[1]+'-'+c[2];m.textContent='已貼上好友碼，請按「送出」。'};
navTap('#fcCopy',async()=>{const t=fcode(FD.pend||'');try{await navigator.clipboard.writeText(t);$('#fcM').textContent='已複製。請從主畫面開啟遊戲，至「好友」頁按「貼上」。'}catch(e){$('#fcM').textContent='無法複製，請記下好友碼：'+t}});
$('#fcWeb').onclick=()=>{$('#fcv').classList.add('hidden');if(ME)frOpen();else nickOpen('friends')};
$('#frX').onclick=frClose;
$('#bFr').onclick=frOpen;
async function frInvite(id,b){
  const f=FD.list&&FD.list.friends.find(x=>x.id===id),name=f?f.name:'好友';b.disabled=true;b.textContent='建立房間⋯';
  let code=null;try{const j=await mget('/m/new?pub=0&max=6&di='+di);code=dCode(j.code);if(code.length!==4)code=null}catch(e){}
  if(!code){b.disabled=false;b.textContent='邀請對戰';$('#frMsg').textContent='無法建立房間，請稍後再試。';return}
  clearInterval(FD.poll);$('#frv').classList.add('hidden');duelOpen();
  duelJoin(code,()=>{dsend({t:'cfg',song:SONGS[si].key,di,pub:false,max:6,vote:false});DU.note='邀請送出中⋯';
    api('/fr/invite',{pk:pkey(),id,room:code,song:SONGS[si].key,d:di,v:2}).then(j=>{
      DU.note=j.ok?(j.delivered?'已邀請 '+name+'，等待對方加入⋯':name+' 目前離線，請將房號提供給對方。'):j.error==='notfriend'?'雙方已不是好友。':'邀請未送出，請將房號提供給對方。';
      if(DU.ws)duelView()})});
}
/* ================= star map ================= */
// A night sky with no lines. Each constellation copies the bright-star pattern of a real one ([RA hours, Dec degrees,
// magnitude]); its songs sit on the pattern's brightest stars, first song on the brightest, so the shape reads by
// brightness alone and players see it themselves. Drag to pan, pinch or wheel to zoom, tap a constellation to fly in,
// tap a star for its song. Star sizes are in screen pixels and grow only a little when zooming, like a real sky.
const SKY_SHORT={auld:'驪歌',k545:'K.545',nocturne:'夜曲'};
const SKY_C=['#9df0b8','#cfe6ff','#7cf0ff','#ffd36b','#ff8fd8'];   // by difficulty rank (LVL): 入門 簡單 普通 困難 專家
const SKY_SHAPE={
  lyra:[[18.62,38.78,0],[18.98,32.69,3.2],[18.83,33.36,3.5],[18.91,36.9,4.3],[18.75,37.6,4.4],[18.74,39.67,4.7]],
  orion:[[5.24,-8.2,.1],[5.92,7.4,.5],[5.42,6.35,1.6],[5.6,-1.2,1.7],[5.68,-1.94,1.8],[5.8,-9.67,2.1],[5.53,-.3,2.2],[5.59,-5.9,2.8],[4.83,6.96,3.2],[5.59,9.93,3.4],[4.85,5.6,3.7],[6.04,9.65,4.1]],
  uma:[[11.06,61.75,1.8],[12.9,55.96,1.8],[13.79,49.31,1.9],[13.4,54.93,2.2],[11.03,56.38,2.4],[11.9,53.69,2.4],[11.16,44.5,3],[10.37,41.5,3.1],[8.99,48.04,3.1],[9.55,51.68,3.2],[12.26,57.03,3.3],[8.5,60.72,3.4],[10.28,42.91,3.4],[11.77,47.78,3.7]],
  sco:[[16.49,-26.43,1],[17.56,-37.1,1.6],[17.62,-43,1.9],[16,-22.62,2.3],[16.84,-34.29,2.3],[17.71,-39.03,2.4],[16.09,-19.8,2.6],[17.51,-37.3,2.7],[16.6,-28.22,2.8],[15.98,-26.11,2.9],[16.35,-25.59,2.9],[16.86,-38.05,3],[17.2,-43.24,3.3],[16.9,-42.36,3.6]],
  leo:[[10.14,11.97,1.4],[10.33,19.84,2],[11.82,14.57,2.1],[11.24,20.52,2.6],[9.76,23.77,3],[11.24,15.43,3.3],[10.28,23.42,3.4],[10.12,16.76,3.5],[10.55,9.3,3.9],[9.88,26,3.9],[11.4,10.53,4],[11.35,6.03,4]],
  gem:[[7.76,28.03,1.1],[7.58,31.89,1.6],[6.63,16.4,1.9],[6.38,22.51,2.9],[6.73,25.13,3],[6.25,22.5,3.3],[6.75,12.9,3.4],[7.34,21.98,3.5],[7.74,24.4,3.6],[7.3,16.54,3.6],[6.88,33.96,3.6],[7.07,20.57,3.8],[7.43,27.8,3.8],[7.6,26.9,4.1],[6.48,20.2,4.1],[7.19,30.25,4.4]],
  cyg:[[20.69,45.28,1.3],[20.37,40.26,2.2],[20.77,33.97,2.5],[19.75,45.13,2.9],[19.51,27.96,3.1],[21.22,30.23,3.2],[19.5,51.73,3.8],[19.94,35.08,3.9]],
  sgr:[[18.4,-34.38,1.8],[18.92,-26.3,2],[19.04,-29.88,2.6],[18.35,-29.83,2.7],[18.47,-25.42,2.8],[19.16,-21.02,2.9],[18.1,-30.42,3],[18.29,-36.76,3.1],[18.76,-26.99,3.2],[19.12,-27.67,3.3],[18.96,-21.1,3.5],[18.23,-21.06,3.9]],
  cma:[[6.75,-16.72,-1.5],[6.98,-28.97,1.5],[7.14,-26.39,1.8],[6.38,-17.96,2],[7.4,-29.3,2.4],[6.34,-30.06,3],[7.05,-23.83,3],[7.06,-15.63,4.1]],
  cas:[[.68,56.54,2.2],[.15,59.15,2.3],[.95,60.72,2.5],[1.43,60.24,2.7],[1.91,63.67,3.4],[.82,57.8,3.4],[.62,53.9,3.7],[.55,62.9,4.2]],
  tau:[[4.6,16.51,.9],[5.44,28.6,1.7],[3.79,24.1,2.9],[5.63,21.14,3],[4.48,15.87,3.4],[4.01,12.49,3.4],[4.48,19.18,3.5],[4.33,15.63,3.6],[3.41,9.03,3.6],[4.38,17.54,3.8]],
  cru:[[12.44,-63.1,.8],[12.8,-59.69,1.3],[12.52,-57.11,1.6],[12.25,-58.75,2.8],[12.36,-60.4,3.6],[12.9,-57.2,4]],
  boo:[[14.26,19.18,0],[14.75,27.07,2.4],[13.91,18.4,2.7],[14.53,38.3,3],[15.26,33.3,3.5],[15.03,40.39,3.5],[14.53,30.37,3.6],[14.69,13.73,3.8],[13.82,15.8,4.1],[14.68,16.42,4.5]],
  peg:[[.14,29.09,2.1],[23.06,28.08,2.4],[21.74,9.88,2.4],[23.08,15.2,2.5],[.22,15.18,2.8],[22.72,30.22,2.9],[22.69,10.83,3.4],[22.17,6.2,3.5],[22.83,24.6,3.5],[22.12,25.35,3.8],[22.78,23.57,3.9],[21.74,25.65,4.1],[22.78,12.17,4.2],[22.17,33.18,4.3]],
  aql:[[19.85,8.87,.8],[19.77,10.61,2.7],[19.09,13.86,3],[20.19,-.82,3.2],[19.43,3.11,3.4],[19.1,-4.88,3.4],[19.92,6.41,3.7],[19.87,1,3.9],[18.99,15.07,4],[19.6,-1.29,4.4]],
  del:[[20.63,14.6,3.6],[20.66,15.91,3.8],[20.78,16.12,3.9],[20.55,11.3,4],[20.73,15.07,4.4]]};
// which real pattern each constellation borrows; a name not listed takes the smallest free pattern that fits its songs
const SKY_PICK={'古老旋律座':'lyra','巴洛克座':'orion','古典座':'uma','浪漫座':'sco','晚浪漫與印象座':'leo','鋼琴詩人座':'leo','歌劇座':'gem','芭蕾座':'cyg','管弦樂座':'sgr','進行曲座':'cma','圓舞曲座':'cas','聖誕座':'tau','聖詩座':'cru','童謠座':'boo','童謠民謠座':'boo','世界民謠座':'peg','亞洲座':'aql','霓虹座':'del'};
let SKY=null,skyBack='home';
function skyBuild(){
  let sd=11;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
  const n=CONS.length,cols=Math.max(1,Math.ceil(Math.sqrt(n*2))),rows=Math.ceil(n/cols),CW=500,CH=480,W=(cols+.5)*CW,H=rows*CH+80;
  const used=new Set(),shapeFor=(name,m)=>{
    let s=SKY_PICK[name];
    if(!s||used.has(s)){const free=Object.keys(SKY_SHAPE).filter(k=>!used.has(k)),L=k=>SKY_SHAPE[k].length;
      s=free.filter(k=>L(k)>=m).sort((a,b)=>L(a)-L(b))[0]||free.sort((a,b)=>L(b)-L(a))[0]||'uma'}
    used.add(s);return s};
  const C=CONS.map((c,k)=>{
    const r=Math.floor(k/cols),q=k%cols,m=r===rows-1?n-r*cols:cols;
    const x0=((cols-m)/2+q+.5)*CW+CW*.25+(rows>1?(r%2?.18:-.18)*CW:0),y0=(r+.5)*CH+40+(q%2?28:-28);
    let S=SKY_SHAPE[shapeFor(c.name,c.ii.length)].map(a=>a.slice());const ras=S.map(a=>a[0]);if(Math.max(...ras)-Math.min(...ras)>12)S.forEach(a=>{if(a[0]<12)a[0]+=24});
    const d0=S.reduce((t,a)=>t+a[1],0)/S.length,r0=S.reduce((t,a)=>t+a[0],0)/S.length,cd=Math.cos(d0*Math.PI/180);
    const Q=S.map(([ra,de,mg])=>({x:-(ra-r0)*15*cd,y:-(de-d0),m:mg}));   // sky-chart orientation: north up, east to the left
    const qx=Q.map(p=>p.x),qy=Q.map(p=>p.y),bx0=Math.min(...qx),bx1=Math.max(...qx),by0=Math.min(...qy),by1=Math.max(...qy);
    while(Q.length<c.ii.length)Q.push({x:bx0+rnd()*(bx1-bx0),y:by0+rnd()*(by1-by0),m:4.2});   // more songs than the pattern has stars: faint extras inside it
    const R=Math.sqrt(Q.length)*46,ext=Math.max(...Q.map(p=>Math.max(Math.abs(p.x)/1.25,Math.abs(p.y)/.85)))||1,f=R/ext;
    const P=Q.map(p=>({x:x0+p.x*f,y:y0+p.y*f,m:p.m,i:-1}));
    // nudge very close pairs apart so each star can be tapped and labelled; the shape stays the same
    for(let it=0;it<40;it++)for(const p of P)for(const o of P){if(p===o)continue;const dx=o.x-p.x,dy=o.y-p.y,d=Math.hypot(dx,dy)||1;if(d<28){const u=(28-d)/2/d;p.x-=dx*u;p.y-=dy*u;o.x+=dx*u;o.y+=dy*u}}
    P.forEach(p=>{p.mag=clamp(1+(2.6-p.m)*.5,.4,2.3)});
    [...P].sort((a,b)=>a.m-b.m).slice(0,c.ii.length).forEach((p,j)=>{p.i=c.ii[j]});   // songs in play order, brightest star first
    const SP=P.filter(p=>p.i>=0);SP.forEach(p=>{p.nn=Math.min(...SP.filter(o=>o!==p).map(o=>Math.hypot(o.x-p.x,o.y-p.y)),999)});   // room for a name, among song stars
    const px=P.map(p=>p.x),py=P.map(p=>p.y),b0=Math.min(...px),b1=Math.max(...px),t0=Math.min(...py),t1=Math.max(...py);
    return{k,name:c.name,P,x:(b0+b1)/2,y:(t0+t1)/2,top:t0,bw:b1-b0,bh:t1-t0,R};
  });
  // background: a milky-way band, faint nebulae and field stars, batched by colour, brightness and twinkle phase
  const fb=new Map(),cnt=Math.round(2600*W*H/(3200*1500));
  for(let i=0;i<cnt;i++){const band=rnd()<.55,x=rnd()*W,y=band?H*(.78-.5*x/W)+(rnd()+rnd()+rnd()-1.5)*170:rnd()*H,m=Math.pow(rnd(),3.2);
    const h=rnd()<.15?'#ffd9b0':rnd()<.25?'#b9ccff':'#ffffff',a=Math.min(2,Math.floor(m*3.5)),g=Math.floor(rnd()*4),key=h+a+g;
    if(!fb.has(key))fb.set(key,{h,a:[.22,.42,.7][a],g,p:[]});fb.get(key).p.push([x,y,.3+m*1.0])}
  const neb=[];for(let i=0;i<Math.round(70*W/3200);i++){const x=rnd()*W;neb.push({x,y:H*(.78-.5*x/W)+(rnd()-.5)*260,r:120+rnd()*260,c:rnd()<.5?'90,110,200':'150,90,170',a:.025+rnd()*.035})}
  const cv=$('#skyCv');
  SKY={W,H,C,fb:[...fb.values()],neb,cv,cx:cv.getContext('2d'),vw:0,vh:0,dpr:1,s:1,ox:0,oy:0,minS:1,anim:null,raf:0,dirty:true,focus:-2,cache:new Map(),lt:0};
  skyA11y();
}
function skyFit(){
  const S=SKY,r=S.cv.getBoundingClientRect(),w=Math.max(1,r.width),h=Math.max(1,r.height),first=!S.vw;
  S.dpr=Math.min(2,window.devicePixelRatio||1);S.cv.width=Math.round(w*S.dpr);S.cv.height=Math.round(h*S.dpr);
  const z=first?1:S.s/S.minS,cxw=first?S.W/2:(S.vw/2-S.ox)/S.s,cyw=first?S.H/2:(S.vh/2-S.oy)/S.s;   // keep the same spot centred on resize
  S.vw=w;S.vh=h;S.minS=Math.max(.02,Math.min(w/S.W,(h-86)/S.H));S.s=S.minS*z;S.ox=w/2-cxw*S.s;S.oy=h/2+(first?20:0)-cyw*S.s;skyClampV();S.dirty=true;
}
function skyClampV(){
  const S=SKY;S.s=clamp(S.s,S.minS,S.minS*10);
  const ww=S.W*S.s,hh=S.H*S.s;
  S.ox=ww<S.vw?(S.vw-ww)/2:clamp(S.ox,S.vw-ww-40,40);
  S.oy=hh<S.vh-86?44+(S.vh-86-hh)/2:clamp(S.oy,S.vh-hh-50,60);
}
function skyZoomAt(f,px,py){const S=SKY,ns=clamp(S.s*f,S.minS,S.minS*10);S.ox=px-(px-S.ox)*ns/S.s;S.oy=py-(py-S.oy)*ns/S.s;S.s=ns;S.anim=null;skyClampV();S.dirty=true}
const skyZoomFor=C=>Math.min(SKY.minS*10,SKY.vw*.8/(C.bw+60),(SKY.vh-120)/(C.bh+70));
function skyFly(x,y,ns,instant){
  const S=SKY,s0=S.s,ox0=S.ox,oy0=S.oy;
  const end=()=>{S.s=ns;S.ox=S.vw/2-x*ns;S.oy=(S.vh+10)/2-y*ns;skyClampV()};
  if(instant||RM||SET.lowFx){end();S.anim=null;S.dirty=true;return}
  end();const ox1=S.ox,oy1=S.oy;S.s=s0;S.ox=ox0;S.oy=oy0;const t0=performance.now();
  S.anim=t=>{const k=Math.min(1,(t-t0)/450),e=1-Math.pow(1-k,3);S.s=s0+(ns-s0)*e;S.ox=ox0+(ox1-ox0)*e;S.oy=oy0+(oy1-oy0)*e;if(k>=1)S.anim=null};
}
const skyFlyTo=(C,instant)=>{const ns=skyZoomFor(C);skyFly(C.x,C.y-14/ns,ns,instant)};
const skyOverview=instant=>skyFly(SKY.W/2,SKY.H/2-20/SKY.minS,SKY.minS,instant);
const skyDone=c=>c.ii.every(i=>starOf(i).lit);
function skyCount(){
  let lit=0,s=0;for(let i=0;i<SONGS.length;i++){const v=starOf(i);if(v.lit)lit++;if(v.r===4)s++}
  return{lit,s,full:CONS.filter(skyDone).length};
}
function skyBadge(){$('#skyN').textContent=skyCount().lit+'/'+SONGS.length}
// top bar: the whole sky, or the constellation the view is zoomed into
function skyHead(){
  const S=SKY,zl=S.s/S.minS;let f=-1;
  if(zl>=2){const wx=(S.vw/2-S.ox)/S.s,wy=(S.vh/2-S.oy)/S.s;let bd=1e9;for(const C of S.C){const d=Math.hypot(C.x-wx,C.y-wy);if(d<C.R*1.4&&d<bd){bd=d;f=C.k}}}
  $('#skyBk').hidden=zl<1.15;
  if(f===S.focus)return;S.focus=f;
  if(f<0){const n=skyCount();$('#skyT').textContent='星空';$('#skyStat').innerHTML='點亮 <em>'+n.lit+'</em> / '+SONGS.length+' · 完整星座 <em>'+n.full+'</em> / '+CONS.length+' · S 評級 <em>'+n.s+'</em>'}
  else{const c=CONS[f],lit=c.ii.filter(i=>starOf(i).lit).length;$('#skyT').textContent=c.name;$('#skyStat').innerHTML='點亮 <em>'+lit+'</em> / '+c.ii.length+(lit===c.ii.length?' · <em>星座完成</em>':'')}
}
const skyStar=i=>{const c=SKY.cache;if(!c.has(i))c.set(i,{v:starOf(i),ul:unlocked(i)});return c.get(i)};   // nothing changes while the sky is open
function skyNameHit(c,wx,wy){const s=SKY.s,fs=Math.max(15/s,Math.min(30,26/Math.sqrt(s/SKY.minS)));return Math.abs(c.x-wx)<fs*c.name.length*.7+12/s&&wy>c.top-fs*2.4&&wy<c.top+4/s}   // same size and place as the drawn name
function skyPaint(t){
  const S=SKY,g=S.cx,s=S.s,zl=s/S.minS,motion=!SET.lowFx&&!RM;
  g.setTransform(S.dpr,0,0,S.dpr,0,0);
  const bg=g.createLinearGradient(0,0,0,S.vh);bg.addColorStop(0,'#070a1f');bg.addColorStop(.6,'#04061a');bg.addColorStop(1,'#020309');g.fillStyle=bg;g.fillRect(0,0,S.vw,S.vh);
  g.save();g.translate(S.ox,S.oy);g.scale(s,s);
  const X0=-S.ox/s-40,Y0=-S.oy/s-40,X1=(S.vw-S.ox)/s+40,Y1=(S.vh-S.oy)/s+40,vis=(x,y,r)=>x+r>X0&&x-r<X1&&y+r>Y0&&y-r<Y1;
  for(const n of S.neb){if(!vis(n.x,n.y,n.r))continue;const rg=g.createRadialGradient(n.x,n.y,0,n.x,n.y,n.r);rg.addColorStop(0,'rgba('+n.c+','+n.a+')');rg.addColorStop(1,'rgba('+n.c+',0)');g.fillStyle=rg;g.fillRect(n.x-n.r,n.y-n.r,n.r*2,n.r*2)}
  const fr=.9*Math.pow(zl,.2)/s;   // field stars: screen-pixel sizes, dimmer than any constellation star
  for(const b of S.fb){g.globalAlpha=b.a*(motion?.78+.22*Math.sin(t/900+b.g*1.6):1);g.fillStyle=b.h;g.beginPath();
    for(const p of b.p){if(p[0]<X0||p[0]>X1||p[1]<Y0||p[1]>Y1)continue;const r=p[2]*fr;g.moveTo(p[0]+r,p[1]);g.arc(p[0],p[1],r,0,6.28)}g.fill()}
  g.globalAlpha=1;
  const k=Math.pow(zl,.3)/s;
  for(const C of S.C){
    if(!vis(C.x,C.y,C.R*1.6))continue;
    const c=CONS[C.k];let lit=0;
    for(const p of C.P){
      const tw=motion?.9+.1*Math.sin(t/700+p.x):1;
      if(p.i<0){const r=(.35+p.mag*.6)*k*tw;g.fillStyle='rgba(220,228,255,.5)';g.beginPath();g.arc(p.x,p.y,r*.75,0,6.28);g.fill();continue}   // part of the shape, no song
      const {v,ul}=skyStar(p.i);
      if(v.lit){lit++;const r=(.9+p.mag*1.2+v.r*.3)*k*tw,col=SKY_C[v.d],rg=g.createRadialGradient(p.x,p.y,0,p.x,p.y,r*4.5);rg.addColorStop(0,col);rg.addColorStop(.22,col+'99');rg.addColorStop(1,col+'00');
        g.fillStyle=rg;g.beginPath();g.arc(p.x,p.y,r*4.5,0,6.28);g.fill();g.fillStyle='#fff';g.beginPath();g.arc(p.x,p.y,r*.5,0,6.28);g.fill();
        if(v.r===4){g.strokeStyle=col+'aa';g.lineWidth=.8/s;g.beginPath();g.moveTo(p.x-r*4,p.y);g.lineTo(p.x+r*4,p.y);g.moveTo(p.x,p.y-r*4);g.lineTo(p.x,p.y+r*4);g.stroke()}}   // S rank: a four-point sparkle
      else{const r=(.45+p.mag*.95)*k*tw,rg=g.createRadialGradient(p.x,p.y,0,p.x,p.y,r*3.2);g.globalAlpha=ul?1:.45;   // not cleared: plain white, still brighter than the background
        rg.addColorStop(0,'rgba(225,232,255,.35)');rg.addColorStop(1,'rgba(200,215,255,0)');g.fillStyle=rg;g.beginPath();g.arc(p.x,p.y,r*3.2,0,6.28);g.fill();
        g.fillStyle='rgba(248,250,255,.95)';g.beginPath();g.arc(p.x,p.y,r*.75,0,6.28);g.fill();g.globalAlpha=1}
      const la=clamp((p.nn*s-40)/12,0,1)*clamp((zl-1.5)/.5,0,1);   // a song's name appears once its star has room around it on screen
      if(la>0){let lab=SKY_SHORT[SONGS[p.i].key]||SONGS[p.i].name;if(Array.from(lab).length>8)lab=Array.from(lab).slice(0,7).join('')+'…';
        g.globalAlpha=la*(ul?1:.6);g.font=(11/s)+'px system-ui';g.textAlign='center';g.fillStyle=v.lit?'rgba(220,228,255,.92)':'rgba(160,170,215,.85)';g.fillText(lab,p.x,p.y+18/s);g.globalAlpha=1}
    }
    const done=lit===c.ii.length,fs=Math.max(15/s,Math.min(30,26/Math.sqrt(zl)));g.font='600 '+fs+'px system-ui';g.textAlign='center';
    g.fillStyle=done?'rgba(255,211,107,.95)':'rgba(200,208,245,'+(zl>2.2?.55:.9)+')';g.fillText(C.name.split('').join(' '),C.x,C.top-fs*1.1);
    if(zl<=2.2){g.font=(fs*.62)+'px system-ui';g.fillStyle='rgba(140,150,200,.8)';g.fillText(lit+' / '+c.ii.length,C.x,C.top-fs*.25)}
  }
  g.restore();
}
function skyLoop(t){
  const S=SKY;if(!S||!skyOn()){if(S)S.raf=0;return}
  if(S.anim){S.anim(t);S.dirty=true}
  if(S.dirty||(!SET.lowFx&&!RM&&t-S.lt>=33)){skyPaint(t);skyHead();S.dirty=false;S.lt=t}   // twinkling needs only ~30 fps
  S.raf=requestAnimationFrame(skyLoop);
}
// screen readers and keyboards: an invisible list of every song; focusing one flies the view to its star
function skyA11y(){
  const box=$('#skyList');box.textContent='';
  for(const C of SKY.C)for(const p of C.P){if(p.i<0)continue;const b=document.createElement('button');b.textContent=C.name+'：'+SONGS[p.i].name;
    b.addEventListener('focus',()=>{const ns=Math.max(skyZoomFor(C),SKY.minS*3);skyFly(p.x,p.y,ns)});b.onclick=e=>{e.stopPropagation();skyCardShow(p.i,C.name);const f=$('#skyCard button');if(f){f.focus();$('#skyCard').dataset.back=String(p.i)}};box.appendChild(b)}
}
(()=>{   // gestures: one finger pans, two fingers pinch around their midpoint, wheel zooms, a tap picks a star or a constellation
  const cv=$('#skyCv'),pts=new Map();let last=null,moved=0;
  cv.addEventListener('pointerdown',e=>{if(!SKY)return;try{cv.setPointerCapture(e.pointerId)}catch(_){}pts.set(e.pointerId,[e.clientX,e.clientY]);if(pts.size===1)moved=0;SKY.anim=null});
  cv.addEventListener('pointermove',e=>{if(!SKY||!pts.has(e.pointerId))return;const S=SKY,prev=pts.get(e.pointerId);pts.set(e.pointerId,[e.clientX,e.clientY]);
    if(pts.size===1){S.ox+=e.clientX-prev[0];S.oy+=e.clientY-prev[1];moved+=Math.abs(e.clientX-prev[0])+Math.abs(e.clientY-prev[1]);skyClampV();S.dirty=true}
    else if(pts.size===2){const r=cv.getBoundingClientRect(),[a,b]=[...pts.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]),m=[(a[0]+b[0])/2-r.left,(a[1]+b[1])/2-r.top];
      if(last){skyZoomAt(d/last.d,m[0],m[1]);S.ox+=m[0]-last.m[0];S.oy+=m[1]-last.m[1];skyClampV()}last={d,m};moved=99}});
  const up=e=>{pts.delete(e.pointerId);if(pts.size<2)last=null};
  cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
  cv.addEventListener('click',e=>{
    if(!SKY)return;if(moved>=8){e.stopPropagation();return}   // the end of a drag is not a tap
    const S=SKY,r=cv.getBoundingClientRect(),sx=e.clientX-r.left,sy=e.clientY-r.top,wx=(sx-S.ox)/S.s,wy=(sy-S.oy)/S.s;
    let best=null,bd=26;for(const C of S.C)for(const p of C.P){if(p.i<0)continue;const d=Math.hypot(p.x*S.s+S.ox-sx,p.y*S.s+S.oy-sy);if(d<bd){bd=d;best=[p,C]}}   // finger-sized reach in screen pixels
    const C=S.C.find(c=>Math.hypot(c.x-wx,c.y-wy)<c.R*1.15||skyNameHit(c,wx,wy));   // the shape or its name
    if(best&&S.s>=skyZoomFor(best[1])*.7){e.stopPropagation();skyCardShow(best[0].i,best[1].name)}
    else if(C&&S.s<skyZoomFor(C)*.7){e.stopPropagation();$('#skyCard').hidden=true;skyFlyTo(C)}
    else if(best){e.stopPropagation();skyCardShow(best[0].i,best[1].name)}});
  cv.addEventListener('wheel',e=>{if(!SKY)return;e.preventDefault();const r=cv.getBoundingClientRect();skyZoomAt(Math.exp(-e.deltaY*.0015),e.clientX-r.left,e.clientY-r.top)},{passive:false});
  $('#skyZi').onclick=e=>{e.stopPropagation();skyZoomAt(1.6,SKY.vw/2,SKY.vh/2)};
  $('#skyZo').onclick=e=>{e.stopPropagation();skyZoomAt(1/1.6,SKY.vw/2,SKY.vh/2)};
  addEventListener('resize',()=>{if(SKY&&skyOn())skyFit()});
})();
// one star: best rank and score per difficulty, highest difficulty cleared, best rank overall
function starOf(i){
  const per=DIFFS.map((_,d)=>{const r=lsGet(KEY_RK(i,d));return RANKS.includes(r)?{r,s:parseInt(lsGet(KEY_SC(i,d))||'0',10)||0}:null});   // by difficulty index
  let d=-1,r=-1;per.forEach((p,k)=>{if(p){d=Math.max(d,LVL[k]);r=Math.max(r,RANKS.indexOf(p.r))}});   // d: rank of the hardest difficulty cleared
  let old=false;if(d<0&&cleared(i)){d=LVL[0];r=0;old=true}   // cleared before ranks were kept
  return{lit:d>=0,d,r,per,old};
}
function skyCardShow(i,cname){
  const s=SONGS[i],v=starOf(i),ul=unlocked(i),c=$('#skyCard');c.textContent='';
  const add=(t,cls,txt,p)=>{const e=document.createElement(t);if(cls)e.className=cls;if(txt!=null)e.textContent=txt;(p||c).appendChild(e);return e};
  add('div','sub',cname);add('h3','',s.name);add('div','sub',s.composer+' · '+s.year);
  if(ul){
    const tb=add('table');
    DORD.forEach(k=>{const df=DIFFS[k],tr=add('tr','',null,tb),p=v.per[k];add('td','',df.n,tr);const td=add('td','',p?p.r+' · '+p.s.toLocaleString():v.old&&!k?'已通關':'未通關',tr);td.style.color=p?RANK_COL[p.r]:v.old&&!k?'#cfe6ff':'#8a93c0'});
  }else{
    const c=CON_OF[i],need=c[1]-2-conCleared(c[0]);
    add('p','','在「'+CONS[c[0]].name+'」再通過 '+need+' 首曲目後開放。').style.margin='10px 0';
  }
  const row=add('div','row');
  if(ul){add('button','pri','挑戰這首',row).onclick=()=>{
    const top=DORD.reduce((a,k,j)=>v.per[k]||(v.old&&!k)?j:a,-1),nd=DORD[Math.min(DORD.length-1,top+1)];di=nd;lsSet('pmb6-di',String(nd))   // the level just above the hardest one cleared
    si=i;skyClose(true);initAudio();preloadSong(s);showSelect()}}
  add('button','','關閉',row).onclick=e=>{e.stopPropagation();c.hidden=true};
  c.hidden=false;
}
function skyOpen(from){
  skyBack=from;$('#'+from).classList.add('hidden');$('#sky').classList.remove('hidden');$('#skyCard').hidden=true;
  if(!SKY)skyBuild();SKY.cache=new Map();skyFit();SKY.focus=-2;
  const c=CON_OF[si];if(from==='end'&&c)skyFlyTo(SKY.C[c[0]],true);else skyOverview(true);
  SKY.dirty=true;if(!SKY.raf)SKY.raf=requestAnimationFrame(skyLoop);
}
function skyClose(leaving){
  $('#sky').classList.add('hidden');$('#skyCard').hidden=true;
  if(!leaving)$('#'+skyBack).classList.remove('hidden');
  skyBadge();
}
const skyOn=()=>!$('#sky').classList.contains('hidden');
$('#bSky').onclick=()=>{initAudio();skyOpen('home')};
$('#skyX').onclick=()=>skyClose();
$('#sky').addEventListener('click',e=>{if(!e.target.closest('#skyCard'))$('#skyCard').hidden=true});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&skyOn()){if(!$('#skyCard').hidden)$('#skyCard').hidden=true;else if(SKY&&SKY.s>SKY.minS*1.15)skyOverview();else skyClose()}});
navTap('#skyBk',()=>{$('#skyCard').hidden=true;skyOverview()});
$('#rsky').onclick=()=>skyOpen('end');
skyBadge();
const tutDone=()=>!!lsGet('ppl-tut')||SONGS.some((_,i)=>cleared(i));
function startTut(){mode='tut';startRun(0)}
$('#bStart').onclick=()=>{initAudio();goFs();if(!tutDone())startTut();else showSelect()};
$('#bTut').onclick=()=>{initAudio();goFs();startTut()};
function onPress(el,fn){let t=-1e9;
  el.addEventListener('pointerup',e=>{e.stopPropagation();t=performance.now();fn()});
  el.addEventListener('click',e=>{e.stopPropagation();if(performance.now()-t>600)fn()});}
onPress($('#bPause'),()=>{if(paused&&!resumeCD)resumeGame();else pauseGame()});
$('#bResume').onclick=resumeGame;
$('#bRestart').onclick=()=>{$('#pause').classList.add('hidden');doResume();startRun(0)};
function skipTut(){lsSet('ppl-tut','1');$('#pause').classList.add('hidden');doResume();showSelect()}
$('#bSkip').onclick=skipTut;onPress($('#bSkipH'),skipTut);
$('#bQuit').onclick=()=>{$('#pause').classList.add('hidden');doResume();if(mode==='normal')showSelect();else showHome()};
/* ---- settings ---- */
function audioDiag(){
  const el=$('#aDiag');if(!el)return;
  let ses='';try{ses=navigator.audioSession?navigator.audioSession.type:'無'}catch(e){}
  el.textContent=AC?'音訊狀態：'+AC.state+' · '+Math.round(AC.sampleRate/100)/10+' kHz · 工作階段 '+ses:'音訊尚未啟動';
}
function syncSet(){
  audioDiag();$('#sNick').textContent=ME?ME.name:'（尚未設定暱稱）';$('#bNick').textContent=ME?'變更暱稱':'設定暱稱';
  for(const[k,id]of[['mel','vMel'],['bk','vBk'],['fx','vFx']]){$('#'+id).value=SET[k];$('#'+id+'V').textContent=SET[k]}
  const tg2=(id,on)=>{const b=$('#'+id);b.setAttribute('aria-checked',String(!!on));b.classList.toggle('on',on)};tg2('tFx',SET.lowFx);tg2('tVib',SET.vib);tg2('tMl',SET.ml!==false);
  const ms=Math.round(latS()*1000);$('#calV').textContent=(ms>=0?'+':'')+ms+' ms'+(SET.lat==null?'（自動）':'');$('#calCur').textContent=(ms>=0?'+':'')+ms+' ms'+(SET.lat==null?'（自動）':'');
}
for(const[k,id]of[['mel','vMel'],['bk','vBk'],['fx','vFx']])$('#'+id).oninput=e=>{SET[k]=+e.target.value;applyVol();saveSet();syncSet()};
$('#tFx').onclick=()=>{SET.lowFx=!SET.lowFx;saveSet();syncSet()};
$('#tMl').onclick=()=>{SET.ml=SET.ml===false;saveSet();syncSet()};
if(!navigator.vibrate)$('#tVib').closest('.sw').style.display='none';   // iPhone browsers and apps have no vibration API
$('#tVib').onclick=()=>{SET.vib=!SET.vib;saveSet();syncSet();vib(30)};
$('#bNick').onclick=()=>nickOpen(ME?'rename':'set');
let wipeT=-1e9;
$('#bWipe').onclick=async()=>{   // two taps: the first one only arms it
  const b=$('#bWipe'),idle='刪除我的線上資料';
  if(performance.now()-wipeT>4000){wipeT=performance.now();b.textContent='再按一次以永久刪除暱稱、排行榜成績與好友資料';setTimeout(()=>{if(performance.now()-wipeT>=4000)b.textContent=idle},4100);return}
  wipeT=-1e9;b.disabled=true;b.textContent='刪除中⋯';
  const j=await api('/lb/delete',{pk:pkey()});b.disabled=false;
  if(!j.ok){b.textContent='刪除失敗，請連線後再次嘗試';setTimeout(()=>{b.textContent=idle},3000);return}
  frDisconnect();try{for(const k of Object.keys(localStorage))if(/^ppl-(pk|me|hide|lr-)/.test(k))localStorage.removeItem(k)}catch(e){}
  HIDE.clear();setMe(null);LBC.clear();FD.list=null;FD.code='';lsSet('ppl-fc','');$('#frN').textContent='';b.textContent='已刪除。單人模式的進度仍保留於此裝置';setTimeout(()=>{b.textContent=idle},4000);syncSet();
};
$('#bSet').onclick=()=>{initAudio();syncSet();$('#home').classList.add('hidden');$('#set').classList.remove('hidden')};
function closeSet(){$('#set').classList.add('hidden');showHome()}
$('#bSetC').onclick=closeSet;
$('#set').addEventListener('click',e=>{if(e.target.id==='set')closeSet()});   // tap outside the panel closes it
/* ---- latency calibration: clicks on the audio clock, player taps along; offset = median(tap - click) ---- */
let calClicks=[],calTaps=[],calEnd=0;
$('#bCal').onclick=()=>{initAudio();$('#set').classList.add('hidden');$('#cal').classList.remove('hidden');$('#calMsg').textContent='按「開始」後會出現 8 拍節拍聲，請跟著聲音點擊下方區塊。';syncSet()};
$('#calGo').onclick=()=>{
  initAudio();if(!AC)return;calTaps=[];const t0=AC.currentTime+.6;calClicks=[];
  for(let k=0;k<10;k++){const c=t0+k*.5;calClicks.push(c);tick(c-AC.currentTime,k%4?.12:.2)}
  calEnd=t0+10*.5;$('#calMsg').textContent='跟著節拍點擊下方區塊⋯';
  setTimeout(calDone,(calEnd-AC.currentTime+.3)*1000);
};
$('#calPad').addEventListener('pointerdown',e=>{
  e.preventDefault();const pad=$('#calPad');pad.classList.add('beat');setTimeout(()=>pad.classList.remove('beat'),90);
  if(!AC||!calClicks.length||AC.currentTime>calEnd+.3)return;
  const lag=Math.max(0,(performance.now()-e.timeStamp)/1000);const t=AC.currentTime-(lag<1?lag:0);
  let best=1e9;for(const c of calClicks.slice(2)){const d=t-c;if(Math.abs(d)<Math.abs(best))best=d}
  if(Math.abs(best)<.3)calTaps.push(best);
});
function calDone(){
  calClicks=[];
  if(calTaps.length<4){$('#calMsg').textContent='有效點擊不足，請再試一次。';return}
  const a=calTaps.slice().sort((x,y)=>x-y),m=a[Math.floor(a.length/2)];
  SET.lat=Math.round(clamp(m*1000,-100,400));saveSet();syncSet();
  $('#calMsg').textContent='校準完成：'+(SET.lat>=0?'+':'')+SET.lat+' ms（'+calTaps.length+' 次有效點擊）。';
}
$('#calM').onclick=()=>{SET.lat=Math.round(latS()*1000)-10;saveSet();syncSet()};
$('#calP').onclick=()=>{SET.lat=Math.round(latS()*1000)+10;saveSet();syncSet()};
function closeCal(){calClicks=[];$('#cal').classList.add('hidden');syncSet();$('#set').classList.remove('hidden')}
$('#calC').onclick=closeCal;
$('#cal').addEventListener('click',e=>{if(e.target.id==='cal')closeCal()});
/* ---- share result image ---- */
function shareImg(){
  const r=lastRes;if(!r)return null;
  const c=document.createElement('canvas');c.width=1200;c.height=630;const x=c.getContext('2d');
  const g=x.createLinearGradient(0,0,1200,630);g.addColorStop(0,'#10173a');g.addColorStop(1,'#04050d');x.fillStyle=g;x.fillRect(0,0,1200,630);
  const b=x.createRadialGradient(950,315,0,950,315,420);b.addColorStop(0,'rgba(124,240,255,.18)');b.addColorStop(1,'transparent');x.fillStyle=b;x.fillRect(0,0,1200,630);
  const lg=x.createLinearGradient(70,0,560,0);lg.addColorStop(0,'#7cf0ff');lg.addColorStop(.5,'#b794ff');lg.addColorStop(1,'#ff8fd1');
  const F='"Noto Sans TC","PingFang TC","Microsoft JhengHei",sans-serif';
  x.fillStyle=lg;x.font='800 64px '+F;x.fillText('PingPongLight',70,120);
  x.fillStyle='#e8ecff';x.font='700 40px '+F;x.fillText(r.label,70,210,700);
  x.font='800 86px '+F;x.fillText(r.score.toLocaleString(),70,340);
  x.fillStyle='#b9c1ea';x.font='500 32px '+F;x.fillText('精準度 '+Math.round(r.acc*100)+'%　最高連擊 '+r.maxCombo,70,410);
  x.fillStyle='#8a93c0';x.font='400 26px '+F;x.fillText((APP?new URL(SITE).host:location.host)+'　'+new Date().toLocaleDateString('zh-TW'),70,560);
  x.textAlign='center';x.fillStyle=RANK_COL[r.rank];x.shadowColor=RANK_COL[r.rank];x.shadowBlur=40;x.font='800 300px '+F;x.fillText(r.rank,950,420);
  return c;
}
$('#bShare').onclick=()=>{
  const c=shareImg();if(!c)return;
  const text='我在 PingPongLight '+lastRes.label+' 拿到 '+lastRes.rank+'（'+lastRes.score.toLocaleString()+' 分）';
  if(APP){const data=c.toDataURL('image/png').split(',')[1];   // the app: save to the cache folder, then the system share sheet
    capCall('Filesystem','writeFile',{path:'pingponglight-result.png',data,directory:'CACHE'}).then(r=>capCall('Share','share',{title:'PingPongLight',text,files:[r.uri]})).catch(()=>{});return}
  c.toBlob(bl=>{
    if(!bl)return;
    try{const f=new File([bl],'pingponglight.png',{type:'image/png'});
      if(navigator.canShare&&navigator.canShare({files:[f]})){navigator.share({files:[f],title:'PingPongLight',text}).catch(()=>{});return}}catch(e){}
    const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download='pingponglight.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  },'image/png');
};
// How-to opens as a card over the home screen; ✕, 知道了, the dimmed backdrop or Esc closes it.
function howOpen(){$('#howv').classList.remove('hidden');$('#home').inert=true;$('#howv .card').focus()}   // the card, not a button: buttons fade in and can't take focus yet
function howClose(){const v=$('#howv');if(!v)return;if(v.classList.contains('hidden'))return;v.classList.add('hidden');$('#home').inert=false;$('#bHow').focus({preventScroll:true})}
$('#bHow').onclick=howOpen;
$('#howX').onclick=howClose;$('#howOk').onclick=howClose;
$('#howv').addEventListener('click',e=>{if(e.target.id==='howv')howClose()});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('#howv').classList.contains('hidden'))howClose()});
navTap('#bGo',()=>{if(RSEL&&RSEL.on){mpSelGo();return}if(!unlocked(si))return;initAudio();goFs();mode='normal';startRun(0)});
$('#bNext').onclick=()=>{initAudio();if(mode==='tut'){mode='normal';si=0;startRun(0)}else if(si+1<SONGS.length&&unlocked(si+1)){si++;startRun(0)}};
$('#bRetry').onclick=()=>{initAudio();startRun(0)};
$('#bCont').onclick=()=>{initAudio();startRun(cp.ti)};
$('#bSel').onclick=showSelect;
$('#bFs').onclick=toggleFs;
// Every button fires on touchend, not on the delayed synthetic click (a quick second tap was being eaten).
// Bound in the bubble phase so navTap's own touchend runs first; a drag of more than 10px is a scroll, not a tap.
(function(){let T=null;
  document.addEventListener('touchstart',e=>{const b=e.touches.length===1&&e.target.closest&&e.target.closest('button');T=b?{b,x:e.touches[0].clientX,y:e.touches[0].clientY}:null},{passive:true,capture:true});
  document.addEventListener('touchmove',e=>{const t=e.touches[0];if(T&&t&&(Math.abs(t.clientX-T.x)>10||Math.abs(t.clientY-T.y)>10))T=null},{passive:true,capture:true});
  document.addEventListener('touchcancel',()=>{T=null},{capture:true});
  document.addEventListener('touchend',e=>{const c=T;T=null;if(!c||e.defaultPrevented||c.b.disabled||!c.b.isConnected)return;
    const t=e.changedTouches[0],r=c.b.getBoundingClientRect();if(!t||t.clientX<r.left-8||t.clientX>r.right+8||t.clientY<r.top-8||t.clientY>r.bottom+8)return;
    e.preventDefault();c.b.click()},{passive:false});
})();
function navTap(sel,fn){
  const el=$(sel);if(!el)return;let down=false;
  el.onclick=()=>fn();
  el.addEventListener('touchstart',()=>{down=true},{passive:true});
  el.addEventListener('touchcancel',()=>{down=false});
  el.addEventListener('touchend',e=>{if(!down)return;down=false;const t=e.changedTouches[0],r=el.getBoundingClientRect();
    if(!t||t.clientX<r.left-8||t.clientX>r.right+8||t.clientY<r.top-8||t.clientY>r.bottom+8)return;e.preventDefault();fn()},{passive:false});
}
navTap('#frX',frClose);navTap('#lbX',lbClose);navTap('#bBack',()=>{if(RSEL&&RSEL.on)duelLeave();else showHome()});navTap('#bSetC',closeSet);
navTap('#dX',()=>{if(DU.ws){duelLeave()}else{mpRestore();$('#duel').classList.add('hidden');showHome()}});
addEventListener('resize',layout);
if(window.visualViewport)visualViewport.addEventListener('resize',layout);
document.addEventListener('fullscreenchange',()=>setTimeout(layout,100));
document.addEventListener('webkitfullscreenchange',()=>setTimeout(layout,100));
addEventListener('orientationchange',()=>{setTimeout(layout,200);setTimeout(vpCheck,350);setTimeout(()=>{vpCheck();layout()},1200)});
addEventListener('pageshow',()=>{vpCheck();layout()});
document.addEventListener('visibilitychange',()=>{if(!document.hidden)setTimeout(()=>{vpCheck();layout()},150)});
for(const t of[300,1000,2500])setTimeout(()=>{vpCheck();layout()},t);   // a turn during launch can land after the first layout
if(!unlocked(si))si=0;
for(const f of[layout,buildChips,hud,audioStatus]){try{f()}catch(e){showErr(e)}}   // one failing step must not stop start-up
if(APP)$('#bFs').style.display='none';
else if('serviceWorker' in navigator&&location.protocol==='https:')addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));hudShow(false);$('#fsHint').style.display=(!(DE.requestFullscreen||DE.webkitRequestFullscreen)&&!standalone)?'block':'none';
requestAnimationFrame(frame);
try{netBoot()}catch(e){}
window.__pb={get S(){const Gn=st==='play'?G():0;return{st,resolved,n:tg.length,score,combo,balls:balls.map(b=>({x:b.x,y:b.y,v:b.v,ti:b.ti,win:b.win?b.win.edge:-1,depth:b.win?b.win.depth:-1e9,dtT:b.ti>=0?tT(b.ti)-Gn:9,lead:LEAD(b.v)})),F:FR,HR:HRe(),BR,nb,tiers:tierCount,cents:lastCents,p:lastP,pSrc,cp:cp.ti,G:Gn,useAC,life,mode,paused,resumeCD,lat:latS(),D:D&&D.n}},setTs(v){ts=v},setSong(i){si=i},skyRes(k,d,ok){const j=SONGS.findIndex(x=>x.key===k);if(j<0)return null;mode='normal';si=j;song=SONGS[si];di=d;D=DIFFS[d];score=1000;tierCount=[tg.length||10,0,0,0];missCount=0;st='done';showResult(ok,'');const r=$('#rsky');return r.hidden?'':r.textContent},tg:()=>tg.map(t=>t.t),pv:()=>({key:PV.s&&PV.s.key,i:PV.i,n:PV.n&&PV.n.length,g:PV.g?+PV.g.gain.value.toFixed(3):null,home:HM.on,ac:AC&&AC.state}),pause:pauseGame,resume:resumeGame,shareImg,STARS,il:()=>instLoad,gaps:()=>{const r=[];for(const it of items)for(const o of bumps)r.push(Math.hypot(it.x-o.x,it.y-o.y)-itemGap(o.Rm));return r}};
})();
