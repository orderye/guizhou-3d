// 遗留高程来源:Mapzen terrarium z10 PNG → 标准网格高程栅格
//
// 这是 V3.13 之前的数据源(V3.13 起主源改为 Copernicus GLO-30,见 elev.mjs)。
// 保留它是为了让没有 Python / 没有 GLO-30 缓存的环境仍能完整重建运行时数据
// (`npm run download` 会取 terrarium 瓦片)。
//
// **显式开关,不会自动启用** —— 与 GLO-30 相比,terrarium 在坝子/城区系统性偏高
// (实测贵阳同点高 186 m:218 m 栅格把周围山体混入了平坝),且无大地水准面改正。
// 统一由 elev.mjs 按 --legacy-terrarium 分派。
//
// 网格约定:格心 —— 格元 (i,j) 中心位于 lon = west+(i+0.5)*dLon, lat = north-(j+0.5)*dLat
import fs from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { DIRS, DEM_BBOX, DEM_Z, GRID, PROJ, log } from '../config.mjs';

/** 解码 terrarium PNG 瓦片到 mercator 像素空间(elev = R*256 + G + B/256 - 32768) */
function decodeTerrarium() {
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
  log('elev', `terrarium: decoded ${nTiles} tiles → ${inCols}×${inRows}`);
  return { inp, inCols, inRows, nTiles };
}

/** 双线性重采样 mercator 像素 → 标准网格(格心约定) */
export function runTerrarium() {
  const { cols, rows, west, north, dLon, dLat } = GRID;
  const { inp, inCols, inRows, nTiles } = decodeTerrarium();

  const elev = new Uint16Array(cols * rows);
  const latToV = (lat) => {
    const r = lat * Math.PI / 180;
    const yN = (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2;
    return yN * inRows;
  };
  const vTop = latToV(DEM_BBOX.north), vBot = latToV(DEM_BBOX.south);
  for (let r = 0; r < rows; r++) {
    // 格心:格元中心纬度
    const lat = north - (r + 0.5) * dLat;
    const v = latToV(lat) - vTop;
    const vy = Math.max(0, Math.min(inRows - 1.001, (v / (vBot - vTop)) * inRows));
    const y0i = Math.floor(vy), fy = vy - y0i;
    for (let c = 0; c < cols; c++) {
      // 格心:格元中心经度
      const lon = west + (c + 0.5) * dLon;
      const u = ((lon - DEM_BBOX.west) / (DEM_BBOX.east - DEM_BBOX.west)) * inCols;
      const x0i = Math.floor(u), fx = u - x0i;
      const xa = Math.min(x0i, inCols - 2), ya = Math.min(y0i, inRows - 2);
      const v00 = inp[ya * inCols + xa], v10 = inp[ya * inCols + xa + 1];
      const v01 = inp[(ya + 1) * inCols + xa], v11 = inp[(ya + 1) * inCols + xa + 1];
      const e = (v00 * (1 - fx) + v10 * fx) * (1 - fy) + (v01 * (1 - fx) + v11 * fx) * fy;
      elev[r * cols + c] = Math.max(0, Math.round(e));
    }
  }
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin'), Buffer.from(elev.buffer));
  return { tiles: nTiles };
}
