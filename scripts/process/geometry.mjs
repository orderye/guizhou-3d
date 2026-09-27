// 几何工具:投影、PIP、加密、Douglas-Peucker、面积/质心
import { PROJ } from '../config.mjs';

// lonlat → 投影米制坐标数组 Float64 [x0,y0,x1,y1...]
export function lineToProj(lonlat) {
  const out = new Float64Array(lonlat.length * 2);
  for (let i = 0; i < lonlat.length; i++) {
    const p = PROJ.project(lonlat[i][0], lonlat[i][1]);
    out[i * 2] = p.x; out[i * 2 + 1] = p.y;
  }
  return out;
}

export function ringArea(ring) { // ring: Float64 proj
  const n = ring.length / 2; let a = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    a += (ring[j * 2] * ring[i * 2 + 1]) - (ring[i * 2] * ring[j * 2 + 1]);
  }
  return Math.abs(a / 2);
}

export function ringCentroid(ring) {
  const n = ring.length / 2; let x = 0, y = 0;
  for (let i = 0; i < n; i++) { x += ring[i * 2]; y += ring[i * 2 + 1]; }
  return [x / n, y / n];
}

export function ringBBox(ring) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < ring.length; i += 2) {
    if (ring[i] < minX) minX = ring[i];
    if (ring[i] > maxX) maxX = ring[i];
    if (ring[i + 1] < minY) minY = ring[i + 1];
    if (ring[i + 1] > maxY) maxY = ring[i + 1];
  }
  return { minX, minY, maxX, maxY };
}

// 射线法 PIP(ring 为投影坐标)
export function pip(px, py, ring) {
  let inside = false;
  const n = ring.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = ring[i * 2], yi = ring[i * 2 + 1];
    const xj = ring[j * 2], yj = ring[j * 2 + 1];
    if ((yi > py) !== (yj > py)) {
      const xint = xi + ((py - yi) / (yj - yi)) * (xj - xi);
      if (px < xint) inside = !inside;
    }
  }
  return inside;
}

// 折线加密(投影坐标),step 米
export function densify(line, step) {
  const n = line.length / 2;
  if (n < 2) return line;
  const out = [];
  out.push(line[0], line[1]);
  for (let i = 1; i < n; i++) {
    const x0 = line[(i - 1) * 2], y0 = line[(i - 1) * 2 + 1];
    const x1 = line[i * 2], y1 = line[i * 2 + 1];
    const d = Math.hypot(x1 - x0, y1 - y0);
    if (d > step) {
      const k = Math.ceil(d / step);
      for (let s = 1; s < k; s++) {
        out.push(x0 + (x1 - x0) * s / k, y0 + (y1 - y0) * s / k);
      }
    }
    out.push(x1, y1);
  }
  return out;
}

// Douglas-Peucker 简化(投影坐标, tol 米)
export function simplifyDP(line, tol) {
  const n = line.length / 2;
  if (n < 3) return line;
  const keep = new Uint8Array(n);
  keep[0] = keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    if (b - a < 2) continue;
    const ax = line[a * 2], ay = line[a * 2 + 1];
    const bx = line[b * 2], by = line[b * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, maxI = -1;
    for (let i = a + 1; i < b; i++) {
      const px = line[i * 2], py = line[i * 2 + 1];
      let d;
      if (len2 === 0) d = Math.hypot(px - ax, py - ay);
      else {
        let t = ((px - ax) * dx + (py - ay) * dy) / len2;
        t = Math.max(0, Math.min(1, t));
        d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      }
      if (d > maxD) { maxD = d; maxI = i; }
    }
    if (maxD > tol) {
      keep[maxI] = 1;
      stack.push([a, maxI], [maxI, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(line[i * 2], line[i * 2 + 1]);
  return out;
}

// seeded RNG(可复现)
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
