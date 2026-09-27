// 城市真实建筑 footprint(T1/T2)→ 有向包围盒实例数据
// 输出:{ cities: [{ city, items: [[x,z,wM,dM,rot,hM],...] }] }
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { loadMask } from './hydro.mjs';
import { mulberry32 } from './geometry.mjs';

function processFile(fp, centerLon, centerLat, cityLabel, mask, meta, rng, cap = 6000) {
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const maskAt = (lon, lat) => {
    const c = Math.floor((lon - west) / dLon), r = Math.floor((north - lat) / dLat);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
    return mask[r * cols + c] > 127;
  };
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const mPerUnit = 1 / WORLD.scale;
  const items = [];
  for (const el of raw.elements) {
    if (el.type !== 'way' || !el.geometry) continue;
    const g = el.geometry;
    if (g.length < 4) continue;
    const tags = el.tags || {};
    if (!maskAt(g[0].lon, g[0].lat)) continue;
    // 有向包围盒(PCA)
    let mx = 0, my = 0;
    const W = [];
    for (const p of g) {
      const w = WORLD.toWorld(p.lon, p.lat);
      W.push([w.x, w.z]);
      mx += w.x; my += w.z;
    }
    mx /= g.length; my /= g.length;
    let sxx = 0, sxy = 0, syy = 0;
    for (const [dx0, dy0] of W) {
      const dx = dx0 - mx, dy = dy0 - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const theta = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const cos = Math.cos(-theta), sin = Math.sin(-theta);
    let minU = Infinity, maxU = -Infinity, minV = Infinity, maxV = -Infinity;
    for (const [dx, dy] of W) {
      const u = dx * cos - dy * sin, v = dx * sin + dy * cos;
      minU = Math.min(minU, u); maxU = Math.max(maxU, u);
      minV = Math.min(minV, v); maxV = Math.max(maxV, v);
    }
    const mPerUnitW = WORLD.widthMeters / WORLD.widthUnits;
    const wM = (maxU - minU) * mPerUnitW, dM = (maxV - minV) * mPerUnitW;
    if (wM < 8 || dM < 8 || wM > 220 || dM > 220) continue;
    if (Math.max(wM, dM) / Math.min(wM, dM) > 8) continue; // 细长条伪影剔除
    const cx = mx + (cos * (minU + maxU) / 2 - sin * (minV + maxV) / 2);
    const cz = my + (sin * (minU + maxU) / 2 + cos * (minV + maxV) / 2);
    let h;
    if (tags.height) h = parseFloat(tags.height) || 0;
    else if (tags['building:levels']) h = (parseFloat(tags['building:levels']) || 3) * 3.4;
    else h = 9 + rng() * 18;
    h = Math.max(6, Math.min(120, h));
    items.push([
      Math.round(cx * 1000) / 1000, Math.round(cz * 1000) / 1000,
      Math.round(wM), Math.round(dM),
      Math.round(theta * 1000) / 1000, Math.round(h * 10) / 10
    ]);
  }
  // 超限抽样(控制运行时规模)
  if (items.length > cap) {
    for (let i = items.length - 1; i > 0; i--) {
      const j = (rng() * (i + 1)) | 0;
      [items[i], items[j]] = [items[j], items[i]];
    }
    items.length = cap;
  }
  return { city: cityLabel, items };
}

export function run() {
  const t0 = Date.now();
  const { mask, meta } = loadMask();
  const rng = mulberry32(20260926);
  const cities = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'cities/cities.json'), 'utf8')).cities;

  const files = fs.readdirSync(DIRS.rawOsm).filter(f => f.startsWith('buildings-') && f.endsWith('.json'));
  const out = [];
  let total = 0;
  for (const f of files) {
    let label = f.replace(/^buildings-/, '').replace(/\.json$/, '');
    let lon = null, lat = null, cap = 6000;
    if (label === 'guiyang') {
      lon = 106.65; lat = 26.62; label = '贵阳';
    } else if (label.startsWith('t3-')) {
      label = label.slice(3);
      const c = cities.find(x => x.n === label && x.t === 3);
      if (!c) { log('buildings', `跳过 ${f}(未匹配县城)`); continue; }
      lon = c.lon; lat = c.lat; cap = 3000;
    } else {
      const c = cities.find(x => (x.n === label || x.n === label + '市') && x.t <= 2);
      if (!c) { log('buildings', `跳过 ${f}(未匹配城市)`); continue; }
      lon = c.lon; lat = c.lat;
    }
    const r = processFile(path.join(DIRS.rawOsm, f), lon, lat, label, mask, meta, rng, cap);
    out.push(r);
    total += r.items.length;
    log('buildings', `${label}: ${r.items.length} 栋`);
  }
  log('buildings', `合计 ${total} 栋真实 footprint in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.mkdirSync(path.join(DIRS.runtime, 'cities'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.runtime, 'cities/buildings.json'), JSON.stringify({ cities: out }));
}

if (process.argv[1] && process.argv[1].endsWith('buildings.mjs')) run();
