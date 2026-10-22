// 高程生产步骤:GLO-30 → 标准网格高程栅格 + terrain.meta.json
//
// 职责(2026-10-22 重构):原 dem 步骤从 terrarium PNG 解码高程并写 terrain.elev.bin,
// 任何一次 `npm run preprocess` 都会把 GLO-30 覆盖回旧源、并把 meta 网格重置成
// 另一套 dLat(与运行时声明相差 185 m 累积)。现在高程来源唯一:
//   scripts/process/elev-glo30.py(GLO-30 缓存 → 标准网格,EGM2008 改正)
//
// Python 依赖:EGM2008 大地水准面格网是 GeoTIFF,需要 rasterio。
//   python3 -m venv .venv && .venv/bin/pip install numpy rasterio
//   大地水准面格网:https://cdn.proj.org/us_nga_egm08_25.tif → data/raw/geoid/egm2008.tif
// venv 缺失时**明确报错**,不静默降级到 terrarium(否则会悄悄产生配准错误的数据)。
//
// 网格约定:格心 —— 格元 (i,j) 中心位于 lon = west+(i+0.5)*dLon, lat = north-(j+0.5)*dLat
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRS, DEM_Z, GRID, ROOT, log } from '../config.mjs';
import { WORLD } from './world.mjs';
import { runTerrarium } from './elev-terrarium.mjs';

const VENV_PY = path.join(ROOT, '.venv/bin/python');
const PY = fs.existsSync(VENV_PY) ? VENV_PY : null;

export function run() {
  const t0 = Date.now();
  fs.mkdirSync(path.join(DIRS.runtime, 'terrain'), { recursive: true });

  // 显式开关:terrarium 遗留源(无 Python 环境的离线路径)
  const legacyTerrarium = process.argv.includes('--legacy-terrarium');
  let demSource;

  if (legacyTerrarium) {
    log('elev', 'terrarium 遗留源(未经 EGM2008 改正,精度低于 GLO-30)');
    const r = runTerrarium();
    demSource = {
      source: 'Mapzen Terrain Tiles (AWS Open Data) terrarium z10 PNG — 遗留源,' +
              '无大地水准面改正,坝子/城区系统性偏高(贵阳同点 +186 m)',
      zoom: DEM_Z, tiles: r.tiles, approxResM: GRID.cellM
    };
  } else {
    const cache = path.join(DIRS.raw, 'glo30', 'grid_218m.npy');
    if (!fs.existsSync(cache)) {
      throw new Error(
        `缺少 GLO-30 缓存:${cache}\n` +
        '请先抓取(需网络 + Python):\n' +
        '  python3 -m venv .venv && .venv/bin/pip install numpy rasterio\n' +
        '  .venv/bin/python scripts/download/glo30.py --res 218 --from-cache 120\n' +
        '（无 Python 时可显式使用遗留源:npm run preprocess -- --legacy-terrarium）'
      );
    }
    if (!PY) {
      throw new Error(
        '未找到 .venv/bin/python —— 高程重采样需要 numpy + rasterio(EGM2008 GeoTIFF 解析)。\n' +
        '请先准备:\n' +
        '  python3 -m venv .venv && .venv/bin/pip install numpy rasterio\n' +
        '  # 大地水准面格网 → data/raw/geoid/egm2008.tif\n' +
        '  #   https://cdn.proj.org/us_nga_egm08_25.tif\n' +
        '（不提供 Python 时不会静默降级到 terrarium —— 那会产生南北向拉伸 12% 的错配数据；\n' +
        '  如确需使用遗留源,请显式加 --legacy-terrarium）'
      );
    }

    const script = path.join(ROOT, 'scripts/process/elev-glo30.py');
    log('elev', 'GLO-30 → 标准网格重采样 …');
    execFileSync(PY, [
      script,
      '--from-cache', '218',
      '--cols', String(GRID.cols),
      '--rows', String(GRID.rows),
      '--dlon', String(GRID.dLon),
      '--dlat', String(GRID.dLat),
      '--west', String(GRID.west),
      '--north', String(GRID.north)
    ], { stdio: 'inherit' });
    demSource = {
      source: 'Copernicus DEM GLO-30 (AWS Open Data), EGM2008 改正为正高, ' +
              '重采样到标准等距米制网格(dLon/dLat 分离),格心约定',
      zoom: 10, tiles: 48, approxResM: GRID.cellM
    };
  }

  // 省内高程范围(与运行时 TerrainSampler 重算口径一致:硬掩膜内)
  const elev = new Uint16Array(fs.readFileSync(path.join(DIRS.runtime, 'terrain/terrain.elev.bin')).buffer);
  const maskPath = path.join(DIRS.processed, 'terrain/maskHard.bin');
  const mask = fs.existsSync(maskPath)
    ? new Uint8Array(fs.readFileSync(maskPath).buffer)
    : null;
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < elev.length; i++) {
    if (mask && mask[i] < 128) continue;
    if (elev[i] < mn) mn = elev[i];
    if (elev[i] > mx) mx = elev[i];
  }
  if (!isFinite(mn)) { mn = 0; mx = 0; }

  const meta = {
    grid: {
      cols: GRID.cols, rows: GRID.rows,
      west: GRID.west, north: GRID.north,
      dLon: GRID.dLon, dLat: GRID.dLat
    },
    elev: { min: Math.round(mn), max: Math.round(mx), unit: 'm' },
    world: {
      scale: WORLD.scale, originX: WORLD.originX, originY: WORLD.originY,
      widthUnits: WORLD.widthUnits, heightUnits: WORLD.heightUnits,
      verticalScale: 10, heightCurve: 1.15, exaggerationDefault: 2.8
    },
    projection: { type: 'albers-equal-area-conic', lon0: 106.5, lat0: 26.8, sp1: 25.5, sp2: 28.5, R: 6378137 },
    dem: demSource,
    generatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(DIRS.runtime, 'terrain/terrain.meta.json'), JSON.stringify(meta, null, 2));
  log('elev', `grid ${GRID.cols}×${GRID.rows} @ ${GRID.cellM}m, 省内 ${mn}–${mx} m, meta 已更新`);
  log('elev', `DONE in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}
