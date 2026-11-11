'use strict';
// 一条命令起全套（开发模式）：数据服务(8787, tsx 免构建) + Vite 前端(5173, 代理 /api)。
// 生产模式请用：npm run build && npm start（单进程托管 dist + api）。
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const env = { ...process.env, NODE_OPTIONS: '--no-warnings' };

const server = spawn('npx', ['tsx', 'apps/server/src/index.ts'], { cwd: root, env, stdio: 'inherit' });
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: path.join(root, 'apps/web'), env, stdio: 'inherit' });

console.log('\n[缠论视图] 开发模式启动中…');
console.log('[缠论视图] 前端：http://localhost:5173  （/api 代理到 8787）');
console.log('[缠论视图] 数据服务：http://127.0.0.1:8787\n');

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.kill('SIGTERM');
  vite.kill('SIGTERM');
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
server.on('exit', (c) => { if (!shuttingDown) { console.error('数据服务退出', c); shutdown(); } });
vite.on('exit', (c) => { if (!shuttingDown) { console.error('Vite 退出', c); shutdown(); } });