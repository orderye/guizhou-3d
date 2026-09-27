// 下载 OSM 真实数据(Overpass API):水系/湖泊/林地/道路/居民点/贵阳建筑
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, BBOX, log } from '../config.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter'
];

const BB = `${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}`;

// name: 输出文件名; q: 查询
const QUERIES = [
  {
    name: 'places', q: `[out:json][timeout:180];node["place"~"^(city|town|county_seat)$"]["name"](${BB});out body;`
  },
  {
    name: 'rivers', q: `[out:json][timeout:300];way["waterway"="river"](${BB});out geom;`
  },
  {
    name: 'streams', q: `[out:json][timeout:300];way["waterway"~"^(stream|canal)$"](${BB});out geom;`
  },
  {
    name: 'water', q: `[out:json][timeout:300];(way["natural"="water"](${BB});relation["natural"="water"](${BB});way["landuse"="reservoir"](${BB}););out geom;`
  },
  {
    name: 'woods', q: `[out:json][timeout:300];(way["natural"="wood"](${BB});relation["natural"="wood"](${BB});way["landuse"="forest"](${BB}););out geom;`
  },
  {
    name: 'roads', q: `[out:json][timeout:300];way["highway"~"^(motorway|trunk|primary)$"](${BB});out geom;`
  },
  {
    name: 'buildings-guiyang', q: `[out:json][timeout:180];way["building"](26.52,106.58,26.74,106.84);out geom;`,
    optional: true, maxBytes: 80 * 1024 * 1024
  }
];

async function fetchQuery(q, maxBytes = Infinity) {
  let lastErr;
  for (let ep = 0; ep < ENDPOINTS.length; ep++) {
    const url = ENDPOINTS[ep];
    try {
      log('osm', `POST ${new URL(url).host} (${(q.length / 1024).toFixed(1)}KB query)`);
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 420000);
      const res = await fetch(url, {
        method: 'POST',
        signal: ac.signal,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': 'guizhou-3d-sandbox/3.0 (data pipeline)'
        },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const len = Number(res.headers.get('content-length') || 0);
      if (len > maxBytes) throw new Error(`too large ${len}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error(`too large ${buf.length}`);
      return buf;
    } catch (e) {
      lastErr = e;
      log('osm', `endpoint fail: ${e.message}`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  throw lastErr;
}

export async function downloadOsm() {
  fs.mkdirSync(DIRS.rawOsm, { recursive: true });
  const failed = [];
  for (const { name, q, optional, maxBytes } of QUERIES) {
    const fp = path.join(DIRS.rawOsm, `${name}.json`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 500) { log('osm', `cached ${name}`); continue; }
    try {
      const buf = await fetchQuery(q, maxBytes);
      fs.writeFileSync(fp, buf);
      log('osm', `saved ${name} (${(buf.length / 1024 / 1024).toFixed(1)}MB)`);
    } catch (e) {
      log('osm', `FAILED ${name}: ${e.message}${optional ? ' (optional, skipped)' : ''}`);
      if (!optional) failed.push(name);
    }
  }
  fs.writeFileSync(path.join(DIRS.rawOsm, 'meta.json'), JSON.stringify({
    source: 'OpenStreetMap via Overpass API (© OpenStreetMap contributors, ODbL)',
    endpoints: ENDPOINTS, bbox: BBOX, downloadedAt: new Date().toISOString(),
    failed
  }, null, 2));
  return failed.length === 0;
}
