// 省界掩膜生成:贵州行政边界 → 硬/软/外扩三张掩膜(方案 §7 边缘下沉)
//
// 职责边界(2026-10-22 重构):本脚本**只产掩膜**,不再写 terrain.elev.bin。
// 高程由 scripts/process/elev-glo30.mjs(GLO-30 → 标准网格)负责 —— 此前 dem 步骤
// 仍从 terrarium PNG 解码高程,任何一次 `npm run preprocess` 都会把 GLO-30 覆盖回旧源,
// 并把 meta 网格重置成另一套 dLat(与运行时声明相差 185 m 累积)。
//
// 网格约定:**格心(cell-center)** —— 格元 (i,j) 的中心位于
//   lon = west + (i+0.5)*dLon,lat = north - (j+0.5)*dLat
// 掩膜栅格与高程栅格共用 scripts/config.mjs 的 GRID,保证同源同约定。
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, GRID, PROJ, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { simplifyDP } from './geometry.mjs';

export function loadProvinceRings() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIRS.rawAdmin, '520000.json'), 'utf8'));
  const rings = [];
  for (const f of raw.features) {
    const geom = f.geometry;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    for (const poly of polys) {
      for (const r of poly) {
        const proj = new Float64Array(r.length * 2);
        for (let i = 0; i < r.length; i++) {
          const p = PROJ.project(r[i][0], r[i][1]);
          proj[i * 2] = p.x; proj[i * 2 + 1] = p.y;
        }
        rings.push(proj);
      }
    }
  }
  return rings;
}

// 软边缘:内部到边界的近似距离(chamfer 3-4),按 fadeCells 衰减
export function edgeFade(hard, cols, rows, fadeCells) {
  const INF = 65535;
  const d = new Uint16Array(cols * rows).fill(INF);
  for (let i = 0; i < d.length; i++) if (!hard[i]) d[i] = 0;
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
    d[i] = Math.min(v, fadeCells * 4 + 2);
  }
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < d.length; i++) {
    if (!hard[i]) { out[i] = 0; continue; }
    out[i] = Math.round(255 * Math.min(1, d[i] / (fadeCells * 3)));
  }
  return out;
}

export function run() {
  const t0 = Date.now();
  fs.mkdirSync(path.join(DIRS.runtime, 'terrain'), { recursive: true });
  fs.mkdirSync(path.join(DIRS.processed, 'terrain'), { recursive: true });

  const { cols, rows, west, north, dLon, dLat } = GRID;

  // ── 贵州硬掩膜:先在 Albers 投影域扫描线填充(精确),再采样到 DEM 网格 ──
  const t1 = Date.now();
  const rings = loadProvinceRings();
  const hard2 = new Uint8Array(cols * rows);
  {
    const simpRings = rings.map(rg => simplifyDP(rg, 120)).filter(rg => rg.length >= 8);
    const cellP = 430;
    const px0 = WORLD.originX - WORLD.widthMeters / 2;
    const py0 = WORLD.originY - WORLD.heightMeters / 2;
    const pCols = Math.ceil(WORLD.widthMeters / cellP);
    const pRows = Math.ceil(WORLD.heightMeters / cellP);
    const pmask = new Uint8Array(pCols * pRows);
    const edges = [];
    for (const ring of simpRings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ya = ring[j * 2 + 1], yb = ring[i * 2 + 1];
        if (ya === yb) continue;
        edges.push({ ymin: Math.min(ya, yb), ymax: Math.max(ya, yb), xa: ring[j * 2], ya, xb: ring[i * 2], yb });
      }
    }
    edges.sort((a, b) => a.ymin - b.ymin);
    let ptr = 0;
    let active = [];
    for (let pr = 0; pr < pRows; pr++) {
      const py = py0 + (pr + 0.5) * cellP;
      while (ptr < edges.length && edges[ptr].ymin <= py) active.push(edges[ptr++]);
      active = active.filter(E => E.ymax > py);
      if (!active.length) continue;
      const xs = [];
      for (const E of active) {
        // 线性插值求交点。分母 E.yb−E.ya 可能为负(边的 y 递减),这是正常的;
        // 不能用 E.ymax 代替 E.yb —— 那会让 t 符号错乱、交点飞到投影域外,
        // 进而把整行西侧误填为省内(实测西扩 34 km)。
        const t = (py - E.ya) / (E.yb - E.ya);
        const x = E.xa + t * (E.xb - E.xa);
        // 防御:交点必须落在投影域内(环本身在域内时恒成立)
        if (x < px0 || x > px0 + pCols * cellP) continue;
        xs.push(x);
      }
      xs.sort((a, b) => a - b);
      // 交点必须成对(进入/离开交替);数量为奇说明简化后环自相交,该行跳过
      if (xs.length < 2 || (xs.length & 1)) continue;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - px0) / cellP - 0.5));
        const c1 = Math.min(pCols - 1, Math.floor((xs[k + 1] - px0) / cellP - 0.5));
        for (let c = c0; c <= c1; c++) pmask[pr * pCols + c] = 255;
      }
    }
    let nInside = 0;
    for (let r = 0; r < rows; r++) {
      // 格心约定:格元 (r,c) 的中心 —— 与高程栅格同一采样点
      const lat = north - (r + 0.5) * dLat;
      for (let c = 0; c < cols; c++) {
        const lon = west + (c + 0.5) * dLon;
        const p = PROJ.project(lon, lat);
        const pc = Math.floor((p.x - px0) / cellP);
        const prr = Math.floor((p.y - py0) / cellP);
        if (pc >= 0 && prr >= 0 && pc < pCols && prr < pRows && pmask[prr * pCols + pc]) {
          hard2[r * cols + c] = 255; nInside++;
        }
      }
    }
    log('mask', `inside ${(nInside / 1e6).toFixed(2)}M cells (${(nInside / (cols * rows) * 100).toFixed(1)}%), ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  // ── 软边缘 + 渲染缓冲带(省界外 ~5.6km) + 输出 ──
  const soft = edgeFade(hard2, cols, rows, 10);
  // 外扩掩膜:省界外 26 格(≈5.6km)内仍渲染(压平为基座搁边),更远剔除
  const wide = new Uint8Array(cols * rows);
  {
    const INF = 9999;
    const d = new Uint16Array(cols * rows).fill(INF);
    for (let i = 0; i < d.length; i++) if (hard2[i]) d[i] = 0;
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
    for (let i = 0; i < d.length; i++) wide[i] = d[i] <= 78 ? 255 : 0;
  }
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.mask.bin'), Buffer.from(soft));
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.maskwide.bin'), Buffer.from(wide));
  fs.writeFileSync(path.join(DIRS.processed, 'terrain/maskHard.bin'), Buffer.from(hard2));
  log('mask', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
