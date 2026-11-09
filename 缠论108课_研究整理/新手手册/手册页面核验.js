'use strict';
// 独立临时Chrome核验手册：锚点、配图、勾选持久化、桌面/手机布局、控制台错误。
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const root=__dirname,profile=fs.mkdtempSync(path.join(root,'浏览器手册_'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-background-networking',
  '--disable-component-update','--disable-sync','--user-data-dir='+profile,
  '--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let counter=0,buffer='',pending=new Map(),listeners=[],consoleErrors=[];
const exited=new Promise(r=>chrome.on('exit',()=>{fs.rmSync(profile,{recursive:true,force:true});r();}));
chrome.stdio[4].on('data',c=>{buffer+=c.toString();let e;
  while((e=buffer.indexOf('\0'))>=0){const raw=buffer.slice(0,e);buffer=buffer.slice(e+1);if(!raw)continue;
    const m=JSON.parse(raw);
    if(m.id&&pending.has(m.id)){const p=pending.get(m.id);pending.delete(m.id);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
    else{if(m.method==='Runtime.consoleAPICalled'&&m.params.type==='error')consoleErrors.push(JSON.stringify(m.params.args));
      listeners.forEach(f=>f(m));}}});
function call(method,params={},sessionId){return new Promise((res,rej)=>{const id=++counter;
  pending.set(id,{resolve:res,reject:rej});
  chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');});}
const timer=setTimeout(()=>{console.error('超时');chrome.kill();process.exitCode=1;},180000);
(async()=>{
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},sessionId);await call('Runtime.enable',{},sessionId);
  const checks=[];
  for(const [label,width] of [['桌面',1280],['手机',390]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:950,deviceScaleFactor:1,mobile:label==='手机'},sessionId);
    const loaded=new Promise(r=>{const fn=m=>{if(m.method==='Page.loadEventFired'&&m.sessionId===sessionId){listeners=listeners.filter(f=>f!==fn);r();}};listeners.push(fn);});
    await call('Page.navigate',{url:'file://'+root+'/../缠论新手学习实践手册.html?v='+label},sessionId);
    await loaded;
    const res=await call('Runtime.evaluate',{expression:`(() => {
      const secs=[...document.querySelectorAll('section[id]')];
      const navs=[...document.querySelectorAll('nav.toc a')];
      const missing=navs.filter(a=>!document.getElementById(a.getAttribute('href').slice(1)));
      const figs=[...document.querySelectorAll('figure .figscroll svg')];
      const boxes=[...document.querySelectorAll('input[data-gate]')];
      boxes[0].click();
      const after1=document.getElementById('ptext').textContent;
      const stored=localStorage.getItem('chanlun-manual-progress-v1');
      boxes[0].click();
      const after0=document.getElementById('ptext').textContent;
      const scrollable=[...document.querySelectorAll('.figscroll')].filter(d=>d.scrollWidth>d.clientWidth+1).length;
      return JSON.stringify({viewport:innerWidth,docWidth:document.documentElement.scrollWidth,
        clientWidth:document.documentElement.clientWidth,
        sections:secs.length,navs:navs.length,missingAnchors:missing.length,figures:figs.length,
        gates:boxes.length,progressOn:after1,progressOff:after0,stored:stored,scrollableFigs:scrollable,
        quotes:document.querySelectorAll('q[data-src]').length});
    })()`,returnByValue:true},sessionId);
    const m={设备:label,...JSON.parse(res.result.value)};
    // 横向溢出判定：经典滚动条会占掉约15px，docWidth==clientWidth 即无横向溢出；
    // 只有 docWidth 超出 clientWidth、或 clientWidth 超出视口才算布局越界。
    if(m.docWidth>m.clientWidth+1||m.clientWidth>width||m.missingAnchors||m.sections!==13||m.navs!==13||m.figures!==25||m.gates!==8
       ||!m.progressOn.includes('1 / 8')||!m.progressOff.includes('0 / 8')||!m.stored){
      throw new Error('手册页面核验失败：'+JSON.stringify(m));
    }
    if(label==='手机'&&m.scrollableFigs<20)throw new Error('手机端配图应可横向滑动：'+m.scrollableFigs);
    const shot=await call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width,height:950,scale:1}},sessionId);
    fs.writeFileSync(path.join(root,'手册首页核验_'+label+'.png'),Buffer.from(shot.data,'base64'));
    const g1=await call('Runtime.evaluate',{expression:'(() => {const el=document.getElementById("gate1");window.scrollTo({top:0,behavior:"instant"});const r=el.getBoundingClientRect();return JSON.stringify({y:Math.max(0,r.top+scrollY-4),h:Math.min(r.height+12,6000)});})()',returnByValue:true},sessionId);
    const clip1=JSON.parse(g1.result.value);
    const s1=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:true,
      clip:{x:0,y:clip1.y,width,height:clip1.h,scale:1}},sessionId);
    fs.writeFileSync(path.join(root,'手册第1关核验_'+label+'.png'),Buffer.from(s1.data,'base64'));
    if(label==='手机'){
      const pos=await call('Runtime.evaluate',{expression:'(() => {const el=document.getElementById("gate4");window.scrollTo({top:el.getBoundingClientRect().top+scrollY-56,behavior:"instant"});return scrollY;})()',returnByValue:true},sessionId);
      if(pos.result.value<1000)throw new Error('未滚动到第4关');
      const s2=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},sessionId);
      fs.writeFileSync(path.join(root,'手册第4关核验_手机.png'),Buffer.from(s2.data,'base64'));
    }else{
      const pos=await call('Runtime.evaluate',{expression:'(() => {const el=document.getElementById("gate8");window.scrollTo({top:el.getBoundingClientRect().top+scrollY-56,behavior:"instant"});return scrollY;})()',returnByValue:true},sessionId);
      const s2=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},sessionId);
      fs.writeFileSync(path.join(root,'手册第8关核验_桌面.png'),Buffer.from(s2.data,'base64'));
    }
    checks.push(m);console.log(JSON.stringify(m));
  }
  if(consoleErrors.length)throw new Error('控制台错误：'+consoleErrors.join(' | '));
  fs.writeFileSync(path.join(root,'手册页面核验.json'),JSON.stringify({checks,consoleErrors},null,1));
  console.log('控制台错误：0');
  await call('Browser.close');
})().catch(e=>{console.error(e);process.exitCode=1;chrome.kill();})
  .finally(async()=>{clearTimeout(timer);await exited;});