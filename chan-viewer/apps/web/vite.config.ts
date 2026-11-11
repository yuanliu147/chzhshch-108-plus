import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：/api 代理到本地数据服务（node:http + node:sqlite，零运行时依赖）
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:8787',
    },
  },
  build: {
    outDir: 'dist',
    chunkSizeWarningLimit: 1200,
  },
});