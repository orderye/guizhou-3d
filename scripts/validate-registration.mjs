// 配准/自洽验证:地形栅格 ↔ 河网 ↔ 河谷 ↔ 水面 的一致性检查
//
// 背景(2026-10-22):连续发现两个配准级缺陷,本脚本把"配准正确"变成可重复的检查:
//   ① DEM 网格南北向拉伸 12%(GLO-30 被写成经纬度正方形网格)
//   ② 运行时把 Albers 投影拆成"每列一个 x、每行一个 z",地形网格与河网错开 1–9 km
// 二者都不会让程序崩溃,只让画面"看着差不多但就是不对" —— 只能靠数字守住。
//
// 用法:node scripts/validate-registration.mjs
// 退出码 0 = 全部通过;1 = 有检查失败
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, GRID, ROOT, log } from './config.mjs';

const RT = path.join(ROOT, 'public/runtime');
const meta = JSON.parse(fs.readFileSync(path.join(RT, 'terrain/terrain.meta.json'), 'utf8'));
const g = meta.grid;
const w = meta.world;
const P = meta.projection;

const R = P.R, D2R = Math.PI / 180;
const lon0 = P.lon0 * D2R, p1 = P.sp1 * D2R, p2 = P.sp2 * D2R;
const n = (Math.sin(p1) + Math.sin(p2)) / 2;
const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
const rho0 = R * Math.sqrt(C - 2 * n * Math.sin(P.lat0 * D2R)) / n;
const M_LON = 111320 * Math.cos(26.8 * Math.PI / 180);
const M_LAT = 110900;

const colSin = new Float64Array(g.cols), colCos = new Float64Array(g.cols);
for (let i = 0; i < g.cols; i++) {
  const th = n * ((g.west + (i + 0.5) * g.dLon) * D2R - lon0);
  colSin[i] = Math.sin(th); colCos[i] = Math.cos(th);
}
const rowRho = new Float64Array(g.rows);
for (let j = 0; j < g.rows; j++) {
  const lat = g.north - (j + 0.5) * g.dLat;
  rowRho[j] = R * Math.sqrt(Math.max(0, C - 2 * n * Math.sin(lat * D2R))) / n;
}
const worldX = (i, j) => (rowRho[j] * colSin[i] - w.originX) * w.scale;
const worldZ = (i, j) => -((rho0 - rowRho[j] * colCos[i]) - w.originY) * w.scale;
/** 世界坐标 → 网格浮点索引(与运行时 app/utils/sampler.ts 的 gridAt 同一套公式) */
function gridAt(X, Z) {
  const px = X / w.scale + w.originX, py = -Z / w.scale + w.originY;
  const dy = rho0 - py;
  const th = Math.atan2(px, dy);
  const rho = Math.hypot(px, dy);
  const lat = Math.asin(Math.max(-1, Math.min(1, (C - (rho * n / R) ** 2) / (2 * n)))) / D2R;
  const lon = th / n / D2R + P.lon0;
  return { i: (lon - g.west) / g.dLon - 0.5, j: (g.north - lat) / g.dLat - 0.5 };
}

const elevRaw = new Uint16Array(fs.readFileSync(path.join(RT, 'terrain/terrain.elev.bin')).buffer);
const valley = new Uint8Array(fs.readFileSync(path.join(RT, 'terrain/valley.bin')).buffer);
const rivers = JSON.parse(fs.readFileSync(path.join(RT, 'rivers/rivers.json'), 'utf8')).features;

/**
 * 2×高斯 3×3 [1,2,1]/4 平滑 —— 与 app/utils/sampler.ts 的 smoothGrid、
 * scripts/process/valley.mjs 的 smoothGrid 逐位一致。
 * 必须用平滑后的高程比较:河谷下切表就是按平滑高程算的,
 * 运行时渲染的也是平滑高程 —— 用原始高程比较会引入数十米的假偏差。
 */
function smoothGrid(src, passes = 2) {
  const a = Float64Array.from(src), b = new Float64Array(a.length);
  for (let p = 0; p < passes; p++) {
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const c0 = c > 0 ? c - 1 : 0, c2 = c < g.cols - 1 ? c + 1 : g.cols - 1;
        b[r * g.cols + c] = (a[r * g.cols + c0] + 2 * a[r * g.cols + c] + a[r * g.cols + c2]) / 4;
      }
    }
    for (let r = 0; r < g.rows; r++) {
      for (let c = 0; c < g.cols; c++) {
        const r0 = r > 0 ? r - 1 : 0, r2 = r < g.rows - 1 ? r + 1 : g.rows - 1;
        a[r * g.cols + c] = (b[r0 * g.cols + c] + 2 * b[r * g.cols + c] + b[r2 * g.cols + c]) / 4;
      }
    }
  }
  return a;
}
const elev = smoothGrid(elevRaw);

