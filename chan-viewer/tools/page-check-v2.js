'use strict';
// 页面核验：自起生产服务（dist + api，测试端口 8799），CDP 驱动本机 Chrome。
// 默认 headless 做回归；CHAN_HEADED=1 时使用有界面 Chrome（不做用户插件环境的替代证明）。
// 双视口覆盖日线→30分→5分、上下文缩略、联动、测距、学习/对比/练习、控制台 0 错误。
// 用法：先 npm run build，再 node tools/page-check-v2.js；有界面：CHAN_HEADED=1 node tools/page-check-v2.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, '报告');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const HEADED = process.env.CHAN_HEADED === '1';

if (!fs.existsSync(path.join(root, 'apps/web/dist/index.html'))) {
  console.error('缺少前端构建产物，请先运行：npm run build');
  process.exit(1);
}
fs.mkdirSync(reportDir, { recursive: true });

const server = spawn('node', ['--no-warnings', 'apps/server/dist/index.js'], {
  cwd: root, env: { ...process.env, CHAN_PORT: String(PORT) }, stdio: 'ignore',
});
const serverExited = new Promise((r) => server.on('exit', r));
async function waitServer() {
  for (let i = 0; i < 60; i++) {
    try { const r = await fetch(`${BASE}/api/symbols?q=600000`); if (r.ok) return; } catch { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('数据服务启动超时');
}

const profile = fs.mkdtempSync(path.join(reportDir, HEADED ? '浏览器有界面_' : '浏览器核验_'));
const chromeArgs = [
  ...(HEADED ? [] : ['--headless=new', '--disable-gpu']),
  '--no-first-run', '--disable-background-networking', '--disable-component-update', '--disable-sync',
  '--user-data-dir=' + profile, '--remote-debugging-pipe',
];
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', chromeArgs, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
let counter = 0, buffer = '';
const pending = new Map();
let listeners = [];
const consoleErrors = [];
const chromeExited = new Promise((r) => chrome.on('exit', () => { fs.rmSync(profile, { recursive: true, force: true }); r(); }));
chrome.stdio[4].on('data', (c) => {
  buffer += c.toString();
  let e;
  while ((e = buffer.indexOf('\0')) >= 0) {
    const raw = buffer.slice(0, e); buffer = buffer.slice(e + 1);
    if (!raw) continue;
    const m = JSON.parse(raw);
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id);
      m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result);
    } else {
      if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') consoleErrors.push(JSON.stringify(m.params.args));
      if (m.method === 'Runtime.exceptionThrown') consoleErrors.push(JSON.stringify(m.params.exceptionDetails?.text ?? m.params));
      listeners.forEach((f) => f(m));
    }
  }
});
function call(method, params = {}, sessionId) {
  return new Promise((res, rej) => {
    const id = ++counter;
    pending.set(id, { resolve: res, reject: rej });
    chrome.stdio[3].write(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }) + '\0');
  });
}
async function evalJs(expression, sessionId) {
  const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }, sessionId);
  if (r.exceptionDetails) throw new Error('页面脚本异常：' + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function waitFor(expression, sessionId, timeout = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    if (await evalJs(expression, sessionId)) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('等待超时：' + expression);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const normText = (text) => String(text ?? '').replace(/\s/g, '');
// 仅核验页读取React已挂载实例，不向生产代码添加调试全局或测试开关。
function inspectChartInPage(selector) {
  const node = document.querySelector(selector);
  const key = node && Object.keys(node).find((k) => k.startsWith('__reactFiber'));
  for (let fiber = key ? node[key] : null; fiber; fiber = fiber.return) {
    for (let hook = fiber.memoizedState; hook; hook = hook.next) {
      const chart = hook.memoizedState?.current;
      if (chart && typeof chart.getOption === 'function' && !chart.isDisposed()) {
        return { chart, bars: fiber.memoizedProps?.bars ?? [] };
      }
    }
  }
  throw new Error('未找到实际图表实例：' + selector);
}
const inspectExpr = (selector) => `(${inspectChartInPage.toString()})(${JSON.stringify(selector)})`;
async function chartSnapshot(selector, sessionId) {
  return evalJs(`(() => {
    const {chart,bars}=${inspectExpr(selector)};
    const option=chart.getOption(), zoom=option.dataZoom[0];
    const start=Math.round(zoom.startValue),end=Math.round(zoom.endValue);
    const visible=bars.slice(start,end+1),low=Math.min(...visible.map(b=>b.low)),high=Math.max(...visible.map(b=>b.high));
    const extent=chart.getModel().getComponent('yAxis',0).axis.scale.getExtent();
    const structures=chart.getModel().getSeries().filter(s=>['中枢','线段','笔','合并K线'].includes(s.name)).map(s=>{
      const raw=option.series.find(x=>x.name===s.name).data;
      const last=s.name==='线段'||s.name==='笔'?2:1;
      const overlap=raw.filter(x=>x.value[0]<=end&&x.value[last]>=start).length;
      return {name:s.name,overlap,processed:s.getData().count()};
    });
    return {start,end,count:end-start+1,total:bars.length,low,high,extent,structures};
  })()`, sessionId);
}
async function idleRebuilds(selector, sessionId) {
  return evalJs(`(async () => {
    const {chart}=${inspectExpr(selector)};
    const proto=Object.getPrototypeOf(chart),original=proto.setOption;
    let rebuilds=0,total=0;
    proto.setOption=function(option,...args){total++;if(option?.series)rebuilds++;return original.call(this,option,...args);};
    try {await new Promise(r=>setTimeout(r,2000));return {rebuilds,total};}
    finally {proto.setOption=original;}
  })()`, sessionId);
}
const buttonExpr = (scope, text, contains = false) => `[...document.querySelectorAll(${JSON.stringify(scope)})].find(b=>${contains ? `b.textContent.includes(${JSON.stringify(text)})` : `b.textContent.replace(/\\s/g,'')===${JSON.stringify(normText(text))}`})`;
const timer = setTimeout(() => { console.error('总超时'); chrome.kill(); server.kill(); process.exitCode = 1; }, 220000);

(async () => {
  await waitServer();
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId);
  await call('Runtime.enable', {}, sessionId);
  const checks = [];

  for (const [label, width] of [['桌面', 1280], ['手机', 390]]) {
    await evalJs('localStorage.clear()', sessionId).catch(() => {});
    await call('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: label === '手机' }, sessionId);
    const loaded = new Promise((r) => { const fn = (m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) { listeners = listeners.filter((f) => f !== fn); r(); } }; listeners.push(fn); });
    await call('Page.navigate', { url: BASE + '/?v=' + label + '&t=' + Date.now() }, sessionId);
    await loaded;
    await waitFor(`!!document.querySelector('.meta') && document.querySelector('.meta').textContent.length>0`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart canvas').length===1 && !!document.querySelector('.period-d')`, sessionId, 22000);
    await sleep(700);

    const multi = JSON.parse(await evalJs(`(() => {
      const chart=document.querySelector('.multi-chart')?.getBoundingClientRect();
      const canvas=document.querySelector('.multi-chart canvas');
      const button=document.querySelector('.multi-tools button');
      const segmentLabel=document.querySelector('.multi-tools .ant-segmented-item-label');
      const group=document.querySelector('.multi-tools .ant-segmented-group');
      const bs=button?getComputedStyle(button):null, ls=segmentLabel?getComputedStyle(segmentLabel):null;
      return JSON.stringify({
        charts:document.querySelectorAll('.multi-chart').length,
        depth:document.querySelector('.multi-charts')?.className,
        paths:[...document.querySelectorAll('.drill-path button')].map(x=>x.textContent),
        dataWindow:document.querySelector('.chart-data-window')?.textContent ?? '',
        loaded:document.querySelector('.instrument-block > span')?.textContent ?? '',
        config:document.querySelector('.config-tags')?.textContent ?? '',
        rows:document.querySelectorAll('.structure-row').length,
        chartHeight:chart?.height ?? 0,
        canvasW:canvas?.width ?? 0,
        controlStyle:{buttonHeight:bs?parseFloat(bs.height):0,buttonPadding:bs?parseFloat(bs.paddingLeft):0,buttonBorder:bs?parseFloat(bs.borderLeftWidth):0,labelPadding:ls?parseFloat(ls.paddingLeft):0,groupDisplay:group?getComputedStyle(group).display:''},
        docWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth
      });
    })()`, sessionId));
    if (multi.charts !== 1 || !multi.depth.includes('depth-1') || multi.paths.length !== 1 || !multi.paths[0].includes('日线')) throw new Error('初始日线主图失败：' + JSON.stringify(multi));
    if (!(multi.dataWindow.includes('价格单位') || multi.dataWindow.includes('价格 元')) || !multi.loaded.includes('日线全量') || !/日线全量 [1-9]\d{2,}/.test(multi.loaded)) throw new Error('日线全量/单位数据窗失败：' + JSON.stringify(multi));
    if (multi.rows <= 0 || multi.chartHeight < 250 || multi.docWidth > multi.clientWidth + 1) throw new Error('日线布局/清单失败：' + JSON.stringify(multi));
    if (multi.controlStyle.buttonHeight < 22 || multi.controlStyle.buttonPadding < 7 || multi.controlStyle.buttonBorder < 1 || multi.controlStyle.labelPadding < 7 || multi.controlStyle.groupDisplay !== 'flex') throw new Error('首屏控件样式未就绪：' + JSON.stringify(multi.controlStyle));
    multi.actual = await chartSnapshot('.period-d .chart-canvas', sessionId);
    if (multi.actual.count <= 0 || multi.actual.structures.some(s=>s.processed < s.overlap)) throw new Error('日线跨窗口结构被过滤：'+JSON.stringify(multi.actual));
    const spread=multi.actual.high-multi.actual.low;
    if (multi.actual.extent[0] > multi.actual.low || multi.actual.extent[1] < multi.actual.high || multi.actual.extent[1]-multi.actual.extent[0] > spread*1.5+0.1) throw new Error('价格轴被离屏结构压缩：'+JSON.stringify(multi.actual));
    multi.idle = await idleRebuilds('.period-d .chart-canvas', sessionId);
    if (multi.idle.rebuilds !== 0) throw new Error('日线空闲仍在重建结构：'+JSON.stringify(multi.idle));
    await shot(sessionId, `M6_日线初始_${label}.png`, width);

    // 日线当前视窗 → 30分钟主图；上级缩为上下文。
    await evalJs(`${buttonExpr('.drill-actions button', '进入30分钟', true)}?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart').length===2 && !!document.querySelector('.period-m30')`, sessionId);
    await sleep(500);
    let depth = JSON.parse(await evalJs(`(() => {
      const c=document.querySelector('.period-d')?.getBoundingClientRect(), m=document.querySelector('.period-m30')?.getBoundingClientRect();
      return JSON.stringify({charts:document.querySelectorAll('.multi-chart').length,path:document.querySelector('.drill-path')?.textContent,className:document.querySelector('.multi-charts')?.className,contextH:c?.height??0,mainH:m?.height??0,contextData:!!document.querySelector('.period-d .chart-data-window'),contextVol:document.querySelector('.period-d')?.textContent.includes('成交量'),ranges:[...document.querySelectorAll('.period-range')].map(x=>x.textContent)});
    })()`, sessionId));
    if (depth.charts !== 2 || !depth.className.includes('depth-2') || !depth.path.includes('30分钟') || depth.mainH <= depth.contextH || depth.contextData || depth.contextVol) throw new Error('日线→30分钟当前层主图失败：' + JSON.stringify(depth));
    depth.actual = await chartSnapshot('.period-m30 .chart-canvas', sessionId);
    depth.idle = await idleRebuilds('.period-m30 .chart-canvas', sessionId);
    if (depth.idle.rebuilds !== 0 || depth.actual.structures.some(s=>s.processed < s.overlap)) throw new Error('30分重绘/弱过滤门禁失败：'+JSON.stringify(depth));
    await shot(sessionId, `M6_30分钟主图_${label}.png`, width);
    // 先手调到精确19根，随后返回必须恢复同一 startValue/endValue。
    await evalJs(`(() => { const {chart}=${inspectExpr('.period-m30 .chart-canvas')};chart.dispatchAction({type:'dataZoom',startValue:281,endValue:299}); })()`, sessionId);
    const saved30 = await chartSnapshot('.period-m30 .chart-canvas', sessionId);
    if (saved30.count !== 19) throw new Error('30分19根索引定位失败：'+JSON.stringify(saved30));

    // 30分钟当前视窗 → 5分钟主图；主图限制可读根数，上级显示覆盖带。
    await evalJs(`${buttonExpr('.drill-actions button', '进入5分钟', true)}?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart').length===3 && !!document.querySelector('.period-m5')`, sessionId);
    await sleep(500);
    depth = JSON.parse(await evalJs(`(() => {
      const d=document.querySelector('.period-d')?.getBoundingClientRect(), m=document.querySelector('.period-m30')?.getBoundingClientRect(), f=document.querySelector('.period-m5')?.getBoundingClientRect();
      const range=document.querySelector('.period-m5 .period-range')?.textContent??'';
      return JSON.stringify({charts:document.querySelectorAll('.multi-chart').length,path:document.querySelector('.drill-path')?.textContent,className:document.querySelector('.multi-charts')?.className,dayH:d?.height??0,m30H:m?.height??0,m5H:f?.height??0,range,visible:Number((range.match(/可见 (\\d+)\\//)||[])[1]||0),dataWindows:document.querySelectorAll('.chart-data-window').length});
    })()`, sessionId));
    if (depth.charts !== 3 || !depth.className.includes('depth-3') || depth.m5H <= depth.m30H || depth.m30H <= depth.dayH || depth.visible <= 0 || depth.visible > 620 || depth.dataWindows !== 1) throw new Error('30分钟→5分钟当前层主图失败：' + JSON.stringify(depth));
    depth.actual = await chartSnapshot('.period-m5 .chart-canvas', sessionId);
    depth.idle = await idleRebuilds('.period-m5 .chart-canvas', sessionId);
    if (depth.idle.rebuilds !== 0 || depth.actual.structures.some(s=>s.processed < s.overlap)) throw new Error('5分持续重绘或跨窗口结构遗漏：'+JSON.stringify(depth));
    depth.saved30 = saved30;
    // 主图悬停：真实数据窗更新且跨图覆盖同步不报错。
    const mainRect = JSON.parse(await evalJs(`(() => { const r=document.querySelector('.period-m5 canvas').getBoundingClientRect(); return JSON.stringify([r.left,r.top,r.width,r.height]); })()`, sessionId));
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: mainRect[0] + mainRect[2] * .5, y: mainRect[1] + mainRect[3] * .4 }, sessionId);
    await sleep(250);
    if (!(await evalJs(`(() => { const t=document.querySelector('.period-m5 .chart-data-window')?.textContent??''; return t.includes('价格') && t.includes('时间=柱结束'); })()`, sessionId))) throw new Error('主图悬停数据窗失败');
    await shot(sessionId, `M6_5分钟联动_${label}.png`, width);

    if (label === '桌面') {
      // 两点测距：价差/百分比/根数，不触发下钻。
      await evalJs(`${buttonExpr('.multi-tools button', '测距')}?.click()`, sessionId);
      await waitFor(`!!document.querySelector('.chart-measure-hint')`, sessionId);
      // 两点都必须落在价格主图 grid（副图区域不参与价格测距）。
      for (const [rx, ry] of [[.32, .3], [.68, .45]]) {
        const x = mainRect[0] + mainRect[2] * rx, y = mainRect[1] + mainRect[3] * ry;
        // zrender 在重绘后需要一次真实 hover 再接收第二点，模拟用户正常移动鼠标。
        await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);
        await sleep(60);
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, sessionId);
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, sessionId);
        await sleep(180);
      }
      await waitFor(`!!document.querySelector('.chart-measure-box') && document.querySelector('.chart-measure-box').textContent.includes('含端点')`, sessionId, 4000);
      const measure = await evalJs(`document.querySelector('.chart-measure-box')?.textContent??''`, sessionId);
      if (!measure.includes('元') || !measure.includes('自然间隔')) throw new Error('测距结果缺单位/距离：' + measure);
      await shot(sessionId, 'M6_两点测距_桌面.png', width);
      await evalJs(`${buttonExpr('.multi-tools button', '测距')}?.click()`, sessionId);
    }

    // 5分跨到另一日期后，每个上级都投影当前主图，日线单柱带不能零宽。
    await evalJs(`(() => {const {chart,bars}=${inspectExpr('.period-m5 .chart-canvas')};const day=bars[1000].date.slice(0,10),start=bars.findIndex(b=>b.date.startsWith(day))+3;chart.dispatchAction({type:'dataZoom',startValue:start,endValue:start+11});})()`, sessionId);
    await waitFor(`(() => {const {chart}=${inspectExpr('.period-d .chart-canvas')};const band=chart.getOption().series.find(s=>s.id==='视窗覆盖')?.data.find(x=>x.value[2]===1);return !!band&&band.value[0]===band.value[1];})()`, sessionId);
    depth.singleBarCoverage = await evalJs(`(() => {const {chart}=${inspectExpr('.period-d .chart-canvas')};const s=chart.getModel().getSeries().find(s=>s.id==='视窗覆盖'),el=s.getData().getItemGraphicEl(0);return {width:el.getBoundingRect().width,data:chart.getOption().series.find(s=>s.id==='视窗覆盖').data};})()`, sessionId);
    if (!(depth.singleBarCoverage.width>0)) throw new Error('单柱覆盖不可见：'+JSON.stringify(depth.singleBarCoverage));
    await evalJs(`${buttonExpr('.drill-actions button', '返回上级')}?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart').length===2 && document.querySelector('.drill-path')?.textContent.includes('30分钟')`, sessionId);
    depth.returned30 = await chartSnapshot('.period-m30 .chart-canvas', sessionId);
    if (depth.returned30.start !== saved30.start || depth.returned30.end !== saved30.end) throw new Error('返回30分未恢复手调视窗：'+JSON.stringify({saved30,returned:depth.returned30}));
    await evalJs(`${buttonExpr('.multi-tools button', '口径设置')}?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.ant-drawer .cfg-dim .ant-select').length===12`, sessionId);
    await evalJs(`document.querySelector('.ant-drawer-close')?.click()`, sessionId);
    await waitFor(`!document.querySelector('.ant-drawer-open')`, sessionId);
    await evalJs(`${buttonExpr('.drill-actions button', '恢复全局')}?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart').length===1 && !!document.querySelector('.period-d')`, sessionId);

    if (label === '桌面') {
      // 全历史清单的离屏旧结构必须真正定位到图内，不只改详情。
      await evalJs(`[...document.querySelectorAll('.list-filter .ant-segmented-item')].find(x=>x.textContent==='全部历史')?.click()`, sessionId);
      await waitFor(`document.querySelectorAll('.structure-row').length>3`, sessionId);
      await evalJs(`document.querySelector('.structure-row:last-child')?.click()`, sessionId);
      await waitFor(`(() => { const {chart}=${inspectExpr('.period-d .chart-canvas')};const o=chart.getOption(),z=o.dataZoom[0],s=o.series.find(x=>x.name==='线段').data.find(x=>x.value[5]===1);return !!s && s.value[0]>=z.startValue && s.value[2]<=z.endValue; })()`, sessionId);
      multi.reverseLocate = await chartSnapshot('.period-d .chart-canvas', sessionId);
      multi.reverseLocate.object = await evalJs(`document.querySelector('.object-time')?.textContent`, sessionId);
      await shot(sessionId, 'R_清单反向定位_桌面.png', width);
      await evalJs(`${buttonExpr('.drill-actions button', '恢复全局')}?.click()`, sessionId);
      // 图层：默认买卖点/成交量开启；恢复默认；合并实体可切。
      await evalJs(`${buttonExpr('.multi-tools button', '图层', true)}?.click()`, sessionId);
      await waitFor(`document.querySelectorAll('.layer-popover .ant-checkbox-wrapper').length===9`, sessionId);
      for (const name of ['买卖点', '成交量副图']) {
        if (!(await evalJs(`[...document.querySelectorAll('.layer-popover .ant-checkbox-wrapper')].find(x=>x.textContent.trim()===${JSON.stringify(name)})?.classList.contains('ant-checkbox-wrapper-checked')`, sessionId))) throw new Error(`默认图层未开启：${name}`);
      }
      await evalJs(`[...document.querySelectorAll('.layer-popover .ant-checkbox-wrapper')].find(x=>x.textContent.trim()==='分型')?.click()`, sessionId);
      await waitFor(`[...document.querySelectorAll('.layer-popover .ant-checkbox-wrapper')].find(x=>x.textContent.trim()==='分型')?.classList.contains('ant-checkbox-wrapper-checked')`, sessionId);
      await evalJs(`document.querySelector('.layer-popover-head button')?.click()`, sessionId);
      await waitFor(`![...document.querySelectorAll('.layer-popover .ant-checkbox-wrapper')].find(x=>x.textContent.trim()==='分型')?.classList.contains('ant-checkbox-wrapper-checked')`, sessionId);
      await evalJs(`[...document.querySelectorAll('.multi-tools button')].find(b=>b.textContent.startsWith('图层'))?.click()`, sessionId);
      await evalJs(`[...document.querySelectorAll('.merge-switch .ant-segmented-item')].find(x=>x.textContent==='合并实体')?.click()`, sessionId);
      await waitFor(`document.querySelector('.merge-switch .ant-segmented-item-selected')?.textContent==='合并实体'`, sessionId);
      await evalJs(`[...document.querySelectorAll('.merge-switch .ant-segmented-item')].find(x=>x.textContent==='原始实体')?.click()`, sessionId);
      await waitFor(`document.querySelector('.merge-switch .ant-segmented-item-selected')?.textContent==='原始实体'`, sessionId);

      // 鼠标锚定缩放、普通滚轮平移。
      const dayRect = JSON.parse(await evalJs(`(() => { const r=document.querySelector('.period-d canvas').getBoundingClientRect(); return JSON.stringify([r.left,r.top,r.width,r.height]); })()`, sessionId));
      const mx = dayRect[0] + dayRect[2] * .55, my = dayRect[1] + dayRect[3] * .35;
      const range0 = await evalJs(`document.querySelector('.period-d .period-range')?.textContent??''`, sessionId);
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: 0, deltaY: -120, modifiers: 2 }, sessionId);
      await waitFor(`document.querySelector('.period-d .period-range')?.textContent !== ${JSON.stringify(range0)}`, sessionId, 5000);
      const range1 = await evalJs(`document.querySelector('.period-d .period-range')?.textContent??''`, sessionId);
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: mx, y: my, deltaX: -140, deltaY: 0 }, sessionId);
      await waitFor(`document.querySelector('.period-d .period-range')?.textContent !== ${JSON.stringify(range1)}`, sessionId, 5000);
      await shot(sessionId, 'M6_日线缩放_桌面.png', width);
    }

    // 学习/对比/练习回归。
    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='学习回放')?.click()`, sessionId);
    await waitFor(`!!document.querySelector('.chart-wrap canvas') && !!document.querySelector('.replaybar')`, sessionId);
    await sleep(400);
    const learn = JSON.parse(await evalJs(`(() => {
      const c=document.querySelector('canvas');
      return JSON.stringify({canvasCount:document.querySelectorAll('canvas').length,canvasW:c?c.width:0,
        configSelects:document.querySelectorAll('.cfg-dim .ant-select').length,
        events:document.querySelectorAll('.event').length,
        pos:document.querySelector('.replaybar .pos')?.textContent??'',
        docWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth});
    })()`, sessionId));
    if (learn.canvasW <= 0 || learn.configSelects < 6 || learn.events <= 0) throw new Error('学习模式渲染失败：' + JSON.stringify(learn));
    const before = learn.pos;
    await evalJs(`[...document.querySelectorAll('.replaybar button')].find(b=>b.textContent==='−1')?.click()`, sessionId);
    await waitFor(`document.querySelector('.replaybar .pos')?.textContent !== ${JSON.stringify(before)}`, sessionId);
    const after = await evalJs(`document.querySelector('.replaybar .pos').textContent`, sessionId);
    if (after === before) throw new Error('回放步进未改变游标');
    await shot(sessionId, `M6_学习模式_${label}.png`, width);

    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='口径对比')?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('canvas').length===2`, sessionId);
    await sleep(400);
    const compare = JSON.parse(await evalJs(`(() => JSON.stringify({canvases:document.querySelectorAll('canvas').length,diffs:document.querySelectorAll('.diff-item').length}))()`, sessionId));
    if (compare.canvases !== 2 || compare.diffs <= 0) throw new Error('对比模式失败：' + JSON.stringify(compare));
    await shot(sessionId, `M6_口径对比_${label}.png`, width);

    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='分型练习')?.click()`, sessionId);
    await waitFor(`!!document.querySelector('.chart-wrap canvas') && [...document.querySelectorAll('button')].some(b=>b.textContent==='提交对照')`, sessionId);
    await sleep(400);
    let practice = { marked: false };
    if (label === '桌面') {
      const rect = JSON.parse(await evalJs(`(() => { const c=document.querySelector('.chart-wrap canvas'); const r=c.getBoundingClientRect(); return JSON.stringify([r.left,r.top,r.width,r.height]); })()`, sessionId));
      const cy = rect[1] + rect[3] * 0.5;
      for (let x = rect[0] + 100; x < rect[0] + Math.min(rect[2] - 30, 520); x += 18) {
        await call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y: cy, button: 'left', clickCount: 1 }, sessionId);
        await call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y: cy, button: 'left', clickCount: 1 }, sessionId);
      }
      await waitFor(`Number((document.querySelector('.replaybar .pos')?.textContent.match(/已标 (\\d+)/)||[])[1]||0) > 0`, sessionId, 6000).catch(() => {});
      const markCount = await evalJs(`Number((document.querySelector('.replaybar .pos')?.textContent.match(/已标 (\\d+)/)||[])[1]||0)`, sessionId);
      practice.marked = markCount > 0;
      practice.markCount = markCount;
      if (practice.marked) {
        await evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent==='提交对照')?.click()`, sessionId);
        await waitFor(`document.querySelectorAll('.mark-list .mark').length>0`, sessionId);
        await sleep(300);
        practice.judgments = await evalJs(`document.querySelectorAll('.mark-list .mark').length`, sessionId);
        practice.score = await evalJs(`document.querySelector('.replaybar .pos[style]')?.textContent ?? ''`, sessionId);
        practice.persisted = await evalJs(`!!localStorage.getItem('chan-viewer-practice-v1')`, sessionId);
        if (!practice.judgments || !practice.persisted) throw new Error('练习对照/持久化失败：' + JSON.stringify(practice));
      } else {
        throw new Error('练习标记未能触发（点击未映射到K线）');
      }
    }
    await shot(sessionId, `M6_分型练习_${label}.png`, width);

    const overflow = learn.docWidth > learn.clientWidth + 1 || learn.clientWidth > width;
    if (overflow) throw new Error(`${label}横向溢出：` + JSON.stringify(learn));
    checks.push({ '设备': label, '初始日线': multi, '两级下钻': depth, '学习': learn, '回放': { before, after }, '对比': compare, '练习': practice, '无横向溢出': !overflow });
    console.log(JSON.stringify({ '设备': label, charts: multi.charts, m5Visible: depth.visible, events: learn.events, diffs: compare.diffs, '练习标记': practice.markCount ?? '—' }));
  }

  if (consoleErrors.length) throw new Error('控制台错误：' + consoleErrors.join(' | '));
  fs.writeFileSync(path.join(reportDir, '页面核验.json'), JSON.stringify({ checks, consoleErrors, '全部通过': true, headed: HEADED }, null, 1));
  console.log(`控制台错误：0；页面核验全部通过${HEADED ? '（有界面 Chrome）' : ''} → 报告/页面核验.json`);
  await call('Browser.close');
})().catch((e) => { console.error('页面核验失败：', e.message); process.exitCode = 1; chrome.kill(); })
  .finally(async () => { clearTimeout(timer); server.kill(); await Promise.all([chromeExited, serverExited]); });

async function shot(sessionId, name, width) {
  const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: 950, scale: 1 } }, sessionId);
  fs.writeFileSync(path.join(reportDir, name), Buffer.from(s.data, 'base64'));
}
