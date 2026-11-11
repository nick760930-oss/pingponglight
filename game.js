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
function vib(p){if(!SET.vib)return;try{if(navigator.vibrate)navigator.vibrate(p)}catch(e){}}
try{if(navigator.audioSession)navigator.audioSession.type='playback'}catch(e){}   // iOS 16.4+: Web Audio keeps playing with the silent switch on
let silentEl=null;
function wavUri(){   // 0.25 s of silence as a data URI (keeps iOS audio session in "playback" mode)
  const n=2000,b=new Uint8Array(44+n),v=new DataView(b.buffer),w=(o,t)=>{for(let i=0;i<t.length;i++)b[o+i]=t.charCodeAt(i)};
  w(0,'RIFF');v.setUint32(4,36+n,true);w(8,'WAVEfmt ');v.setUint32(16,16,true);v.setUint16(20,1,true);v.setUint16(22,1,true);v.setUint32(24,8000,true);v.setUint32(28,8000,true);v.setUint16(32,1,true);v.setUint16(34,8,true);w(36,'data');v.setUint32(40,n,true);
  for(let i=0;i<n;i++)b[44+i]=128;
  let s='';for(const x of b)s+=String.fromCharCode(x);return 'data:audio/wav;base64,'+btoa(s);
}
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
  el.textContent=AC&&AC.state==='running'?'聲音已啟用':'聲音未啟用：請按「測試聲音」，並確認裝置未開啟靜音。';
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
function songInsts(s){const m=s&&INSTMAP[s.key];return m?[...new Set(Object.values(m))]:[]}
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
function playInst(name,role,midi,t,hold,vol,cents){
  const S=SAMP[name];if(!S||!S.ready)return false;
  const I=INST[name];while(midi>I.hi)midi-=12;while(midi<I.lo)midi+=12;
  let m0=Math.round(midi/3)*3;if(!S.buf[m0]){m0=+Object.keys(S.buf).reduce((a,b)=>Math.abs(b-midi)<Math.abs(a-midi)?b:a)}
  const buf=S.buf[m0];if(!buf)return false;
  const src=AC.createBufferSource(),g=AC.createGain();src.buffer=buf;src.playbackRate.value=Math.pow(2,(midi-m0)/12);
  if(cents&&src.detune)src.detune.value=cents;
  const end=t+Math.min(hold,buf.duration/src.playbackRate.value-.05);
  g.gain.setValueAtTime(vol*I.g*SGAIN*(role==='lead'?1:1.15),t);g.gain.setTargetAtTime(0,end,I.rel/3);
  let out=g;if(AC.createStereoPanner&&PAN[role]){const pn=AC.createStereoPanner();pn.pan.value=PAN[role];g.connect(pn);out=pn}
  src.connect(g);out.connect(role==='lead'?busMel:busBk);src.start(t);src.stop(end+I.rel+.1);
  track(g,end+I.rel);return true;
}
function instOf(role){const m=song&&INSTMAP[song.key];if(!m||st==='home'||st==='menu')return null;return role==='ctr'?(m.ctr||m.bk):role==='bass'?(m.bass||m.bk):m[role]}
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
const homeWant=()=>!!AC&&AC.state==='running'&&(st==='home'||st==='menu')&&mode!=='tut'&&!document.hidden&&$('#cal').classList.contains('hidden');
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
function prepare(s){
  melList=[];bkList=[];
  for(const n of s.n)(n[3]===1?melList:bkList).push(n);
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
let FR={x:0,y:0,w:0,h:0},BR=9,V0=420,HR=50,portrait=false;
const HRe=()=>HR*(rangeT>0?rangeMul:1)*(DU.shrinkT>0?.7:1);
/* online duel state */
const DU={ws:null,code:'',you:0,host:0,players:[],cfg:{song:0,di:1},phase:'lobby',off:0,pings:[],seed:1,startAt:0,
  opp:{s:0,c:0,l:100,r:0,j:-1,jt:0},oppName:'',myFin:null,oppFin:null,left:false,pstreak:0,fogT:0,shrinkT:0,sprint:false,banner:null,prevDi:null,ready:false};
let mode='normal',D=null,life=100,resumeCD=0,lastRes=null,freezeG=0;
const TUTN=20,TUTD={n:'教學',nb:1,gap:1.25,spd:.9,dmg:0};
let st='home',si=0,offset=0,nt=0,resolved=0,nb=1,bi=0,tickQ=[],endAt=0,paused=false,exitT=0;
let score=0,combo=0,maxCombo=0,tierCount=[0,0,0,0],time=0,ts=1,gAC=0,gT=0,cp={ti:0,score:0},lastCents=0,lastP=.5,pSrc='none';
let balls=[],bumps=[],items=[],rings=[],floats=[],parts=[],aims=[],missCount=0,runFrom=0;
let shake=0,flash={a:0,hue:0},easeT=0,starT=0,shield=0,rangeT=0,rangeMul=1,edgeGlow=[0,0,0,0],edgeHue=[0,0,0,0],spawnT=4,itemT=8;
const LEADIN=2.6,CPN=25;
const DIFFS=[{n:'簡單',nb:1,gap:1.0,spd:1.0,dmg:20},{n:'普通',nb:2,gap:.55,spd:1.0,dmg:25},{n:'困難',nb:2,gap:.4,spd:1.2,dmg:34}];
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
let di=(v=>isNaN(v)?1:Math.min(2,Math.max(0,v)))(parseInt(lsGet('pmb6-di')||'1',10)),SPD=1;
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
const unlocked=i=>!LOCKS||i<3+SONGS.reduce((a,_,k)=>a+(cleared(k)?1:0),0);
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
const LEAD=v=>Math.max(BR*5,(v||0)*.13)*(easeT>0?1.6:1),GRACE=v=>Math.max(BR*5,(v||0)*.11)*(easeT>0?1.6:1);

function safeIns(){const c=getComputedStyle($('#safe'));return{t:parseFloat(c.paddingTop)||0,r:parseFloat(c.paddingRight)||0,b:parseFloat(c.paddingBottom)||0,l:parseFloat(c.paddingLeft)||0}}
let layoutRetry=0;
function viewSize(){   // some browsers briefly report 0 during fullscreen / rotation changes
  const vv=window.visualViewport,c=[[vv&&vv.width,vv&&vv.height],[innerWidth,innerHeight],[DE.clientWidth,DE.clientHeight]];
  for(const[w,h]of c)if(w>=50&&h>=50)return[Math.round(w),Math.round(h)];
  return null;
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
  const side=Math.max(24,W*.04)+Math.max(sa.l,sa.r);
  FR.w=Math.min(W-side*2,900);FR.h=Math.min(H-top-bot,FR.w*.5);FR.w=Math.min(FR.w,FR.h*2.4);
  FR.x=Math.round((W-FR.w)/2);FR.y=Math.round(top+(H-top-bot-FR.h)/2);
  BR=Math.max(8,Math.min(FR.w,FR.h)*.032);V0=FR.w*.55;HR=Math.max(46,BR*5.5);
  for(const b of balls){b.x=clamp(b.x,FR.x+BR,FR.x+FR.w-BR);b.y=clamp(b.y,FR.y+BR,FR.y+FR.h-BR)}
}

/* ================= run control ================= */
function hud(){
  $('#score').textContent=score.toLocaleString();
  if(mode==='duel'){const tot=score+DU.opp.s;$('#pf').style.width=(tot?score/tot*100:50)+'%';duelSub()}   // tug-of-war bar
  else $('#pf').style.width=(tg.length?resolved/tg.length*100:0)+'%';
  const lf=$('#life');lf.style.width=life+'%';lf.classList.toggle('low',life<35);
  $('#combo').innerHTML=(mlOn()&&st==='play'?'<span class="mlv" style="--c:hsl('+ML_HUE[mlv]+',90%,'+(mlv?68:62)+'%)">'+[0,1,2,3].map(i=>'<i'+(i<=mlv?' class="on"':'')+'></i>').join('')+'</span>'+ML_NAME[mlv]+' · ':'')+(combo>1?'連擊 '+combo+' · ':'')+resolved+' / '+tg.length+(rangeT>0?(rangeMul>1?' · 範圍放大':' · 範圍縮小'):'')+(starT>0?' · 分數×2':'')+(shield?' · 護盾':'');
}
function newBall(ti){
  const s=sideOf(ti),dy=srand(-.35,.35),l=Math.hypot(1,dy);
  return{x:FR.x+FR.w*(s===1?srand(.25,.4):srand(.6,.75)),y:FR.y+FR.h*(nb===2?(ti%2?.7:.3):.5),dx:(s===1?1:-1)/l,dy:dy/l,v:0,pop:0,ti,side:s,win:null,trail:[],sq:0,sqn:0,laps:0,away:false};
}
function startRun(from){
  from=from||0;
  if(mode==='tut'){D=TUTD;si=SONGS.findIndex(s=>s.key==='twinkle');if(si<0)si=0}
  else D=DIFFS[di];
  RNG=mode==='duel'?mulberry32(DU.seed):Math.random;
  DU.pstreak=0;DU.fogT=0;DU.shrinkT=0;DU.sprint=false;DU.banner=null;DU.myFin=null;DU.oppFin=null;DU.opp={s:0,c:0,l:100,r:0,j:-1,jt:0};
  song=SONGS[si];LEADTYPE=song.lead||'triangle';SPD=D.spd;nb=D.nb;prepare(song);
  from=Math.min(from,Math.max(0,tg.length-1));
  offset=from>0?tg[from].t-.02:0;
  bi=bkList.findIndex(n=>n[0]/100>=offset);if(bi<0)bi=bkList.length;
  resolved=from;nt=from+nb;score=from?cp.score:0;if(!from)cp={ti:0,score:0};
  combo=0;maxCombo=0;tierCount=[0,0,0,0];shake=0;exitT=0;easeT=0;starT=0;shield=0;rangeT=0;rangeMul=1;paused=false;resumeCD=0;life=100;missCount=0;runFrom=from;flash.a=0;edgeGlow=[0,0,0,0];
  bumps=[];items=[];rings=[];floats=[];parts=[];aims=[];spawnT=5;itemT=9;tickQ=[];cutAll();mlv=0;mgrow=0;mlBan=null;
  balls=[];for(let j=0;j<nb;j++)if(from+j<tg.length)balls.push(newBall(from+j));
  endAt=mode==='tut'?timeOf(tg[tg.length-1].t)+2:timeOf(song.dur)+1.2;
  st='ready';hudShow(true);preloadSong(song);
  $('#sub').textContent=(mode==='tut'?'新手教學':'第 '+(si+1)+' 關')+' · 《'+song.name+'》 · '+D.n+' · '+tg.length+' 拍'+(nb===2?' · 雙球':'')+(from?' · 自第 '+(from+1)+' 拍':'');
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
  rings.push({x,y,r0:6,life:.3,max:.3,hue:best?hueNow():220,w:1.5});     // visual only; a wrong tap makes no sound
  if(!best)return;
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
document.addEventListener('touchmove',e=>{if(!(e.target.closest&&e.target.closest('.card')))e.preventDefault()},{passive:false});
document.addEventListener('touchstart',e=>{if(e.touches.length>1&&!(e.target.closest&&e.target.closest('.card')))e.preventDefault()},{passive:false});
document.addEventListener('dblclick',e=>e.preventDefault());
document.addEventListener('contextmenu',e=>e.preventDefault());
document.addEventListener('selectstart',e=>{if(!(e.target.closest&&e.target.closest('input,select,textarea')))e.preventDefault()});
document.addEventListener('wheel',e=>{if(e.ctrlKey||!(e.target.closest&&e.target.closest('.card')))e.preventDefault()},{passive:false});
document.addEventListener('keydown',e=>{if((e.ctrlKey||e.metaKey)&&['+','-','=','0'].includes(e.key))e.preventDefault();
  else if(e.key==='Escape'||e.key==='p'||e.key==='P'){if(st==='play'){if(paused&&!resumeCD)resumeGame();else pauseGame()}}});
const standalone=!!(navigator.standalone||(window.matchMedia&&matchMedia('(display-mode: fullscreen), (display-mode: standalone)').matches));
if(!(DE.requestFullscreen||DE.webkitRequestFullscreen)&&!standalone)$('#fsHint').style.display='block';

/* ================= game logic ================= */
function burst(x,y,hue,n,sp,life){
  if(SET.lowFx)n=Math.round(n*.3);
  for(let i=0;i<n;i++){const a=rand(0,6.283),v=rand(.3,1)*sp;parts.push({x:x,y:y,vx:Math.cos(a)*v,vy:Math.sin(a)*v,life:rand(.4,1)*life,max:life,hue:hue+rand(-18,18),r:rand(1.2,3)})}
}
function nextPitch(){const t=tg[Math.min(tg.length-1,Math.max(0,resolved))];return melList[t.mi][2]}
function keyBell(vol){if(!AC)return;const p=nextPitch()+12;pluck(440*Math.pow(2,(p-69)/12),AC.currentTime,.5,vol*.7,[[1,1],[3,.12]],.5,busFx,0)}   // in-key accent (never a clash)
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
  const sf=Math.pow(Math.max(.3,b.v/V0),1.1),pts=Math.round((100*T.m*sf*(1+.3*p)*(starT>0?2:1))*(mode==='duel'&&DU.sprint?2:1))+combo*5;
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
  const r=RNG(),type=r<.3?'big':r<.5?'small':r<.78?'star':(shield>=2?'star':'shield');
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
  if(mode==='tut'){lsSet('ppl-tut','1')}
  else if(ok&&mode==='normal'){
    lsSet(KEY_CL(si),'1');
    if(newBest)lsSet(kS,String(score));
    const pr=lsGet(kR);if(!pr||RANKS.indexOf(rank)>RANKS.indexOf(pr))lsSet(kR,rank);
    cp={ti:0,score:0};
  }
  $('#rk').textContent=mode==='tut'?'教學完成':(ok?'過關':'失敗');
  $('#rt').textContent=(mode==='tut'?'新手教學':'第 '+(si+1)+' 關')+' · 《'+song.name+'》· '+D.n;
  lastRes={ok,rank,score,acc,maxCombo,name:song.name,label:$('#rt').textContent};
  const rk=$('#rank');rk.textContent=ok?rank:'失敗';rk.style.color=ok?RANK_COL[rank]:'#ff7a93';rk.style.fontSize=ok?'':'clamp(40px,11vh,64px)';
  $('#rnew').innerHTML=newBest?'<span class="badge">新紀錄</span>':(ok?'':'<span class="sub">'+(msg||'')+'</span>');
  const row=(l,v,c)=>'<tr><td style="color:'+(c||'inherit')+'">'+l+'</td><td>'+v+'</td></tr>';
  $('#rtab').innerHTML=row('完美',tierCount[0],'#ffd36b')+row('極佳',tierCount[1],'#7cf0ff')+row('良好',tierCount[2],'#8fe388')+row('尚可',tierCount[3],'#9aa3c7')+row('失誤',missCount,'#ff7a93')
    +row('最高連擊',maxCombo)+row('精準度',Math.round(acc*100)+'%')+row('完成度',Math.min(resolved,tg.length)-runFrom+' / '+N);
  countUp($('#rscore'),score);
  const hasNext=mode==='tut'||(mode==='normal'&&ok&&si+1<SONGS.length&&unlocked(si+1));
  $('#bNext').style.display=hasNext?'':'none';$('#bNext').textContent=mode==='tut'?'開始第 1 關':'下一關';
  $('#bShare').style.display=mode==='tut'||!ok?'none':'';
  const cb=$('#bCont');if(!ok&&cp.ti>0){cb.style.display='';cb.textContent='從第 '+(cp.ti+1)+' 拍繼續'}else cb.style.display='none';
  for(const id of['bAgain','bLeave'])$('#'+id).style.display=mode==='duel'?'':'none';
  if(mode==='duel'){for(const id of['bNext','bCont','bRetry','bSel'])$('#'+id).style.display='none';duelFinish(ok,rank,acc)}
  else for(const id of['bRetry','bSel'])$('#'+id).style.display='';
  $('#end').classList.remove('hidden');
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
function showHome(){mode='normal';setMedia(false);hudShow(false);st='home';cutAll();balls=[];tg=[];resolved=0;hud();$('#menu').classList.add('hidden');$('#end').classList.add('hidden');$('#home').classList.remove('hidden');audioStatus()}
function showSelect(){mode='normal';setMedia(false);hudShow(false);st='menu';cutAll();balls=[];buildChips();$('#home').classList.add('hidden');$('#end').classList.add('hidden');$('#menu').classList.remove('hidden')}

/* ================= update ================= */
function wallFx(b,e){rings.push({x:b.x,y:b.y,r0:BR*.5,life:.3,max:.3,hue:hueNow()+80,w:1.5});edgeGlow[e]=Math.max(edgeGlow[e],.18);edgeHue[e]=hueNow()}
function stepFree(b,dt){b.x+=b.dx*b.v*dt;b.y+=b.dy*b.v*dt}
function updateBall(b,dt){
  if(b.pop<1)b.pop=Math.min(1,b.pop+dt*3);
  if(b.sq>0)b.sq=Math.max(0,b.sq-dt*6);
  if(b.ti<0){                                     // no more targets: drift and fade
    b.v=Math.max(b.v,V0*.5);stepFree(b,dt);
    if(b.y<FR.y+BR){b.y=FR.y+BR;b.dy=Math.abs(b.dy)}else if(b.y>FR.y+FR.h-BR){b.y=FR.y+FR.h-BR;b.dy=-Math.abs(b.dy)}
    if(b.x<FR.x+BR){b.x=FR.x+BR;b.dx=Math.abs(b.dx)}else if(b.x>FR.x+FR.w-BR){b.x=FR.x+FR.w-BR;b.dx=-Math.abs(b.dx)}
    return;
  }
  // speed is recomputed every step from the path still to travel and the time left: it lands exactly on the beat
  if(tT(b.ti)-GB()>.05||b.v<1)b.v=ballWant(b);   // in the last 50 ms keep the (already exact) speed instead of creeping toward the line
  b.x+=b.dx*b.v*dt;b.y+=b.dy*b.v*dt;
  const last=b.trail[b.trail.length-1];
  if(!last||Math.hypot(b.x-last.x,b.y-last.y)>BR*.45){b.trail.push({x:b.x,y:b.y});if(b.trail.length>16)b.trail.shift()}
  else if(b.trail.length>4)b.trail.shift();
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
      b.win=null;shake=Math.max(shake,5);flash.a=.16;flash.hue=345;keyBell(.06);
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
  if(mode==='duel'){if(DU.fogT>0)DU.fogT-=dt;if(DU.shrinkT>0){DU.shrinkT-=dt;if(DU.shrinkT<=0)hud()}if(DU.banner&&(DU.banner.t-=dt)<=0)DU.banner=null;
    if(!DU.sprint&&tg.length&&resolved>=tg.length*.8){DU.sprint=true;DU.banner={text:'最後衝刺！分數 ×2',hue:48,t:2.2,max:2.2};flash.a=.25;flash.hue=48;hud()}}
  if(starT>0){starT-=dt;if(starT<=0)hud()}
  const prog=tg.length?resolved/tg.length:0;
  const bm=1,tut=mode==='tut';
  spawnT-=dt;if(spawnT<=0&&Gn>LEADIN&&(!tut||resolved>=12)){if(bumps.length<(tut?1:(1+Math.floor(prog*3))*bm))spawnBump();spawnT=Math.max(1.8,4.5-prog*2.6)/bm*srand(.8,1.2)}
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
function drawBalls(x){
  const h=hueNow();
  for(const b of balls){
    const sc=b.pop<1?(1-Math.pow(1-b.pop,3)):1,r=BR*sc,col=starT>0?50:h;
    x.save();x.globalCompositeOperation='lighter';x.lineCap='round';x.lineJoin='round';
    const glow=!mlFull()&&mlv>=3;   // layer 3: brighter, wider trail
    for(let i=1;i<b.trail.length;i++){
      const f=i/b.trail.length;x.strokeStyle=`hsla(${col},100%,${glow?72:65}%,${f*f*(glow?.9:.6)})`;x.lineWidth=BR*(glow?2.2:1.7)*f;
      x.beginPath();x.moveTo(b.trail[i-1].x,b.trail[i-1].y);x.lineTo(b.trail[i].x,b.trail[i].y);x.stroke();
    }
    x.drawImage(sprite(col),b.x-r*3.6,b.y-r*3.6,r*7.2,r*7.2);x.restore();
    x.save();x.translate(b.x,b.y);
    if(b.sq>0){const horiz=b.sqn===1||b.sqn===3,s=b.sq*.35;x.scale(horiz?1-s:1+s*.6,horiz?1+s*.6:1-s)}
    x.fillStyle='#fff';x.beginPath();x.arc(0,0,r*.7,0,6.283);x.fill();x.restore();
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
  if(st==='ready'&&mode==='duel'){const left=Math.max(0,(DU.startAt-duelNow())/1000);ctx.fillStyle='#e8ecff';ctx.font='800 22px "Noto Sans TC",sans-serif';ctx.fillText('對手：'+(DU.oppName||'玩家')+'　對戰即將開始 '+Math.ceil(left),W/2,FR.y+FR.h/2+BR*6);
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

/* ================= online duel ================= */
// The server address is fixed. A ?duel= override is honoured only on a local dev page and only for a local server,
// so a shared link can never point players at someone else's server.
const DUEL_URL=(()=>{if(!/^(localhost|127\.0\.0\.1)$/.test(location.hostname))return 'https://pingponglight-duel.nick760930.workers.dev';
  try{const q=new URLSearchParams(location.search).get('duel');if(q&&/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?$/.test(q))return q}catch(e){}
  return 'http://'+location.hostname+':8787'})();
// Everything from the network is untrusted: escape before HTML, clamp numbers, whitelist enums.
const esc=s=>String(s==null?'':s).replace(/[&<>"'`]/g,c=>'&#'+c.charCodeAt(0)+';');
const dInt=(v,lo,hi)=>{v=Math.floor(Number(v));return Number.isFinite(v)?Math.max(lo,Math.min(hi,v)):lo};
const dName=v=>String(v==null?'':v).replace(/[\u0000-\u001f\u007f-\u009f<>&"'`\\]/g,'').trim().slice(0,12);
const DRANKS=['S','A','B','C','D','—'],DATK=['bump','shrink','fog'];
// Inbound budget for the high-rate messages only (live state / attacks): a flooding peer cannot stall the game loop.
// Control messages (room, start, fin, left, pong) always pass, so a burst after the page was frozen never loses them.
const DIN={tok:60,t:0};
function dAllow(t){if(t!=='st'&&t!=='atk')return true;const now=performance.now();DIN.tok=Math.min(60,DIN.tok+(now-DIN.t)/1000*30);DIN.t=now;if(DIN.tok>=1){DIN.tok--;return true}return false}
const duelNow=()=>Date.now()+DU.off;
function dsend(o){try{if(DU.ws&&DU.ws.readyState===1)DU.ws.send(JSON.stringify(o))}catch(e){}}
function dmsg(t){$('#dMsg').textContent=t||''}
function duelOpen(){initAudio();$('#home').classList.add('hidden');$('#duel').classList.remove('hidden');$('#dName').value=lsGet('ppl-name')||'';duelView()}
function duelView(){const inRoom=!!(DU.ws&&DU.code);$('#dJoin').hidden=inRoom;$('#dRoom').hidden=!inRoom}
async function duelCreate(){
  initAudio();dmsg('建立房間中⋯');
  try{const r=await fetch(DUEL_URL+'/new');if(r.status===429){dmsg('操作太頻繁，請一分鐘後再試。');return}
    const j=await r.json();if(typeof j.code!=='string')throw 0;duelJoin(j.code)}
  catch(e){dmsg('無法連線到對戰伺服器，請稍後再試。')}
}
function duelJoin(code){
  initAudio();code=String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,4);
  if(code.length!==4){dmsg('請輸入 4 碼房號。');return}
  const nm=($('#dName').value||'').trim().slice(0,12);if(nm)lsSet('ppl-name',nm);
  duelClose(true);dmsg('連線中⋯');
  let ws;try{ws=new WebSocket(DUEL_URL.replace(/^http/,'ws')+'/ws/'+code)}catch(e){dmsg('無法連線到對戰伺服器。');return}
  DU.ws=ws;DU.code=code;DU.left=false;DU.pings=[];
  ws.onopen=()=>{dmsg('');dsend({t:'hello',name:nm||''});for(let k=0;k<6;k++)setTimeout(()=>dsend({t:'ping',c:Date.now()}),k*250);duelView()};
  ws.onmessage=e=>{if(DU.ws!==ws||typeof e.data!=='string'||e.data.length>4096)return;
    let d;try{d=JSON.parse(e.data)}catch(_){return}if(!d||typeof d!=='object'||Array.isArray(d)||typeof d.t!=='string'||!dAllow(d.t))return;
    try{duelOn(d)}catch(err){}};
  ws.onclose=ev=>{if(DU.ws!==ws)return;DU.ws=null;
    if(mode==='duel'&&st==='play'){DU.left=true;DU.banner={text:'與伺服器的連線中斷',hue:350,t:3,max:3}}
    else{DU.code='';duelView();dmsg(ev.code===1006&&!DU.players.length?'無法加入：房間不存在、已滿，或操作太頻繁。':'連線已中斷。')}};
  clearInterval(DU.pingIv);DU.pingIv=setInterval(()=>dsend({t:'ping',c:Date.now()}),5000);
}
function duelClose(silent){
  clearInterval(DU.pingIv);const w=DU.ws;DU.ws=null;DU.code='';DU.players=[];DU.phase='lobby';
  try{if(w)w.close()}catch(e){}if(!silent)duelView();
}
function duelLeave(){duelClose();if(DU.prevDi!=null){di=DU.prevDi;DU.prevDi=null}mode='normal';$('#duel').classList.add('hidden');showHome()}
function duelOn(d){
  if(d.t==='pong'){const now=Date.now(),c=+d.c,sv=+d.s,rtt=now-c;if(!Number.isFinite(c)||!Number.isFinite(sv)||rtt<0||rtt>10000)return;d={c,s:sv};DU.pings.push({rtt,off:d.s-(d.c+rtt/2)});DU.pings.sort((a,b)=>a.rtt-b.rtt);DU.pings=DU.pings.slice(0,8);
    const best=DU.pings.slice(0,3);DU.off=best.reduce((a,p)=>a+p.off,0)/best.length;return}   // clock offset from the fastest round trips
  if(d.t==='room'){if(!Array.isArray(d.players))return;
    d.you=dInt(d.you,0,1);d.host=dInt(d.host,0,1);d.players=d.players.slice(0,2).filter(p=>p&&typeof p==='object').map(p=>({i:dInt(p.i,0,1),name:dName(p.name)||'玩家',ready:p.ready===true}));
    const cf=d.cfg&&typeof d.cfg==='object'?d.cfg:{};d.cfg={song:dInt(cf.song,0,SONGS.length-1),di:dInt(cf.di,0,DIFFS.length-1)};d.phase=d.phase==='play'?'play':'lobby';
    DU.you=d.you;DU.host=d.host;DU.players=d.players;DU.cfg=d.cfg;DU.phase=d.phase;
    const me=d.players.find(p=>p.i===d.you),op=d.players.find(p=>p.i!==d.you);DU.oppName=op?op.name:'';DU.ready=!!(me&&me.ready);
    duelRoomUI();if(SONGS[d.cfg.song])preloadSong(SONGS[d.cfg.song]);return}
  if(d.t==='start'){if(mode==='duel'&&(st==='play'||st==='ready'))return;
    const at=+d.at,now=duelNow();duelStart({at:Number.isFinite(at)&&Math.abs(at-now)<15000?at:now+4500,seed:dInt(d.seed,0,4294967295),song:dInt(d.song,0,SONGS.length-1),di:dInt(d.di,0,DIFFS.length-1)});return}
  if(d.t==='st'){if(mode!=='duel')return;const o=DU.opp,was=o.c;o.s=dInt(d.s,0,1e8);o.c=dInt(d.c,0,1e5);o.l=dInt(d.l,0,100);o.r=dInt(d.r,0,1e5);o.j=dInt(d.j,-1,4);o.jt=performance.now();
    if(was>=10&&o.c===0&&mode==='duel'&&st==='play')DU.banner={text:'對手斷連！',hue:185,t:1.4,max:1.4};
    hud();return}
  if(d.t==='atk'){const now=performance.now();if(!DATK.includes(d.k)||now-(DU.atkT||0)<1500)return;DU.atkT=now;duelAttacked(d.k);return}
  if(d.t==='fin'){if(mode!=='duel'||DU.oppFin)return;d={s:dInt(d.s,0,1e8),ok:d.ok===true,rank:DRANKS.includes(d.rank)?d.rank:'—',mc:dInt(d.mc,0,1e5)};DU.oppFin=d;if(DU.myFin)duelResult();else if(mode==='duel'&&st==='play')DU.banner={text:'對手已'+(d.ok?'完成':'出局'),hue:d.ok?48:350,t:2,max:2};return}
  if(d.t==='left'){DU.left=true;DU.oppName=DU.oppName||'對手';
    if(mode==='duel'&&st==='play')DU.banner={text:'對手已離線',hue:350,t:2.5,max:2.5};
    else if(!$('#end').classList.contains('hidden'))duelResult();
    dmsg('對手已離開房間。');return}
}
function duelRoomUI(){
  $('#dCodeT').textContent='房號 '+DU.code;
  $('#dPl').innerHTML=[0,1].map(i=>{const p=DU.players.find(q=>q.i===i);return p?'<span class="'+(p.ready?'ok':'')+'">'+(p.i===DU.you?'你：':'')+esc(p.name)+(p.ready?' ✓ 準備':'')+'</span>':'<span style="opacity:.5">等待對手加入⋯</span>'}).join('');
  const host=DU.you===DU.host,sel=$('#dSong'),dd=$('#dDi');
  if(sel.options.length!==SONGS.length){sel.innerHTML=SONGS.map((x,i)=>'<option value="'+i+'">'+(i+1)+'. '+x.name+'</option>').join('');dd.innerHTML=DIFFS.map((x,i)=>'<option value="'+i+'">'+x.n+'</option>').join('')}
  sel.value=DU.cfg.song;dd.value=DU.cfg.di;sel.disabled=dd.disabled=!host;
  const b=$('#dReady');b.textContent=DU.ready?'取消準備':'準備';b.classList.toggle('pri',!DU.ready);
  if(!$('#duel').classList.contains('hidden'))dmsg(DU.players.length<2?'把房號告訴朋友，或按「邀請朋友」分享連結。':(host?'你是房主，可以選曲目和難度。兩人都按「準備」就開始。':'房主選曲中，兩人都按「準備」就開始。'));
}
function duelStart(d){
  DU.seed=d.seed>>>0||1;DU.startAt=d.at;if(DU.prevDi==null)DU.prevDi=di;
  si=Math.max(0,Math.min(SONGS.length-1,d.song|0));di=d.di|0;mode='duel';
  $('#duel').classList.add('hidden');$('#end').classList.add('hidden');
  startRun(0);
  const wait=()=>{if(mode!=='duel'||st!=='ready')return;const left=DU.startAt-duelNow();if(left<=12){launch();return}setTimeout(wait,Math.min(250,Math.max(1,left-10)))};
  wait();
}
function duelHit(j){   // j: 0-3 tier, 4 miss
  dsend({t:'st',s:score,c:combo,l:life,r:resolved,j});
  if(j===0){if(++DU.pstreak>=10){DU.pstreak=0;const k=['bump','shrink','fog'][Math.floor(Math.random()*3)];dsend({t:'atk',k});
    DU.banner={text:'發動攻擊：'+({bump:'障礙',shrink:'縮小範圍',fog:'迷霧'})[k],hue:185,t:1.3,max:1.3}}}
  else DU.pstreak=0;
  hud();
}
function duelAttacked(k){
  if(mode!=='duel'||st!=='play')return;
  if(shield>0){shield--;hud();DU.banner={text:'護盾擋下攻擊',hue:190,t:1.4,max:1.4};return}
  vib([30,40,30]);flash.a=.2;flash.hue=320;
  if(k==='bump'){for(let t=0;t<12;t++){const x=FR.x+FR.w*rand(.3,.7),y=FR.y+FR.h*rand(.2,.8);if(balls.every(b=>Math.hypot(b.x-x,b.y-y)>FR.h*.3)){bumps.push({x,y,Rm:Math.min(FR.w,FR.h)*.11,age:0,life:4});break}}}
  else if(k==='shrink')DU.shrinkT=5;else DU.fogT=3.5;
  DU.banner={text:'受到攻擊：'+({bump:'障礙',shrink:'觸碰範圍縮小',fog:'迷霧'})[k]||'',hue:320,t:1.6,max:1.6};hud();
}
function duelSub(){
  const o=DU.opp,J=['完美','極佳','良好','尚可','失誤'],recent=performance.now()-o.jt<700&&o.j>=0;
  $('#sub').textContent='對手 '+(DU.oppName||'玩家')+'　'+o.s.toLocaleString()+(o.c>1?'　連擊 '+o.c:'')+'　生命 '+o.l+'%'+(recent?'　'+J[o.j]:'')+(DU.shrinkT>0?'　［範圍縮小］':'');
}
function drawDuel(x){
  if(DU.fogT>0){   // fog covers the middle of the field; both lines stay visible
    const a=Math.min(1,DU.fogT/.5)*.82,g=x.createLinearGradient(FR.x,0,FR.x+FR.w,0);
    g.addColorStop(0,'rgba(40,30,70,0)');g.addColorStop(.18,`rgba(40,30,70,${a})`);g.addColorStop(.82,`rgba(40,30,70,${a})`);g.addColorStop(1,'rgba(40,30,70,0)');
    x.fillStyle=g;x.fillRect(FR.x,FR.y,FR.w,FR.h);
  }
  if(DU.sprint&&st==='play'){x.save();x.strokeStyle=`hsla(48,100%,60%,${.35+.25*Math.sin(time*8)})`;x.lineWidth=3;rr(x,FR.x-4,FR.y-4,FR.w+8,FR.h+8,12);x.stroke();x.restore()}
  if(performance.now()-DU.opp.jt<700&&DU.opp.j>=0){const J=['完美','極佳','良好','尚可','失誤'],C=[48,185,125,225,350];x.textAlign='right';x.fillStyle=`hsl(${C[DU.opp.j]},100%,72%)`;x.font='800 14px "Noto Sans TC",sans-serif';x.fillText('對手 '+J[DU.opp.j],FR.x+FR.w-12,FR.y+FR.h-12);x.textAlign='center'}
  if(DU.banner){const b=DU.banner,k=b.t/b.max;x.globalAlpha=Math.min(1,k*2.5);x.fillStyle=`hsl(${b.hue},100%,72%)`;x.font='800 '+Math.round(Math.min(34,FR.h*.11))+'px "Noto Sans TC",sans-serif';x.fillText(b.text,W/2,FR.y+FR.h*.3-(1-k)*14);x.globalAlpha=1}
}
function duelFinish(ok,rank,acc){
  DU.myFin={s:score,ok,acc,rank:ok?rank:'—',mc:maxCombo};dsend({t:'fin',...DU.myFin});
  $('#rk').textContent='線上對戰';$('#bAgain').disabled=true;
  duelResult();
}
function duelResult(){
  const me=DU.myFin;if(!me)return;const op=DU.oppFin,el=$('#rnew');
  if(!op&&!DU.left){el.innerHTML='<div class="sub">等待對手完成⋯</div>';
    // if the opponent's result never arrives, allow a rematch after a while (the server accepts it after 20 s)
    clearTimeout(DU.waitT);DU.waitT=setTimeout(()=>{if(DU.myFin===me&&!DU.oppFin&&DU.ws)$('#bAgain').disabled=false},22000);return}
  let res;if(!op)res='勝利（對手離線）';else if(me.ok!==op.ok)res=me.ok?'勝利！':'落敗';else res=me.s>op.s?'勝利！':me.s<op.s?'落敗':'平手';
  const col=res.startsWith('勝')?'#ffd36b':res==='平手'?'#7cf0ff':'#ff7a93';
  el.innerHTML='<div class="dres" style="color:'+col+'">'+res+'</div>'+(op?'<div class="sub">對手 '+esc(DU.oppName||'玩家')+'：'+dInt(op.s,0,1e8).toLocaleString()+' 分 · '+(op.ok?'評級 '+esc(op.rank):'出局')+' · 最高連擊 '+dInt(op.mc,0,1e5)+'</div>':'');
  $('#bAgain').disabled=!DU.ws;
  if(res.startsWith('勝'))vib([20,40,20,40,60]);
}
function duelAgain(){$('#end').classList.add('hidden');hudShow(false);st='menu';balls=[];mode='normal';dsend({t:'again'});$('#duel').classList.remove('hidden');duelView();duelRoomUI()}
$('#bDuel').onclick=duelOpen;
if(/WORKERS_SUBDOMAIN/.test(DUEL_URL))$('#bDuel').style.display='none';   // hidden until the duel server is deployed
$('#dX').onclick=()=>{if(DU.ws){duelLeave()}else{$('#duel').classList.add('hidden');showHome()}};
$('#dNew').onclick=duelCreate;
$('#dGo').onclick=()=>duelJoin($('#dCode').value);
$('#dCode').addEventListener('keydown',e=>{if(e.key==='Enter')duelJoin($('#dCode').value)});
$('#dLeave').onclick=duelLeave;
$('#dReady').onclick=()=>{initAudio();dsend({t:'ready',v:!DU.ready})};
$('#dSong').onchange=e=>{dsend({t:'cfg',song:+e.target.value,di:+$('#dDi').value})};
$('#dDi').onchange=e=>{dsend({t:'cfg',song:+$('#dSong').value,di:+e.target.value})};
$('#dShare').onclick=()=>{const u=location.origin+location.pathname+'?room='+DU.code,t='來 PingPongLight 跟我對戰！房號 '+DU.code;
  try{if(navigator.share){navigator.share({title:'PingPongLight 對戰邀請',text:t,url:u}).catch(()=>{});return}}catch(e){}
  try{navigator.clipboard.writeText(t+' '+u);dmsg('已複製邀請連結。')}catch(e){dmsg(u)}};
$('#bAgain').onclick=duelAgain;
$('#bLeave').onclick=duelLeave;
(function(){try{const r=new URLSearchParams(location.search).get('room');if(r){lsSet('ppl-tut','1');setTimeout(()=>{duelOpen();$('#dCode').value=r.toUpperCase().slice(0,4)},50)}}catch(e){}})();

/* ================= menu ================= */
const mmss=t=>{t=Math.round(t);return Math.floor(t/60)+':'+String(t%60).padStart(2,'0')};
function buildChips(){
  const d=$('#diffs');d.innerHTML='';
  DIFFS.forEach((df,i)=>{const b=document.createElement('button');b.className='chip'+(i===di?' sel':'');b.innerHTML=df.n+'<small>'+(df.nb===2?'雙球':'單球')+(df.spd>1?' · 速度×'+df.spd:'')+'</small>';b.onclick=()=>{di=i;lsSet('pmb6-di',String(i));buildChips()};d.appendChild(b)});
  const c=$('#chips');c.innerHTML='';
  SONGS.forEach((s,i)=>{
    const ul=unlocked(i),b=document.createElement('button');b.className='chip'+(i===si?' sel':'')+(ul?'':' lock');
    const rk=(r=>RANKS.includes(r)?r:'')(lsGet(KEY_RK(i,di)));
    b.innerHTML=(ul?'':'🔒 ')+(i+1)+'. '+s.name+'<small>'+s.year+' · '+s.composer+' · <span class="stars">'+starTxt(STARS[i])+'</span>'+(rk?' · '+rk:'')+'</small>';
    b.onclick=()=>{if(!ul)return;si=i;buildChips();initAudio();preloadSong(SONGS[i])};c.appendChild(b);
  });
}
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
  audioDiag();
  for(const[k,id]of[['mel','vMel'],['bk','vBk'],['fx','vFx']]){$('#'+id).value=SET[k];$('#'+id+'V').textContent=SET[k]}
  const tg2=(id,on)=>{const b=$('#'+id);b.textContent=on?'開啟':'關閉';b.classList.toggle('on',on)};tg2('tFx',SET.lowFx);tg2('tVib',SET.vib);tg2('tMl',SET.ml!==false);
  const ms=Math.round(latS()*1000);$('#calV').textContent=(ms>=0?'+':'')+ms+' ms'+(SET.lat==null?'（自動）':'');$('#calCur').textContent=(ms>=0?'+':'')+ms+' ms';
}
for(const[k,id]of[['mel','vMel'],['bk','vBk'],['fx','vFx']])$('#'+id).oninput=e=>{SET[k]=+e.target.value;applyVol();saveSet();syncSet()};
$('#tFx').onclick=()=>{SET.lowFx=!SET.lowFx;saveSet();syncSet()};
$('#tMl').onclick=()=>{SET.ml=SET.ml===false;saveSet();syncSet()};
$('#tVib').onclick=()=>{SET.vib=!SET.vib;saveSet();syncSet();vib(30)};
$('#bSet').onclick=()=>{initAudio();syncSet();$('#home').classList.add('hidden');$('#set').classList.remove('hidden')};
function closeSet(){$('#set').classList.add('hidden');showHome()}
$('#bSetX').onclick=closeSet;$('#bSetC').onclick=closeSet;
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
$('#calX').onclick=closeCal;$('#calC').onclick=closeCal;
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
  x.fillStyle='#8a93c0';x.font='400 26px '+F;x.fillText(location.host+'　'+new Date().toLocaleDateString('zh-TW'),70,560);
  x.textAlign='center';x.fillStyle=RANK_COL[r.rank];x.shadowColor=RANK_COL[r.rank];x.shadowBlur=40;x.font='800 300px '+F;x.fillText(r.rank,950,420);
  return c;
}
$('#bShare').onclick=()=>{
  const c=shareImg();if(!c)return;
  const text='我在 PingPongLight '+lastRes.label+' 拿到 '+lastRes.rank+'（'+lastRes.score.toLocaleString()+' 分）';
  c.toBlob(bl=>{
    if(!bl)return;
    try{const f=new File([bl],'pingponglight.png',{type:'image/png'});
      if(navigator.canShare&&navigator.canShare({files:[f]})){navigator.share({files:[f],title:'PingPongLight',text}).catch(()=>{});return}}catch(e){}
    const a=document.createElement('a');a.href=URL.createObjectURL(bl);a.download='pingponglight.png';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(a.href),5000);
  },'image/png');
};
$('#bHow').onclick=()=>{const h=$('#how');h.hidden=!h.hidden};
$('#bGo').onclick=()=>{if(!unlocked(si))return;initAudio();goFs();mode='normal';startRun(0)};
$('#bBack').onclick=showHome;
$('#bNext').onclick=()=>{initAudio();if(mode==='tut'){mode='normal';si=0;startRun(0)}else if(si+1<SONGS.length&&unlocked(si+1)){si++;startRun(0)}};
$('#bRetry').onclick=()=>{initAudio();startRun(0)};
$('#bCont').onclick=()=>{initAudio();startRun(cp.ti)};
$('#bSel').onclick=showSelect;
$('#bTest').onclick=()=>{initAudio(true);[60,64,67,72].forEach((p,i)=>voice(p,i*.14,.6,.3,0,true));voice(48,0,1.2,.17,0,false);setTimeout(()=>{audioStatus();audioDiag()},250);setTimeout(()=>{audioStatus();audioDiag()},900)};
$('#bFs').onclick=toggleFs;
addEventListener('resize',layout);
if(window.visualViewport)visualViewport.addEventListener('resize',layout);
document.addEventListener('fullscreenchange',()=>setTimeout(layout,100));
document.addEventListener('webkitfullscreenchange',()=>setTimeout(layout,100));
addEventListener('orientationchange',()=>setTimeout(layout,200));
if(!unlocked(si))si=0;
for(const f of[layout,buildChips,hud,audioStatus]){try{f()}catch(e){showErr(e)}}   // one failing step must not stop start-up
if('serviceWorker' in navigator&&location.protocol==='https:')addEventListener('load',()=>navigator.serviceWorker.register('sw.js').catch(()=>{}));hudShow(false);$('#fsHint').style.display=(!(DE.requestFullscreen||DE.webkitRequestFullscreen)&&!standalone)?'block':'none';
requestAnimationFrame(frame);
window.__pb={get S(){const Gn=st==='play'?G():0;return{st,resolved,n:tg.length,score,combo,balls:balls.map(b=>({x:b.x,y:b.y,v:b.v,ti:b.ti,win:b.win?b.win.edge:-1,depth:b.win?b.win.depth:-1e9,dtT:b.ti>=0?tT(b.ti)-Gn:9,lead:LEAD(b.v)})),F:FR,HR:HRe(),tiers:tierCount,cents:lastCents,p:lastP,pSrc,cp:cp.ti,G:Gn,useAC,life,mode,paused,resumeCD,lat:latS(),D:D&&D.n}},setTs(v){ts=v},setSong(i){si=i},tg:()=>tg.map(t=>t.t),pause:pauseGame,resume:resumeGame,shareImg,STARS,il:()=>instLoad,gaps:()=>{const r=[];for(const it of items)for(const o of bumps)r.push(Math.hypot(it.x-o.x,it.y-o.y)-itemGap(o.Rm));return r}};
})();
