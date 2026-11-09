'use strict';
// 独立临时Chrome检查配图：文字重叠、越界、横向溢出，并输出截图。
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const root=__dirname,profile=fs.mkdtempSync(path.join(root,'浏览器配图_'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-background-networking',
  '--disable-component-update','--disable-sync','--user-data-dir='+profile,
  '--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let counter=0,buffer='',pending=new Map(),listeners=[];
const exited=new Promise(r=>chrome.on('exit',()=>{fs.rmSync(profile,{recursive:true,force:true});r();}));
chrome.stdio[4].on('data',c=>{buffer+=c.toString();let e;
  while((e=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,e);buffer=buffer.slice(e+1);if(!raw)continue;
    const m=JSON.parse(raw);
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
    else listeners.forEach(f=>f(m));}});
function call(method,params={},sessionId){return new Promise((res,rej)=>{const id=++counter;
  pending.set(id,{resolve:res,reject:rej});
  chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
const timer=setTimeout(()=>{console.error('超时');chrome.kill();process.exitCode=1;},180000);
const SHOT=['fig-baohan','fig-fangxiang','fig-fenxing','fig-bi','fig-bi-jiage','fig-bi-tichu','fig-seg-case1','fig-seg-case2',
  'fig-center-break','fig-center-three','fig-divergence','fig-buy-panorama','fig-buy2-cases','fig-level'];
(async()=>{
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},sessionId);
  await call('Emulation.setDeviceMetricsOverride',{width:1100,height:1000,deviceScaleFactor:1,mobile:false},sessionId);
  const loaded=new Promise(r=>{const fn=m=>{if(m.method==='Page.loadEventFired'&&m.sessionId===sessionId){listeners=listeners.filter(f=>f!==fn);r();}};listeners.push(fn);});
  await call('Page.navigate',{url:'file://'+root+'/配图预览.html'},sessionId);
  await loaded;
  const res=await call('Runtime.evaluate',{expression:`(() => {
    const out=[];
    document.querySelectorAll('section').forEach(sec=>{
      const svg=sec.querySelector('svg'); if(!svg) return;
      const vb=svg.viewBox.baseVal, sr=svg.getBoundingClientRect();
      const sx=sr.width/vb.width, sy=sr.height/vb.height;
      const texts=[...svg.querySelectorAll('text')].map(t=>{const r=t.getBoundingClientRect();
        return {s:t.textContent.trim(),x:(r.left-sr.left)/sx,y:(r.top-sr.top)/sy,w:r.width/sx,h:r.height/sy};});
      const overlaps=[];
      for(let i=0;i<texts.length;i++)for(let j=i+1;j<texts.length;j++){
        const a=texts[i],b=texts[j];
        const ix=Math.min(a.x+a.w,b.x+b.w)-Math.max(a.x,b.x);
        const iy=Math.min(a.y+a.h,b.y+b.h)-Math.max(a.y,b.y);
        if(ix>1.5&&iy>1.5)overlaps.push([a.s,b.s,+(ix*iy).toFixed(1)]);
      }
      const outside=texts.filter(t=>t.x<-1||t.y<-1||t.x+t.w>vb.width+1||t.y+t.h>vb.height+1).map(t=>t.s);
      const shapes=[...svg.querySelectorAll('rect,circle,path,line')].filter(el=>{
        const r=el.getBoundingClientRect();
        return r.width>0&&(r.left<sr.left-2||r.right>sr.right+2||r.top<sr.top-2||r.bottom>sr.bottom+2);
      }).length;
      out.push({id:sec.id,texts:texts.length,overlaps,outside,shapesOutside:shapes,
        scrollOverflow:sec.querySelector('.figscroll').scrollWidth>sec.querySelector('.figscroll').clientWidth+1});
    });
    return JSON.stringify({docWidth:document.documentElement.scrollWidth,viewport:innerWidth,figs:out});
  })()`,returnByValue:true},sessionId);
  const data=JSON.parse(res.result.value);
  fs.writeFileSync(path.join(root,'配图排版核验.json'),JSON.stringify(data,null,1));
  const bad=data.figs.filter(f=>f.overlaps.length||f.outside.length||f.shapesOutside);
  console.log('视口',data.viewport,'文档宽',data.docWidth,'图数',data.figs.length);
  bad.forEach(b=>console.log('问题',b.id,JSON.stringify({overlaps:b.overlaps,outside:b.outside,shapes:b.shapesOutside})));
  if(!bad.length)console.log('全部配图无文字重叠、无越界');
  for(const id of SHOT){
    const box=await call('Runtime.evaluate',{expression:`(() => {const el=document.getElementById(${JSON.stringify(id)});
      el.scrollIntoView();const r=el.getBoundingClientRect();
      return JSON.stringify({x:0,y:Math.max(0,r.top+scrollY-4),width:1100,height:Math.min(r.height+12,4000)});})()`,returnByValue:true},sessionId);
    const clip=JSON.parse(box.result.value);
    await call('Runtime.evaluate',{expression:`window.scrollTo(0,${clip.y})`},sessionId);
    const shot=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
      clip:{x:0,y:clip.y,width:clip.width,height:clip.height,scale:1}},sessionId);
    fs.writeFileSync(path.join(root,'配图核验_'+id+'.png'),Buffer.from(shot.data,'base64'));
  }
  console.log('截图',SHOT.length,'张');
  await call('Browser.close');
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill();})
  .finally(async()=>{clearTimeout(timer);await exited;});