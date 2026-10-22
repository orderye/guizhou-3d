// 河谷下切表:构造真实水位剖面 + 走廊距离场 → 每格下切深度(Uint8,米)
// 运行时由 TerrainSampler/TerrainEngine 在 visualY 之前减去该值,形成真正的河谷;
// 河流水面(HydroEngine)按段取水平面贴于谷底 —— 静止水体在谷中是水平的。
//
// 为什么不用 DEM 直接反推河床:218m 分辨率下局部起伏可达 1000m,
// 沿线 45% 的相邻点是"逆坡",OSM 河线有 37% 走在山脊上 ——
// 直接取样会得到深达 0.5 世界单位(=9 倍河宽)的深缝。因此:
//   ① 水位在米制空间构造(与垂直夸张无关,物理正确)
//   ② 谷深有上限(maxCut),保证不会出现窄深缝
//   ③ 走廊内河床取严格水平的水位面,水面即贴于河床
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, PROJ, log } from '../config.mjs';
import { WORLD } from './world.mjs';

// 分级参数
//   win/wout: 河宽 / 走廊半宽×2(世界单位)  depth: 目标谷深(米)  maxCut: 谷深上限(米)
//   stepM: 沿河采样间距(米)
// 谷深以米制给出:垂直夸张约 15×,26m 谷深 ≈ 0.086 世界单位,俯视时仍能看见水面
const RANK = {
  1: { win: 0.100, wout: 0.150, depth: 25, stepM: 110, margin: 0.040, maxStep: 4 },
  2: { win: 0.055, wout: 0.085, depth: 12, stepM: 220, margin: 0.032, maxStep: 3 },
  3: { win: 0.028, wout: 0.045, depth: 6, stepM: 220, margin: 0.026, maxStep: 2 }
};
const SIGMA_M = 1500;   // 沿程高斯平滑 σ(米)

// 与 app/utils/sampler.ts 的 smoothGrid 逐位一致(2 遍 3×3 [1,2,1]/4,整数截断)
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

