// 行政边界预处理:省界(强)/ 市州界(淡)/ 县界(默认关) → 世界坐标折线
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, PROJ, log } from '../config.mjs';
import { lineToProj, simplifyDP } from './geometry.mjs';
import { WORLD } from './world.mjs';
import { PREFECTURES } from '../download/admin.mjs';

function ringToWorld(geoCoords, tol) {
  const proj = simplifyDP(lineToProj(geoCoords), tol);
  const out = [];
  for (let i = 0; i < proj.length; i += 2) {
    out.push((proj[i] - WORLD.originX) * WORLD.scale, -(proj[i + 1] - WORLD.originY) * WORLD.scale);
  }
  return out;
}

export function run() {
  const t0 = Date.now();
  const load = (f) => JSON.parse(fs.readFileSync(path.join(DIRS.rawAdmin, f), 'utf8'));

  // 省界:取最大环
  const prov = load('520000.json');
  let best = null, bestLen = 0;
  for (const f of prov.features) {
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    for (const poly of polys) {
      const ring = poly[0];
      if (ring.length > bestLen) { bestLen = ring.length; best = ring; }
    }
  }
  const province = ringToWorld(best, 120);

  // 市州界
  const full = load('520000_full.json');
  const prefectures = [];
  for (const f of full.features) {
    const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
    let ring = null, len = 0;
    for (const p of polys) if (p[0].length > len) { len = p[0].length; ring = p[0]; }
    if (ring) prefectures.push({ n: f.properties.name, p: ringToWorld(ring, 250) });
  }

  // 县界 + 县中心
  const counties = [];
  for (const [pcode] of PREFECTURES) {
    const j = load(`${pcode}_full.json`);
    for (const f of j.features) {
      const p = f.properties;
      if (p.level !== 'district') continue;
      const polys = f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : [f.geometry.coordinates];
      let ring = null, len = 0;
      for (const poly of polys) if (poly[0].length > len) { len = poly[0].length; ring = poly[0]; }
      const c = p.center || p.centroid;
      const cw = c ? WORLD.toWorld(c[0], c[1]) : null;
      counties.push({
        n: p.name, adcode: p.adcode,
        c: cw ? [Math.round(cw.x * 100) / 100, Math.round(cw.z * 100) / 100] : null,
        p: ring ? ringToWorld(ring, 400) : []
      });
    }
  }
  log('admin', `province 1, prefectures ${prefectures.length}, counties ${counties.length}`);

  fs.mkdirSync(path.join(DIRS.runtime, 'cities'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.runtime, 'cities/boundary.json'),
    JSON.stringify({ province, prefectures, counties }));
  log('admin', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && process.argv[1].endsWith('admin.mjs')) run();