// riverbed.bin:magic|count|total|offsets[count+1]|x[f32]|z[f32]|water[u16]|width[u8]|rank[u8]
const rbBuf = fs.readFileSync(path.join(RT, 'rivers/riverbed.bin'));
const rbView = new DataView(rbBuf.buffer, rbBuf.byteOffset, rbBuf.byteLength);
const count = rbView.getUint32(4, true), total = rbView.getUint32(8, true);
const xOff = 12 + (count + 1) * 4, zOff = xOff + total * 4, wOff = zOff + total * 4;
const rbX = new Float32Array(rbBuf.buffer, rbBuf.byteOffset + xOff, total);
const rbZ = new Float32Array(rbBuf.buffer, rbBuf.byteOffset + zOff, total);
const rbW = new Uint16Array(rbBuf.buffer, rbBuf.byteOffset + wOff, total);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  log('valid', `${ok ? '✓' : '✗'} ${name}${detail ? '  — ' + detail : ''}`);
}
function pct(arr, p) {
  const a = [...arr].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor(a.length * p))];
}

// ── 1. 网格与 meta 一致 ──
check('网格与 GRID 真源一致',
  g.cols === GRID.cols && g.rows === GRID.rows &&
  Math.abs(g.dLon - GRID.dLon) < 1e-12 && Math.abs(g.dLat - GRID.dLat) < 1e-12,
  `${g.cols}×${g.rows} dLon=${g.dLon.toFixed(9)} dLat=${g.dLat.toFixed(9)}`);

// ── 2. 投影可逆性:格元世界坐标 → 逆投影 → 必须回到同一格心 ──
{
  let worst = 0;
  for (let j = 0; j < g.rows; j += 41) {
    for (let i = 0; i < g.cols; i += 41) {
      const q = gridAt(worldX(i, j), worldZ(i, j));
      const d = Math.hypot((q.i - i) * g.dLon * M_LON, (q.j - j) * g.dLat * M_LAT);
      if (d > worst) worst = d;
    }
  }
  check('投影可逆(地形网格 ↔ 经纬度)', worst < 1.0, `最大偏差 ${worst.toFixed(3)} m`);
}

// ── 3. 河网落在地形网格上(修复 ② 的直接检验)──
{
  const d = [];
  for (const f of rivers) {
    const p = f.p;
    for (let k = 0; k < p.length; k += 2 * 13) {
      const X = p[k], Z = p[k + 1];
      const q = gridAt(X, Z);
      const ci = Math.round(q.i), cj = Math.round(q.j);
      if (ci < 0 || cj < 0 || ci >= g.cols || cj >= g.rows) continue;
      // 河点应在所属格元中心 109 m 半径内
      d.push(Math.hypot(X - worldX(ci, cj), Z - worldZ(ci, cj)) * 4566.46);
    }
  }
  const p50 = pct(d, 0.5), p90 = pct(d, 0.9);
  check('河网与地形网格对位', p50 < 120 && p90 < 180,
    `距所属格元中心 p50=${p50.toFixed(0)} m p90=${p90.toFixed(0)} m(格心半径 109 m)`);
}

// ── 4. 河道在谷中:河线高程应低于两侧邻域 ──
{
  const diffs = [];
  let above = 0;
  for (const f of rivers) {
    if (f.r !== 1) continue;
    const p = f.p;
    for (let k = 0; k < p.length; k += 2 * 11) {
      const X = p[k], Z = p[k + 1];
      const q = gridAt(X, Z);
      const ci = Math.round(q.i), cj = Math.round(q.j);
      if (ci < 1 || cj < 1 || ci >= g.cols - 1 || cj >= g.rows - 1) continue;
      const at = (a, b) => elev[b * g.cols + a];
      const e = at(ci, cj);
      const side = Math.min(at(ci - 2, cj), at(ci + 2, cj), at(ci, cj - 2), at(ci, cj + 2));
      diffs.push(e - side);
      if (e > Math.max(at(ci - 2, cj), at(ci + 2, cj), at(ci, cj - 2), at(ci, cj + 2))) above++;
    }
  }
  const p50 = pct(diffs, 0.5);
  const abovePct = 100 * above / diffs.length;
  check('河道位于谷中(非山脊)', p50 <= 10 && abovePct <= 5,
    `河线高程 − 邻域谷底 p50=${p50.toFixed(1)} m;"高于四侧"占比 ${abovePct.toFixed(1)}%`);
}

