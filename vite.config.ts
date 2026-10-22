import { defineConfig } from 'vite';
import path from 'node:path';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';

const PUBLIC_DIR = path.resolve(__dirname, 'public');

// public/runtime 下的数据文件没有内容哈希文件名,用数据指纹当版本号:
// 数据没变则请求 URL 稳定(可被浏览器/CDN 长期缓存),数据重新预处理后自动失效
function runtimeVersion(): string {
  const root = path.join(PUBLIC_DIR, 'runtime');
  if (!existsSync(root)) return 'nodata';
  const h = createHash('sha1');
  const walk = (dir: string) => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      const s = statSync(p);
      h.update(`${path.relative(root, p)}:${s.size}:${Math.floor(s.mtimeMs)}\n`);
    }
  };
  walk(root);
  return h.digest('hex').slice(0, 10);
}

export default defineConfig(({ command }) => ({
  root: path.resolve(__dirname, 'app'),
  publicDir: PUBLIC_DIR,
  base: './',
  define: {
    // dev 每次启动都换版本号,避免读到旧的预处理产物
    __RUNTIME_VERSION__: JSON.stringify(command === 'serve' ? `dev${Date.now()}` : runtimeVersion())
  },
  build: {
    outDir: path.resolve(__dirname, 'dist/web'),
    emptyOutDir: true,
    target: 'es2022',
    chunkSizeWarningLimit: 4096
  },
  server: {
    port: 5173,
    host: '127.0.0.1'
  },
  preview: {
    port: 4173,
    host: '127.0.0.1'
  }
}));
