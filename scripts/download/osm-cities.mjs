// T1/T2 城市真实建筑 footprint 下载(Overpass,逐城小 bbox)
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

async function fetchOne(q) {
  for (const url of ENDPOINTS) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 240000);
      const res = await fetch(url, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'guizhou-3d-sandbox/3.0' },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log('bld', `  ${new URL(url).host}: ${e.message}`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  return null;
}

async function main() {
  const cities = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'cities/cities.json'), 'utf8')).cities;
  const majors = cities.filter(c => c.t <= 2);
  let fail = 0;
  for (const c of majors) {
    const fp = path.join(DIRS.rawOsm, `buildings-${c.n}.json`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 500) { log('bld', `${c.n} cached`); continue; }
    // bbox:中心 ± r×1.35(米→度)
    const dLat = c.r * 1.35 / 110900;
    const dLon = c.r * 1.35 / (111320 * Math.cos(c.lat * Math.PI / 180));
    const s = (c.lat - dLat).toFixed(4), w = (c.lon - dLon).toFixed(4), n = (c.lat + dLat).toFixed(4), e = (c.lon + dLon).toFixed(4);
    const q = `[out:json][timeout:240];way["building"](${s},${w},${n},${e});out geom;`;
    log('bld', `>>> ${c.n} (${s},${w},${n},${e})`);
    const buf = await fetchOne(q);
    if (buf) {
      fs.writeFileSync(fp, buf);
      log('bld', `saved ${c.n} (${(buf.length / 1e6).toFixed(1)}MB)`);
    } else { fail++; log('bld', `FAILED ${c.n}`); }
  }
  log('bld', fail ? `FINISHED WITH ${fail} FAILURES` : 'ALL OK');
}
main();