// ── 5. 水面躺在沟底:riverbed 水位 − (高程 − 下切) 应 ≈ 0 ──
{
  const d = [];
  let float = 0;
  for (let i = 0; i < total; i += 3) {
    const q = gridAt(rbX[i], rbZ[i]);
    const ci = Math.round(q.i), cj = Math.round(q.j);
    if (ci < 0 || cj < 0 || ci >= g.cols || cj >= g.rows) continue;
    const bed = elev[cj * g.cols + ci] - valley[cj * g.cols + ci];
    const diff = rbW[i] - bed;
    d.push(diff);
    if (diff > 5) float++;
  }
  const p50 = pct(d, 0.5), p95 = pct(d, 0.95);
  const floatPct = 100 * float / d.length;
  check('水面躺在沟底(不浮空)', p50 >= -2 && p50 <= 3 && p95 <= 40 && floatPct <= 8,
    `水位 − 沟底 p50=${p50.toFixed(1)} m p95=${p95.toFixed(1)} m;高于沟底 >5 m 占比 ${floatPct.toFixed(1)}%`);
}

// ── 6. 派生表与高程同源(时间戳)──
{
  const elevT = fs.statSync(path.join(RT, 'terrain/terrain.elev.bin')).mtimeMs;
  const stale = [];
  for (const f of ['terrain/valley.bin', 'terrain/ao.bin', 'rivers/rivers.json', 'rivers/riverbed.bin', 'forests/forest.bin']) {
    const p = path.join(RT, f);
    if (!fs.existsSync(p)) { stale.push(f + '(缺失)'); continue; }
    if (fs.statSync(p).mtimeMs < elevT) stale.push(f);
  }
  check('派生表与高程同源', stale.length === 0,
    stale.length ? '早于高程:' + stale.join(', ') : '全部晚于高程');
}

// ── 7. 掩膜与高程同网格 ──
{
  const mask = new Uint8Array(fs.readFileSync(path.join(RT, 'terrain/terrain.mask.bin')).buffer);
  check('掩膜与高程同网格', mask.length === elev.length, `mask ${mask.length} vs elev ${elev.length}`);
}

// ── 8. 掩膜面积必须吻合真实省域 ──
// 2026-10-22 事故:掩膜生成的一个插值符号错误让省界西扩 34 km,
// 把川西南高山算进省内 → elev.max 3957 m(真实 2901)→ 视觉归一化被撑爆
// → 全省地形压成阶梯条带。此项专门守住该类错误。
{
  const hardPath = path.join(ROOT, 'data/processed/terrain/maskHard.bin');
  if (!fs.existsSync(hardPath)) {
    check('掩膜面积吻合省域', false, '缺少 data/processed/terrain/maskHard.bin');
  } else {
    const hard = new Uint8Array(fs.readFileSync(hardPath).buffer);
    let n = 0, lo = Infinity, hi = -Infinity;
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        if (hard[j * g.cols + i] >= 128) {
          n++;
          const lon = g.west + (i + 0.5) * g.dLon, lat = g.north - (j + 0.5) * g.dLat;
          if (lon < lo) lo = lon; if (lon > hi) hi = lon;
        }
      }
    }
    const cellKm2 = (g.dLon * 111.320 * Math.cos(26.8 * Math.PI / 180)) * (g.dLat * 110.900);
    const areaKm2 = n * cellKm2;
    // 贵州省陆域面积 176,000 km²
    const err = Math.abs(areaKm2 - 176000) / 176000;
    check('掩膜面积吻合省域(176,000 km²)', err < 0.05,
      `实际 ${Math.round(areaKm2).toLocaleString()} km²(偏差 ${(err * 100).toFixed(1)}%)`);
    // 省内高程上限必须落在贵州实际范围内(最高 2901 m 大窝凼)
    let inMax = 0;
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        if (hard[j * g.cols + i] >= 128) {
          const e = elev[j * g.cols + i];
          if (e > inMax) inMax = e;
        }
      }
    }
    check('省内高程上限合理(贵州最高 ~2901 m)', inMax < 3050,
      `省内最大 ${inMax} m(若 >3050 说明掩膜把省外高山算进来了)`);
  }
}

const failed = results.filter(r => !r.ok);
log('valid', failed.length ? `FAILED: ${failed.length}/${results.length}` : `ALL PASS (${results.length} 项)`);
process.exit(failed.length ? 1 : 0);
