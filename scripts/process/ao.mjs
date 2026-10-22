// 环境光遮蔽(AO):基于真实 DEM 的天空可见度分析
//
// 方案 §51「Phase 8 真实感」清单含 AO。真实地形遮蔽比屏幕空间 AO 更适合本工程:
// ① 离线一次算完,运行时零开销(当前中景已 2.6M 三角形,不能再加后处理 pass)
// ② 遮蔽来自真实高程,不是渲染近似 —— 与「真实数据驱动」原则一致
// ③ 只作用于地形(建筑/树木已有实时投影阴影)
//
// 算法:每格沿 8 个方位做对数步长的地平线扫描,取各方位最大坡度角,
// 天空可见比例 ≈ 1 − sin(地平线角);输出 1/2 分辨率(AO 为低频量,gzip 后约 1MB)。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';

const DIRS8 = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
// 跳过最近邻:栅格的格级粗糙会把地平线角推到极限,掩盖真实山体遮蔽
// 步长按物理距离给定(约 240 m → 7.7 km),与 DEM 分辨率无关
const STEPS = [2, 4, 8, 16, 32, 64];
// 参考坡度:开阔度贡献 = 1/(1+(tan/T0)²) → tan=T0 时半遮蔽。
// 扫描用大尺度平滑高程,残留的是山体尺度坡度(实测 p50≈0.03 / p90≈0.12),
// 故 T0 取 0.08 —— 让深切峡谷的谷底明显被遮蔽。
const T0 = 0.08;

/** 大尺度高斯平滑(σ 格):消除栅格噪声,只保留山体尺度的起伏(用于地平线分析) */
function blur(src, cols, rows, sigma) {
  const r = Math.ceil(sigma * 2.5);
  const k = [];
  let ks = 0;
  for (let i = -r; i <= r; i++) { const v = Math.exp(-0.5 * (i / sigma) ** 2); k.push(v); ks += v; }
  const tmp = new Float32Array(src.length);
  const out = new Float32Array(src.length);
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        const ii = Math.max(0, Math.min(cols - 1, i + t));
        acc += src[j * cols + ii] * k[t + r];
      }
      tmp[j * cols + i] = acc / ks;
    }
  }
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      let acc = 0;
      for (let t = -r; t <= r; t++) {
        const jj = Math.max(0, Math.min(rows - 1, j + t));
        acc += tmp[jj * cols + i] * k[t + r];
      }
      out[j * cols + i] = acc / ks;
    }
  }
  return out;
}

/** 与 app/utils/sampler.ts 的 smoothGrid 逐位一致 */
function smoothGrid(src, cols, rows, passes) {
  let a = src, b = new Uint16Array(src.length);
  const W = [1, 2, 1];
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        const c0 = c > 0 ? c - 1 : 0, c2 = c < cols - 1 ? c + 1 : cols - 1;
        b[o + c] = (a[o + c0] * W[0] + a[o + c] * W[1] + a[o + c2] * W[2]) / 4;
      }
    }
    for (let r = 0; r < rows; r++) {
      const r0 = r > 0 ? r - 1 : 0, r2 = r < rows - 1 ? r + 1 : rows - 1;
      for (let c = 0; c < cols; c++) {
        a[r * cols + c] = (b[r0 * cols + c] * W[0] + b[r * cols + c] * W[1] + b[r2 * cols + c] * W[2]) / 4;
      }
    }
  }
  return a;
}

export function run() {
  const t0 = Date.now();
  const meta = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.meta.json'), 'utf8'));
  const { cols, rows } = meta.grid;
  const cellM = meta.dem.approxResM;
  const raw = new Uint16Array(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin')).buffer);
  const elev = smoothGrid(raw, cols, rows, 2);
  // 地平线分析用大尺度平滑高程(σ=3 格 ≈ 650 m):只反映山体遮蔽,不受格级噪声支配
  const elevS = blur(elev, cols, rows, 3);
  const mask = new Uint8Array(fs.readFileSync(path.join(DIRS.processed, 'terrain/maskHard.bin')).buffer);

  // 1/2 分辨率输出
  const ow = cols >> 1, oh = rows >> 1;
  const ao = new Uint8Array(ow * oh);
  const acc = new Float32Array(ow * oh);
  const cnt = new Uint16Array(ow * oh);

  let done = 0;
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const idx = j * cols + i;
      if (mask[idx] < 128) continue;
      const h0 = elevS[idx];
      let occ = 0;
      for (let d = 0; d < 8; d++) {
        const dx = DIRS8[d][0], dz = DIRS8[d][1];
        const diag = dx !== 0 && dz !== 0 ? 1.41421356 : 1;
        let maxTan = 0;
        for (let s = 0; s < STEPS.length; s++) {
          const step = STEPS[s];
          const ii = i + dx * step, jj = j + dz * step;
          if (ii < 0 || jj < 0 || ii >= cols || jj >= rows) break;
          const h = elevS[jj * cols + ii];
          const dist = step * cellM * diag;
          const tan = (h - h0) / dist;
          if (tan > maxTan) maxTan = tan;
        }
        // 该方位的开阔度:tan=0 → 1(完全开阔),tan→∞ → 0
        occ += 1 / (1 + (maxTan / T0) * (maxTan / T0));
      }
      const sky = Math.max(0, occ / 8);            // 8 方位开阔度均值(1 = 完全开阔)
      const oi = (j >> 1) * ow + (i >> 1);
      acc[oi] += sky;
      cnt[oi]++;
    }
    if ((j & 255) === 0) {
      done = j;
      log('ao', `  扫描 ${(done / rows * 100).toFixed(0)}%  (${((Date.now() - t0) / 1000).toFixed(0)}s)`);
    }
  }
  let mn = 1, mx = 0, sum = 0;
  for (let i = 0; i < ao.length; i++) {
    const v = cnt[i] ? acc[i] / cnt[i] : 1;
    ao[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
    if (cnt[i]) { mn = Math.min(mn, v); mx = Math.max(mx, v); sum += v; }
  }
  const buf = Buffer.alloc(12 + ao.length);
  buf.write('GZAO', 0, 'ascii');
  buf.writeUInt32LE(ow, 4);
  buf.writeUInt32LE(oh, 8);
  Buffer.from(ao.buffer).copy(buf, 12);
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/ao.bin'), buf);
  log('ao', `AO ${ow}×${oh}  开阔度 min=${mn.toFixed(3)} max=${mx.toFixed(3)} 均值=${(sum / ao.length).toFixed(3)} → terrain/ao.bin ${(buf.length / 1e6).toFixed(2)}MB`);
  log('ao', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
