// 对超时的 Overpass 查询做 2×2 分块重试,合并为单文件
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, BBOX, log } from '../config.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter'
];

function subBoxes() {
  const midLon = (BBOX.west + BBOX.east) / 2, midLat = (BBOX.south + BBOX.north) / 2;
  const S = BBOX.south, N = BBOX.north, W = BBOX.west, E = BBOX.east;
  return [
    [S, W, midLat, midLon], [S, midLon, midLat, E],
    [midLat, W, N, midLon], [midLat, midLon, N, E]
  ];
}

async function fetchOne(q, maxBytes) {
  for (let ep = 0; ep < ENDPOINTS.length; ep++) {
    const url = ENDPOINTS[ep];
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 480000);
      const res = await fetch(url, {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'guizhou-3d-sandbox/3.0' },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes) throw new Error('too large');
      return buf;
    } catch (e) {
      log('retry', `  ${new URL(url).host}: ${e.message}`);
      await new Promise(r => setTimeout(r, 4000));
    }
  }
  return null;
}

async function fetchSplit(qTemplate, maxBytes) {
  const parts = [];
  for (const [s, w, n, e] of subBoxes()) {
    const q = qTemplate.replace('%BB%', `${s},${w},${n},${e}`);
    log('retry', `sub-bbox ${s.toFixed(2)},${w.toFixed(2)} → ${n.toFixed(2)},${e.toFixed(2)}`);
    const buf = await fetchOne(q, maxBytes);
    if (buf === null) return null;
    parts.push(JSON.parse(buf.toString('utf8')));
  }
  const merged = { version: 0.6, generator: 'merged', elements: parts.flatMap(p => p.elements || []) };
  return Buffer.from(JSON.stringify(merged));
}

const JOBS = [
  { name: 'streams', maxBytes: 60 * 1024 * 1024, q: `[out:json][timeout:600][maxsize:536870912];way["waterway"~"^(stream|canal)$"](%BB%);out geom;` },
  { name: 'water', maxBytes: 60 * 1024 * 1024, q: `[out:json][timeout:600][maxsize:536870912];(way["natural"="water"](%BB%);relation["natural"="water"](%BB%);way["landuse"="reservoir"](%BB%););out geom;` },
  { name: 'roads', maxBytes: 60 * 1024 * 1024, q: `[out:json][timeout:600][maxsize:536870912];way["highway"~"^(motorway|trunk|primary)$"](%BB%);out geom;` }
];

async function main() {
  const failed = [];
  for (const { name, q, maxBytes } of JOBS) {
    const fp = path.join(DIRS.rawOsm, `${name}.json`);
    if (fs.existsSync(fp) && fs.statSync(fp).size > 500) { log('retry', `${name} cached`); continue; }
    log('retry', `>>> ${name}`);
    const buf = await fetchSplit(q, maxBytes);
    if (buf) {
      fs.writeFileSync(fp, buf);
      log('retry', `saved ${name} (${(buf.length / 1e6).toFixed(1)}MB)`);
    } else { failed.push(name); log('retry', `FAILED ${name}`); }
  }
  log('retry', failed.length ? `FAILED: ${failed.join(',')}` : 'ALL RETRY OK');
}
main();
