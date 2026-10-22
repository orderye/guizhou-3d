#!/usr/bin/env python3
"""Copernicus GLO-30 高精度 DEM 抓取(方案 §44 Phase 1 的数据升级)。

现有 DEM 为 Mapzen terrarium z10(运行时 218 m/格),在坝子/城区系统性偏高
(实测贵阳同点比 GLO-30 低 186 m —— 218 m 栅格把周围山体混入了平坝),
且极近景呈明显低多边形(方案 §62「极近景:地形连续」不达标)。

本脚本:
  1. 按窗口从 AWS Open Data 远程读取 GLO-30(COG,EPSG:4326,30 m,椭球高)
  2. 用 EGM2008 大地水准面格网改正为正高(与 SRTM/terrarium 同基准)
  3. 重采样到目标经纬度网格(默认 120 m/格),空洞按最近有效值填充
  4. 输出 public/runtime/terrain/terrain.elev.bin(Uint16)与 terrain.meta.json

依赖(仅离线数据准备需要,运行时无关):
  python3 -m venv .venv && .venv/bin/pip install numpy rasterio
  大地水准面格网:https://cdn.proj.org/us_nga_egm08_25.tif  → data/raw/geoid/egm2008.tif

用法:
  .venv/bin/python scripts/download/glo30.py --res 120
  .venv/bin/python scripts/download/glo30.py --res 120 --jobs 8
"""
import argparse
import json
import os
import sys
import time
from concurrent.futures import ThreadPoolExecutor


import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNTIME = os.path.join(ROOT, 'public', 'runtime')
RAW = os.path.join(ROOT, 'data', 'raw')
BUCKET = 'https://copernicus-dem-30m.s3.amazonaws.com'
# 目标范围(与现有运行时网格一致:贵州及缓冲)
WEST, EAST, NORTH, SOUTH = 103.25, 110.0, 29.55, 24.35
TILE = 1  # GLO-30 每 tile 1°×1°


def tile_url(lat, lon):
    ns = f'N{lat:02d}' if lat >= 0 else f'S{abs(lat):02d}'
    ew = f'E{lon:03d}' if lon >= 0 else f'W{abs(lon):03d}'
    name = f'Copernicus_DSM_COG_10_{ns}_00_{ew}_00_DEM'
    return f'{BUCKET}/{name}/{name}.tif'


