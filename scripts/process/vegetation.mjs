// 植被预处理:OSM 林地(真实)栅格化 + 地形/水系/城市约束 → 森林密度网格
// 密度网格为 Albers 投影对齐(世界坐标 = 投影×scale,可直接索引)
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, PROJ, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { lineToProj, ringArea } from './geometry.mjs';
import { loadMask } from './hydro.mjs';

export function run() {
  const t0 = Date.now();
  const { mask, meta } = loadMask();
  const { cols, rows, west, north, dLon, dLat } = meta.grid;

  // 森林网格:proj 对齐,格元 ≈ 430m
  const cell = 430;
  const fx0 = WORLD.originX - WORLD.widthMeters / 2;
  const fy0 = WORLD.originY - WORLD.heightMeters / 2;
  const fCols = Math.ceil(WORLD.widthMeters / cell);
  const fRows = Math.ceil(WORLD.heightMeters / cell);
  const wood = new Uint8Array(fCols * fRows);
  const water = new Uint8Array(fCols * fRows);

  // ── 1. OSM 林地栅格化(真实数据) ──
  const woodsRaw = JSON.parse(fs.readFileSync(path.join(DIRS.rawOsm, 'woods.json'), 'utf8'));
  const rings = [];
  for (const el of woodsRaw.elements) {
    const geoms = [];
    if (el.type === 'way' && el.geometry) geoms.push(el.geometry.map(g => [g.lon, g.lat]));
    else if (el.type === 'relation' && el.members) {
      for (const m of el.members) {
        if (m.type === 'way' && m.geometry && m.role !== 'inner') {
          const rg = m.geometry.map(g => [g.lon, g.lat]);
          const a = rg[0], b = rg[rg.length - 1];
          if (Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9) geoms.push(rg);
        }
      }
    }
    for (const g of geoms) {
      const proj = lineToProj(g);
      if (ringArea(proj) < 300 * 300) continue;
      rings.push(proj);
    }
  }
  log('vegetation', `wood rings: ${rings.length}`);
  rasterizeRings(rings, wood, fCols, fRows, fx0, fy0, cell);

  // ── 2. 水系掩膜(河流缓冲 + 湖泊填充) ──
  const rivers = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'rivers/rivers.json'), 'utf8')).features;
  const lakes = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'rivers/lakes.json'), 'utf8')).features;
  const brush = { 1: 3, 2: 2, 3: 1 };
  for (const r of rivers) {
    const rad = brush[r.r] || 1;
    const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x = p[i] / WORLD.scale + WORLD.originX;
      const y = -p[i + 1] / WORLD.scale + WORLD.originY;
      stamp(water, fCols, fRows, fx0, fy0, cell, x, y, rad * cell);
    }
  }
  for (const l of lakes) {
    const pts = [];
    for (let i = 0; i < l.p.length; i += 2) {
      pts.push(l.p[i] / WORLD.scale + WORLD.originX, -l.p[i + 1] / WORLD.scale + WORLD.originY);
    }
    rasterizeRings([Float64Array.from(pts)], water, fCols, fRows, fx0, fy0, cell);
  }

  // ── 3. 综合密度:真实林地为主,叠加高程/坡度/水系/城市约束 ──
  const elevBin = fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin'));
  const elevG = new Uint16Array(elevBin.buffer);
  const elevAt = (lon, lat) => {
    const c = Math.round((lon - west) / dLon), r = Math.round((north - lat) / dLat);
    if (c < 0 || r < 0 || c >= cols || r >= rows) return null;
    return elevG[r * cols + c];
  };
  const cities = JSON.parse(fs.readFileSync(path.join(DIRS.runtime, 'cities/cities.json'), 'utf8')).cities;
  const forest = new Uint8Array(fCols * fRows);
  let sum = 0, n = 0;
  for (let r = 0; r < fRows; r++) {
    for (let c = 0; c < fCols; c++) {
      const px = fx0 + (c + 0.5) * cell, py = fy0 + (r + 0.5) * cell;
      const { lon, lat } = PROJ.unproject(px, py);
      const cc = Math.floor((lon - west) / dLon), rr = Math.floor((north - lat) / dLat);
      let dens = 0;
      if (cc >= 0 && rr >= 0 && cc < cols && rr < rows && mask[rr * cols + cc] > 127) {
        const isWood = wood[r * fCols + c] > 0;
        dens = isWood ? 235 : 38; // 真实林地高密度;其余低密度程序化植被
        const e = elevAt(lon, lat);
        if (e !== null) {
          if (e > 2300) dens *= 0.25;          // 高山灌丛
          else if (e > 2000) dens *= 0.6;
          else if (e < 350) dens *= 0.7;        // 河谷农坝
          if (c < fCols - 1 && r < fRows - 1) {
            const ex = elevAt(lon + 430 / (111320 * Math.cos(lat * Math.PI / 180)), lat);
            const ey = elevAt(lon, lat - 430 / 110900);
            if (ex !== null && ey !== null) {
              const slope = Math.hypot(ex - e, ey - e) / 430;
              if (slope > 0.6) dens *= 0.25;    // 陡壁裸岩
              else if (slope > 0.45) dens *= 0.6;
            }
          }
        }
        if (water[r * fCols + c]) dens = 0;
        // 城市周边抑制
        for (const ct of cities) {
          const cx = ct.x / WORLD.scale + WORLD.originX, cy = -ct.z / WORLD.scale + WORLD.originY;
          const d = Math.hypot(px - cx, py - cy);
          if (d < ct.r * 1.6) { dens *= Math.max(0, (d - ct.r * 0.5) / (ct.r * 1.1)); break; }
        }
      }
      forest[r * fCols + c] = Math.max(0, Math.min(255, Math.round(dens)));
      sum += forest[r * fCols + c]; n++;
    }
  }
  log('vegetation', `forest mean density: ${(sum / n).toFixed(1)}/255`);

  // ── 4. 河流烙印(远景地形着色用,方案 §22 河谷表现) ──
  const tint = new Uint8Array(fCols * fRows);
  const tBrush = { 1: 3.4, 2: 1.5, 3: 1.0 };
  const majorCities = cities.filter(c => c.t <= 2);
  const nearCity = (px, py) => {
    for (const ct of majorCities) {
      const cx = ct.x / WORLD.scale + WORLD.originX, cy = -ct.z / WORLD.scale + WORLD.originY;
      if (Math.hypot(px - cx, py - cy) < ct.r * 1.5) return true;
    }
    return false;
  };
  for (const r of rivers) {
    const rad = (tBrush[r.r] || 1.0) * cell;
    const p = r.p;
    for (let i = 0; i + 3 < p.length; i += 2) {
      const x = p[i] / WORLD.scale + WORLD.originX;
      const y = -p[i + 1] / WORLD.scale + WORLD.originY;
      if (r.r >= 2 && nearCity(x, y)) continue; // 城市密集河网不烙印,避免成片泛蓝
      stampTint(tint, fCols, fRows, fx0, fy0, cell, x, y, rad, r.r === 1 ? 255 : r.r === 2 ? 185 : 140);
    }
  }
  for (const l of lakes) {
    const pts = [];
    for (let i = 0; i < l.p.length; i += 2) {
      pts.push(l.p[i] / WORLD.scale + WORLD.originX, -l.p[i + 1] / WORLD.scale + WORLD.originY);
    }
    rasterizeRings([Float64Array.from(pts)], tint, fCols, fRows, fx0, fy0, cell, 255);
  }
  fs.writeFileSync(path.join(DIRS.runtime, 'rivers/rivertint.bin'), Buffer.from(tint.buffer));

  fs.mkdirSync(path.join(DIRS.runtime, 'forests'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.runtime, 'forests/forest.bin'), Buffer.from(forest.buffer));
  fs.writeFileSync(path.join(DIRS.runtime, 'forests/forest.meta.json'), JSON.stringify({
    cols: fCols, rows: fRows, cell,
    originX: fx0, originY: fy0,
    note: 'Albers 投影对齐网格;值 0-255 为森林密度。来源:OSM natural=wood/landuse=forest(真实)+ 程序化低密度背景植被',
    generatedAt: new Date().toISOString()
  }, null, 2));
  log('vegetation', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

function rasterizeRings(rings, out, cols, rows, x0, y0, cell, value = 255) {
  const edges = [];
  for (const ring of rings) {
    const n = ring.length / 2;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const y1 = ring[j * 2 + 1], y2 = ring[i * 2 + 1];
      if (y1 === y2) continue;
      edges.push({ ymin: Math.min(y1, y2), ymax: Math.max(y1, y2), x1: ring[j * 2], y1, x2: ring[i * 2], y2 });
    }
  }
  if (!edges.length) return;
  edges.sort((a, b) => a.ymin - b.ymin);
  for (let r = 0; r < rows; r++) {
    const py = y0 + (r + 0.5) * cell;
    let lo = 0, hi = edges.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (edges[m].ymin <= py) lo = m + 1; else hi = m; }
    if (lo === 0) continue;
    const xs = [];
    for (let e = lo - 1; e >= 0 && edges[e].ymax > py - cell / 2; e--) {
      const E = edges[e];
      if (py >= E.ymin && py < E.ymax) {
        const t = (py - E.y1) / (E.y2 - E.y1);
        xs.push(E.x1 + t * (E.x2 - E.x1));
      }
    }
    if (!xs.length) continue;
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const c0 = Math.max(0, Math.floor((xs[k] - x0) / cell));
      const c1 = Math.min(cols - 1, Math.ceil((xs[k + 1] - x0) / cell));
      for (let c = c0; c <= c1; c++) out[r * cols + c] = Math.max(out[r * cols + c], value);
    }
  }
}

