// 共享配置:数据源、包围盒、Albers 等积圆锥投影(EPSG:4326 → 局部米制平面)
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// 贵州省及周边裁剪包围盒(带少量缓冲,便于河流跨界裁剪)
export const BBOX = { south: 24.35, west: 103.25, north: 29.55, east: 110.0 };

// 运行时高程栅格网格 —— 全项目唯一真源(所有预处理脚本 + 运行时 meta 共用)
//
// 约定:**格心(cell-center)**
//   格元 (i,j) 的中心位于 lon = west + (i+0.5)*dLon,lat = north - (j+0.5)*dLat
//   等价连续坐标 u = (lon-west)/dLon - 0.5(u 的整数 = 单元中心)
//
// 尺寸:dLon = (east-west)/cols = 6.75/3072,dLat = (north-south)/rows = 5.2/2654
// → 东西 218.7 m × 南北 217.3 m,近似等距米制格。
// 2026-10-22 修正:GLO-30 栅格此前被写成"经纬度正方形"网格(dLon=dLat),
// 运行时按本网格解读会导致南北向拉伸 12%、最南端错位约 68 km(河道被画在山脊上)。
export const GRID = {
  cols: 3072,
  rows: 2654,
  west: BBOX.west,
  north: BBOX.north,
  dLon: (BBOX.east - BBOX.west) / 3072,
  dLat: (BBOX.north - BBOX.south) / 2654,
  cellM: 218
};

/**
 * 采样点 → 最近格心索引(格心约定)
 *   格元 (i,j) 的中心位于 lon = west + (i+0.5)*dLon,lat = north - (j+0.5)*dLat
 *   → 最近中心的索引 = round((lon-west)/dLon - 0.5)
 * 注意:这不是"包含该点的格",而是"值最接近该点的格"—— 与 DEM 值的定义一致。
 */
export function gridIndex(lon, lat) {
  return {
    i: Math.round((lon - GRID.west) / GRID.dLon - 0.5),
    j: Math.round((GRID.north - lat) / GRID.dLat - 0.5)
  };
}

// DEM 下载层级与包围盒(略大于 BBOX,保证覆盖)
export const DEM_Z = 10;
export const DEM_BBOX = { south: 24.0, west: 103.0, north: 29.9, east: 110.2 };

// 卫星影像底图(Web Mercator 瓦片 → 重采样为单张底图)
export const SAT_PROVIDER = process.env.SAT_PROVIDER || 'esri';
export const SAT_BBOX = BBOX;   // 覆盖范围与 DEM 网格一致
export const SAT_OUT_W = 3328;  // 底图输出宽度(19968 源像素 / 6 = 3328,约 209m/px)

export const DIRS = {
  raw: path.join(ROOT, 'data/raw'),
  rawDem: path.join(ROOT, 'data/raw/dem'),
  rawAdmin: path.join(ROOT, 'data/raw/admin'),
  rawOsm: path.join(ROOT, 'data/raw/osm'),
  rawSat: path.join(ROOT, 'data/raw/sat'),
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
