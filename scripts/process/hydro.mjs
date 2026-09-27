// 水系预处理:OSM 河流/湖泊 → 贵州裁剪、分级、简化、世界坐标
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, BBOX, PROJ, log } from '../config.mjs';
import { lineToProj, densify, simplifyDP, ringArea, ringBBox } from './geometry.mjs';
import { WORLD } from './world.mjs';

// 一级河流(方案 §3.2):真实命名匹配
const RANK1 = ['乌江', '赤水河', '北盘江', '南盘江', '红水河', '清水江', '都柳江', '㵲阳河', '舞阳河', '六冲河', '三岔河', '猫跳河', '芙蓉江', '洪渡河', '樟江', '打狗河', '濛江', '格凸河', '蒙江', '湘江', '清水河', '余庆河', '石阡河', '印江河', '洪州河', '南明河'];
const RANK1_SET = new Set(RANK1.filter(n => n.length >= 2));

export function loadMask() {
  const p = path.join(DIRS.processed, 'terrain/maskHard.bin');
  if (!fs.existsSync(p)) throw new Error('先运行 dem 预处理');
  const meta = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.meta.json'), 'utf8'));
  return { mask: new Uint8Array(fs.readFileSync(p).buffer), meta };
}

function maskAt(mask, meta, lon, lat) {
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const c = Math.floor((lon - west) / dLon);
  const r = Math.floor((north - lat) / dLat);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
  return mask[r * cols + c];
}

// 折线裁剪:加密→掩膜筛选→按断口分段
export function clipLine(lonlat, mask, meta, stepM = 220, maxGapM = 520) {
  const proj = densify(lineToProj(lonlat), stepM);
  const n = proj.length / 2;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const { lon, lat } = PROJ.unproject(proj[i * 2], proj[i * 2 + 1]);
    inside[i] = maskAt(mask, meta, lon, lat) > 127 ? 1 : 0;
  }
  const runs = [];
  let cur = null;
  for (let i = 0; i < n; i++) {
    if (!inside[i]) { cur = null; continue; }
    if (cur && Math.hypot(proj[i * 2] - proj[(i - 1) * 2], proj[i * 2 + 1] - proj[(i - 1) * 2 + 1]) > maxGapM) cur = null;
    if (!cur) { cur = []; runs.push(cur); }
    cur.push(proj[i * 2], proj[i * 2 + 1]);
  }
  return runs; // [ [x,y,...proj meters], ... ]
}

export function projToWorldArr(f64) {
  const out = new Float32Array(f64.length);
  for (let i = 0; i < f64.length; i += 2) {
    out[i] = (f64[i] - WORLD.originX) * WORLD.scale;
    out[i + 1] = -(f64[i + 1] - WORLD.originY) * WORLD.scale;
  }
  return out;
}

function riverRank(name, waterway) {
  if (name && RANK1_SET.has(name)) return 1;
  if (waterway === 'river') return 2;
  if (waterway === 'canal') return 3;
  return 3; // stream
}
export const RIVER_WIDTH = { 1: 0.46, 2: 0.22, 3: 0.09 };

