// 城市预处理:OSM 居民点 + DataV 县级行政中心 → 分级城市表
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { loadMask } from './hydro.mjs';
import { PREFECTURES } from '../download/admin.mjs';

const TIER1 = new Set(['贵阳', '贵阳市', 'Guiyang']);
const TIER2 = new Set(['遵义', '遵义市', '六盘水', '六盘水市', '安顺', '安顺市', '毕节', '毕节市', '铜仁', '铜仁市', '凯里', '凯里市', '都匀', '都匀市', '兴义', '兴义市']);

export function run() {
  const t0 = Date.now();
  const { mask, meta } = loadMask();
  const { cols, rows, west, north, dLon, dLat } = meta.grid;
  const maskAt = (lon, lat) => {
    const c = Math.floor((lon - west) / dLon), r = Math.floor((north - lat) / dLat);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return 0;
    return mask[r * cols + c];
  };
  const toWorld = (lon, lat) => WORLD.toWorld(lon, lat);

  // ── OSM 居民点 ──
  const osm = [];
  const raw = JSON.parse(fs.readFileSync(path.join(DIRS.rawOsm, 'places.json'), 'utf8'));
  for (const el of raw.elements) {
    if (el.type !== 'node' || !el.tags) continue;
    const t = el.tags;
    if (!t.name || !t.place) continue;
    if (!['city', 'town', 'county_seat'].includes(t.place)) continue;
    if (!maskAt(el.lon, el.lat)) continue;
    osm.push({
      name: t['name:zh'] || t.name,
      place: t.place,
      pop: parseInt(t.population || '0', 10) || 0,
      lon: el.lon, lat: el.lat
    });
  }
  log('cities', `OSM places in province: ${osm.length}`);

  // ── DataV 县级中心(真实行政中心坐标) ──
  const counties = [];
  for (const [pcode] of PREFECTURES) {
    const fp = path.join(DIRS.rawAdmin, `${pcode}_full.json`);
    if (!fs.existsSync(fp)) continue;
    const j = JSON.parse(fs.readFileSync(fp, 'utf8'));
    for (const f of j.features) {
      const p = f.properties || {};
      if (p.level !== 'district' || !p.name) continue;
      const c = p.center || p.centroid;
      if (!c) continue;
      counties.push({ name: p.name, lon: c[0], lat: c[1], adcode: p.adcode });
    }
  }
  log('cities', `DataV county centers: ${counties.length}`);

  // 县城匹配:OSM town 距县级中心 < 4km → Tier 3
  const km = (lon1, lat1, lon2, lat2) => {
    const dx = (lon2 - lon1) * 111.32 * Math.cos(lat1 * Math.PI / 180);
    const dy = (lat2 - lat1) * 110.9;
    return Math.hypot(dx, dy);
  };
  const cities = [];
  const used = new Set();
  for (const c of counties) {
    let best = null, bestD = 4.5;
    for (const o of osm) {
      if (used.has(o) || o.place === 'city') continue;
      const d = km(c.lon, c.lat, o.lon, o.lat);
      if (d < bestD) { bestD = d; best = o; }
    }
    const w = toWorld(c.lon, c.lat);
    if (best) {
      used.add(best);
      cities.push({ n: c.name, t: 3, pop: best.pop || 30000, x: w.x, z: w.z, r: 2000, lon: best.lon, lat: best.lat });
    } else {
      cities.push({ n: c.name, t: 3, pop: 30000, x: w.x, z: w.z, r: 2000, lon: c.lon, lat: c.lat });
    }
  }
  // 主要城市
  for (const o of osm) {
    if (used.has(o)) continue;
    const isCity = o.place === 'city';
    const nm = o.name;
    let tier = 0;
    if (isCity && TIER1.has(nm)) tier = 1;
    else if (isCity && TIER2.has(nm)) tier = 2;
    if (tier > 0) {
      const w = toWorld(o.lon, o.lat);
      cities.push({ n: nm.replace(/市$/, ''), t: tier, pop: o.pop || (tier === 1 ? 4400000 : 800000), x: w.x, z: w.z, r: tier === 1 ? 8500 : 5200, lon: o.lon, lat: o.lat });
      used.add(o);
    }
  }
  // 其余 OSM towns → Tier 4 乡镇
  let t4 = 0;
  for (const o of osm) {
    if (used.has(o)) continue;
    const w = toWorld(o.lon, o.lat);
    cities.push({ n: o.name, t: 4, pop: o.pop || 8000, x: w.x, z: w.z, r: 1000, lon: o.lon, lat: o.lat });
    t4++;
  }
  cities.sort((a, b) => a.t - b.t || b.pop - a.pop);
  const tierCount = [0, 0, 0, 0, 0];
  cities.forEach(c => tierCount[c.t]++);
  log('cities', `T1=${tierCount[1]} T2=${tierCount[2]} T3=${tierCount[3]} T4=${tierCount[4]} total=${cities.length}`);

  fs.mkdirSync(path.join(DIRS.runtime, 'cities'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.runtime, 'cities/cities.json'), JSON.stringify({ cities }));
  log('cities', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && process.argv[1].endsWith('cities.mjs')) run();
