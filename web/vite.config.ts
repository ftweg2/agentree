import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 开发服务器只监听本机回环地址，/api 代理到后端 127.0.0.1:4777。
// 模拟数据：设置环境变量 VITE_USE_MOCK=1，或运行 `npm run dev:mock`（读取 .env.mock）。
// 联调时可以用环境变量 AGENTREE_API 临时改代理目标，默认 http://127.0.0.1:4777
const API_TARGET = process.env.AGENTREE_API || 'http://127.0.0.1:4777';

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
    fs: {
      // 允许读取 ../shared（类型文件只在编译期使用，这里是保险）
      allow: ['..'],
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': {
        target: API_TARGET,
        changeOrigin: false,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
  },
});
