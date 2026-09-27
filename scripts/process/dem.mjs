// DEM 预处理:解码 terrarium 瓦片 → 运行时高程栅格 + 贵州掩膜(硬/软边缘)
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { DIRS, BBOX, DEM_BBOX, DEM_Z, PROJ, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { simplifyDP } from './geometry.mjs';

export function loadProvinceRings() {
  const raw = JSON.parse(fs.readFileSync(path.join(DIRS.rawAdmin, '520000.json'), 'utf8'));
  const rings = [];
  for (const f of raw.features) {
    const geom = f.geometry;
    const polys = geom.type === 'MultiPolygon' ? geom.coordinates : [geom.coordinates];
    for (const poly of polys) {
      for (let r = 0; r < poly.length; r++) {
        const proj = new Float64Array(poly[r].length * 2);
        for (let i = 0; i < poly[r].length; i++) {
          const p = PROJ.project(poly[r][i][0], poly[r][i][1]);
          proj[i * 2] = p.x; proj[i * 2 + 1] = p.y;
        }
        rings.push(proj);
      }
    }
  }
  return rings;
}

// 软边缘:内部到边界的近似距离(chamfer 3-4),按 fadeCells 衰减
export function edgeFade(hard, cols, rows, fadeCells) {
  const INF = 65535;
  const d = new Uint16Array(cols * rows).fill(INF);
  for (let i = 0; i < d.length; i++) if (!hard[i]) d[i] = 0;
  const D1 = 3, D2 = 4;
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    const i = r * cols + c; if (d[i] === 0) continue;
    let v = d[i];
    if (c > 0) v = Math.min(v, d[i - 1] + D1);
    if (r > 0) {
      v = Math.min(v, d[i - cols] + D1);
      if (c > 0) v = Math.min(v, d[i - cols - 1] + D2);
      if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + D2);
    }
    d[i] = v;
  }
  for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
    const i = r * cols + c; if (d[i] === 0) continue;
    let v = d[i];
    if (c < cols - 1) v = Math.min(v, d[i + 1] + D1);
    if (r < rows - 1) {
      v = Math.min(v, d[i + cols] + D1);
      if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + D2);
      if (c > 0) v = Math.min(v, d[i + cols - 1] + D2);
    }
    d[i] = Math.min(v, fadeCells * 4 + 2);
  }
  const out = new Uint8Array(cols * rows);
  for (let i = 0; i < d.length; i++) {
    if (!hard[i]) { out[i] = 0; continue; }
    out[i] = Math.round(255 * Math.min(1, d[i] / (fadeCells * 3)));
  }
  return out;
}

