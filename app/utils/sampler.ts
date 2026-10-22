// TerrainSampler:高程栅格的统一查询入口(方案 §59-12:所有对象高度必须经此获取)
export interface TerrainMeta {
  grid: { cols: number; rows: number; west: number; north: number; dLon: number; dLat: number };
  elev: { min: number; max: number; unit: string };
  world: {
    scale: number; originX: number; originY: number;
    widthUnits: number; heightUnits: number;
    verticalScale: number; heightCurve: number; exaggerationDefault: number;
  };
  dem: { source: string; zoom: number; tiles: number; approxResM: number };
  projection: { type: string; lon0: number; lat0: number; sp1: number; sp2: number; R: number };
}

/** 3×3 高斯 [1,2,1] 可分离平滑,n 遍 */
function smoothGrid(src: Uint16Array, cols: number, rows: number, passes: number): Uint16Array {
  let a = src, b = new Uint16Array(src.length);
  const W = [1, 2, 1];
  for (let p = 0; p < passes; p++) {
    // 横向
    for (let r = 0; r < rows; r++) {
      const o = r * cols;
      for (let c = 0; c < cols; c++) {
        const c0 = c > 0 ? c - 1 : 0, c2 = c < cols - 1 ? c + 1 : cols - 1;
        b[o + c] = (a[o + c0] * W[0] + a[o + c] * W[1] + a[o + c2] * W[2]) / 4;
      }
    }
    // 纵向
    for (let r = 0; r < rows; r++) {
      const r0 = r > 0 ? r - 1 : 0, r2 = r < rows - 1 ? r + 1 : rows - 1;
      for (let c = 0; c < cols; c++) {
        a[r * cols + c] = (b[r0 * cols + c] * W[0] + b[r * cols + c] * W[1] + b[r2 * cols + c] * W[2]) / 4;
      }
    }
  }
  return a;
}

