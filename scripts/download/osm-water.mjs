// water(湖泊/水库)专项下载:3×3 分块 + 多轮重试
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, BBOX, log } from '../config.mjs';

const ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
  'https://overpass.osm.ch/api/interpreter',
  'https://overpass.osm.jp/api/interpreter'
];

function subBoxes(n) {
  const out = [];
  const dl = (BBOX.east - BBOX.west) / n, la = (BBOX.north - BBOX.south) / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    out.push([BBOX.south + j * la, BBOX.west + i * dl, BBOX.south + (j + 1) * la, BBOX.west + (i + 1) * dl]);
  }
  return out;
}

async function fetchOne(q) {
  for (let ep = 0; ep < ENDPOINTS.length; ep++) {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 300000);
      const res = await fetch(ENDPOINTS[ep], {
        method: 'POST', signal: ac.signal,
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'guizhou-3d-sandbox/3.0' },
        body: 'data=' + encodeURIComponent(q)
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      log('water', `  ${new URL(ENDPOINTS[ep]).host}: ${e.message}`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  return null;
}

async function main() {
  const fp = path.join(DIRS.rawOsm, 'water.json');
  if (fs.existsSync(fp) && fs.statSync(fp).size > 500) { log('water', 'cached'); return; }
  const N = 3;
  const parts = [];
  const boxes = subBoxes(N);
  for (let b = 0; b < boxes.length; b++) {
    const [s, w, n2, e] = boxes[b];
    const q = `[out:json][timeout:300][maxsize:536870912];(way["natural"="water"](${s},${w},${n2},${e});relation["natural"="water"](${s},${w},${n2},${e});way["landuse"="reservoir"](${s},${w},${n2},${e}););out geom;`;
    let buf = null;
    for (let attempt = 1; attempt <= 3 && !buf; attempt++) {
      log('water', `block ${b + 1}/${boxes.length} attempt ${attempt}`);
      buf = await fetchOne(q);
    }
    if (!buf) { log('water', `BLOCK ${b + 1} FAILED, abort run`); return; }
    parts.push(JSON.parse(buf.toString('utf8')));
  }
  const merged = { version: 0.6, generator: 'merged', elements: parts.flatMap(p => p.elements || []) };
  fs.writeFileSync(fp, JSON.stringify(merged));
  log('water', `saved water.json (${(fs.statSync(fp).size / 1e6).toFixed(1)}MB)`);
}
main();