export function run() {
  const t0 = Date.now();
  fs.mkdirSync(path.join(DIRS.runtime, 'terrain'), { recursive: true });
  fs.mkdirSync(path.join(DIRS.processed, 'terrain'), { recursive: true });

  // ── 1. 解码输入瓦片(mercator 像素空间) ──
  const meta = JSON.parse(fs.readFileSync(path.join(DIRS.rawDem, 'meta.json'), 'utf8'));
  const { x0, x1, y0, y1 } = meta.tileRange;
  const inCols = (x1 - x0 + 1) * 256, inRows = (y1 - y0 + 1) * 256;
  const inp = new Int16Array(inCols * inRows);
  let nTiles = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const fp = path.join(DIRS.rawDem, `z${DEM_Z}_${x}_${y}.png`);
      if (!fs.existsSync(fp)) continue;
      const png = PNG.sync.read(fs.readFileSync(fp));
      const bx = (x - x0) * 256, by = (y - y0) * 256;
      for (let py = 0; py < 256; py++) {
        const src = (py * 256) * 4, dst = (by + py) * inCols + bx;
        for (let px = 0; px < 256; px++) {
          const o = src + px * 4;
          inp[dst + px] =
            png.data[o] * 256 + png.data[o + 1] + png.data[o + 2] / 256 - 32768;
        }
      }
      nTiles++;
    }
  }
  log('dem', `decoded ${nTiles} tiles → ${inCols}×${inRows}`);

  const mPerDegLon = (() => { const a = PROJ.project(106.5, 26.8), b = PROJ.project(107.5, 26.8); return b.x - a.x; })();
  const mPerDegLat = (() => { const a = PROJ.project(106.5, 26.3), b = PROJ.project(106.5, 27.3); return b.y - a.y; })();

  // ── 2. 输出网格尺寸(EPSG:4326 均匀网格,近方格元) ──
  const cols = 3072;
  const dLon = (BBOX.east - BBOX.west) / cols;
  const dLat = dLon * mPerDegLon / mPerDegLat;
  const rows = Math.ceil((BBOX.north - BBOX.south) / dLat);

  // ── 3. 贵州硬掩膜:先在 Albers 投影域扫描线填充(精确),再采样到 DEM 网格 ──
  const t1 = Date.now();
  const rings = loadProvinceRings();
  const hard2 = new Uint8Array(cols * rows);
  {
    const simpRings = rings.map(rg => simplifyDP(rg, 120)).filter(rg => rg.length >= 8);
    const cellP = 430;
    const px0 = WORLD.originX - WORLD.widthMeters / 2;
    const py0 = WORLD.originY - WORLD.heightMeters / 2;
    const pCols = Math.ceil(WORLD.widthMeters / cellP);
    const pRows = Math.ceil(WORLD.heightMeters / cellP);
    const pmask = new Uint8Array(pCols * pRows);
    const edges = [];
    for (const ring of simpRings) {
      const n = ring.length / 2;
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const ya = ring[j * 2 + 1], yb = ring[i * 2 + 1];
        if (ya === yb) continue;
        edges.push({ ymin: Math.min(ya, yb), ymax: Math.max(ya, yb), xa: ring[j * 2], ya, xb: ring[i * 2], yb });
      }
    }
    edges.sort((a, b) => a.ymin - b.ymin);
    let ptr = 0;
    let active = [];
    for (let pr = 0; pr < pRows; pr++) {
      const py = py0 + (pr + 0.5) * cellP;
      while (ptr < edges.length && edges[ptr].ymin <= py) active.push(edges[ptr++]);
      active = active.filter(E => E.ymax > py);
      if (!active.length) continue;
      const xs = [];
      for (const E of active) {
        const t = (py - E.ya) / (E.yb - E.ya);
        xs.push(E.xa + t * (E.xb - E.xa));
      }
      xs.sort((a, b) => a - b);
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil((xs[k] - px0) / cellP - 0.5));
        const c1 = Math.min(pCols - 1, Math.floor((xs[k + 1] - px0) / cellP - 0.5));
        for (let c = c0; c <= c1; c++) pmask[pr * pCols + c] = 255;
      }
    }
    let nInside = 0;
    for (let r = 0; r < rows; r++) {
      const lat = BBOX.north - r * dLat;
      for (let c = 0; c < cols; c++) {
        const lon = BBOX.west + c * dLon;
        const p = PROJ.project(lon, lat);
        const pc = Math.floor((p.x - px0) / cellP);
        const prr = Math.floor((p.y - py0) / cellP);
        if (pc >= 0 && prr >= 0 && pc < pCols && prr < pRows && pmask[prr * pCols + pc]) {
          hard2[r * cols + c] = 255; nInside++;
        }
      }
    }
    log('dem', `mask: inside ${(nInside / 1e6).toFixed(2)}M cells (${(nInside / (cols * rows) * 100).toFixed(1)}%), ${((Date.now() - t1) / 1000).toFixed(1)}s`);
  }

  // ── 4. 高程重采样(统计仅限省内格元) ──
  const elev = new Uint16Array(cols * rows);
  let mn = Infinity, mx = -Infinity;
  const latToV = (lat) => {
    const r = lat * Math.PI / 180;
    const yN = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    return yN * inRows;
  };
  const vTop = latToV(DEM_BBOX.north), vBot = latToV(DEM_BBOX.south);
  for (let r = 0; r < rows; r++) {
    const lat = BBOX.north - r * dLat;
    const v = latToV(lat) - vTop;
    const vy = Math.max(0, Math.min(inRows - 1.001, (v / (vBot - vTop)) * inRows));
    const y0i = Math.floor(vy), fy = vy - y0i;
    for (let c = 0; c < cols; c++) {
      const lon = BBOX.west + c * dLon;
      const u = ((lon - DEM_BBOX.west) / (DEM_BBOX.east - DEM_BBOX.west)) * inCols;
      const x0i = Math.floor(u), fx = u - x0i;
      const xa = Math.min(x0i, inCols - 2), ya = Math.min(y0i, inRows - 2);
      const v00 = inp[ya * inCols + xa], v10 = inp[ya * inCols + xa + 1];
      const v01 = inp[(ya + 1) * inCols + xa], v11 = inp[(ya + 1) * inCols + xa + 1];
      let e = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      const ev = Math.max(0, Math.round(e));
      elev[r * cols + c] = ev;
      if (hard2[r * cols + c] === 255) {
        if (ev < mn) mn = ev;
        if (ev > mx) mx = ev;
      }
    }
  }
  log('dem', `grid ${cols}×${rows}, 省内 elev ${mn.toFixed(0)}–${mx.toFixed(0)} m`);

  // ── 4.5 去坏点:省内格元超出贵州合理高程范围(137–2901m,放宽 60–3100)→ 取 8 邻域中值 ──
  {
    let fixed = 0;
    const med = [];
    for (let r = 1; r < rows - 1; r++) for (let c = 1; c < cols - 1; c++) {
      const i = r * cols + c;
      if (hard2[i] !== 255) continue;
      const e = elev[i];
      if (e >= 60 && e <= 3100) continue;
      med.length = 0;
      for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
        if (!di && !dj) continue;
        const v = elev[i + dj * cols + di];
        if (v >= 60 && v <= 3100) med.push(v);
      }
      if (med.length) {
        med.sort((a, b) => a - b);
        elev[i] = med[med.length >> 1];
        fixed++;
      }
    }
    if (fixed) {
      mn = Infinity; mx = -Infinity;
      for (let i = 0; i < elev.length; i++) {
        if (hard2[i] !== 255) continue;
        if (elev[i] < mn) mn = elev[i];
        if (elev[i] > mx) mx = elev[i];
      }
      log('dem', `despike: ${fixed} cells fixed → ${mn}–${mx} m`);
    }
  }

  // ── 5. 软边缘 + 渲染缓冲带(省界外 ~5.6km) + 输出 ──
  const soft = edgeFade(hard2, cols, rows, 10);
  // 外扩掩膜:省界外 26 格(≈5.6km)内仍渲染(压平为基座搁边),更远剔除
  const wide = new Uint8Array(cols * rows);
  {
    const INF = 9999;
    const d = new Uint16Array(cols * rows).fill(INF);
    for (let i = 0; i < d.length; i++) if (hard2[i]) d[i] = 0;
    const D1 = 3, D2 = 4;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const i = r * cols + c; if (d[i] === 0) continue;
      let v = d[i];
      if (c > 0) v = Math.min(v, d[i - 1] + D1);
      if (r > 0) {
        v = Math.min(v, d[i - cols] + D1);
        if (c > 0) v = Math.min(v, d[i - cols - 1] + D2);
        if (c < cols - 1) v = Math.min(v, d[i - cols + 1] + D2);
      }
      d[i] = v;
    }
    for (let r = rows - 1; r >= 0; r--) for (let c = cols - 1; c >= 0; c--) {
      const i = r * cols + c; if (d[i] === 0) continue;
      let v = d[i];
      if (c < cols - 1) v = Math.min(v, d[i + 1] + D1);
      if (r < rows - 1) {
        v = Math.min(v, d[i + cols] + D1);
        if (c < cols - 1) v = Math.min(v, d[i + cols + 1] + D2);
        if (c > 0) v = Math.min(v, d[i + cols - 1] + D2);
      }
      d[i] = v;
    }
    for (let i = 0; i < d.length; i++) wide[i] = d[i] <= 78 ? 255 : 0;
  }
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin'), Buffer.from(elev.buffer));
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.mask.bin'), Buffer.from(soft));
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.maskwide.bin'), Buffer.from(wide));
  fs.writeFileSync(path.join(DIRS.processed, 'terrain/maskHard.bin'), Buffer.from(hard2));

  const outMeta = {
    grid: { cols, rows, west: BBOX.west, north: BBOX.north, dLon, dLat },
    elev: { min: Math.round(mn), max: Math.round(mx), unit: 'm' },
    world: {
      scale: WORLD.scale, originX: WORLD.originX, originY: WORLD.originY,
      widthUnits: WORLD.widthUnits, heightUnits: WORLD.heightUnits,
      verticalScale: 10, heightCurve: 1.15, exaggerationDefault: 2.8
    },
    projection: { type: 'albers-equal-area-conic', lon0: 106.5, lat0: 26.8, sp1: 25.5, sp2: 28.5, R: 6378137 },
    dem: { source: meta.source, zoom: DEM_Z, tiles: nTiles, approxResM: Math.round(dLon * mPerDegLon) },
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.meta.json'), JSON.stringify(outMeta, null, 2));
  log('dem', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

if (process.argv[1] && process.argv[1].endsWith('dem.mjs')) run();