function medianOf(list) {
  const s = [...list].sort((x, y) => x - y);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

/** 沿程高斯平滑(σ 以米计) */
function smoothSeq(seq, stepM, sigmaM) {
  const R = Math.max(1, Math.ceil(3 * sigmaM / stepM));
  const inv = 1 / (2 * sigmaM * sigmaM);
  const out = new Float64Array(seq.length);
  for (let i = 0; i < seq.length; i++) {
    let acc = 0, ws = 0;
    for (let j = Math.max(0, i - R); j <= Math.min(seq.length - 1, i + R); j++) {
      const d = (j - i) * stepM;
      const w = Math.exp(-d * d * inv);
      acc += seq[j] * w; ws += w;
    }
    out[i] = acc / ws;
  }
  return out;
}

/** 沿流向非增 + 每步落差 ≤ maxStep(最小改动) */
function limitMono(seq, maxStep) {
  const out = new Float64Array(seq.length);
  out[0] = seq[0];
  for (let i = 1; i < seq.length; i++) {
    let v = Math.min(seq[i], out[i - 1]);
    v = Math.max(v, out[i - 1] - maxStep);
    out[i] = v;
  }
  return out;
}

/** 保序回归(PAVA):拟合为非增序列,最小二乘意义下的最优单调解(池化邻域) */
function pavaNonInc(seq) {
  const n = seq.length;
  const vals = Float64Array.from(seq);
  const wts = new Float64Array(n).fill(1);
  const blocks = [];
  for (let i = 0; i < n; i++) {
    blocks.push(i);
    while (blocks.length >= 2) {
      const a = blocks[blocks.length - 2], b = blocks[blocks.length - 1];
      if (vals[a] >= vals[b]) break;          // 非增约束已满足
      const w = wts[a] + wts[b];
      vals[a] = (vals[a] * wts[a] + vals[b] * wts[b]) / w;
      wts[a] = w; wts[b] = 0;
      blocks.pop();
    }
  }
  const out = new Float64Array(n);
  let k = 0;
  for (const b of blocks) {
    const w = wts[b];
    for (let j = 0; j < w; j++) out[k++] = vals[b];
  }
  return out;
}

export function run() {
  const t0 = Date.now();
  const metaPath = path.join(DIRS.runtime, 'terrain/terrain.meta.json');
  const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const raw = new Uint16Array(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin')).buffer);
  const smooth = smoothGrid(raw, cols, rows, 2);
  const rivers = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'rivers/rivers.json'), 'utf8')).features;

  const MPU = 1 / WORLD.scale;                       // 1 世界单位 = MPU 米
  const M_LAT = 111320, M_LON = 111320 * Math.cos(26.8 * Math.PI / 180);

  const gridAt = (lon, lat) => [
    (lon - west) / dLon - 0.5,
    (north - lat) / dLat - 0.5
  ];
  const sampleBilinear = (arr, fc, fr) => {
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const fx = fc - c0, fz = fr - r0;
    const g = (ci, ri) => (ci < 0 || ri < 0 || ci >= cols || ri >= rows) ? 0 : arr[ri * cols + ci];
    const v00 = g(c0, r0), v10 = g(c0 + 1, r0), v01 = g(c0, r0 + 1), v11 = g(c0 + 1, r0 + 1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
  };
  /**
   * 河道走廊内的真实最低地形(米)——水位基准。
   *
   * 之前用 3×3 邻域的 25% 低分位做基准,稳健但**偏高**:深切峡谷里
   * 河床可能比 3×3 邻域低几十米,于是构造出的水位浮在沟谷底之上
   * (实测浮空点:水位比沟谷底高 36 m)→ 水面悬在坡上、河谷切割不成立。
   *
   * 这里改为:以采样点为中心,沿**垂直河道**方向在走廊宽度内取最低地形。
   * 河道走向可由相邻采样点求得,垂直方向取 ±走廊半宽,得到该点的真实谷底。
   */
  const corridorFloor = (fc, fr, dirFc, dirFr, halfCells) => {
    // 垂直方向(横跨河道)
    const px = -dirFr, py = dirFc;
    let lo = Infinity;
    const steps = Math.max(1, Math.ceil(halfCells));
    for (let t = -steps; t <= steps; t++) {
      const c = Math.round(fc + px * t), r = Math.round(fr + py * t);
      if (c < 0 || r < 0 || c >= cols || r >= rows) continue;
      const v = smooth[r * cols + c];
      if (v < lo) lo = v;
    }
    return isFinite(lo) ? lo : 0;
  };
  /** 3×3 邻域低分位(25%)——抑制 DEM 野值,比 min 稳健(仅用于稳健性回退) */
  const lowQuantile = (fc, fr) => {
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const vs = [];
    for (let dj = -1; dj <= 1; dj++) {
      for (let dc = -1; dc <= 1; dc++) {
        const ci = c0 + dc, ri = r0 + dj;
        if (ci < 0 || ri < 0 || ci >= cols || ri >= rows) continue;
        vs.push(smooth[ri * cols + ci]);
      }
    }
    if (!vs.length) return 0;
    vs.sort((a, b) => a - b);
    return vs[Math.min(vs.length - 1, Math.floor(vs.length * 0.25))];
  };

  // ── 1) 每条河的水位剖面(米) ──
  const profiles = [];
  for (const f of rivers) {
    const rank = Math.min(3, Math.max(1, f.r | 0));
    const cfg = RANK[rank];
    // 沿折线按等级步长重采样(世界坐标)
    const p = f.p, np = p.length / 2;
    if (np < 2) continue;
    const stepU = cfg.stepM / MPU;
    const samples = [];
    for (let i = 0; i < np - 1; i++) {
      const x0 = p[i * 2], z0 = p[i * 2 + 1], x1 = p[i * 2 + 2], z1 = p[i * 2 + 3];
      const d = Math.hypot(x1 - x0, z1 - z0);
      const k = Math.max(1, Math.round(d / stepU));
      for (let j = 0; j < k; j++) {
        const t = j / k;
        samples.push([x0 + (x1 - x0) * t, z0 + (z1 - z0) * t]);
      }
    }
    samples.push([p[(np - 1) * 2], p[(np - 1) * 2 + 1]]);
    if (samples.length < 4) continue;

    // 逐点允许走廊半宽(米):弯道处收窄,避免走廊面自交形成黑洞
    const halfMax = cfg.wout * MPU * 0.5;
    const allowed = new Float64Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const ia = Math.max(0, i - 1), ib = Math.min(samples.length - 1, i + 1);
      let ax = samples[i][0] - samples[ia][0], az = samples[i][1] - samples[ia][1];
      let bx = samples[ib][0] - samples[i][0], bz = samples[ib][1] - samples[i][1];
      const al = Math.hypot(ax, az) || 1, bl = Math.hypot(bx, bz) || 1;
      ax /= al; az /= al; bx /= bl; bz /= bl;
      const cross = ax * bz - az * bx, dot = ax * bx + az * bz;
      const theta = Math.abs(Math.atan2(cross, dot));        // 转向角
      const half = 0.45 * (al + bl) * 0.5 / Math.max(Math.tan(theta / 2), 0.02);
      allowed[i] = Math.min(halfMax, half);
    }

    // 采样:中心线地形 + 走廊内真实谷底
    // 走廊方向:由相邻采样点求得(在格坐标空间),走廊内垂直河道方向取最低地形
    const terr = new Float64Array(samples.length);
    const floor = new Float64Array(samples.length);
    const cells = [];
    const halfCells = cfg.wout * MPU / 218;   // 走廊半宽(格)
    // 预计算每个采样点的格坐标(用于求河道走向)
    const gcs = new Float64Array(samples.length * 2);
    for (let i = 0; i < samples.length; i++) {
      const [x, z] = samples[i];
      const px = x / WORLD.scale + WORLD.originX;
      const py = -z / WORLD.scale + WORLD.originY;
      const { lon, lat } = PROJ.unproject(px, py);
      const [fc, fr] = gridAt(lon, lat);
      cells.push([lon, lat, fc, fr]);
      gcs[i * 2] = fc; gcs[i * 2 + 1] = fr;
    }
    for (let i = 0; i < samples.length; i++) {
      terr[i] = sampleBilinear(smooth, gcs[i * 2], gcs[i * 2 + 1]);
      // 河道走向(格坐标空间):用相邻采样点的格坐标差
      const ia = Math.max(0, i - 1), ib = Math.min(samples.length - 1, i + 1);
      const dFc = gcs[ib * 2] - gcs[ia * 2], dFr = gcs[ib * 2 + 1] - gcs[ia * 2 + 1];
      const dLen = Math.hypot(dFc, dFr) || 1;
      const dirFc = dFc / dLen, dirFr = dFr / dLen;
      const fl = corridorFloor(gcs[i * 2], gcs[i * 2 + 1], dirFc, dirFr, halfCells);
      // 走廊最低地形与 3×3 低分位取低者(前者更真实,后者更稳健)
      floor[i] = Math.min(fl, lowQuantile(gcs[i * 2], gcs[i * 2 + 1]));
    }
    // 流向判定:首尾各 1/7 中位数,高处→低处为顺流
    const k7 = Math.max(1, Math.floor(terr.length / 7));
    const head = medianOf(Array.from(terr.slice(0, k7)));
    const tail = medianOf(Array.from(terr.slice(-k7)));
    const reversed = head < tail;
    const T = reversed ? Array.from(terr).reverse() : Array.from(terr);
    const F = reversed ? Array.from(floor).reverse() : Array.from(floor);

    // 水位:目标谷深 + 走廊谷底 → 沿程平滑 → 保序回归(严格单调不增)
    const raw0 = new Float64Array(T.length);
    for (let i = 0; i < T.length; i++) {
      raw0[i] = Math.min(T[i] - cfg.depth, F[i]);
    }
    const sm = smoothSeq(raw0, cfg.stepM, SIGMA_M);
    // 保序回归 → 限幅:每步落差封顶,避免极近景下水面段间出现大块错位
    const wl = limitMono(pavaNonInc(sm), cfg.maxStep);

    // ── 上界钳制(必须在 PAVA/限幅**之后**)──
    // 物理约束:水面不得高于当地沟谷底。若水位高于沟底,下切表无法把它"挖"上来
    // (cut = 地形 − 目标,目标高于地形时为负 → 不下切),结果就是水面悬在坡上。
    // 实测:未钳制时 17% 的采样点浮空 >5 m,浮空点水位比沟谷底高 36 m。
    //
    // 为什么不能把钳制放在 PAVA 之前:PAVA 会把相邻段"池化"求均值,
    // 拟合出的水位可以高于逐点上限 → 钳制被抵消。这里改为:
    //   ① 逐点钳到 F[i] − 2(沟底再低 2 m)
    //   ② 再做一次**只降不升**的单调化(河不能往高处流)——这不会破坏上限
    const capped = new Float64Array(wl.length);
    for (let i = 0; i < wl.length; i++) capped[i] = Math.min(wl[i], F[i] - 2);
    for (let i = 1; i < capped.length; i++) {
      if (capped[i] > capped[i - 1]) capped[i] = capped[i - 1];
    }
    const W = reversed ? Array.from(capped).reverse() : Array.from(capped);

    profiles.push({ rank, cells, xs: samples.map(s => s[0]), zs: samples.map(s => s[1]), water: W, allowed });
  }
  log('valley', `profiles: ${profiles.length} (points=${profiles.reduce((s, p) => s + p.xs.length, 0)})`);

  // ── 2) 走廊距离场:每格记录最近采样点距离与该点水位 ──
  const bestD = new Float32Array(cols * rows).fill(Infinity);
  const bestW = new Float32Array(cols * rows);
  const bestR = new Uint8Array(cols * rows);
  for (const pr of profiles) {
    const cfg = RANK[pr.rank];
    const R = Math.ceil((cfg.wout * MPU) / 218) + 1;
    for (let i = 0; i < pr.cells.length; i++) {
      const [lon, lat] = pr.cells[i];
      const w = pr.water[i];
      const cc = Math.round((lon - west) / dLon - 0.5);
      const rr = Math.round((north - lat) / dLat - 0.5);
      for (let dj = -R; dj <= R; dj++) {
        const ri = rr + dj;
        if (ri < 0 || ri >= rows) continue;
        const latC = north - (ri + 0.5) * dLat;
        const dLatM = (latC - lat) * M_LAT;
        for (let dc = -R; dc <= R; dc++) {
          const ci = cc + dc;
          if (ci < 0 || ci >= cols) continue;
          const lonC = west + (ci + 0.5) * dLon;
          const d = Math.hypot((lonC - lon) * M_LON, dLatM);
          const idx = ri * cols + ci;
          if (d < bestD[idx]) { bestD[idx] = d; bestW[idx] = w; bestR[idx] = pr.rank; }
        }
      }
    }
  }

  // ── 3) 河谷下切量表(米):沟底削平到水位,水面即躺在沟中 ──
  // 沟宽 = 河宽(边缘正好在沟缘)→ 水面不浮空;沟壁仅 ~0.6 格,浅槽不做接缝处理
  const cut = new Uint8Array(cols * rows);
  let touched = 0, maxCut = 0;
  const WALL_M = 250;   // 沟壁宽度(米)≈1.2 格
  for (let ri = 0; ri < rows; ri++) {
    for (let ci = 0; ci < cols; ci++) {
      const idx = ri * cols + ci;
      const d = bestD[idx];
      if (!isFinite(d)) continue;
      const cfg = RANK[bestR[idx]];
      const bedR = cfg.win * MPU * 0.5;          // 水面边缘(米)
      const wallR = bedR + WALL_M;
      const t = Math.max(0, Math.min(1, (d - bedR) / Math.max(1, wallR - bedR)));
      const bed = bestW[idx] - 2;                // 谷底略低于水面
      const target = bed + (smooth[idx] - bed) * t;
      const c = smooth[idx] - target;
      if (c <= 0.5) continue;
      const cv = Math.min(255, Math.round(c));
      cut[idx] = cv;
      if (cv > maxCut) maxCut = cv;
      touched++;
    }
  }
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/valley.bin'), Buffer.from(cut.buffer));
  log('valley', `下切 ${touched} 格 (${(touched / (cols * rows) * 100).toFixed(2)}%) max=${maxCut}m → terrain/valley.bin ${(cut.length / 1e6).toFixed(1)}MB`);

  // ── 4) 水位序列(供运行时生成水平水面) ──
  // 布局:magic|count|total|offsets[count+1]|x[f32]|z[f32]|water[u16]|width[u8]|rank[u8]
  // water 之前的偏移均为偶数,保证 Uint16Array 对齐
  const total = profiles.reduce((s, p) => s + p.xs.length, 0);
  const off = new Uint32Array(profiles.length + 1);
  let acc = 0;
  for (let i = 0; i < profiles.length; i++) { off[i] = acc; acc += profiles[i].xs.length; }
  off[profiles.length] = acc;
  const rankBuf = Buffer.alloc(profiles.length);
  for (let i = 0; i < profiles.length; i++) rankBuf[i] = profiles[i].rank;
  const xs = new Float32Array(total), zs = new Float32Array(total), ws = new Uint16Array(total);
  const wds = new Uint8Array(total);
  for (let i = 0; i < profiles.length; i++) {
    const pr = profiles[i];
    for (let j = 0; j < pr.xs.length; j++) {
      const k = off[i] + j;
      xs[k] = pr.xs[j]; zs[k] = pr.zs[j];
      ws[k] = Math.max(0, Math.min(65535, Math.round(pr.water[j])));
      wds[k] = Math.min(255, Math.round(pr.allowed[j] / 2));
    }
  }
  const head = Buffer.alloc(12);
  head.writeUInt32LE(0x42445256, 0);           // 'VRBD'
  head.writeUInt32LE(profiles.length, 4);
  head.writeUInt32LE(total, 8);
  const out = Buffer.concat([
    head,
    Buffer.from(off.buffer),
    Buffer.from(xs.buffer), Buffer.from(zs.buffer), Buffer.from(ws.buffer),
    Buffer.from(wds.buffer), rankBuf
  ]);
  fs.writeFileSync(path.join(DIRS.runtime, 'rivers/riverbed.bin'), out);
  const byRank = [0, 0, 0, 0];
  profiles.forEach(p => byRank[p.rank]++);
  log('valley', `riverbed.bin: ${profiles.length} 条(一级${byRank[1]} 二级${byRank[2]} 三级${byRank[3]}) 采样点 ${total} → ${(out.length / 1e6).toFixed(2)}MB`);
  log('valley', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
