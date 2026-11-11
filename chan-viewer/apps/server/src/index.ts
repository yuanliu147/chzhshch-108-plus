// 本地数据服务入口：node:http + node:sqlite，零运行时依赖。
// 开发：Vite 代理 /api 到此；生产：兼静态托管 apps/web/dist。
// node:sqlite 实验特性警告由启动脚本 --no-warnings 过滤。
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleApi } from './routes.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.CHAN_PORT ?? 8787);
const DIST = path.resolve(__dirname, '../../web/dist');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

async function serveStatic(reqPath: string, res: http.ServerResponse): Promise<void> {
  let rel = decodeURIComponent(reqPath.split('?')[0] ?? '/');
  if (rel === '/') rel = '/index.html';
  const file = path.resolve(DIST, '.' + rel);
  if (!file.startsWith(DIST)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream' });
    res.end(buf);
  } catch {
    // SPA 回退
    try {
      const buf = await readFile(path.join(DIST, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('前端尚未构建。开发请用 npm run dev（Vite + 数据服务），或先 npm run build。');
    }
  }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    try {
      if (!handleApi(req, res, url)) {
        res.writeHead(404).end('not found');
      }
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: String(e instanceof Error ? e.message : e) }));
    }
    return;
  }
  void serveStatic(url.pathname, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[缠论视图] 数据服务已启动：http://127.0.0.1:${PORT}`);
  console.log(`[缠论视图] 数据库：${process.env.CHAN_DB_PATH ?? '/Users/admin/WorkSpace/baostock_data/data/baostock.db'}（只读）`);
});