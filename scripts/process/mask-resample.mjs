// 掩膜重采样:DEM 换源换分辨率(218 m → 120 m)后,省界掩膜需按新网格重算
//
// 逻辑与 dem.mjs 一致:最近邻重采样硬掩膜 → 软边缘(edgeFade,按比例缩放衰减格数)
// → 外扩掩膜(省界外 N 格内仍渲染,压平为基座搁边)。距离变换为 chamfer 3-4。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PROC = path.join(ROOT, 'data/processed/terrain');
const RT = path.join(ROOT, 'public/runtime/terrain');

const oldMeta = JSON.parse(fs.readFileSync(path.join(PROC, 'meta_218m.json'), 'utf8'));
const newMeta = JSON.parse(fs.readFileSync(path.join(RT, 'terrain.meta.json'), 'utf8'));
const o = oldMeta.grid, n = newMeta.grid;
const oldHard = new Uint8Array(fs.readFileSync(path.join(PROC, 'mask_218m.bin')).buffer);

if (o.cols === n.cols && o.rows === n.rows) {
  console.log('[mask] 网格未变化,跳过');
  process.exit(0);
}
const scale = (n.dLon * 111320 * Math.cos(26.8 * Math.PI / 180)) / (o.dLon * 111320 * Math.cos(26.8 * Math.PI / 180));

// ── 最近邻重采样硬掩膜 ──
const hard = new Uint8Array(n.cols * n.rows);
for (let r = 0; r < n.rows; r++) {
  const orr = Math.min(o.rows - 1, Math.max(0, Math.round((o.north - (n.north - (r + 0.5) * n.dLat)) / o.dLat)));
  for (let c = 0; c < n.cols; c++) {
    const oc = Math.min(o.cols - 1, Math.max(0, Math.round((n.west + (c + 0.5) * n.dLon - o.west) / o.dLon)));
    hard[r * n.cols + c] = oldHard[orr * o.cols + oc];
  }
}

/**
 * chamfer 3-4 距离变换:源为"外部"格(hard==0),得到每格到最近外部格的近似距离
 * → 内部格 d>0(离边界越远越大),边界 d=0
 *   soft = f(d) 给出"内部到边界"的渐隐;wide = d<=阈值 给出省界外缓冲带
 */
function chamfer(inside, cols, rows) {
  const INF = 65535;
  const d = new Uint16Array(cols * rows).fill(INF);
  for (let i = 0; i < d.length; i++) if (!inside[i]) d[i] = 0;
  const D1 = 3, D2 = 4;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (d[i] === 0) continue;
    let v = d[i];
    if (c > 0) v = Math.min(v, d[i - 1] + D1);
    if (r > 0) {
      v = Math.min(v, d[i - cols] + D1);
      if (c > 0) v = Math.min(v, d[i - cols - 1] + D2);
      if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + D2);
    }
    d[i] = v;
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c; if (d[i] === 0) continue;
    let v = d[i];
    if (c < cols - 1) v = Math.min(v, d[i + 1] + D1);
    if (r < rows - 1) {
      v = Math.min(v, d[i + cols] + D1);
      if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + D2);
      if (c > 0) v = Math.min(v, d[i + cols - 1] + D2);
    }
    d[i] = v;
  }
  return d;
}

// 软边缘:省界外 10 格(218m 基准)渐隐 → 按新分辨率折算
const fadeCells = Math.max(2, Math.round(10 * scale));
const d = chamfer(hard, n.cols, n.rows);
const soft = new Uint8Array(n.cols * n.rows);
for (let i = 0; i < d.length; i++) {
  if (!hard[i]) { soft[i] = 0; continue; }
  soft[i] = Math.round(255 * Math.min(1, d[i] / (fadeCells * 3)));
}
// 外扩掩膜:省界外 26 格(218m 基准 ≈ 5.6 km)内仍渲染
const wideDist = Math.round(78 * scale);
const wide = new Uint8Array(n.cols * n.rows);
for (let i = 0; i < d.length; i++) wide[i] = d[i] <= wideDist ? 255 : 0;

fs.writeFileSync(path.join(RT, 'terrain.mask.bin'), Buffer.from(soft.buffer));
fs.writeFileSync(path.join(RT, 'terrain.maskwide.bin'), Buffer.from(wide.buffer));
fs.writeFileSync(path.join(PROC, 'maskHard.bin'), Buffer.from(hard.buffer));
console.log(`[mask] ${o.cols}×${o.rows} @218m → ${n.cols}×${n.rows} @120m;软边缘 ${fadeCells} 格,外扩 ${wideDist} 格`);