/** 2D 值噪声(确定性,用于近景微地形细节) */
function hash2(ix: number, iz: number): number {
  let h = Math.imul(ix, 374761393) + Math.imul(iz, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, z: number): number {
  const ix = Math.floor(x), iz = Math.floor(z);
  const fx = x - ix, fz = z - iz;
  const u = fx * fx * (3 - 2 * fx), v = fz * fz * (3 - 2 * fz);
  const a = hash2(ix, iz), b = hash2(ix + 1, iz), c = hash2(ix, iz + 1), d = hash2(ix + 1, iz + 1);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

export class TerrainSampler {
  meta: TerrainMeta;
  elev: Uint16Array;
  mask: Uint8Array;
  maskWide: Uint8Array | null;
  valley: Uint8Array | null;   // 河谷下切深度(米,逐格)
  colX: Float64Array;   // 每列世界 X
  rowZ: Float64Array;   // 每行世界 Z
  private colXf64: Float64Array;
  private rowZf64: Float64Array;
  verticalScale: number;
  heightCurve: number;
  baseY = 0;       // 底座顶面(裙墙底)
  baseLowY = 0;    // 省界外围压平面高度

  constructor(meta: TerrainMeta, elevBuf: ArrayBuffer, maskBuf: ArrayBuffer, exaggeration: number | null, maskWideBuf?: ArrayBuffer | null, valleyBuf?: ArrayBuffer | null) {
    this.meta = meta;
    const raw = new Uint16Array(elevBuf);
    // 轻度平滑(2×高斯3×3):消除单格坏点/喀斯特孤峰针刺,保持山脊结构
    // 所有贴地对象(河流/道路/建筑)与本平滑面一致,避免穿模
    this.elev = smoothGrid(raw, meta.grid.cols, meta.grid.rows, 2);
    this.mask = new Uint8Array(maskBuf);
    this.maskWide = maskWideBuf ? new Uint8Array(maskWideBuf) : null;
    this.valley = valleyBuf ? new Uint8Array(valleyBuf) : null;
    // 平滑后重算省内高程范围
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < this.elev.length; i++) {
      if (this.mask[i] < 128) continue;
      if (this.elev[i] < mn) mn = this.elev[i];
      if (this.elev[i] > mx) mx = this.elev[i];
    }
    this.meta.elev.min = mn; this.meta.elev.max = mx;
    const w = meta.world;
    this.verticalScale = w.verticalScale * (exaggeration !== null ? exaggeration / w.exaggerationDefault : 1);
    this.heightCurve = w.heightCurve;
    // 预计算列/行世界坐标(Albers 投影)
    const { cols, rows, west, north, dLon, dLat } = meta.grid;
    this.colXf64 = new Float64Array(cols);
    this.rowZf64 = new Float64Array(rows);
    // Albers 参数(与 scripts/config.mjs 一致)
    const R = 6378137, D2R = Math.PI / 180;
    const lon0 = 106.5 * D2R, p1 = 25.5 * D2R, p2 = 28.5 * D2R;
    const n = (Math.sin(p1) + Math.sin(p2)) / 2;
    const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
    const rho0 = R * Math.sqrt(C - 2 * n * Math.sin(26.8 * D2R)) / n;
    const proj = (lon: number, lat: number) => {
      const lam = lon * D2R - lon0;
      const phi = lat * D2R;
      const rho = R * Math.sqrt(Math.max(0, C - 2 * n * Math.sin(phi))) / n;
      const th = n * lam;
      return { x: rho * Math.sin(th), y: rho0 - rho * Math.cos(th) };
    };
    for (let i = 0; i < cols; i++) {
      const lon = west + i * dLon;
      // 列内 x 随 lat 微变,取格元中心纬度
      const latC = north - (rows - 1) * dLat / 2;
      this.colXf64[i] = (proj(lon, latC).x - w.originX) * w.scale;
    }
    for (let j = 0; j < rows; j++) {
      const lat = north - j * dLat;
      const lonC = west + cols * dLon / 2;
      this.rowZf64[j] = -(proj(lonC, lat).y - w.originY) * w.scale;
    }
    this.colX = this.colXf64;
    this.rowZ = this.rowZf64;

    // 底座与省外压平面(方案 §28:厚度 = 视觉高差 × 0.2)
    const maxV = this.visualY(this.meta.elev.max);
    const minV = this.visualY(this.meta.elev.min);
    this.baseY = minV - (maxV - minV) * 0.2 - 0.4;
    this.baseLowY = this.baseY + 0.06;
  }

  get cols() { return this.meta.grid.cols; }
  get rows() { return this.meta.grid.rows; }

  /** 世界 X → 浮点列号(二分) */
  private colAt(x: number): number {
    const arr = this.colXf64, n = arr.length;
    if (x <= arr[0]) return 0;
    if (x >= arr[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= x) lo = m; else hi = m; }
    return lo + (x - arr[lo]) / (arr[hi] - arr[lo]);
  }
  private rowAt(z: number): number {
    const arr = this.rowZf64, n = arr.length;
    if (z <= arr[0]) return 0;
    if (z >= arr[n - 1]) return n - 1;
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (arr[m] <= z) lo = m; else hi = m; }
    return lo + (z - arr[lo]) / (arr[hi] - arr[lo]);
  }

  elevAtCell(i: number, j: number): number {
    const { cols, rows } = this.meta.grid;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
    return this.elev[j * cols + i];
  }
  maskAtCell(i: number, j: number): number {
    const { cols, rows } = this.meta.grid;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
    return this.mask[j * cols + i];
  }
  maskWideAtCell(i: number, j: number): number {
    if (!this.maskWide) return this.maskAtCell(i, j);
    const { cols, rows } = this.meta.grid;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
    return this.maskWide[j * cols + i];
  }

  /** 河谷下切深度(米):0 = 无河谷 */
  valleyAtCell(i: number, j: number): number {
    if (!this.valley) return 0;
    const { cols, rows } = this.meta.grid;
    if (i < 0 || j < 0 || i >= cols || j >= rows) return 0;
    return this.valley[j * cols + i];
  }

  /** 双线性插值原始高程(米) */
  metersAtWorld(x: number, z: number): number {
    const fc = this.colAt(x), fr = this.rowAt(z);
    const i0 = Math.floor(fc), j0 = Math.floor(fr);
    const fx = fc - i0, fz = fr - j0;
    const v00 = this.elevAtCell(i0, j0), v10 = this.elevAtCell(i0 + 1, j0);
    const v01 = this.elevAtCell(i0, j0 + 1), v11 = this.elevAtCell(i0 + 1, j0 + 1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
  }

  /** 掩膜(0-255,含边缘衰减) */
  maskAtWorld(x: number, z: number): number {
    const fc = this.colAt(x), fr = this.rowAt(z);
    return this.maskAtCell(Math.round(fc), Math.round(fr));
  }

  /** 视觉高度:normalize → pow(curve) → verticalScale(方案 §10) */
  visualY(meters: number): number {
    const { min, max } = this.meta.elev;
    const norm = Math.max(0, Math.min(1, (meters - min) / (max - min)));
    return Math.pow(norm, this.heightCurve) * this.verticalScale;
  }

  /** 运行时调整垂直夸张(热切换,方案 §56):重算底座/压平面参数 */
  setVerticalScale(v: number) {
    this.verticalScale = Math.max(1, Math.min(60, v));
    const maxV = this.visualY(this.meta.elev.max);
    const minV = this.visualY(this.meta.elev.min);
    this.baseY = minV - (maxV - minV) * 0.2 - 0.4;
    this.baseLowY = this.baseY + 0.06;
  }

  /** 近景微地形细节(程序化视觉增强):3 倍频值噪声,米制幅度;确定性(同一世界坐标恒定) */
  detailMeters(x: number, z: number): number {
    return (vnoise(x / 170, z / 170) - 0.5) * 2 * 13
      + (vnoise(x / 60, z / 60) - 0.5) * 2 * 5
      + (vnoise(x / 24, z / 24) - 0.5) * 2 * 1.8;
  }

  /** 细节噪声的世界垂直量(随垂直夸张与 LOD 衰减) */
  detailWorld(x: number, z: number, fade: number): number {
    return this.detailMeters(x, z) * (this.verticalScale / (this.meta.elev.max - this.meta.elev.min)) * fade;
  }

  /** 地形表面视觉高度:即 LOD0 渲染网格表面(掩膜过渡 + 近景微细节)。
   *  所有贴地对象(河流/道路/建筑/树/标签/裙墙)与近景地形严格一致(方案 §21/§62) */
  heightAt(x: number, z: number): number {
    return this.meshHeightAt(x, z, 1);
  }

  /** LOD→细节噪声幅度衰减(与 TerrainEngine 共用) */
  detailFadeFor(step: number): number {
    return step <= 1 ? 1 : step <= 2 ? 0.7 : step <= 4 ? 0.35 : 0;
  }

  private meshCache = new Map<number, number>();

  /** 渲染网格表面高度:与 TerrainEngine 的 step 平滑 + 微细节 + 线性插值完全一致,
   *  用于河流/道路贴地,消除弦线埋没 */
  meshHeightAt(x: number, z: number, step: number): number {
    const fc = this.colAt(x), fr = this.rowAt(z);
    const i0 = Math.floor(fc / step) * step, j0 = Math.floor(fr / step) * step;
    const fx = (fc - i0) / step, fz = (fr - j0) / step;
    const fade = this.detailFadeFor(step);
    const key = (a: number, b: number) => a * 100003 + b;
    const h = (i: number, j: number): number => {
      const k = key(i, j) * 4 + step;
      let v = this.meshCache.get(k);
      if (v === undefined) {
        v = this.visualY(this.avgE(i, j, step) - this.avgValley(i, j, step));
        if (fade > 0) {
          // 顶点级微细节(与 TerrainEngine 同一公式,同一世界坐标)
          const ic = Math.min(i, this.meta.grid.cols - 1), jc = Math.min(j, this.meta.grid.rows - 1);
          v += this.detailWorld(this.colXf64[ic], this.rowZf64[jc], fade);
        }
        this.meshCache.set(k, v);
      }
      return v;
    };
    const i1 = i0 + step, j1 = j0 + step;
    const y = (h(i0, j0) * (1 - fx) + h(i1, j0) * fx) * (1 - fz) +
      (h(i0, j1) * (1 - fx) + h(i1, j1) * fx) * fz;
    // 掩膜过渡(与 heightAt 同规则)
    const m = this.maskAtWorld(x, z) / 255;
    if (m >= 0.5) return y;
    return this.baseLowY + (y - this.baseLowY) * (m * 2);
  }

  /** 块平均高程 */
  private avgE(i: number, j: number, s: number): number {
    if (s <= 1) return this.elevAtCell(i, j);
    const r = s >> 1;
    const cols = this.meta.grid.cols, rows = this.meta.grid.rows;
    const i0 = Math.max(0, i - r), i1 = Math.min(cols - 1, i + r - 1);
    const j0 = Math.max(0, j - r), j1 = Math.min(rows - 1, j + r - 1);
    let sum = 0, n = 0;
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      sum += this.elevAtCell(ii, jj); n++;
    }
    return n ? sum / n : 0;
  }

  /** 块平均河谷下切深度(米):与 avgE 同窗口,LOD 变粗时河谷随之被抹平 */
  avgValley(i: number, j: number, s: number): number {
    if (!this.valley) return 0;
    if (s <= 1) return this.valleyAtCell(i, j);
    const r = s >> 1;
    const cols = this.meta.grid.cols, rows = this.meta.grid.rows;
    const i0 = Math.max(0, i - r), i1 = Math.min(cols - 1, i + r - 1);
    const j0 = Math.max(0, j - r), j1 = Math.min(rows - 1, j + r - 1);
    let sum = 0, n = 0;
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      sum += this.valleyAtCell(ii, jj); n++;
    }
    return n ? sum / n : 0;
  }

  clearMeshCache() {
    this.meshCache.clear();
  }

  /** 表面法线(有限差分,世界单位) */
  normalAt(x: number, z: number, eps = 0.12, out: [number, number, number] = [0, 1, 0]): [number, number, number] {
    const hL = this.heightAt(x - eps, z), hR = this.heightAt(x + eps, z);
    const hD = this.heightAt(x, z - eps), hU = this.heightAt(x, z + eps);
    const nx = (hL - hR) / (2 * eps);
    const nz = (hD - hU) / (2 * eps);
    const len = Math.hypot(nx, 1, nz);
    out[0] = nx / len; out[1] = 1 / len; out[2] = nz / len;
    return out;
  }
}
