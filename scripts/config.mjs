// 共享配置:数据源、包围盒、Albers 等积圆锥投影(EPSG:4326 → 局部米制平面)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 贵州省及周边裁剪包围盒(带少量缓冲,便于河流跨界裁剪)
export const BBOX = { south: 24.35, west: 103.25, north: 29.55, east: 110.0 };

// DEM 下载层级与包围盒(略大于 BBOX,保证覆盖)
export const DEM_Z = 10;
export const DEM_BBOX = { south: 24.0, west: 103.0, north: 29.9, east: 110.2 };

export const DIRS = {
  rawDem: path.join(ROOT, 'data/raw/dem'),
  rawAdmin: path.join(ROOT, 'data/raw/admin'),
  rawOsm: path.join(ROOT, 'data/raw/osm'),
  runtime: path.join(ROOT, 'public/runtime'),
  processed: path.join(ROOT, 'data/processed')
};

// Albers 等积圆锥投影 —— 贵州省标准双纬线
// lon/lat(度) → {x, y}(米)
export const PROJ = (() => {
  const R = 6378137.0;
  const D2R = Math.PI / 180;
  const lon0 = 106.5 * D2R;
  const lat0 = 26.8 * D2R;
  const p1 = 25.5 * D2R;
  const p2 = 28.5 * D2R;
  const n = (Math.sin(p1) + Math.sin(p2)) / 2;
  const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
  const rho0 = (R * Math.sqrt(C - 2 * n * Math.sin(lat0))) / n;
  return {
    lon0Deg: 106.5,
    n, C, rho0, R, D2R,
    project(lonDeg, latDeg) {
      const lam = lonDeg * D2R - lon0;
      const phi = latDeg * D2R;
      const rho = (R * Math.sqrt(Math.max(0, C - 2 * n * Math.sin(phi)))) / n;
      const th = n * lam;
      return { x: rho * Math.sin(th), y: rho0 - rho * Math.cos(th) };
    },
    // 投影坐标(米) → 经纬度(度)
    unproject(x, y) {
      const th = Math.atan2(x, rho0 - y);
      const rho = Math.hypot(x, rho0 - y);
      const phi = Math.asin((C - (rho * n / R) ** 2) / (2 * n));
      return { lon: th / n / D2R + 106.5, lat: phi / D2R };
    }
  };
})();

export const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) guizhou-3d-sandbox/3.0';

export function log(tag, msg) {
  console.log(`[${new Date().toISOString().slice(11, 19)}] [${tag}] ${msg}`);
}

export async function fetchWithRetry(url, { tries = 3, timeoutMs = 60000, headers = {} } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': USER_AGENT, ...headers }
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res;
    } catch (e) {
      clearTimeout(t);
      lastErr = e;
      await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    }
  }
  throw lastErr;
}
