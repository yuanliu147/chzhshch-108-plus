'use strict';
// 页面核验：自起生产服务（dist + api，测试端口 8799），手写 CDP 驱动本机 headless Chrome，
// 双视口(1280/390)断言三模式渲染与交互、控制台 0 错误、无横向溢出，落截图+JSON。
// 沿用仓库 手册页面核验.js 的 CDP 模式（--remote-debugging-pipe，fd3/4，\0 分隔）。
// 用法：先 npm run build，再 node tools/page_check.js
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const reportDir = path.join(root, '报告');
const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;

if (!fs.existsSync(path.join(root, 'apps/web/dist/index.html'))) {
  console.error('缺少前端构建产物，请先运行：npm run build');
  process.exit(1);
}
fs.mkdirSync(reportDir, { recursive: true });

// ---- 起服务 ----
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

// ---- CDP ----
const profile = fs.mkdtempSync(path.join(reportDir, '浏览器核验_'));
const chrome = spawn('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', [
  '--headless=new', '--disable-gpu', '--no-first-run', '--disable-background-networking',
  '--disable-component-update', '--disable-sync', '--user-data-dir=' + profile,
  '--remote-debugging-pipe'], { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
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
  const r = await call('Runtime.evaluate', { expression, returnByValue: true }, sessionId);
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
const timer = setTimeout(() => { console.error('总超时'); chrome.kill(); server.kill(); process.exitCode = 1; }, 180000);

(async () => {
  await waitServer();
  const { targetId } = await call('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await call('Target.attachToTarget', { targetId, flatten: true });
  await call('Page.enable', {}, sessionId);
  await call('Runtime.enable', {}, sessionId);
  const checks = [];

  for (const [label, width] of [['桌面', 1280], ['手机', 390]]) {
    await call('Emulation.setDeviceMetricsOverride', { width, height: 950, deviceScaleFactor: 1, mobile: label === '手机' }, sessionId);
    const loaded = new Promise((r) => { const fn = (m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === sessionId) { listeners = listeners.filter((f) => f !== fn); r(); } }; listeners.push(fn); });
    await call('Page.navigate', { url: BASE + '/?v=' + label }, sessionId);
    await loaded;
    await waitFor(`!!document.querySelector('.meta') && document.querySelector('.meta').textContent.includes('根') && document.querySelectorAll('canvas').length>0`, sessionId);
    await sleep(400);

    // 学习模式
    const learn = JSON.parse(await evalJs(`(() => {
      const c=document.querySelector('canvas');
      return JSON.stringify({canvasCount:document.querySelectorAll('canvas').length,canvasW:c?c.width:0,
        configSelects:document.querySelectorAll('.cfg-dim .ant-select').length,
        events:document.querySelectorAll('.event').length,
        pos:document.querySelector('.replaybar .pos')?.textContent??'',
        docWidth:document.documentElement.scrollWidth,clientWidth:document.documentElement.clientWidth});
    })()`, sessionId));
    if (learn.canvasW <= 0 || learn.configSelects < 6 || learn.events <= 0) throw new Error('学习模式渲染失败：' + JSON.stringify(learn));
    // 回放步进
    const before = learn.pos;
    await evalJs(`[...document.querySelectorAll('.replaybar button')].find(b=>b.textContent==='−1')?.click()`, sessionId);
    await waitFor(`document.querySelector('.replaybar .pos')?.textContent !== ${JSON.stringify(before)}`, sessionId);
    const after = await evalJs(`document.querySelector('.replaybar .pos').textContent`, sessionId);
    if (after === before) throw new Error('回放步进未改变游标');
    await shot(sessionId, `P7_学习模式_${label}.png`, width);

    // 对比模式
    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='口径对比')?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('canvas').length===2`, sessionId);
    await sleep(400);
    const compare = JSON.parse(await evalJs(`(() => JSON.stringify({canvases:document.querySelectorAll('canvas').length,diffs:document.querySelectorAll('.diff-item').length}))()`, sessionId));
    if (compare.canvases !== 2 || compare.diffs <= 0) throw new Error('对比模式失败：' + JSON.stringify(compare));
    await shot(sessionId, `P7_口径对比_${label}.png`, width);

    // 练习模式
    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='分型练习')?.click()`, sessionId);
    await waitFor(`!!document.querySelector('.chart-wrap canvas') && [...document.querySelectorAll('button')].some(b=>b.textContent==='提交对照')`, sessionId);
    await sleep(400);
    let practice = { marked: false };
    if (label === '桌面') {
      // 用 CDP 可信鼠标事件在题窗内散布点击标记分型（zrender 只认真实输入事件）。
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
    await shot(sessionId, `P7_分型练习_${label}.png`, width);

    // 多周期区间套模式（日线/30分/5分 三图联立）。
    await evalJs(`[...document.querySelectorAll('.ant-segmented-item')].find(t=>t.textContent==='多周期区间套')?.click()`, sessionId);
    await waitFor(`document.querySelectorAll('.multi-chart canvas').length===3`, sessionId, 22000);
    await sleep(800);
    const multi = JSON.parse(await evalJs(`(() => JSON.stringify({canvases:document.querySelectorAll('.multi-chart canvas').length}))()`, sessionId));
    if (multi.canvases !== 3) throw new Error('多周期区间套模式失败：' + JSON.stringify(multi));
    await shot(sessionId, `P7_多周期区间套_${label}.png`, width);

    const overflow = learn.docWidth > learn.clientWidth + 1 || learn.clientWidth > width;
    if (overflow) throw new Error(`${label}横向溢出：` + JSON.stringify(learn));
    checks.push({ 设备: label, 学习: learn, 回放: { before, after }, 对比: compare, 练习: practice, 多周期: multi, 无横向溢出: !overflow });
    console.log(JSON.stringify({ 设备: label, canvasW: learn.canvasW, events: learn.events, diffs: compare.diffs, 练习标记: practice.markCount ?? '—' }));
  }

  if (consoleErrors.length) throw new Error('控制台错误：' + consoleErrors.join(' | '));
  fs.writeFileSync(path.join(reportDir, '页面核验.json'), JSON.stringify({ checks, consoleErrors, 全部通过: true }, null, 1));
  console.log('控制台错误：0；页面核验全部通过 → 报告/页面核验.json');
  await call('Browser.close');
})().catch((e) => { console.error('页面核验失败：', e.message); process.exitCode = 1; chrome.kill(); })
  .finally(async () => { clearTimeout(timer); server.kill(); await Promise.all([chromeExited, serverExited]); });

async function shot(sessionId, name, width) {
  const s = await call('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width, height: 950, scale: 1 } }, sessionId);
  fs.writeFileSync(path.join(reportDir, name), Buffer.from(s.data, 'base64'));
}