export function run() {
  const t0 = Date.now();
  const { mask, meta } = loadMask();
  fs.mkdirSync(path.join(DIRS.runtime, 'rivers'), { recursive: true });

  // ── 河流 ──
  const raw = JSON.parse(fs.readFileSync(path.join(DIRS.rawOsm, 'rivers.json'), 'utf8'));
  const rawStreams = fs.existsSync(path.join(DIRS.rawOsm, 'streams.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIRS.rawOsm, 'streams.json'), 'utf8')) : { elements: [] };
  const features = [];
  let dropped = 0;
  const seen = new Set();
  for (const el of [...raw.elements, ...rawStreams.elements]) {
    if (el.type !== 'way' || !el.geometry) continue;
    const tags = el.tags || {};
    const name = tags.name || '';
    const ww = tags.waterway || 'stream';
    const lonlat = el.geometry.map(g => [g.lon, g.lat]);
    const runs = clipLine(lonlat, mask, meta);
    const rank = riverRank(name, ww);
    const minLen = rank === 1 ? 4000 : rank === 2 ? 5000 : 2500;
    for (const runProj of runs) {
      const len = runProj.length / 2 >= 2
        ? runProj.slice(2).reduce((s, _, i) => i % 2 === 0 ? s + Math.hypot(runProj[i + 2] - runProj[i], runProj[i + 3] - runProj[i + 1]) : s, 0)
        : 0;
      if (runProj.length / 2 < 2 || len < minLen) { dropped++; continue; }
      const tol = rank === 1 ? 60 : rank === 2 ? 110 : 170;
      const simp = simplifyDP(runProj, tol);
      const key = simp.slice(0, 4).join(',') + '|' + simp.length;
      if (seen.has(key)) continue;
      seen.add(key);
      features.push({ n: name, r: rank, w: RIVER_WIDTH[rank], p: Array.from(projToWorldArr(simp)) });
    }
  }
  log('hydro', `rivers: ${features.length} segments (dropped ${dropped} short/out)`);
  const rankCount = [0, 0, 0, 0];
  features.forEach(f => rankCount[f.r]++);
  log('hydro', `rank1=${rankCount[1]} rank2=${rankCount[2]} rank3=${rankCount[3]}`);

  // ── 湖泊/水库 ──
  const lakes = [];
  const waterRaw = fs.existsSync(path.join(DIRS.rawOsm, 'water.json'))
    ? JSON.parse(fs.readFileSync(path.join(DIRS.rawOsm, 'water.json'), 'utf8')) : { elements: [] };
  const elevBin = fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin'));
  const elevG = new Uint16Array(elevBin.buffer);
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const elevAt = (lon, lat) => {
    const c = Math.round((lon - west) / dLon), r = Math.round((north - lat) / dLat);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
    return elevG[r * cols + c];
  };
  for (const el of waterRaw.elements) {
    if (el.type === 'way' && el.geometry) {
      const ring = el.geometry.map(g => [g.lon, g.lat]);
      if (ring.length < 4) continue;
      processLakeRing(ring, el.tags || {}, lakes, elevAt, mask, meta);
    } else if (el.type === 'relation' && el.members) {
      // 简化:取 outer 闭合成员环
      const outer = el.members.filter(m => m.type === 'way' && m.geometry && m.role !== 'inner');
      for (const m of outer) {
        const ring = m.geometry.map(g => [g.lon, g.lat]);
        if (ring.length < 4) continue;
        const a = ring[0], b = ring[ring.length - 1];
        if (Math.abs(a[0] - b[0]) > 1e-9 || Math.abs(a[1] - b[1]) > 1e-9) continue; // 非闭合跳过(不做完整多边形拼装)
        processLakeRing(ring, el.tags || {}, lakes, elevAt, mask, meta);
      }
    }
  }
  log('hydro', `lakes/reservoirs: ${lakes.length}`);

  fs.writeFileSync(path.join(DIRS.runtime, 'rivers/rivers.json'),
    JSON.stringify({ features }));
  fs.writeFileSync(path.join(DIRS.runtime, 'rivers/lakes.json'),
    JSON.stringify({ features: lakes }));
  log('hydro', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s, rivers.json ${(fs.statSync(path.join(DIRS.runtime, 'rivers/rivers.json')).size / 1e6).toFixed(1)}MB`);
}

function processLakeRing(ring, tags, out, elevAt, mask, meta) {
  const proj = lineToProj(ring);
  const areaKm2 = ringArea(proj) / 1e6;
  if (areaKm2 < 0.35) return;
  // 大部分顶点在省内才保留
  let inN = 0;
  for (let i = 0; i < ring.length; i++) {
    inN += maskAtPub(mask, meta, ring[i][0], ring[i][1]) ? 1 : 0;
  }
  if (inN / ring.length < 0.55) return;
  // 采样环顶点最小高程作为水面
  let surf = Infinity;
  for (const [lon, lat] of ring) {
    const e = elevAt(lon, lat);
    if (e !== null && e < surf) surf = e;
  }
  if (!isFinite(surf)) return;
  const bbox = ringBBox(proj);
  if ((bbox.maxX - bbox.minX) * (bbox.maxY - bbox.minY) < 200 * 200) return;
  const simp = simplifyDP(proj, 60);
  out.push({
    n: tags.name || '',
    a: Math.round(areaKm2 * 10) / 10,
    surf,
    p: Array.from(projToWorldArr(simp))
  });
}
function maskAtPub(mask, meta, lon, lat) {
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const c = Math.floor((lon - west) / dLon), r = Math.floor((north - lat) / dLat);
  if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
  return mask[r * cols + c] > 127;
}
