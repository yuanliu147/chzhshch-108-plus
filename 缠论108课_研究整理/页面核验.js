'use strict';
// 使用独立、临时本地Chrome实例检查报告；不连接用户浏览器配置。
const fs=require('fs'),path=require('path'),{spawn}=require('child_process');
const root=__dirname,profile=fs.mkdtempSync(path.join(root,'浏览器核验_'));
const chrome=spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',[
  '--headless=new','--disable-gpu','--no-first-run','--disable-background-networking',
  '--disable-component-update','--disable-sync','--user-data-dir='+profile,
  '--remote-debugging-pipe'],{stdio:['ignore','ignore','ignore','pipe','pipe']});
let counter=0,buffer='',pending=new Map(),listeners=[];
const exited=new Promise(resolve=>chrome.on('exit',()=>{fs.rmSync(profile,{recursive:true,force:true});resolve();}));
chrome.stdio[4].on('data',chunk=>{
  buffer+=chunk.toString();let end;
  while((end=buffer.indexOf('\0'))>=0){
    const raw=buffer.slice(0,end);buffer=buffer.slice(end+1);if(!raw)continue;
    const m=JSON.parse(raw);
    if(m.id&&pending.has(m.id)){
      const p=pending.get(m.id);pending.delete(m.id);
      m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);
    }else listeners.forEach(f=>f(m));
  }
});
function call(method,params={},sessionId){
  return new Promise((resolve,reject)=>{
    const id=++counter;pending.set(id,{resolve,reject});
    chrome.stdio[3].write(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})})+'\0');
  });
}
const timer=setTimeout(()=>{console.error('浏览器核验超时');chrome.kill();process.exitCode=1;},90000);
(async()=>{
  const {targetId}=await call('Target.createTarget',{url:'about:blank'});
  const {sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  await call('Page.enable',{},sessionId);
  const checks=[];
  for(const [label,width] of [['桌面',1280],['手机',390]]){
    await call('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:label==='手机'},sessionId);
    const loaded=new Promise(resolve=>{
      const fn=m=>{if(m.method==='Page.loadEventFired'&&m.sessionId===sessionId){listeners=listeners.filter(f=>f!==fn);resolve();}};
      listeners.push(fn);
    });
    await call('Page.navigate',{url:'file://'+root+'/缠论108课_研究报告.html?layout='+label},sessionId);
    await loaded;
    const result=await call('Runtime.evaluate',{expression:`(() => {
      const p=JSON.parse(document.getElementById('report-data').textContent);
      const missing=[...document.querySelectorAll('a[href^="#"]')].filter(a=>!document.getElementById(a.getAttribute('href').slice(1)));
      const input=document.getElementById('query');input.value='特征序列';input.dispatchEvent(new Event('input'));
      const filtered=[...document.querySelectorAll('#index-body tr')].filter(r=>!r.hidden).length;
      document.getElementById('reset').click();
      const kind=document.getElementById('kind');kind.value='appendix';kind.dispatchEvent(new Event('change'));
      const appendix=[...document.querySelectorAll('#index-body tr')].filter(r=>!r.hidden).length;
      document.getElementById('reset').click();
      document.querySelector('a[data-line="469"]').click();
      const comment=document.getElementById('reader-line-469');
      const jump=comment&&comment.classList.contains('highlight')&&comment.textContent.includes('都必须是完成的');
      document.getElementById('close-reader').click();
      document.querySelector('button[data-course="062"]').click();
      const noteSize=document.getElementById('reader-content').textContent.length;
      document.getElementById('close-reader').click();window.scrollTo(0,0);
      return JSON.stringify({viewport:innerWidth,documentWidth:document.documentElement.scrollWidth,
        courseCount:Object.keys(p.courses).length,imageCount:Object.keys(p.images).length,
        missingAnchors:missing.length,keywordMatches:filtered,appendixCount:appendix,
        commentJumpValid:Boolean(jump),noteCharacters:noteSize});
    })()`,returnByValue:true},sessionId);
    const metrics={设备:label,...JSON.parse(result.result.value)};
    if(metrics.documentWidth!==width||metrics.courseCount!==113||metrics.imageCount!==43||metrics.missingAnchors||metrics.appendixCount!==5||!metrics.commentJumpValid){throw new Error('页面核验失败：'+JSON.stringify(metrics));}
    const shot=await call('Page.captureScreenshot',{format:'png',clip:{x:0,y:0,width,height:1000,scale:1}},sessionId);
    fs.writeFileSync(path.join(root,'报告首页核验_'+label+'.png'),Buffer.from(shot.data,'base64'));
    checks.push(metrics);console.log(JSON.stringify(metrics));
    if(label==='手机'){
      const position=await call('Runtime.evaluate',{expression:'(() => {const top=document.getElementById("timing").getBoundingClientRect().top+scrollY-60;window.scrollTo({top,behavior:"instant"});return scrollY;})()',returnByValue:true},sessionId);
      if(position.result.value<1000)throw new Error('确认时点示意区未滚动到位');
      const chart=await call('Page.captureScreenshot',{format:'png',captureBeyondViewport:false,fromSurface:true},sessionId);
      fs.writeFileSync(path.join(root,'确认时点示意核验_手机.png'),Buffer.from(chart.data,'base64'));
    }
  }
  fs.writeFileSync(path.join(root,'页面交互与布局核验.json'),JSON.stringify(checks,null,2));
  await call('Browser.close');
})().catch(error=>{console.error(error);process.exitCode=1;chrome.kill();})
  .finally(async()=>{clearTimeout(timer);await exited;});
