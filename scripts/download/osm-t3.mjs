// T3 县城真实建筑批量下载(88 县区,逐城小 bbox,节流 + 重试)
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

async function fetchOne(q) {
  for (const url of ENDPOINTS) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 90000);
      const res = await fetch(url, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'guizhou-3d-sandbox/3.0' },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log('t3', `  ${new URL(url).host}: ${e.message}`);
      await new Promise(r => setTimeout(r, 2500));
    }
  }
  return null;
}

async function main() {
  const cities = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'cities/cities.json'), 'utf8')).cities;
  const t3 = cities.filter(c => c.t === 3);
  log('t3', `T3 counties: ${t3.length}`);
  let ok = 0, empty = 0, fail = 0;
  let i = 0;
  for (const c of t3) {
    i++;
    const fp = path.join(DIRS.rawOsm, `buildings-t3-${c.n}.json`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 400) { ok++; continue; }
    // bbox:县城半径 1.6km → ±0.02°
    const dLat = 2200 / 110900, dLon = 2200 / (111320 * Math.cos(c.lat * Math.PI / 180));
    const s = (c.lat - dLat).toFixed(4), w = (c.lon - dLon).toFixed(4), n = (c.lat + dLat).toFixed(4), e = (c.lon + dLon).toFixed(4);
    const q = `[out:json][timeout:60];way["building"](${s},${w},${n},${e});out geom;`;
    const buf = await fetchOne(q);
    if (buf) {
      fs.writeFileSync(fp, buf);
      const el = JSON.parse(buf.toString('utf8')).elements.length;
      if (el === 0) empty++;
      ok++;
      log('t3', `[${i}/${t3.length}] ${c.n}: ${el} 栋`);
    } else {
      fail++;
      log('t3', `[${i}/${t3.length}] ${c.n} FAILED`);
    }
    await new Promise(r => setTimeout(r, 1200)); // 节流
  }
  log('t3', `DONE ok=${ok} empty=${empty} fail=${fail}`);
}
main();
