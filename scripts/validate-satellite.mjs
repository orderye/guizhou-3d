// 卫星底图配准验证:把底图按"渲染时实际使用的反投影"采样回 DEM 网格,
// 用真实河网/湖库/省界检验吻合度,并输出叠加图供肉眼复核。
// 用法:node scripts/validate-satellite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { execFileSync } from 'node:child_process';
import { DIRS, log } from './config.mjs';

const META = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.meta.json'), 'utf8'));
const SAT = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'terrain/satellite.json'), 'utf8'));
const { grid, world } = META;
const { cols, rows, west, north, dLon, dLat } = grid;

// ── 底图解码为 raw rgb24(ffmpeg) ──
const rawPath = '/tmp/_sat_validate.raw';
const jpg = path.join(DIRS.runtime, 'terrain/satellite.jpg');
execFileSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-i', jpg, '-f', 'rawvideo', '-pix_fmt', 'rgb24', rawPath]);
const SW = SAT.outWidth, SH = SAT.outHeight;
const raw = fs.readFileSync(rawPath);
const rect = SAT.mercatorRect;
const rectW = rect.x1 - rect.x0, rectH = rect.y1 - rect.y0;

function sampleSat(lon, lat) {
  const r = lat * Math.PI / 180;
  const mx = (lon + 180) / 360;
  const my = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
  const fx = (mx - rect.x0) / rectW * SW;
  const fy = (my - rect.y0) / rectH * SH;   // 图像行 0 = 最北(按北→南拼接)
  if (fx < 0 || fy < 0 || fx > SW - 1 || fy > SH - 1) return null;
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, SW - 1), y1 = Math.min(y0 + 1, SH - 1);
  const ax = fx - x0, ay = fy - y0;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p00 = raw[(y0 * SW + x0) * 3 + c], p10 = raw[(y0 * SW + x1) * 3 + c];
    const p01 = raw[(y1 * SW + x0) * 3 + c], p11 = raw[(y1 * SW + x1) * 3 + c];
    out[c] = (p00 * (1 - ax) + p10 * ax) * (1 - ay) + (p01 * (1 - ax) + p11 * ax) * ay;
  }
  return out;
}

// ── 复现 TerrainSampler 的世界坐标(逐列/逐行近似,与渲染一致) ──
const R = 6378137, D2R = Math.PI / 180;
const lon0 = 106.5 * D2R, p1 = 25.5 * D2R, p2 = 28.5 * D2R;
const n = (Math.sin(p1) + Math.sin(p2)) / 2;
const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
const rho0 = R * Math.sqrt(C - 2 * n * Math.sin(26.8 * D2R)) / n;
const proj = (lon, lat) => {
  const lam = lon * D2R - lon0, phi = lat * D2R;
  const rho = R * Math.sqrt(Math.max(0, C - 2 * n * Math.sin(phi))) / n;
  const th = n * lam;
  return { x: rho * Math.sin(th), y: rho0 - rho * Math.cos(th) };
};
const unproj = (x, y) => {
  const th = Math.atan2(x, rho0 - y), rho = Math.hypot(x, rho0 - y);
  const phi = Math.asin((C - (rho * n / R) ** 2) / (2 * n));
  return { lon: th / n / D2R + 106.5, lat: phi / D2R };
};

const mPerDegLon = (() => { const a = proj(106.5, 26.8), b = proj(107.5, 26.8); return b.x - a.x; })();
const mPerDegLat = (() => { const a = proj(106.5, 26.3), b = proj(106.5, 27.3); return b.y - a.y; })();
const latC = north - (rows - 1) * dLat / 2;
const colX = new Float64Array(cols), rowZ = new Float64Array(rows);
for (let i = 0; i < cols; i++) colX[i] = (proj(west + i * dLon, latC).x - world.originX) * world.scale;
for (let j = 0; j < rows; j++) rowZ[j] = -(proj(west + cols * dLon / 2, north - j * dLat).y - world.originY) * world.scale;

const colAt = (x) => {
  if (x <= colX[0]) return 0;
  if (x >= colX[cols - 1]) return cols - 1;
  let lo = 0, hi = cols - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (colX[m] <= x) lo = m; else hi = m; }
  return lo + (x - colX[lo]) / (colX[hi] - colX[lo]);
};
const rowAt = (z) => {
  if (z <= rowZ[0]) return 0;
  if (z >= rowZ[rows - 1]) return rows - 1;
  let lo = 0, hi = rows - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (rowZ[m] <= z) lo = m; else hi = m; }
  return lo + (z - rowZ[lo]) / (rowZ[hi] - rowZ[lo]);
};

