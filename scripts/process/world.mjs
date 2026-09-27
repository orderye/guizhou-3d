// 全局世界坐标参数(与运行时 TerrainSampler 保持一致)
// 世界: X = 东, Z = -北, Y = 视觉高程(运行时计算)
import { PROJ, BBOX } from '../config.mjs';

// 目标:全省横向跨度 ≈ 150 世界单位
export const WORLD = (() => {
  // 用加密边框点计算投影范围
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  const N = 64;
  const pts = [];
  for (let i = 0; i <= N; i++) {
    const lon = BBOX.west + (BBOX.east - BBOX.west) * i / N;
    for (let j = 0; j <= N; j++) {
      const lat = BBOX.south + (BBOX.north - BBOX.south) * j / N;
      pts.push(PROJ.project(lon, lat));
    }
  }
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const scale = 150 / (maxX - minX);
  const originX = (minX + maxX) / 2;
  const originY = (minY + maxY) / 2;
  return {
    scale, originX, originY,
    widthMeters: maxX - minX, heightMeters: maxY - minY,
    widthUnits: (maxX - minX) * scale, heightUnits: (maxY - minY) * scale,
    toWorld(lon, lat) {
      const p = PROJ.project(lon, lat);
      return { x: (p.x - originX) * scale, z: -(p.y - originY) * scale };
    },
    projToWorld(px, py) {
      return { x: (px - originX) * scale, z: -(py - originY) * scale };
    }
  };
})();

export function toWorldLine(lonlatLine) {
  const out = new Float32Array(lonlatLine.length * 2);
  for (let i = 0; i < lonlatLine.length; i++) {
    const w = WORLD.toWorld(lonlatLine[i][0], lonlatLine[i][1]);
    out[i * 2] = w.x; out[i * 2 + 1] = w.z;
  }
  return out;
}
