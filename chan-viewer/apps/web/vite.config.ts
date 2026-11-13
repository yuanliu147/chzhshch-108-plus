import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发模式：/api 代理到本地数据服务（node:http + node:sqlite，零运行时依赖）
export default defineConfig({
  plugins: [react()],
  // antd CSS-in-JS、React 与 rc-util 必须共用同一预打包实例，避免首屏样式缓存错配。
  resolve: { dedupe: ['react', 'react-dom', '@ant-design/cssinjs', '@rc-component/util'] },
  optimizeDeps: {
    include: ['react', 'react-dom', 'react-dom/client', 'antd', '@ant-design/cssinjs', '@rc-component/util', 'zustand', 'zustand/middleware'],
  },
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