// ── 底图采样到 DEM 网格(渲染时实际采样点) ──
log('sat', `采样底图 ${cols}×${rows} …`);
const t0 = Date.now();
const satR = new Float32Array(cols * rows), satG = new Float32Array(cols * rows), satB = new Float32Array(cols * rows);
const hasSat = new Uint8Array(cols * rows);
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const wx = colX[i], wz = rowZ[j];
    // 渲染时顶点实际位置 → 投影平面 → 经纬度
    const ll = unproj(wx / world.scale + world.originX, -wz / world.scale + world.originY);
    const s = sampleSat(ll.lon, ll.lat);
    if (!s) continue;
    const k = j * cols + i;
    satR[k] = s[0]; satG[k] = s[1]; satB[k] = s[2]; hasSat[k] = 1;
  }
}
log('sat', `采样完成 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

// ── 水体判据:暗且偏蓝 ──
const isWater = (k) => {
  if (!hasSat[k]) return false;
  const r = satR[k] / 255, g = satG[k] / 255, b = satB[k] / 255;
  return b > r + 0.02 && (r + g + b) / 3 < 0.42;
};
const mask = new Uint8Array(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.mask.bin')));

let inProv = 0, waterAll = 0;
for (let k = 0; k < cols * rows; k++) {
  if (mask[k] < 128) continue;
  inProv++;
  if (isWater(k)) waterAll++;
}
const waterBase = waterAll / inProv;

// ── 河网/湖库附近的吻合度 ──
const rivers = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'rivers/rivers.json'), 'utf8'));
const lakes = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'rivers/lakes.json'), 'utf8'));

function hitRate(points, radius) {
  let hit = 0, tot = 0;
  const seen = new Set();
  for (const [wx, wz] of points) {
    const ci = Math.round(colAt(wx)), ri = Math.round(rowAt(wz));
    for (let dj = -radius; dj <= radius; dj++) {
      for (let di = -radius; di <= radius; di++) {
        const i = ci + di, j = ri + dj;
        if (i < 0 || j < 0 || i >= cols || j >= rows) continue;
        const k = j * cols + i;
        if (seen.has(k)) continue;
        seen.add(k);
        if (mask[k] < 128) continue;
        tot++;
        if (isWater(k)) hit++;
      }
    }
  }
  return tot ? hit / tot : 0;
}

const riverPts = [];
for (const f of rivers.features) {
  const p = f.p;
  for (let i = 0; i < p.length; i += 2) riverPts.push([p[i], p[i + 1]]);
}
const lakePts = [];
for (const f of lakes.features) {
  const p = f.p;
  for (let i = 0; i < p.length; i += 2) lakePts.push([p[i], p[i + 1]]);
}

const riverHit = hitRate(riverPts, 2);
const lakeHit = hitRate(lakePts, 2);
log('sat', `全省水像元占比      ${(waterBase * 100).toFixed(2)}%`);
log('sat', `河网周边(±2格)水占比 ${(riverHit * 100).toFixed(2)}%  → 提升 ${(riverHit / waterBase).toFixed(1)}×`);
log('sat', `湖库周边(±2格)水占比 ${(lakeHit * 100).toFixed(2)}%  → 提升 ${(lakeHit / waterBase).toFixed(1)}×`);

// ── 叠加图:底图 + 河线(红) + 湖(蓝) + 省界(黄) ──
const png = new PNG({ width: cols, height: rows });
for (let j = 0; j < rows; j++) {
  for (let i = 0; i < cols; i++) {
    const k = j * cols + i, o = k * 4;
    const v = hasSat[k] ? (satR[k] * 0.35 + satG[k] * 0.5 + satB[k] * 0.15) / 255 : 0.08;
    png.data[o] = Math.round(v * 255 * 0.8);
    png.data[o + 1] = Math.round(v * 255 * 0.85);
    png.data[o + 2] = Math.round(v * 255 * 0.8);
    png.data[o + 3] = 255;
  }
}
const put = (i, j, r, g, b) => {
  if (i < 0 || j < 0 || i >= cols || j >= rows) return;
  const o = (j * cols + i) * 4;
  png.data[o] = r; png.data[o + 1] = g; png.data[o + 2] = b;
};
for (const [wx, wz] of riverPts) {
  const i = Math.round(colAt(wx)), j = Math.round(rowAt(wz));
  put(i, j, 255, 60, 40); put(i + 1, j, 255, 60, 40); put(i, j + 1, 255, 60, 40);
}
for (const [wx, wz] of lakePts) {
  const i = Math.round(colAt(wx)), j = Math.round(rowAt(wz));
  put(i, j, 40, 120, 255); put(i + 1, j, 40, 120, 255); put(i, j + 1, 40, 120, 255);
}
for (let j = 1; j < rows - 1; j++) {
  for (let i = 1; i < cols - 1; i++) {
    const k = j * cols + i;
    if (mask[k] >= 128) continue;
    if (mask[k + 1] >= 128 || mask[k - 1] >= 128 || mask[k + cols] >= 128 || mask[k - cols] >= 128) {
      put(i, j, 255, 220, 60);
    }
  }
}
const outDir = path.join(DIRS.processed, 'validate');
fs.mkdirSync(outDir, { recursive: true });
const outPng = path.join(outDir, 'sat_overlay.png');
fs.writeFileSync(outPng, PNG.sync.write(png));
log('sat', `叠加图 → ${outPng}`);
log('sat', `DONE  riverBoost=${(riverHit / waterBase).toFixed(1)} lakeBoost=${(lakeHit / waterBase).toFixed(1)}`);