def read_tile(lat, lon, west, north, res_deg, cols, rows, out_grid):
    """读单个 tile,重投影到全局目标网格的对应窗口,写入 out_grid"""
    import rasterio
    from rasterio.warp import reproject, Resampling
    from rasterio.transform import from_origin
    url = tile_url(lat, lon)
    twest, teast = lon, lon + 1
    tsouth, tnorth = lat, lat + 1
    # 目标网格中与该 tile 相交的行列范围
    c0 = max(0, int(np.floor((twest - WEST) / res_deg)))
    c1 = min(cols, int(np.ceil((teast - WEST) / res_deg)))
    r0 = max(0, int(np.floor((NORTH - tnorth) / res_deg)))
    r1 = min(rows, int(np.ceil((NORTH - tsouth) / res_deg)))
    if c1 <= c0 or r1 <= r0:
        return False
    sub = np.full((r1 - r0, c1 - c0), np.nan, dtype=np.float32)
    dst_transform = from_origin(WEST + c0 * res_deg, NORTH - r0 * res_deg, res_deg, res_deg)
    with rasterio.open(url) as ds:
        reproject(
            source=rasterio.band(ds, 1),
            destination=sub,
            src_transform=ds.transform, src_crs=ds.crs,
            dst_transform=dst_transform, dst_crs=ds.crs,
            resampling=Resampling.bilinear,
            src_nodata=np.nan, dst_nodata=np.nan, init_dest_nodata=True
        )
    reg = out_grid[r0:r1, c0:c1]
    m = np.isfinite(sub)
    reg[m] = sub[m]
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--res', type=float, default=120.0, help='目标分辨率(米)')
    ap.add_argument('--jobs', type=int, default=6)
    ap.add_argument('--refresh', action='store_true', help='忽略缓存重新下载')
    ap.add_argument('--grid-from', default=None, help='复用该 meta.json 的 grid 参数')
    ap.add_argument('--from-cache', type=float, default=None,
                    help='从已缓存的该分辨率网格重采样到 --res(不再下载)')
    ap.add_argument('--geoid', default=os.path.join(RAW, 'geoid', 'egm2008.tif'))
    ap.add_argument('--out-res', default=None, help='仅调试:输出到指定文件')
    args = ap.parse_args()

    import rasterio
    from rasterio.warp import reproject, Resampling

    # 目标网格:若提供 --grid-from,则严格复用该 meta 的网格参数(保持与既有 runtime 一致)
    res_deg = args.res / 111320.0
    cols = int(round((EAST - WEST) / res_deg))
    rows = int(round((NORTH - SOUTH) / res_deg))
    if args.grid_from:
        gm = json.load(open(args.grid_from))['grid']
        cols, rows = gm['cols'], gm['rows']
        res_deg = (EAST - WEST) / cols
        print(f'复用 {args.grid_from} 网格 {cols}×{rows}')
    print(f'目标网格 {cols}×{rows} @ ~{args.res}m  (经纬度 {WEST}..{EAST} / {SOUTH}..{NORTH})')

    # 缓存:拼接后的椭球高网格存盘,坏点修复等后处理可重跑而不重新下载
    cache_dir = os.path.join(RAW, 'glo30')
    os.makedirs(cache_dir, exist_ok=True)
    if args.from_cache:
        src = np.load(os.path.join(RAW, 'glo30', f'grid_{int(args.from_cache)}m.npy'))
        rr, rc = src.shape   # numpy 形状为 (行, 列)
        # 源缓存为椭球高:先改正再重采样
        print(f'从缓存 {rc}×{rr} 重采样到 {cols}×{rows}')
        # 源缓存的网格参数(索引必须用源分辨率,否则错位产生条带伪影)
        srcDLon = (EAST - WEST) / rc
        srcDLat = (NORTH - SOUTH) / rr
        grid = np.full((rows, cols), np.nan, dtype=np.float32)
        for r in range(rows):
            lat = NORTH - (r + 0.5) * res_deg
            sr = (NORTH - lat) / srcDLat
            r0 = min(rr - 1, max(0, int(np.floor(sr)))); fy = sr - int(np.floor(sr))
            r1 = min(rr - 1, r0 + 1)
            for c in range(cols):
                lon = WEST + (c + 0.5) * res_deg
                sc = (lon - WEST) / srcDLon
                c0 = min(rc - 1, max(0, int(np.floor(sc)))); fx = sc - int(np.floor(sc))
                c1 = min(rc - 1, c0 + 1)
                g00 = src[r0, c0]; g10 = src[r0, c1]
                g01 = src[r1, c0]; g11 = src[r1, c1]
                grid[r, c] = (g00*(1-fx)*(1-fy) + g10*fx*(1-fy) + g01*(1-fx)*fy + g11*fx*fy)
        np.save(os.path.join(cache_dir, f'grid_{int(args.res)}m.npy'), grid)
        jobs = []
        print('缓存重采样完成(大地水准面改正由主流程统一执行)')
    cache = os.path.join(cache_dir, f'grid_{int(args.res)}m.npy')
    grid = None
    if os.path.exists(cache) and not args.refresh:
        g0 = np.load(cache)
        if g0.shape == (rows, cols):
            grid = g0
            print(f'复用缓存 {cache}')
    if grid is None:
        grid = np.full((rows, cols), np.nan, dtype=np.float32)
    lats = range(int(np.floor(SOUTH)), int(np.floor(NORTH)) + 1)
    lons = range(int(np.floor(WEST)), int(np.floor(EAST)) + 1)
    jobs = []
    for la in lats:
        for lo in lons:
            jobs.append((la, lo))
    t0 = time.time()
    done = [0]

    def work(job):
        la, lo = job
        try:
            if not read_tile(la, lo, WEST, NORTH, res_deg, cols, rows, grid):
                return None
            done[0] += 1
            el = time.time() - t0
            print(f'  [{done[0]}/{len(jobs)}] {la}N {lo}E  {el:.0f}s', flush=True)
            return True
        except Exception as e:
            print(f'  ! {la}N {lo}E 失败: {type(e).__name__} {e}', flush=True)
            return False

    if grid is None or not np.isfinite(grid).any():
        with ThreadPoolExecutor(max_workers=args.jobs) as ex:
            list(ex.map(work, jobs))
        np.save(cache, grid)
    nvalid = int(np.isfinite(grid).sum())
    print(f'拼接完成 {time.time()-t0:.0f}s; 有效像元 {nvalid}/{grid.size}')
    if nvalid < grid.size * 0.5:
        print('! 有效像元过少,中止(不覆盖现有 DEM)')
        sys.exit(1)

    # 大地水准面改正(椭球高 → 正高)
    if os.path.exists(args.geoid):
        with rasterio.open(args.geoid) as g:
            gg = g.read(1)
            gt = g.transform
            # 目标网格经纬度 → 格网索引
            lons2 = WEST + (np.arange(cols) + 0.5) * res_deg
            lats2 = NORTH - (np.arange(rows) + 0.5) * res_deg
            LON, LAT = np.meshgrid(lons2, lats2)
            gc = ((LON - gt.c) / gt.a).astype(np.int32)
            gr = ((gt.d - LAT) / gt.e).astype(np.int32)
            gh, gw = gg.shape
            gc = np.clip(gc, 0, gw - 2)
            gr = np.clip(gr, 0, gh - 2)
            fx = np.clip((LON - gt.c) / gt.a - gc, 0, 1)
            fy = np.clip((gt.d - LAT) / gt.e - gr, 0, 1)
            N = (gg[gr, gc] * (1 - fx) * (1 - fy) + gg[gr, gc + 1] * fx * (1 - fy) +
                 gg[gr + 1, gc] * (1 - fx) * fy + gg[gr + 1, gc + 1] * fx * fy)
            grid = grid - N.astype(np.float32)
            print(f'EGM2008 改正量: 均值 {-np.nanmean(N):+.1f} m, 范围 {-np.nanmax(N):+.1f}..{-np.nanmin(N):+.1f} m (椭球高 → 正高)')
    else:
        print(f'! 未找到大地水准面格网 {args.geoid} → 保留椭球高(与 SRTM 基准不一致,高程将整体偏移)')

    # 空洞填充(最近有效值,按行向前扫描)
    valid = np.isfinite(grid)
    if (~valid).any():
        for r in range(rows):
            row = grid[r]
            idx = np.where(np.isfinite(row))[0]
            if len(idx) == 0:
                continue
            if idx[0] > 0:
                row[:idx[0]] = row[idx[0]]
            if idx[-1] < cols - 1:
                row[idx[-1] + 1:] = row[idx[-1]]
            # 列间线性插值
            for a, b in zip(idx[:-1], idx[1:]):
                if b - a > 1:
                    row[a:b + 1] = np.linspace(row[a], row[b], b - a + 1)
        # 整行空:用上一行
        for r in range(1, rows):
            if not np.isfinite(grid[r]).any():
                grid[r] = grid[r - 1]

    # 坏点修复:与 8 邻域均值偏差 > 120 m 视为野值(GLO-30 偶有填充/错误值)
    for it in range(3):
        acc = np.zeros_like(grid)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                acc += np.roll(np.roll(grid, dy, 0), dx, 0)
        bad = np.abs(grid - acc / 8.0) > 120
        nbad = int(bad.sum())
        if nbad:
            grid = np.where(bad, acc / 8.0, grid)
        print(f'  坏点修复第 {it+1} 轮: {nbad} 个')
        if not nbad:
            break
    print(f'高程范围 {np.nanmin(grid):.0f} ~ {np.nanmax(grid):.0f} m')
    out = np.clip(np.round(grid), 0, 65535).astype(np.uint16)
    os.makedirs(os.path.join(RUNTIME, 'terrain'), exist_ok=True)
    with open(os.path.join(RUNTIME, 'terrain', 'terrain.elev.bin'), 'wb') as f:
        f.write(out.tobytes())

    meta_path = os.path.join(RUNTIME, 'terrain', 'terrain.meta.json')
    meta = json.load(open(meta_path))
    meta['grid'] = {
        'cols': cols, 'rows': rows,
        'west': WEST, 'north': NORTH,
        'dLon': (EAST - WEST) / cols, 'dLat': (NORTH - SOUTH) / rows
    }
    meta['dem'] = {
        'source': 'Copernicus DEM GLO-30 (AWS Open Data), EGM2008 改正为正高',
        'zoom': 10, 'tiles': len(jobs), 'approxResM': int(args.res)
    }
    # 省内高程范围(与既有约定一致:统计硬掩膜内的格)
    # 省内统计:用运行时软掩膜(soft==255 即完全省内),与 TerrainSampler 的重算口径一致
    softp = os.path.join(ROOT, 'public', 'runtime', 'terrain', 'terrain.mask.bin')
    hard = np.fromfile(softp, dtype=np.uint8) if os.path.exists(softp) else None
    if hard is not None:
        hard = np.where(hard >= 255, 255, 0).astype(np.uint8)
    if hard is not None and hard.size == out.size:
        inside = out[hard >= 128]
    else:
        inside = out
    meta['elev'] = {'min': int(inside.min()), 'max': int(inside.max()), 'unit': 'm'}
    json.dump(meta, open(meta_path, 'w'), ensure_ascii=False, indent=2)
    print(f'已写出 terrain.elev.bin ({out.nbytes/1e6:.1f}MB) 与 terrain.meta.json')


if __name__ == '__main__':
    main()
