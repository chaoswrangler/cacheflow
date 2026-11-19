/* Cache Flow cinematic layer: HUD canvas (perspective grid, radar sweep, target locks, circuitry),
   self-drawing wolf outline, howling-wolf hero, local clock. Non-module so it runs before the app. */
(()=>{
const RM=matchMedia("(prefers-reduced-motion: reduce)").matches;
/* letterbox intro */
requestAnimationFrame(()=>setTimeout(()=>document.body.classList.remove("intro"),RM?0:250));
/* local clock */
const ck=document.getElementById("clock");
const tick=()=>{ if(ck) ck.textContent=new Date().toLocaleTimeString([], {hour:"2-digit",minute:"2-digit",hour12:false}); };
tick(); setInterval(tick,15000);
/* outline wolf draws itself, then drifts with the pointer */
document.querySelectorAll("svg.draw").forEach(s=>{ s.querySelectorAll("path").forEach(p=>p.setAttribute("pathLength","1")); setTimeout(()=>s.classList.add("on"),RM?0:700); });
const pw=document.querySelector(".page-wolf");
if(pw&&!RM) addEventListener("mousemove",e=>{ const x=e.clientX/innerWidth-.5,y=e.clientY/innerHeight-.5; pw.style.transform=`translate(${x*-18}px,${y*-12}px)`; },{passive:true});

/* HUD canvas */
const cv=document.getElementById("fx"); if(!cv) return; const cx=cv.getContext("2d"); let W,H,D,t0=performance.now();
const C="95,208,255";
let traces=[];
/* circuitry: right-angle/45° traces growing in from the screen edges, with pulses running along them */
function buildTraces(){
  traces=[]; const n=Math.round(Math.min(26,Math.max(10,(W+H)/90)));
  for(let i=0;i<n;i++){
    const side=i%2? "l":"r"; let x=side==="l"? 0 : W, y=Math.random()*H;
    const pts=[[x,y]]; let dir=side==="l"?1:-1; const segs=3+Math.random()*4|0;
    for(let k=0;k<segs;k++){
      const len=30+Math.random()*120;
      if(k%2===0){ x+=dir*len; } else { const d=(Math.random()<.5?-1:1)*len*.7; x+=dir*Math.abs(d)*.6; y+=d; }
      pts.push([x,y]);
    }
    let L=0; const seg=[]; for(let k=1;k<pts.length;k++){ const l=Math.hypot(pts[k][0]-pts[k-1][0],pts[k][1]-pts[k-1][1]); seg.push(l); L+=l; }
    traces.push({pts,seg,L,sp:40+Math.random()*90,ph:Math.random()*L,a:.05+Math.random()*.07});
  }
}
const size=()=>{ D=Math.min(devicePixelRatio||1,2); W=innerWidth; H=innerHeight; cv.width=W*D; cv.height=H*D; cx.setTransform(D,0,0,D,0,0); buildTraces(); };
size(); addEventListener("resize",size);
function along(tr,d){ d=((d%tr.L)+tr.L)%tr.L; for(let k=0;k<tr.seg.length;k++){ if(d<=tr.seg[k]){ const a=tr.pts[k],b=tr.pts[k+1],f=d/tr.seg[k]; return [a[0]+(b[0]-a[0])*f,a[1]+(b[1]-a[1])*f]; } d-=tr.seg[k]; } return tr.pts[tr.pts.length-1]; }
let locks=[]; const newLock=()=>({x:W*(.55+Math.random()*.4),y:H*(.15+Math.random()*.6),born:performance.now(),life:2600+Math.random()*1800,id:(Math.random()*0xffff|0).toString(16).toUpperCase().padStart(4,"0")});
for(let i=0;i<3;i++){const l=newLock(); l.born-=Math.random()*2000; locks.push(l);}
const mob=()=>W<720;
function frame(now){
  const t=(now-t0)/1000, sy=scrollY, top=sy<H*1.1;
  cx.clearRect(0,0,W,H);
  /* perspective floor grid, scrolls toward viewer */
  const hz=H*.62, fade=Math.max(0,1-sy/(H*.9));
  if(fade>0){
    cx.lineWidth=1;
    for(let i=-14;i<=14;i++){ const x=W/2+i*W*.09; cx.strokeStyle=`rgba(${C},${.10*fade*(1-Math.abs(i)/16)})`; cx.beginPath(); cx.moveTo(W/2+i*W*.012,hz); cx.lineTo(x+(x-W/2)*2.2,H); cx.stroke(); }
    for(let j=0;j<14;j++){ const p=((j+(t*.35)%1)/14), y=hz+Math.pow(p,2.4)*(H-hz); cx.strokeStyle=`rgba(${C},${(.03+p*.13)*fade})`; cx.beginPath(); cx.moveTo(0,y); cx.lineTo(W,y); cx.stroke(); }
    const g=cx.createLinearGradient(0,hz-60,0,hz+20); g.addColorStop(0,`rgba(${C},0)`); g.addColorStop(1,`rgba(${C},${.10*fade})`); cx.fillStyle=g; cx.fillRect(0,hz-60,W,80);
  }
  /* circuitry */
  for(const tr of traces){
    cx.strokeStyle=`rgba(${C},${tr.a})`; cx.lineWidth=1; cx.beginPath(); cx.moveTo(tr.pts[0][0],tr.pts[0][1]); for(const p of tr.pts.slice(1)) cx.lineTo(p[0],p[1]); cx.stroke();
    const e=tr.pts[tr.pts.length-1]; cx.beginPath(); cx.arc(e[0],e[1],2.4,0,7); cx.stroke();
    for(const p of tr.pts.slice(1,-1)){ cx.fillStyle=`rgba(${C},${tr.a*1.6})`; cx.fillRect(p[0]-1,p[1]-1,2,2); }
    if(!RM){ const [px,py]=along(tr,tr.ph+t*tr.sp); const gl=cx.createRadialGradient(px,py,0,px,py,9); gl.addColorStop(0,`rgba(${C},.75)`); gl.addColorStop(1,`rgba(${C},0)`); cx.fillStyle=gl; cx.beginPath(); cx.arc(px,py,9,0,7); cx.fill(); }
  }
  /* corner radar */
  const R=mob()?60:110, rx=R+24, ry=H-R-24;
  cx.strokeStyle=`rgba(${C},.18)`; cx.lineWidth=1;
  [1,.66,.33].forEach(k=>{cx.beginPath();cx.arc(rx,ry,R*k,0,7);cx.stroke();});
  cx.beginPath();cx.moveTo(rx-R,ry);cx.lineTo(rx+R,ry);cx.moveTo(rx,ry-R);cx.lineTo(rx,ry+R);cx.stroke();
  const a=t*1.4; const sg=cx.createConicGradient?cx.createConicGradient(a,rx,ry):null;
  if(sg){ sg.addColorStop(0,`rgba(${C},.28)`); sg.addColorStop(.12,`rgba(${C},0)`); sg.addColorStop(1,`rgba(${C},0)`); cx.fillStyle=sg; cx.beginPath(); cx.arc(rx,ry,R,0,7); cx.fill(); }
  cx.font="10px 'IBM Plex Mono',monospace"; cx.fillStyle=`rgba(${C},.55)`; cx.fillText("SCAN "+String(Math.floor((a*57.3)%360)).padStart(3,"0")+"°",rx-R,ry-R-8);
  /* target locks near the top of the page */
  if(top && !mob()){
    locks=locks.map(l=>now-l.born>l.life?newLock():l);
    for(const l of locks){
      const age=(now-l.born)/l.life, ap=Math.min(1,age*4), out=age>.85?(1-age)/.15:1, s=40-ap*22, al=.6*out;
      cx.strokeStyle=`rgba(${C},${al})`; cx.lineWidth=1.2; const k=7;
      [[-1,-1],[1,-1],[-1,1],[1,1]].forEach(([dx,dy])=>{ const cxp=l.x+dx*s, cyp=l.y+dy*s; cx.beginPath(); cx.moveTo(cxp,cyp-dy*k); cx.lineTo(cxp,cyp); cx.lineTo(cxp-dx*k,cyp); cx.stroke(); });
      if(ap>=1){ cx.fillStyle=`rgba(${C},${al})`; cx.font="9px 'IBM Plex Mono',monospace"; cx.fillText("LOCK "+l.id,l.x+s+6,l.y-s+8); cx.fillText(`${(l.x/W*100).toFixed(1)} / ${(l.y/H*100).toFixed(1)}`,l.x+s+6,l.y-s+20); }
    }
  }
  /* horizontal sweep line */
  const sp=(t%6)/6; if(sp<.5){ const y=sp*2*H; const g2=cx.createLinearGradient(0,y-40,0,y); g2.addColorStop(0,`rgba(${C},0)`); g2.addColorStop(1,`rgba(${C},.07)`); cx.fillStyle=g2; cx.fillRect(0,y-40,W,40); cx.fillStyle=`rgba(${C},.18)`; cx.fillRect(0,y,W,1); }
}
if(RM) frame(performance.now()); else (function loop(now){ frame(now); requestAnimationFrame(loop); })(performance.now());
})();
/* ================= HOWL SCENE ================= */
(()=>{
const RM=matchMedia("(prefers-reduced-motion: reduce)").matches;
const box=document.querySelector(".howl"); if(!box) return;
const cbox=box.closest(".cbox");
box.querySelectorAll(".rimline,.waves path").forEach(p=>p.setAttribute("pathLength","1"));
/* shards fly in from everywhere, head first */
const setupShards=()=>box.querySelectorAll(".sh").forEach(p=>{ const a=Math.random()*Math.PI*2, d=300+Math.random()*500;
  p.style.setProperty("--dx",Math.cos(a)*d+"px"); p.style.setProperty("--dy",Math.sin(a)*d+"px");
  p.style.setProperty("--rr",(Math.random()*540-270)+"deg"); const bb=p.getBBox(); p.style.setProperty("--dl",(bb.y/520*0.7+Math.random()*.25).toFixed(2)+"s"); });
/* binary moon */
const cv=box.querySelector(".moon"), ctx=cv.getContext("2d"), dpr=Math.min(devicePixelRatio||1,2);
let MW=0,cells=[],boost=0;
function msize(){ MW=cv.clientWidth; cv.width=cv.height=MW*dpr; ctx.setTransform(dpr,0,0,dpr,0,0);
  const fs=Math.max(8,MW/36), r=MW*.42, c=MW/2; cells=[];
  for(let y=c-r;y<=c+r;y+=fs){ for(let x=c-r;x<=c+r;x+=fs*.62){ const d=Math.hypot(x-c,y-c)/r; if(d>1)continue;
    const cr=(Math.sin(x*.08)*Math.cos(y*.06)+Math.sin((x+y)*.045))*.5;
    cells.push({x,y,ox:x,oy:y,d,b:Math.max(.12,1-d*d*.55-(cr>.45?.45:0)),ch:Math.random()<.5?"0":"1"}); } }
  ctx.font=`600 ${fs}px "IBM Plex Mono",monospace`; ctx.textAlign="center"; ctx.textBaseline="middle"; }
function mdraw(t){ ctx.clearRect(0,0,MW,MW); const c=MW/2,r=MW*.42;
  const g=ctx.createRadialGradient(c,c,r*.1,c,c,r*1.3); g.addColorStop(0,`rgba(150,225,255,${.22+boost*.35})`); g.addColorStop(1,"rgba(95,208,255,0)");
  ctx.fillStyle=g; ctx.beginPath(); ctx.arc(c,c,r*1.3,0,7); ctx.fill();
  for(const k of cells){ if(Math.random()<.02+boost*.08) k.ch=k.ch==="0"?"1":"0";
    const jx=boost*(k.ox-c)*.08*Math.random(), jy=boost*(k.oy-c)*.08*Math.random();
    const sweep=.5+.5*Math.sin(t/800+k.x*.02-k.y*.012), a=Math.min(1,k.b*(.5+.4*sweep)+boost*.35);
    ctx.fillStyle=`rgba(${200+boost*55|0},${235+boost*20|0},255,${a})`; ctx.fillText(k.ch,k.x+jx,k.y+jy); }
  ctx.strokeStyle=`rgba(180,235,255,${.4+boost*.5})`; ctx.lineWidth=1.2; ctx.beginPath(); ctx.arc(c,c,r+5,0,7); ctx.stroke(); }
/* sky: stars, embers, binary drift */
const sk=cbox.querySelector(".sky"), sx=sk.getContext("2d"); let SW=0,SH=0,stars=[],emb=[],bits=[];
function ssize(){ SW=sk.clientWidth; SH=sk.clientHeight; sk.width=SW*dpr; sk.height=SH*dpr; sx.setTransform(dpr,0,0,dpr,0,0);
  stars=Array.from({length:Math.round(SW*SH/5000)},()=>({x:Math.random()*SW,y:Math.random()*SH,r:Math.random()*1.3+.2,p:Math.random()*6}));
  emb=Array.from({length:46},()=>newEmber(true)); bits=Array.from({length:26},()=>newBit(true)); }
function newEmber(init){ const warm=Math.random()<.28; return {x:Math.random()*SW,y:init?Math.random()*SH:SH+10,v:.3+Math.random()*1.1,s:Math.random()*2.2+.6,w:Math.random()*6,warm}; }
function newBit(init){ const mx=SW*.78,my=SH*.25; return {x:mx+(Math.random()-.5)*120,y:my+(Math.random()-.5)*120,vx:(Math.random()-.8)*1.4,vy:Math.random()*1.1+.2,a:init?Math.random():1,ch:Math.random()<.5?"0":"1"}; }
function sdraw(t){ sx.clearRect(0,0,SW,SH);
  for(const s of stars){ const a=.25+.55*(.5+.5*Math.sin(t/700+s.p)); sx.fillStyle=`rgba(200,230,255,${a})`; sx.fillRect(s.x,s.y,s.r,s.r); }
  for(const e of emb){ e.y-=e.v*(1+boost*2); e.x+=Math.sin(t/900+e.w)*.4; if(e.y<-10) Object.assign(e,newEmber(false));
    sx.fillStyle=e.warm?`rgba(255,170,90,${.55+boost*.3})`:`rgba(140,220,255,${.6+boost*.3})`; sx.shadowBlur=8; sx.shadowColor=e.warm?"#ff9a4a":"#5fd0ff";
    sx.beginPath(); sx.arc(e.x,e.y,e.s,0,7); sx.fill(); }
  sx.shadowBlur=0; sx.font="600 11px 'IBM Plex Mono',monospace";
  for(const b of bits){ b.x+=b.vx*(1+boost*3); b.y+=b.vy*(1+boost*3); b.a-=.004; if(b.a<=0||b.y>SH) Object.assign(b,newBit(false));
    sx.fillStyle=`rgba(160,230,255,${b.a*.7})`; sx.fillText(b.ch,b.x,b.y); } }
let run=false; function loop(t){ if(!run)return; mdraw(t); sdraw(t); boost*=.965; requestAnimationFrame(loop); }
addEventListener("resize",()=>{ if(cv.clientWidth){msize();ssize();} });
const howl=()=>{ if(RM)return; box.classList.remove("howling"); void box.offsetWidth; box.classList.add("howling"); boost=1; setTimeout(()=>box.classList.remove("howling"),2700); };
/* parallax: moon recedes, wolf comes at you */
if(!RM) cbox.addEventListener("mousemove",e=>{ const r=cbox.getBoundingClientRect(),x=(e.clientX-r.left)/r.width-.5,y=(e.clientY-r.top)/r.height-.5;
  box.style.setProperty("--mx",(x*-14)+"px"); box.style.setProperty("--my",(y*-10)+"px"); box.style.setProperty("--wx",(x*22)+"px"); box.style.setProperty("--wy",(y*12)+"px"); });
let started=false;
new IntersectionObserver(es=>es.forEach(e=>{ run=e.isIntersecting&&!RM; if(run) requestAnimationFrame(loop);
  if(e.isIntersecting&&!MW){ msize(); ssize(); mdraw(0); sdraw(0); }
  if(e.isIntersecting&&!started){ started=true; try{ setupShards(); }catch(_){} void box.offsetWidth; box.classList.add("go");
    if(!RM){ setTimeout(()=>{ box.classList.add("landing"); cbox.classList.add("shake","boom"); boost=1.4;
        setTimeout(()=>{box.classList.remove("landing");cbox.classList.remove("shake","boom")},1200); },1250);
      setTimeout(howl,2300); setInterval(howl,8000); } }
}),{threshold:.3}).observe(cbox);
box.addEventListener("click",howl); box.addEventListener("mouseenter",howl);
})();