function stampTint(out, cols, rows, x0, y0, cell, px, py, rad, value) {
  const c0 = Math.max(0, Math.floor((px - rad - x0) / cell));
  const c1 = Math.min(cols - 1, Math.ceil((px + rad - x0) / cell));
  const r0 = Math.max(0, Math.floor((py - rad - y0) / cell));
  const r1 = Math.min(rows - 1, Math.ceil((py + rad - y0) / cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cx = x0 + (c + 0.5) * cell, cy = y0 + (r + 0.5) * cell;
    const d = Math.hypot(cx - px, cy - py);
    if (d <= rad) {
      const v = Math.round(value * (1 - 0.6 * (d / rad)));
      if (v > out[r * cols + c]) out[r * cols + c] = v;
    }
  }
}

function stamp(out, cols, rows, x0, y0, cell, px, py, rad) {
  const c0 = Math.max(0, Math.floor((px - rad - x0) / cell));
  const c1 = Math.min(cols - 1, Math.ceil((px + rad - x0) / cell));
  const r0 = Math.max(0, Math.floor((py - rad - y0) / cell));
  const r1 = Math.min(rows - 1, Math.ceil((py + rad - y0) / cell));
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) {
    const cx = x0 + (c + 0.5) * cell, cy = y0 + (r + 0.5) * cell;
    if (Math.hypot(cx - px, cy - py) <= rad) out[r * cols + c] = 255;
  }
}

if (process.argv[1] && process.argv[1].endsWith('vegetation.mjs')) run();
