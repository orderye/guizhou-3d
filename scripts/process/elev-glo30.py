#!/usr/bin/env python3
"""GLO-30 栅格重采样到项目标准网格(方案 §37 数据流水线的一环)。

为什么需要这一步(2026-10-22 发现的配准缺陷):
  `glo30.py --grid-from` 复用了目标网格的 cols/rows,但把行间距也取成了
  (EAST-WEST)/cols —— 即把 GLO-30 写成了「经纬度正方形」网格
  (dLon = dLat = 0.002197265625°,即 218 m 东西 × 245 m 南北),
  而项目其余数据(省界掩膜 / 河谷下切 / 卫星配准 / 河网)都建立在
  标准等距米制网格上(dLon = 0.002197265625°,
  dLat = 0.001959306707°,即 218 m × 218 m)。

  运行时 terrain.meta.json 声明 dLat = 0.001959306707(标准网格),
  于是 245 m 间距的高程被按 218 m 间距解读 —— 高程场在南北向被拉伸 12%,
  最南端错位约 68 km。实测后果:河道中心线比邻域谷底高 p50 = 22.3 m、
  91.2% 的采样点「河线高于两侧地形」(河被画在山脊上),河谷切割无从成立。

本脚本:
  1. 读缓存的 GLO-30 网格(npy,椭球高,格心约定)
  2. 双线性重采样到标准网格(格心约定)
  3. EGM2008 大地水准面改正(椭球高 → 正高,按标准网格经纬度求 N)
  4. 空洞填充 + 坏点修复(与 glo30.py 同口径)
  5. 写 public/runtime/terrain/terrain.elev.bin

  **不写 meta.json** —— meta 由 scripts/process/elev.mjs(本脚本的 Node 包装)统一负责,
  避免 Python 与 JS 两处各写一半元数据导致字段漂移。

依赖:同 glo30.py(numpy + rasterio)
用法:
  .venv/bin/python scripts/process/elev-glo30.py --from-cache 218
  .venv/bin/python scripts/process/elev-glo30.py --from-cache 218 --grid-from public/runtime/terrain/terrain.meta.json
"""
import argparse
import json
import os
import re
import sys

import numpy as np

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
RUNTIME = os.path.join(ROOT, 'public', 'runtime')
RAW = os.path.join(ROOT, 'data', 'raw')

WEST, EAST, NORTH, SOUTH = 103.25, 110.0, 29.55, 24.35


def _npy_header(path):
    """读 npy header,返回 (version_major, header_str, data_offset)"""
    with open(path, 'rb') as f:
        if f.read(6) != b'\x93NUMPY':
            raise ValueError(f'不是 npy 文件: {path}')
        major, _minor = f.read(2)
        if major == 1:
            hlen = int.from_bytes(f.read(2), 'little')
        else:
            hlen = int.from_bytes(f.read(4), 'little')
        header = f.read(hlen).decode('latin1')
        return major, header, f.tell()


def npy_shape(path):
    """只读 header 拿 shape"""
    _major, header, _off = _npy_header(path)
    m = re.search(r"'shape'\s*:\s*(\([^)]*\))", header)
    if not m:
        m = re.search(r'"shape"\s*:\s*(\([^)]*\))', header)
    if not m:
        raise ValueError('无法解析 npy header')
    return tuple(int(x) for x in m.group(1).strip('()').split(',') if x.strip())


def read_npy(path):
    """读取 .npy(纯 float32 一维数组)"""
    _major, _header, off = _npy_header(path)
    with open(path, 'rb') as f:
        f.seek(off)
        data = np.frombuffer(f.read(), dtype=np.float32)
    return data


def resample(src, src_grid, dst_grid):
    """源(椭球高)→目标格网,双线性。约定:格心 = (col+0.5)*dLon"""
    sc, sr = src.shape
    s_dLon, s_dLat = src_grid
    d_c, d_r = dst_grid['cols'], dst_grid['rows']
    # 目标每一格在源中的浮点行/列
    fc = (WEST + (np.arange(d_c) + 0.5) * dst_grid['dLon'] - WEST) / s_dLon - 0.5
    fr = (NORTH - (NORTH - (np.arange(d_r) + 0.5) * dst_grid['dLat'])) / s_dLat - 0.5
    c0 = np.clip(np.floor(fc).astype(np.int64), 0, sc - 2)
    r0 = np.clip(np.floor(fr).astype(np.int64), 0, sr - 2)
    fx = np.clip(fc - c0, 0, 1)
    fy = np.clip(fr - r0, 0, 1)
    a = src[np.ix_(r0, c0)]
    b = src[np.ix_(r0, c0 + 1)]
    c = src[np.ix_(r0 + 1, c0)]
    d = src[np.ix_(r0 + 1, c0 + 1)]
    fx = fx[None, :]
    fy = fy[:, None]
    return ((a * (1 - fx) + b * fx) * (1 - fy) + (c * (1 - fx) + d * fx) * fy).astype(np.float32)


