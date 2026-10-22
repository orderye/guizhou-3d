// 基准采集(CDP):连接带 --remote-debugging-port 的 Chrome/Edge 窗口,
// 逐视角读取页面内 __GZ_PERF__.getStats(),输出方案 §53 性能报告所需指标。
//
// 为什么要 CDP 而不是手看 HUD:
//   ① 浏览器后台标签的 requestAnimationFrame 被节流到 1Hz,HUD 的 FPS 会失真
//      (V3.8 记录过"假性 FPS 0");CDP 的 Page.bringToFront 可保证前台渲染。
//   ② 同一环境采集旧版本基线,才能得到可比的增量数据。
//
// 用法:
//   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
//     --remote-debugging-port=9222 --user-data-dir=/tmp/gz-bench-profile <url>
//   node scripts/benchmark-cdp.mjs [视角...]        # 默认 5 个视角
//   node scripts/benchmark-cdp.mjs --url http://127.0.0.1:5174/ overview
const CDP = process.env.GZ_CDP || 'http://127.0.0.1:9222';
const args = process.argv.slice(2);
const urlIdx = args.indexOf('--url');
const BASE = urlIdx >= 0 ? args[urlIdx + 1] : 'http://127.0.0.1:5173/';
const VIEWS = args.filter((a, i) => !a.startsWith('--') && i !== urlIdx + 1);
const views = VIEWS.length ? VIEWS : ['overview', 'central', 'city', 'closeup', 'river'];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`${CDP}/json/list`)).json();
      const p = list.find(t => t.type === 'page' && t.url.startsWith(BASE.replace(/\/$/, '')));
      if (p) return p;
    } catch { /* 等待浏览器启动 */ }
    await sleep(500);
  }
  throw new Error(`未找到 ${BASE} 的调试页面(浏览器是否已带 --remote-debugging-port 启动?)`);
}

const page = await findPage();
const ws = new WebSocket(page.webSocketDebuggerUrl);
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
const send = (method, params = {}) => new Promise(res => {
  const id = ++msgId;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Runtime.enable');

const rows = [];
for (const view of views) {
  await send('Page.bringToFront');
  await send('Page.navigate', { url: `${BASE}?view=${view}&debug=1` });
  await sleep(1500);
  await send('Page.bringToFront');
  // 等待瓦片渐进构建完成(三角形数连续多次不变)且帧率稳定
  let stats = null, prevTri = -1, stable = 0;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const raw = await evaluate('JSON.stringify(window.__GZ_PERF__ ? window.__GZ_PERF__.getStats() : null)');
    if (!raw) continue;
    const s = JSON.parse(raw);
    if (s.triangles === prevTri && s.fps > 20) { if (++stable >= 3) { stats = s; break; } } else stable = 0;
    prevTri = s.triangles;
    stats = s;
  }
  if (!stats) { console.error(`${view}: 采集失败`); continue; }
  rows.push({ view, fps: stats.fps, calls: stats.drawCalls, tri: stats.triangles });
  console.log(`${view.padEnd(9)} FPS ${String(stats.fps).padStart(3)}  DrawCalls ${String(stats.drawCalls).padStart(3)}  Triangles ${(stats.triangles / 1e6).toFixed(2)}M`);
}
ws.close();
