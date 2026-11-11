const cv=document.getElementById('c'),cx=cv.getContext('2d');
const W=3200,H=1500;   // world size; the view starts showing all of it
let sd=11;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;
// background: milky way band + field stars
const field=[];for(let i=0;i<2600;i++){const band=rnd()<.55;let x=rnd()*W,y;
  if(band){const t=x/W;y=H*(.78-.5*t)+(rnd()+rnd()+rnd()-1.5)*170}else y=rnd()*H;
  const m=Math.pow(rnd(),3.2);field.push({x,y,r:.3+m*1.0,a:.2+m*.5,h:rnd()<.15?'#ffd9b0':rnd()<.25?'#b9ccff':'#ffffff',tw:rnd()*6.28})}
const neb=[];for(let i=0;i<70;i++){const x=rnd()*W,y=H*(.78-.5*x/W)+(rnd()-.5)*260;neb.push({x,y,r:120+rnd()*260,c:rnd()<.5?'90,110,200':'150,90,170',a:.025+rnd()*.035})}
// constellations: each one copies the bright-star pattern of a real constellation ([RA hours, Dec degrees, magnitude]).
// No lines are drawn: the pattern stars are simply brighter than the background, so players see the shape themselves.
// Songs go to the stars brightest first, so the first song of a constellation is its brightest star.
const SHAPE={
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
// the Pleiades: a little cluster drawn next to Alcyone in the bull (decoration, not songs)
const DEF=[['古老旋律座','lyra',[330,330]],['巴洛克座','orion',[780,300]],['古典座','uma',[1240,300]],['浪漫座','sco',[1720,300]],['鋼琴詩人座','leo',[2200,320]],
  ['歌劇座','gem',[2700,330]],['芭蕾座','cyg',[400,800]],['管弦樂座','sgr',[900,780]],['進行曲座','cma',[1380,800]],['圓舞曲座','cas',[1840,770]],
  ['聖誕座','tau',[2290,800]],['聖詩座','cru',[2760,790]],['童謠座','boo',[480,1210]],['世界民謠座','peg',[1120,1220]],['亞洲座','aql',[1770,1230]],['霓虹座','del',[2470,1230]]];
const LIT=[[0,[1,2,3,4,5,6]],[1,[1,2,3]],[2,[1,2,4]],[3,[1,3]],[5,[2]],[7,[1,2]],[10,[1,2,3,4]],[12,[1,2,3]],[13,[2,5]]];
const NAMES=['綠袖子','小星星','驪歌','奇異恩典','平安夜','聖誕鈴聲','卡農','G弦之歌','哈利路亞','土耳其進行曲','月光奏鳴曲','給愛麗絲','歡樂頌','夜曲','藍色多瑙河','天鵝湖','花之圓舞曲','鬥牛士之歌','女人善變','櫻花','阿里郎','倫敦鐵橋','兩隻老虎','雨滴前奏曲','快樂的農夫','楓葉拉格','天鵝'];
const CONS=DEF.map(([name,sh,[x0,y0]],k)=>{
  let S=SHAPE[sh].map(a=>a.slice());const ras=S.map(a=>a[0]);if(Math.max(...ras)-Math.min(...ras)>12)S.forEach(a=>{if(a[0]<12)a[0]+=24});
  const d0=S.reduce((t,a)=>t+a[1],0)/S.length,r0=S.reduce((t,a)=>t+a[0],0)/S.length,cd=Math.cos(d0*Math.PI/180);
  // sky-chart orientation: north up, east to the left
  let Q=S.map(([ra,de,m])=>({x:-(ra-r0)*15*cd,y:-(de-d0),m}));
  const n=Q.length,R=Math.sqrt(n)*46,ext=Math.max(...Q.map(q=>Math.max(Math.abs(q.x)/1.25,Math.abs(q.y)/.85))),f=R/ext;
  const P=Q.map(q=>({x:x0+q.x*f,y:y0+q.y*f,m:q.m}));
  // nudge very close pairs apart a little so each star can be tapped and labelled; the shape stays the same
  for(let it=0;it<40;it++)for(const p of P)for(const q of P){if(p===q)continue;const dx=q.x-p.x,dy=q.y-p.y,d=Math.hypot(dx,dy)||1;if(d<28){const u=(28-d)/2/d;p.x-=dx*u;p.y-=dy*u;q.x+=dx*u;q.y+=dy*u}}
  P.forEach(p=>{p.nn=Math.min(...P.filter(q=>q!==p).map(q=>Math.hypot(q.x-p.x,q.y-p.y)))});
  const lit=(LIT.find(l=>l[0]===k)||[0,[]])[1];
  P.forEach((p,j)=>{p.lit=lit.includes(j+1)||k===0;p.d=p.lit?[0,1,2,1,2,0][(j+k)%6]:-1;p.rank=p.lit?(j*7+k)%5:0;p.name=NAMES[(k*5+j)%NAMES.length];
    p.mag=Math.max(.4,Math.min(2.3,1+(2.6-p.m)*.5))});   // apparent size from the real magnitude
  const deco=[];if(sh==='tau'){const a=P[2];for(const [dx,dy] of [[-7,-5],[6,-7],[9,3],[-4,7],[2,-11],[-10,2]])deco.push({x:a.x+dx,y:a.y+dy})}
  const bx=[Math.min(...P.map(p=>p.x)),Math.max(...P.map(p=>p.x))],by=[Math.min(...P.map(p=>p.y)),Math.max(...P.map(p=>p.y))];
  return{name,P,deco,done:P.every(p=>p.lit),x:(bx[0]+bx[1])/2,y:(by[0]+by[1])/2,top:by[0],bw:bx[1]-bx[0],bh:by[1]-by[0],R};
});
const COL=['#cfe6ff','#7cf0ff','#ffd36b'];
// view
let vw=0,vh=0,dpr=1,s=1,ox=0,oy=0,minS=1;
function fit(){dpr=Math.min(2,window.devicePixelRatio||1);vw=innerWidth;vh=innerHeight;cv.width=vw*dpr;cv.height=vh*dpr;minS=Math.min(vw/W,(vh-70)/H);if(s<minS||!ox){s=minS;ox=(vw-W*s)/2;oy=(vh-H*s)/2+18}}
addEventListener('resize',()=>{fit();draw()});
const clampV=()=>{s=Math.max(minS,Math.min(minS*10,s));const mx=Math.max(0,(vw-W*s)/2),my=Math.max(0,(vh-H*s)/2);ox=Math.min(mx+(W*s<vw?0:0),Math.max(vw-W*s-mx,ox));oy=Math.min(my+20,Math.max(vh-H*s-my-10,oy))};
function zoomAt(f,px,py){const ns=Math.max(minS,Math.min(minS*10,s*f));ox=px-(px-ox)*ns/s;oy=py-(py-oy)*ns/s;s=ns;clampV()}
let anim=null;function flyTo(x,y,ns){const s0=s,ox0=ox,oy0=oy,ox1=vw/2-x*ns,oy1=vh/2-y*ns,t0=performance.now();anim=t=>{const k=Math.min(1,(t-t0)/450),e=1-Math.pow(1-k,3);s=s0+(ns-s0)*e;ox=ox0+(ox1-ox0)*e;oy=oy0+(oy1-oy0)*e;if(k>=1)anim=null}}
function draw(t=0){
  cx.setTransform(dpr,0,0,dpr,0,0);
  const g=cx.createLinearGradient(0,0,0,vh);g.addColorStop(0,'#070a1f');g.addColorStop(.6,'#04061a');g.addColorStop(1,'#020309');cx.fillStyle=g;cx.fillRect(0,0,vw,vh);
  cx.save();cx.translate(ox,oy);cx.scale(s,s);
  for(const n of neb){const rg=cx.createRadialGradient(n.x,n.y,0,n.x,n.y,n.r);rg.addColorStop(0,'rgba('+n.c+','+n.a+')');rg.addColorStop(1,'rgba('+n.c+',0)');cx.fillStyle=rg;cx.fillRect(n.x-n.r,n.y-n.r,n.r*2,n.r*2)}
  for(const f of field){const a=f.a*(.75+.25*Math.sin(t/900+f.tw));cx.globalAlpha=a;cx.fillStyle=f.h;cx.beginPath();cx.arc(f.x,f.y,f.r/Math.sqrt(s/minS),0,6.28);cx.fill()}
  cx.globalAlpha=1;
  const zl=s/minS;   // 1 = whole sky
  for(const C of CONS){
    const k=Math.pow(zl,.3)/s;   // star sizes are in screen pixels and grow only a little when zooming, like a real sky
    for(const d of C.deco){cx.fillStyle='rgba(200,215,255,.6)';cx.beginPath();cx.arc(d.x,d.y,1.1*k,0,6.28);cx.fill()}
    for(const p of C.P){
      const tw=.9+.1*Math.sin(t/700+p.x);
      if(p.lit){const r=(.9+p.mag*1.2+p.rank*.3)*k*tw,c=COL[p.d];const rg=cx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*4.5);rg.addColorStop(0,c);rg.addColorStop(.22,c+'99');rg.addColorStop(1,c+'00');
        cx.fillStyle=rg;cx.beginPath();cx.arc(p.x,p.y,r*4.5,0,6.28);cx.fill();cx.fillStyle='#fff';cx.beginPath();cx.arc(p.x,p.y,r*.5,0,6.28);cx.fill();
        if(p.rank===4){cx.strokeStyle=c+'aa';cx.lineWidth=.8/s;cx.beginPath();cx.moveTo(p.x-r*4,p.y);cx.lineTo(p.x+r*4,p.y);cx.moveTo(p.x,p.y-r*4);cx.lineTo(p.x,p.y+r*4);cx.stroke()}}
      else{   // not cleared yet: a plain white star, still clearly brighter than the background so the shape reads
        const r=(.45+p.mag*.95)*k*tw,rg=cx.createRadialGradient(p.x,p.y,0,p.x,p.y,r*3.2);rg.addColorStop(0,'rgba(225,232,255,.35)');rg.addColorStop(1,'rgba(200,215,255,0)');
        cx.fillStyle=rg;cx.beginPath();cx.arc(p.x,p.y,r*3.2,0,6.28);cx.fill();cx.fillStyle='rgba(248,250,255,.95)';cx.beginPath();cx.arc(p.x,p.y,r*.75,0,6.28);cx.fill()}
      const la=Math.max(0,Math.min(1,(p.nn*s-40)/12));if(la>0){cx.globalAlpha=la;cx.font=(11/s)+'px system-ui';cx.textAlign='center';cx.fillStyle=p.lit?'rgba(220,228,255,.92)':'rgba(130,140,190,.7)';cx.fillText(p.name,p.x,p.y+18/s);cx.globalAlpha=1}
    }
    const fs=Math.max(15/s,Math.min(30,26/Math.sqrt(zl)));cx.font='600 '+fs+'px system-ui';cx.textAlign='center';
    cx.fillStyle=C.done?'rgba(255,211,107,.95)':'rgba(200,208,245,'+(62*s>44?.55:.9)+')';cx.fillText(C.name.split('').join(' '),C.x,C.top-fs*1.1);
    if(62*s<=44){const lit=C.P.filter(p=>p.lit).length;cx.font=(fs*.62)+'px system-ui';cx.fillStyle='rgba(140,150,200,.8)';cx.fillText(lit+' / '+C.P.length,C.x,C.top-fs*.25)}
  }
  cx.restore();
}
function loop(t){if(anim)anim(t);draw(t);requestAnimationFrame(loop)}
fit();requestAnimationFrame(loop);
// gestures: one finger pans, two fingers pinch-zoom around their midpoint, wheel zooms, tap a constellation name to fly there
const pts=new Map();let last=null,moved=0;
cv.addEventListener('pointerdown',e=>{cv.setPointerCapture(e.pointerId);pts.set(e.pointerId,[e.clientX,e.clientY]);moved=0;anim=null});
cv.addEventListener('pointermove',e=>{if(!pts.has(e.pointerId))return;const prev=pts.get(e.pointerId);pts.set(e.pointerId,[e.clientX,e.clientY]);
  if(pts.size===1){ox+=e.clientX-prev[0];oy+=e.clientY-prev[1];moved+=Math.abs(e.clientX-prev[0])+Math.abs(e.clientY-prev[1]);clampV()}
  else if(pts.size===2){const [a,b]=[...pts.values()],d=Math.hypot(a[0]-b[0],a[1]-b[1]),m=[(a[0]+b[0])/2,(a[1]+b[1])/2];if(last){zoomAt(d/last.d,m[0],m[1]);ox+=m[0]-last.m[0];oy+=m[1]-last.m[1];clampV()}last={d,m};moved=99}});
const up=e=>{if(pts.size===1&&moved<8){const wx=(e.clientX-ox)/s,wy=(e.clientY-oy)/s;const C=CONS.find(c=>Math.hypot(c.x-wx,c.y-wy)<c.R*1.1);if(C){const ns=Math.min(minS*10,Math.min(vw*.8/(C.bw+60),(vh-110)/(C.bh+60)));flyTo(C.x,C.y-14/ns,ns)}}pts.delete(e.pointerId);if(pts.size<2)last=null};
cv.addEventListener('pointerup',up);cv.addEventListener('pointercancel',up);
cv.addEventListener('wheel',e=>{e.preventDefault();zoomAt(Math.exp(-e.deltaY*.0015),e.clientX,e.clientY)},{passive:false});
document.getElementById('zi').onclick=()=>zoomAt(1.6,vw/2,vh/2);document.getElementById('zo').onclick=()=>zoomAt(1/1.6,vw/2,vh/2);
window.__fly=i=>{const C=CONS[i];const ns=Math.min(minS*10,Math.min(vw*.8/(C.bw+60),(vh-110)/(C.bh+60)));s=ns;ox=vw/2-C.x*ns;oy=vh/2-C.y*ns};
