// 单文件构建:npm run build-single → dist/guizhou-terrain.html
// 产物:全部 JS/CSS 内联 + 运行时数据 gzip+base64 内嵌(window.__GZ_EMBED__,键前缀 gz://)
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist/web');
const OUT = path.join(ROOT, 'dist/guizhou-terrain.html');

function b64(fp) {
  return fs.readFileSync(fp).toString('base64');
}

console.log('[1/3] vite build …');
execSync('npx vite build', { cwd: ROOT, stdio: 'inherit' });

console.log('[2/3] 收集运行时数据(gzip 压缩;DecompressionStream 不支持 br,故用 gzip)…');
const embed = {};
const rtDir = path.join(ROOT, 'public/runtime');
for (const dir of fs.readdirSync(rtDir)) {
  const sub = path.join(rtDir, dir);
  if (!fs.statSync(sub).isDirectory()) continue;
  for (const f of fs.readdirSync(sub)) {
    const fp = path.join(sub, f);
    embed[`gz://runtime/${dir}/${f}`] = gzipSync(fs.readFileSync(fp), { level: 9 }).toString('base64');
  }
}
const embedMB = Object.values(embed).reduce((s, v) => s + v.length, 0) / 1e6;

console.log('[3/3] 内联 JS/CSS + 数据 …');
let html = fs.readFileSync(path.join(DIST, 'index.html'), 'utf8');
// 内联 CSS
html = html.replace(/<link rel="stylesheet" crossorigin href="\.?\/?([^"]+\.css)">/g, (_, href) => {
  const css = fs.readFileSync(path.join(DIST, href), 'utf8');
  return `<style>${css}</style>`;
});
// 内联 JS + 注入数据
const scriptRe = /<script type="module" crossorigin src="\.?\/?([^"]+\.js)"><\/script>/;
const m = html.match(scriptRe);
if (!m) throw new Error('未找到构建 JS 入口');
const js = fs.readFileSync(path.join(DIST, m[1]), 'utf8');
const embedScript = `<script>window.__GZ_EMBED__=${JSON.stringify(embed)}</script>`;
// 注意:必须用函数替换,避免 bundle 中的 $&/$' 等 replace 特殊序列破坏内联代码
html = html.replace(scriptRe, () => `${embedScript}<script type="module">${js}</script>`);

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, html);
console.log(`DONE: dist/guizhou-terrain.html (${(fs.statSync(OUT).size / 1e6).toFixed(1)}MB, 数据 ${embedMB.toFixed(1)}MB base64)`);