def geoid_correction(grid, dst_grid, geoid_path):
    """EGM2008:grid(椭球高) -= N(正高改正量)"""
    import rasterio
    with rasterio.open(geoid_path) as g:
        gg = g.read(1)
        gt = g.transform
        lons2 = WEST + (np.arange(dst_grid['cols']) + 0.5) * dst_grid['dLon']
        lats2 = NORTH - (np.arange(dst_grid['rows']) + 0.5) * dst_grid['dLat']
        LON, LAT = np.meshgrid(lons2, lats2)
        gc = np.clip(((LON - gt.c) / gt.a).astype(np.int32), 0, gg.shape[1] - 2)
        gr = np.clip(((gt.d - LAT) / gt.e).astype(np.int32), 0, gg.shape[0] - 2)
        fx = np.clip((LON - gt.c) / gt.a - gc, 0, 1)
        fy = np.clip((gt.d - LAT) / gt.e - gr, 0, 1)
        N = (gg[gr, gc] * (1 - fx) * (1 - fy) + gg[gr, gc + 1] * fx * (1 - fy) +
             gg[gr + 1, gc] * (1 - fx) * fy + gg[gr + 1, gc + 1] * fx * fy)
        return grid - N.astype(np.float32), float(-np.nanmean(N)), float(np.nanmax(N)), float(np.nanmin(N))


def fill_holes(grid):
    valid = np.isfinite(grid)
    if not (~valid).any():
        return grid
    for r in range(grid.shape[0]):
        row = grid[r]
        idx = np.where(np.isfinite(row))[0]
        if len(idx) == 0:
            continue
        if idx[0] > 0:
            row[:idx[0]] = row[idx[0]]
        if idx[-1] < grid.shape[1] - 1:
            row[idx[-1] + 1:] = row[idx[-1]]
        for a, b in zip(idx[:-1], idx[1:]):
            if b - a > 1:
                row[a:b + 1] = np.linspace(row[a], row[b], b - a + 1)
    for r in range(1, grid.shape[0]):
        if not np.isfinite(grid[r]).any():
            grid[r] = grid[r - 1]
    return grid


def repair_bad(grid, rounds=3, thresh=120.0):
    for it in range(rounds):
        acc = np.zeros_like(grid)
        for dy in (-1, 0, 1):
            for dx in (-1, 0, 1):
                if dx == 0 and dy == 0:
                    continue
                acc += np.roll(np.roll(grid, dy, 0), dx, 0)
        bad = np.abs(grid - acc / 8.0) > thresh
        nbad = int(bad.sum())
        if nbad:
            grid = np.where(bad, acc / 8.0, grid)
        print(f'  坏点修复第 {it+1} 轮: {nbad} 个')
        if not nbad:
            break
    return grid


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from-cache', type=int, required=True, help='缓存网格分辨率(文件名 grid_<res>m.npy)')
    ap.add_argument('--cols', type=int, required=True, help='目标网格列数')
    ap.add_argument('--rows', type=int, required=True, help='目标网格行数')
    ap.add_argument('--dlon', type=float, required=True, help='目标网格经度步长(度)')
    ap.add_argument('--dlat', type=float, required=True, help='目标网格纬度步长(度)')
    ap.add_argument('--west', type=float, default=WEST, help='目标网格西边界')
    ap.add_argument('--north', type=float, default=NORTH, help='目标网格北边界')
    ap.add_argument('--geoid', default=os.path.join(RAW, 'geoid', 'egm2008.tif'))
    ap.add_argument('--out', default=os.path.join(RUNTIME, 'terrain', 'terrain.elev.bin'))
    args = ap.parse_args()

    # 目标网格由调用方(Node 包装)传入 —— 单一真源是 scripts/config.mjs 的 GRID
    dst = {
        'cols': args.cols, 'rows': args.rows,
        'dLon': args.dlon, 'dLat': args.dlat,
        'west': args.west, 'north': args.north
    }

    cache = os.path.join(RAW, 'glo30', f'grid_{int(args.from_cache)}m.npy')
    if not os.path.exists(cache):
        sys.exit(f'缓存不存在: {cache}\n'
                 f'请先抓取:GLO-30 缓存需由 scripts/download/glo30.py 生成')
    shape = npy_shape(cache)
    src = read_npy(cache).reshape(shape)
    print(f'源网格 {shape[1]}×{shape[0]}  目标 {dst["cols"]}×{dst["rows"]}')

    # 源网格:经纬度正方形(glo30.py --grid-from 的历史产物);若旁注文件声明了标准网格则直接用
    side = os.path.join(RAW, 'glo30', f'grid_{int(args.from_cache)}m.grid.json')
    if os.path.exists(side):
        sg = json.load(open(side))
        src_dLon, src_dLat = sg['dLon'], sg['dLat']
        print(f'源网格(旁注): dLon={src_dLon} dLat={src_dLat}')
    else:
        src_dLon = src_dLat = (EAST - WEST) / shape[1]
        print(f'源网格(推断,经纬度正方形): dLon=dLat={src_dLon}')

    grid = resample(src, (src_dLon, src_dLat), dst)
    del src

    if os.path.exists(args.geoid):
        grid, m, mx, mn = geoid_correction(grid, dst, args.geoid)
        print(f'EGM2008 改正量: 均值 {m:+.1f} m, 范围 {mn:+.1f}..{mx:+.1f} m')
    else:
        print(f'! 未找到大地水准面格网 {args.geoid} → 保留椭球高')

    grid = fill_holes(grid)
    grid = repair_bad(grid)
    print(f'高程范围 {np.nanmin(grid):.0f} ~ {np.nanmax(grid):.0f} m')

    out = np.clip(np.round(grid), 0, 65535).astype(np.uint16)
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, 'wb') as f:
        f.write(out.tobytes())
    print(f'已写出 {args.out} ({out.nbytes/1e6:.1f}MB)')
    # meta.json 由 scripts/process/elev.mjs 统一写(避免两处各写一半元数据)


if __name__ == '__main__':
    main()
