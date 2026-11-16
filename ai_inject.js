(function(){const RL={},RLC={},ROWS_ALL={},TAU=Math.PI*2;
// ===== AI-painted static base + code motion =====
// Each background is one WebP (ai_<id>.webp). Motion layers that must line up with the painting are derived FROM the painting in stat:
//  - glow: bright/warm pixels of the image, blurred (downsample->upsample, no ctx.filter), added back with 'lighter' and a slow breath
//  - twinkle: the brightest small points in a region become faint twinkling stars
//  - anchor: brightest pixel matching a colour test inside a region (e.g. the volcano crater) -> origin for embers
const AIM={},AIIMG={};
function aiImg(id){if(AIIMG[id])return AIIMG[id];const im=new Image();im.onload=()=>{delete RLC['ai_'+id];delete RLC['ai2_'+id];if(typeof views!=='undefined'){views.forEach(v=>{if(v.id===id){v.at=-1e9;v.painted=false}});requestAnimationFrame(frame)}};im.src='ai_'+id+'.webp';return AIIMG[id]=im}
const aiSm=(a,b,v)=>{const t=Math.max(0,Math.min(1,(v-a)/(b-a)));return t*t*(3-2*t)};
function aiPixels(im,sw,sh){const c=document.createElement('canvas');c.width=sw;c.height=sh;const q=c.getContext('2d');q.drawImage(im,0,0,sw,sh);return q.getImageData(0,0,sw,sh)}
function aiGlow(L,im,w,h,o){ // o.glow: {thr, test(r,g,b)->0..1, region:[x0,y0,x1,y1] fractions, gain}
 const G=o.glow,sw=200,sh=Math.round(sw*h/w),id=aiPixels(im,sw,sh),d=id.data,[rx0,ry0,rx1,ry1]=G.region||[0,0,1,1];
 for(let y=0;y<sh;y++)for(let x=0;x<sw;x++){const p=(y*sw+x)*4,r=d[p],g=d[p+1],b=d[p+2],u=x/sw,v=y/sh,l=(.3*r+.59*g+.11*b)/255;
  let m=aiSm(G.thr,G.thr+.25,l)*(G.test?G.test(r,g,b):1);if(u<rx0||u>rx1||v<ry0||v>ry1)m=0;d[p+3]=255*Math.min(1,m*(G.gain||1))}
 const a=document.createElement('canvas');a.width=sw;a.height=sh;a.getContext('2d').putImageData(id,0,0);
 // blur by stepping down twice and back up (smooth scaling)
 const b=document.createElement('canvas');b.width=sw/4|0;b.height=sh/4|0;const bq=b.getContext('2d');bq.imageSmoothingQuality='high';bq.drawImage(a,0,0,b.width,b.height);
 const gq=L.g.getContext('2d');gq.save();gq.setTransform(1,0,0,1,0,0);gq.globalCompositeOperation='lighter';gq.imageSmoothingQuality='high';gq.globalAlpha=.7;gq.drawImage(b,0,0,L.g.width,L.g.height);gq.globalAlpha=.5;gq.drawImage(a,0,0,L.g.width,L.g.height);gq.restore()}
function aiPoints(im,w,h,o){ // brightest local maxima inside a region -> [[x,y,brightness]] in units
 const T=o.twinkle,sw=400,sh=Math.round(sw*h/w),d=aiPixels(im,sw,sh).data,[rx0,ry0,rx1,ry1]=T.region||[0,0,1,1],P=[];
 const L=(x,y)=>{const p=(y*sw+x)*4;return .3*d[p]+.59*d[p+1]+.11*d[p+2]};
 for(let y=1;y<sh-1;y++)for(let x=1;x<sw-1;x++){const u=x/sw,v=y/sh;if(u<rx0||u>rx1||v<ry0||v>ry1)continue;const c=L(x,y);if(c<T.min)continue;
  let mx=true;for(let j=-1;j<=1&&mx;j++)for(let i=-1;i<=1;i++)if((i||j)&&L(x+i,y+j)>c){mx=false;break}
  if(mx&&c-(L(x-1,y)+L(x+1,y)+L(x,y-1)+L(x,y+1))/4>T.peak)P.push([u*w,v*h,c/255])}
 P.sort((a,b)=>b[2]-a[2]);return P.slice(0,T.n||40)}
function aiAnchor(im,w,h,A){const sw=300,sh=Math.round(sw*h/w),d=aiPixels(im,sw,sh).data,[rx0,ry0,rx1,ry1]=A.region;let best=-1,bx=w/2,by=h/2;
 for(let y=Math.floor(ry0*sh);y<ry1*sh;y++)for(let x=Math.floor(rx0*sw);x<rx1*sw;x++){const p=(y*sw+x)*4,s=A.score(d[p],d[p+1],d[p+2]);if(s>best){best=s;bx=x/sw*w;by=y/sh*h}}return[bx,by]}
// ---- particle painters (all batched, tiny, dim, slow) ----
const AIP={
 twinkle(x,w,h,t,L,o){if(!L.tw)return;x.save();x.globalCompositeOperation='lighter';for(let i=0;i<L.tw.length;i++){const[px,py,b]=L.tw[i],k=.5+.5*Math.sin(t*(.6+(i%5)*.17)+i*2.3);x.fillStyle=`rgba(255,250,235,${(o.twA||.3)*k*b})`;x.fillRect(px-.45,py-.45,.9,.9)}x.restore()},
 snow(x,w,h,t){const T=t*.5;x.fillStyle='rgba(235,244,255,.3)';x.beginPath();for(let i=0;i<26;i++){const px=(i*47+Math.sin(T*.6+i)*7+T*3)%w,py=(i*31+T*(5+i%3*2.5))%h;x.rect(px,py,.7,.7)}x.fill();
  x.fillStyle='rgba(235,244,255,.5)';x.beginPath();for(let i=0;i<9;i++){const px=(i*83+Math.sin(T*.5+i*2)*9+T*4)%w,py=(i*53+T*13)%h;x.rect(px,py,1,1)}x.fill()},
 petals(x,w,h,t){const T=t*.5;for(let i=0;i<14;i++){const f=(T*(.035+(i%4)*.008)+i*.137)%1,px=((i*61+T*(5+i%3))%(w+40))-20+Math.sin(T*.8+i)*8,py=f*(h+20)-10,a=T*(.9+i%3*.4)+i,s=1.3+(i%3)*.45,fl=Math.abs(Math.cos(a));
  x.fillStyle=`rgba(${i%3?'255,190,215':'240,160,195'},${.45*(.4+.6*fl)})`;x.beginPath();x.ellipse(px,py,s,s*.45*(.3+.7*fl),a*.6,0,TAU);x.fill()}},
 embers(x,w,h,t,L){if(!L.anc)return;const[ax,ay]=L.anc,T=t*.6;x.save();x.globalCompositeOperation='lighter';x.fillStyle='rgba(255,150,60,.5)';x.beginPath();
  for(let i=0;i<16;i++){const f=(T*(.07+(i%4)*.015)+i/16)%1,px=ax+(i%7-3)*1.6+Math.sin(f*6+i)*4+f*f*18,py=ay-2-f*h*.28;x.globalAlpha=1;x.rect(px,py,.7*(1-f)+.2,.7*(1-f)+.2)}x.fill();x.restore()},
 marine(x,w,h,t){const T=t*.55;x.fillStyle='rgba(190,235,240,.22)';x.beginPath();for(let i=0;i<36;i++){const px=(i*59+Math.sin(T*.4+i)*6+T*2)%w,py=(i*43+T*(1.5+i%3))%h;x.rect(px,py,.7,.7)}x.fill();
  // a dim school of small dark fish drifting across mid-water
  x.fillStyle='rgba(10,40,60,.45)';x.beginPath();{const cx=((T*11+10)%(w+240))-70,cy=h*.42;for(let i=0;i<16;i++){const u=i/16,fx=cx-u*64+Math.sin(i*2.3)*5,fy=cy+Math.sin(u*6+T*1.4)*7+((i*7)%5-2)*3;x.moveTo(fx+2.4,fy);x.quadraticCurveTo(fx,fy-1.2,fx-2,fy);x.quadraticCurveTo(fx,fy+1.2,fx+2.4,fy);x.moveTo(fx-1.8,fy);x.lineTo(fx-3.8,fy-1.2);x.lineTo(fx-3.8,fy+1.2)}}x.fill()},
 meteor(x,w,h,t){const P=26,ph=(t%P)/P;if(ph>.06)return;const f=ph/.06,k=Math.floor(t/P),sx=w*(.2+((k*37)%50)/100),sy=h*(.05+((k*13)%10)/100),ex=sx+f*60,ey=sy+f*22;
  const g=x.createLinearGradient(ex-26,ey-9.5,ex,ey);g.addColorStop(0,'rgba(220,235,255,0)');g.addColorStop(1,`rgba(220,235,255,${.35*Math.sin(Math.PI*f)})`);x.strokeStyle=g;x.lineWidth=.6;x.beginPath();x.moveTo(ex-26,ey-9.5);x.lineTo(ex,ey);x.stroke()},
 mist(x,w,h,t,L){if(!L.mist){const c=document.createElement('canvas');c.width=128;c.height=32;const q=c.getContext('2d'),g=q.createRadialGradient(64,16,0,64,16,64);g.addColorStop(0,'rgba(210,210,200,.5)');g.addColorStop(1,'rgba(210,210,200,0)');q.fillStyle=g;q.save();q.scale(1,.25);q.fillRect(0,0,128,128);q.restore();L.mist=c}
  for(let i=0;i<4;i++){const px=((t*(1.6+i*.5)+i*120)%(w+180))-90,py=h*(.5+i*.09);x.globalAlpha=.16;x.drawImage(L.mist,px-90,py-10,180,20)}x.globalAlpha=1},
 sweep(x,w,h,t){const P=9,ph=(t%P)/P;if(ph>.35)return;const p=-60+ph/.35*(w+120);x.save();x.globalCompositeOperation='lighter';const g=x.createLinearGradient(p-46,0,p+46,0);g.addColorStop(0,'rgba(255,220,140,0)');g.addColorStop(.5,'rgba(255,225,150,.07)');g.addColorStop(1,'rgba(255,220,140,0)');x.fillStyle=g;x.setTransform(x.getTransform().multiply(new DOMMatrix([1,0,-.35,1,0,0])));x.fillRect(p-46,0,92,h);x.restore()},
};
function aiDef(id,o){aiImg(id);AIM[id]=o;
 RL['ai_'+id]={
  stat(x,w,h,L,g){const im=AIIMG[id];if(!im.complete||!im.naturalWidth){x.fillStyle='#0b1022';x.fillRect(0,0,w,h);return}
   x.drawImage(im,0,0,w,h);
   // tone match: AI paintings come out darker/lighter than the code versions, which were tuned for the 55% court overlay
   if(o.lift){x.save();x.globalCompositeOperation='screen';x.globalAlpha=o.lift;x.drawImage(im,0,0,w,h);x.restore()}
   if(o.shade){x.save();x.globalCompositeOperation='multiply';x.globalAlpha=o.shade[1];x.fillStyle=o.shade[0];x.fillRect(0,0,w,h);x.restore()}
   if(o.glow)aiGlow(L,im,w,h,o);if(o.twinkle)L.tw=aiPoints(im,w,h,o);if(o.anchor)L.anc=aiAnchor(im,w,h,o.anchor);if(o.stat)o.stat(x,w,h,L,g)},
  dyn(x,w,h,t,L){if(o.glow){const b=o.breath||[.8,.15,.6];x.save();x.globalCompositeOperation='lighter';x.globalAlpha=Math.max(0,b[0]+b[1]*Math.sin(t*b[2])+b[1]*.4*Math.sin(t*b[2]*2.7+1));
    if(o.drift){x.drawImage(L.g,Math.sin(t*.23)*o.drift,0,w,h)}else x.drawImage(L.g,0,0,w,h);x.restore()}
   for(const p of o.fx||[])AIP[p](x,w,h,t,L,o);if(o.dyn)o.dyn(x,w,h,t,L)}};
 ROWS_ALL['ai_'+id]=[id,'buy',o.notes||[]]}
const warm=(r,g,b)=>aiSm(10,70,r-b),green=(r,g,b)=>aiSm(5,50,g-r)*aiSm(-10,30,g-b+20),pinkish=(r,g,b)=>aiSm(0,40,r-g);

// ===== AI base + stronger code motion (aurora, sea) =====
// Idea: split the painting per pixel into "base" + "moving layer" (base = p*(1-k*m), layer = p*k*m, so base+layer = original).
// The moving layer is then redrawn every frame with a small warp (sampled from shifted source positions, so no gaps/overlaps).
function aiFull(im){const c=document.createElement('canvas');c.width=im.naturalWidth;c.height=im.naturalHeight;const q=c.getContext('2d');q.drawImage(im,0,0);return q.getImageData(0,0,c.width,c.height)}
function aiCanvas(w,h){const c=document.createElement('canvas');c.width=w;c.height=h;return c}
const aiLift=(v,k)=>v+k*(v-v*v/255); // same as drawing the image over itself with 'screen' at alpha k
function aiMoveDef(id,o){aiImg(id);
 RL['ai2_'+id]={
  stat(x,w,h,L){const im=AIIMG[id];if(!im.complete||!im.naturalWidth){x.fillStyle='#0b1022';x.fillRect(0,0,w,h);return}
   const D=aiFull(im),W0=D.width,H0=D.height,d=D.data;
   for(let i=0;i<d.length;i+=4){d[i]=aiLift(d[i],o.lift);d[i+1]=aiLift(d[i+1],o.lift);d[i+2]=aiLift(d[i+2],o.lift)}
   L.W0=W0;L.H0=H0;o.split(L,D,W0,H0);
   const b=aiCanvas(W0,H0);b.getContext('2d').putImageData(D,0,0);L.base=b;x.drawImage(b,0,0,w,h);
   if(o.twinkle)L.tw=aiPoints(im,w,h,o);if(o.stat)o.stat(x,w,h,L)},
  dyn(x,w,h,t,L){if(!L.base)return;o.dyn(x,w,h,t,L);for(const p of o.fx||[])AIP[p](x,w,h,t,L,o)}};
 ROWS_ALL['ai2_'+id]=[id,'buy',o.notes||[]]}
// cut a layer out of D: m(r,g,b,u,v)->0..1 ; rows y0..y1 ; returns canvas (W0 x (y1-y0)) and darkens D by the same amount
function aiCut(D,W0,y0,y1,k,m,fill){const d=D.data,c=aiCanvas(W0,y1-y0),q=c.getContext('2d'),O=q.createImageData(W0,y1-y0),e=O.data;
 for(let y=y0;y<y1;y++){const F=fill?fill(y):null;for(let x=0;x<W0;x++){const p=(y*W0+x)*4,r=d[p],g=d[p+1],b=d[p+2],a=Math.min(1,k*m(r,g,b,x/W0,y/D.height));if(a<=0)continue;
  const s=((y-y0)*W0+x)*4;
  if(F){ // opaque layer (kelp): layer = pixel with alpha a ; base pixel = mix toward local water colour
   e[s]=r;e[s+1]=g;e[s+2]=b;e[s+3]=255*a;d[p]=r*(1-a)+F[0]*a;d[p+1]=g*(1-a)+F[1]*a;d[p+2]=b*(1-a)+F[2]*a}
  else{e[s]=r*a;e[s+1]=g*a;e[s+2]=b*a;e[s+3]=255;d[p]=r*(1-a);d[p+1]=g*(1-a);d[p+2]=b*(1-a)}}}
 q.putImageData(O,0,0);return c}
// ---------- aurora ----------
aiMoveDef('aurora',{lift:.3,twinkle:{region:[0,0,1,.4],min:150,peak:30,n:30},fx:['twinkle'],
 split(L,D,W0,H0){
  const aur=(r,g,b)=>{const gm=aiSm(5,55,g-b+15)*aiSm(0,40,g-r),pm=aiSm(15,70,r-g)*aiSm(0,40,b-g);return Math.max(gm,pm)*aiSm(45,110,Math.max(r,g,b))};
  L.ys=Math.round(H0*.58);L.A=aiCut(D,W0,0,L.ys,.6,(r,g,b,u,v)=>aur(r,g,b)*(1-aiSm(.44,.58,v)));
  L.yl=Math.round(H0*.70);L.R=aiCut(D,W0,L.yl,H0,.7,(r,g,b,u,v)=>aur(r,g,b)*aiSm(.70,.77,v))},
 dyn(x,w,h,t,L){const{W0,H0,ys,yl}=L;
  // strips go into an offscreen canvas at integer pixels (no overlaps -> no bright seams), then that is added once with 'lighter'
  if(!L.OA){L.OA=aiCanvas(W0>>1,ys>>1);L.OR=aiCanvas(W0>>1,(H0-yl)>>1)}
  const A=L.OA,q=A.getContext('2d'),AW=A.width,AH=A.height,N=AW/6|0,pw=AW/N;q.clearRect(0,0,AW,AH);
  for(let i=0;i<N;i++){const u=(i+.5)/N,off=1.1*Math.sin(u*9+t*.35)+.6*Math.sin(u*23-t*.6)+.25*Math.sin(u*47+t*1.1),
    st=1+.022*(.5+.5*Math.sin(u*11-t*.4)),a=.82+.18*Math.sin(u*7-t*.45)+.06*Math.sin(u*31+t*1.3),
    sx=Math.max(0,Math.min(W0-W0/N,(u-.5/N)*W0-off*W0/w)),d0=Math.round(i*pw),d1=Math.round((i+1)*pw);
   q.globalAlpha=Math.min(1,a);q.drawImage(L.A,sx,0,W0/N,ys/st,d0,0,d1-d0,AH)}
  x.save();x.globalCompositeOperation='lighter';x.drawImage(A,0,0,w,ys/H0*h);
  // lake reflection: rows ripple sideways, brightness follows the sky's average pulse
  const R=L.OR,r=R.getContext('2d'),RH=R.height,M=RH/2|0;r.clearRect(0,0,R.width,RH);
  for(let j=0;j<M;j++){const v=(j+.5)/M,dx=((.5+1.1*v)*Math.sin(v*38-t*1.2)+.4*Math.sin(v*90+t*2))*R.width/w,y0=Math.round(j*RH/M),y1=Math.round((j+1)*RH/M);
   r.drawImage(L.R,0,j*(H0-yl)/M,W0,(H0-yl)/M,dx,y0,R.width,y1-y0)}
  x.globalAlpha=Math.min(1,.85+.12*Math.sin(t*.45)+.05*Math.sin(t*1.3));x.drawImage(R,0,h*yl/H0,w,(H0-yl)/H0*h);
  x.restore()},
 notes:['極光從畫裡分出來單獨重畫：光幕左右擺動、下緣微微伸縮，一道較亮的光沿光幕慢慢流過。','湖面倒影跟著明暗起伏，並有水波左右晃動；少量星點閃爍。']});
// ---------- sea ----------
aiMoveDef('sea',{lift:.5,fx:['marine'],
 split(L,D,W0,H0){const d=D.data;
  const kelpM=(r,g,b,u,v)=>{const reg=(u<.14&&v<.47)||(u>.91&&v<.37);return reg?aiSm(0,28,g-b)*aiSm(-28,-2,g-r)*aiSm(40,80,g):0};
  // local water colour per row for filling behind kelp (average of non-kelp pixels in the kelp columns)
  const fillRow=y=>{let R=0,G=0,B=0,n=0;for(let x=0;x<W0;x+=3){const u=x/W0;if(u>.18&&u<.88)continue;const p=(y*W0+x)*4;if(kelpM(d[p],d[p+1],d[p+2],u,y/H0)>.02)continue;R+=d[p];G+=d[p+1];B+=d[p+2];n++}return n?[R/n,G/n,B/n]:[20,50,90]};
  L.yk=Math.round(H0*.47);L.K=aiCut(D,W0,0,L.yk,1.6,kelpM,fillRow);
  // light shafts (bright bluish streaks in the upper water, below the surface band)
  L.yS=Math.round(H0*.55);L.S=aiCut(D,W0,0,L.yS,.85,(r,g,b,u,v)=>aiSm(70,150,.3*r+.59*g+.11*b)*aiSm(0,40,b-r)*aiSm(.06,.13,v)*(1-aiSm(.38,.55,v)));
  L.ysf=Math.round(H0*.11);
  // tileable caustic texture: Voronoi F2-F1 -> thin bright web
  const S=160,P=[];let sd=7;const rnd=()=>(sd=(sd*16807)%2147483647)/2147483647;for(let i=0;i<34;i++)P.push([rnd()*S,rnd()*S]);
  const c=aiCanvas(S,S),q=c.getContext('2d'),I=q.createImageData(S,S),e=I.data;
  for(let y=0;y<S;y++)for(let x=0;x<S;x++){let f1=1e9,f2=1e9;for(const[px,py]of P)for(let oy=-S;oy<=S;oy+=S)for(let ox=-S;ox<=S;ox+=S){const dd=(x-px-ox)**2+(y-py-oy)**2;if(dd<f1){f2=f1;f1=dd}else if(dd<f2)f2=dd}
   const v=1-aiSm(0,3.2,Math.sqrt(f2)-Math.sqrt(f1)),p=(y*S+x)*4;e[p]=190;e[p+1]=230;e[p+2]=255;e[p+3]=255*v*v}
  q.putImageData(I,0,0);L.cau=c;
  L.cv=aiCanvas(320,110);L.cm=aiCanvas(320,110);{const m=L.cm.getContext('2d'),g1=m.createLinearGradient(0,0,0,110);g1.addColorStop(0,'rgba(0,0,0,0)');g1.addColorStop(.35,'rgba(0,0,0,1)');g1.addColorStop(1,'rgba(0,0,0,.8)');m.fillStyle=g1;m.fillRect(0,0,320,110);
   m.globalCompositeOperation='destination-in';const g2=m.createLinearGradient(0,0,320,0);g2.addColorStop(0,'rgba(0,0,0,0)');g2.addColorStop(.18,'#000');g2.addColorStop(.82,'#000');g2.addColorStop(1,'rgba(0,0,0,0)');m.fillStyle=g2;m.fillRect(0,0,320,110)}},
 dyn(x,w,h,t,L){const{W0,H0}=L;
  // 1) surface band ripples sideways (rows of the base image)
  const M=22,ys=L.ysf,rh=ys/H0*h/M;for(let j=0;j<M;j++){const v=(j+.5)/M,dx=1.3*(1-v*.5)*Math.sin(v*17+t*.9)+.6*Math.sin(v*41-t*1.7);x.drawImage(L.base,0,j*ys/M,W0,ys/M,dx,j*rh,w,rh+.03)}
  // 2) light shafts swing from the surface like a pendulum and breathe
  x.save();x.globalCompositeOperation='lighter';x.globalAlpha=Math.min(1,.8+.22*Math.sin(t*.5)+.1*Math.sin(t*1.7));const sh=L.yS/H0*h;
  x.translate(w/2,0);x.transform(1,0,.06*Math.sin(t*.3)+.025*Math.sin(t*.77),1,0,0);x.translate(-w/2,0);x.drawImage(L.S,0,0,W0,L.yS,0,0,w,sh);x.restore();
  // 3) caustics on the seabed: two scrolling copies of the web, masked to the floor, added softly
  {const c=L.cv,q=c.getContext('2d');q.globalCompositeOperation='source-over';q.clearRect(0,0,320,110);
   for(const[sx,sy,sc,a]of[[t*6,t*3,.75,1],[-t*4.5,t*4+40,.6,.85]]){q.save();q.globalAlpha=a;q.scale(1,.5);q.translate(sx%160-160,(sy%160)-160);q.scale(sc,sc);q.fillStyle=q.createPattern(L.cau,'repeat');q.fillRect(0,0,(320+330)/sc,(240+330)/sc);q.restore()}
   q.globalCompositeOperation='destination-in';q.drawImage(L.cm,0,0);
   x.save();x.globalCompositeOperation='lighter';x.globalAlpha=.1+.025*Math.sin(t*.8);x.drawImage(c,w*.08,h*.6,w*.84,h*.4);x.restore()}
  // 4) kelp sways, anchored at its base
  {const yk=L.yk,N=48,rh2=yk/H0*h/N;for(let j=0;j<N;j++){const v=(j+.5)/N,y=v*yk/H0,lr=Math.pow(Math.max(0,1-y/.47),1.3);
    const dx=2.6*lr*Math.sin(t*.7-v*3.2)+.8*lr*Math.sin(t*1.6-v*7);x.drawImage(L.K,0,j*yk/N,W0,yk/N,dx,j*rh2,w,rh2+.03)}}
  // 5) bubbles rising from the reef
  x.save();x.lineWidth=.28;const src=[[.105,.79],[.04,.6],[.905,.8],[.86,.74],[.63,.55]];
  for(let s=0;s<src.length;s++)for(let i=0;i<4;i++){const sp=7+((s*3+i)%4)*2.2,per=(src[s][1]*h)/sp+2,f=((t+i*per/4+s*1.7)%per)/per,
    by=src[s][1]*h-f*src[s][1]*h*.92,bx=src[s][0]*w+Math.sin(t*2.2+i*1.9+s)*1.1*f+(i-1.5)*.9,r=.45+((i+s)%3)*.25+f*.25,a=.42*Math.min(1,f*8)*(1-aiSm(.75,1,f));
   x.strokeStyle=`rgba(200,236,255,${a})`;x.beginPath();x.arc(bx,by,r,0,TAU);x.stroke();x.fillStyle=`rgba(230,248,255,${a*.9})`;x.fillRect(bx-r*.45,by-r*.5,.32,.32)}
  x.restore()},
 notes:['水面一帶左右波動；光柱從畫裡分出來，像鐘擺一樣慢慢擺動並明暗呼吸。','海床有流動的水波光紋；兩側海草從根部輕輕擺動；珊瑚間冒出小氣泡；保留原本的小魚群與漂浮碎屑。']});

const P=window.PPLC;let BGID='aurora';try{BGID=localStorage.getItem('aitest-bg')||'aurora'}catch(e){}
if(BGID!=='aurora'&&BGID!=='sea')BGID='aurora';
for(const id of ['aurora','sea']){const rl=RL['ai2_'+id];let L=null,key='';
 P.draw.BG['ai_'+id]=function(c,w,h,t){const cw=c.canvas.width,ch=c.canvas.height,im=AIIMG[id];if(!im.complete||!im.naturalWidth){c.fillStyle='#0b1022';c.fillRect(0,0,w,h);return}
  const k2=cw+'x'+ch;if(!L||key!==k2){L={};key=k2;const s=document.createElement('canvas');s.width=cw;s.height=ch;const sx=s.getContext('2d'),k=ch/180;sx.scale(k,k);rl.stat(sx,cw/k,180,L);L.s=s}
  c.save();c.setTransform(1,0,0,1,0,0);c.drawImage(L.s,0,0);c.restore();rl.dyn(c,w,h,t,L)}}
const look0=P.look;P.look=function(){const L=look0.apply(this,arguments);return Object.assign({},L,{allDef:false,bg:Object.assign({},L.bg,{id:'bg.ai_'+BGID,k:'ai_'+BGID,def:false})})};
window.AIGAME={get BGID(){return BGID}};
// test switch: shown outside of play, swaps between the two AI backgrounds
const NM={aurora:'極光',sea:'深海'},bt=document.createElement('button');
bt.style.cssText='position:fixed;z-index:9999;left:calc(10px + env(safe-area-inset-left,0px));bottom:calc(10px + env(safe-area-inset-bottom,0px));padding:8px 12px;border-radius:999px;border:1px solid rgba(160,200,255,.5);background:rgba(10,16,40,.85);color:#dfe9ff;font:600 13px system-ui,sans-serif';
const lab=()=>{bt.textContent='測試背景：'+NM[BGID]+'（點一下換'+NM[BGID==='aurora'?'sea':'aurora']+'）'};lab();
bt.onclick=()=>{BGID=BGID==='aurora'?'sea':'aurora';try{localStorage.setItem('aitest-bg',BGID)}catch(e){}lab()};
const add=()=>{document.body.appendChild(bt);setInterval(()=>{let s='';try{s=__pb.S.st}catch(e){}bt.hidden=(s==='play'||s==='ready'||s==='starting')},400)};
if(document.body)add();else addEventListener('DOMContentLoaded',add);
})();
