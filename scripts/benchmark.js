// benchmark:npm run benchmark
// 说明:FPS/DrawCalls 等需在浏览器中采集(页面 ?debug=1,或 window.__GZ_PERF__.getStats())。
// 本脚本输出采集指引与最近一次记录的结果(docs/PERFORMANCE.md)。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const perfPath = path.join(ROOT, 'docs/PERFORMANCE.md');

console.log(`
Guizhou Sandbox Benchmark
─────────────────────────
采集方式:
  1. npm run dev → 打开 http://127.0.0.1:5173/?debug=1
  2. 左上角 HUD 实时显示 FPS / DrawCalls / Triangles / CamDist / Tiles
  3. 或在控制台执行: __GZ_PERF__.getStats()
  4. 视角切换: ?view=overview|north|west|central|south|city|river|closeup
  5. 高程夸张: ?exaggeration=3 (默认 2.8)

历史采集结果见: ${path.relative(ROOT, perfPath)}

自动化采集(推荐,跨版本可比):
  1) 用带调试端口的浏览器打开页面(必须可见窗口,后台标签 rAF 会被节流到 1Hz):
     "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \\
       --remote-debugging-port=9222 --user-data-dir=/tmp/gz-bench-profile \\
       http://127.0.0.1:5173/?view=overview&debug=1
  2) node scripts/benchmark-cdp.mjs [视角...]
     输出:FPS / DrawCalls / Triangles(等待瓦片构建完成后再读数)
`);
if (fs.existsSync(perfPath)) {
  console.log(fs.readFileSync(perfPath, 'utf8'));
}
