// TerrainSampler:高程栅格的统一查询入口(方案 §59-12:所有对象高度必须经此获取)
export interface TerrainMeta {
  grid: {
    cols: number; rows: number; west: number; north: number;
    dLon: number; dLat: number;
    /** 格元边长(米)——用于屏幕空间误差 LOD 的像素尺寸换算 */
    cellM?: number;
  };
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

/** 解析 ao.bin:'GZAO' | w(u32) | h(u32) | data(u8 × w×h) */
export function parseAO(buf: ArrayBuffer): { w: number; h: number; data: Uint8Array } | null {
  if (!buf || buf.byteLength < 12) return null;
  const dv = new DataView(buf);
  if (String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3)) !== 'GZAO') return null;
  const w = dv.getUint32(4, true), h = dv.getUint32(8, true);
  const data = new Uint8Array(buf, 12);
  if (data.length < w * h) return null;
  return { w, h, data };
}

export class TerrainSampler {
  meta: TerrainMeta;
  elev: Uint16Array;
  mask: Uint8Array;
  maskWide: Uint8Array | null;
  valley: Uint8Array | null;   // 河谷下切深度(米,逐格)
  ao: { w: number; h: number; data: Uint8Array } | null = null;   // 环境光遮蔽(1/2 分辨率)
  verticalScale: number;
  heightCurve: number;
  baseY = 0;       // 底座顶面(裙墙底)
  baseLowY = 0;    // 省界外围压平面高度

  // ── Albers 等积圆锥投影(参数取自 meta.projection,与 scripts/config.mjs 的 PROJ 一致)──
  //
  // 为什么不能把 x/z 拆成"每列一个 x、每行一个 z":
  //   x = ρ(lat)·sin(θ(lon)),  y = ρ0 − ρ(lat)·cos(θ(lon))
  // ρ(lat) 在本省南北差 4.73 %,乘上边缘的 sin θ 后四角错位可达 ~9 km。
  // 若按"列固定 x、行固定 z"近似,地形栅格会与河网/城市(用完整投影算出的世界坐标)
  // 系统性错开 1–9 km —— 河永远落在错误的山坡上,河谷切割无从成立。
  // 因此:列存 sinθ/cosθ,行存 ρ,顶点世界坐标按乘法组合精确求得;
  // 世界坐标反查网格用 Albers 解析逆投影(与卫星底图着色器同一套公式)。
  private colSin!: Float64Array;   // 每列 sin(θ)
  private colCos!: Float64Array;   // 每列 cos(θ)
  private rowRho!: Float64Array;   // 每行 ρ(lat)
  private projRho0 = 0;
  private projN = 0;
  private projC = 0;
  private projR = 6378137;
  private projLon0 = 106.5;
  private projD2R = Math.PI / 180;
  private worldScale = 1;
  private worldOriginX = 0;
  private worldOriginY = 0;
  private gridWest = 0;
  private gridNorth = 0;
  private gridDLon = 1;
  private gridDLat = 1;

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
    this.worldScale = w.scale;
    this.worldOriginX = w.originX;
    this.worldOriginY = w.originY;

    // 网格约定:格心 —— 第 (i,j) 格元中心位于 lon = west+(i+0.5)*dLon / lat = north-(j+0.5)*dLat。
    // 与预处理侧一致(mask/valley/hydro/vegetation 均按格心产出);
    // 若运行时按格点解释,高程场整体偏移半格(≈109 m),河道将不再落在谷中。
    const { cols, rows, west, north, dLon, dLat } = meta.grid;
    this.gridWest = west; this.gridNorth = north;
    this.gridDLon = dLon; this.gridDLat = dLat;

    // 投影参数
    const P = meta.projection;
    this.projR = P.R;
    this.projD2R = Math.PI / 180;
    this.projLon0 = P.lon0;
    const p1 = P.sp1 * this.projD2R, p2 = P.sp2 * this.projD2R;
    this.projN = (Math.sin(p1) + Math.sin(p2)) / 2;
    this.projC = Math.cos(p1) ** 2 + 2 * this.projN * Math.sin(p1);
    this.projRho0 = this.projR * Math.sqrt(this.projC - 2 * this.projN * Math.sin(P.lat0 * this.projD2R)) / this.projN;

    // 逐列 sinθ/cosθ,逐行 ρ —— 顶点世界坐标 = 两者相乘(完整投影)
    this.colSin = new Float64Array(cols);
    this.colCos = new Float64Array(cols);
    for (let i = 0; i < cols; i++) {
      const th = this.projN * ((west + (i + 0.5) * dLon) * this.projD2R - this.projLon0 * this.projD2R);
      this.colSin[i] = Math.sin(th);
      this.colCos[i] = Math.cos(th);
    }
    this.rowRho = new Float64Array(rows);
    for (let j = 0; j < rows; j++) {
      const lat = north - (j + 0.5) * dLat;
      const s = this.projC - 2 * this.projN * Math.sin(lat * this.projD2R);
      this.rowRho[j] = this.projR * Math.sqrt(Math.max(0, s)) / this.projN;
    }

    // 底座与省外压平面(方案 §28:厚度 = 视觉高差 × 0.2)
    const maxV = this.visualY(this.meta.elev.max);
    const minV = this.visualY(this.meta.elev.min);
    this.baseY = minV - (maxV - minV) * 0.2 - 0.4;
    this.baseLowY = this.baseY + 0.06;
  }

  get cols() { return this.meta.grid.cols; }
  get rows() { return this.meta.grid.rows; }

  /** 格元 (i,j) 的世界 X(完整 Albers 投影,米→世界单位) */
  worldX(i: number, j: number): number {
    return (this.rowRho[j] * this.colSin[i] - this.worldOriginX) * this.worldScale;
  }

  /** 格元 (i,j) 的世界 Z(完整 Albers 投影,米→世界单位) */
  worldZ(i: number, j: number): number {
    const y = this.projRho0 - this.rowRho[j] * this.colCos[i];
    return -(y - this.worldOriginY) * this.worldScale;
  }

  /**
   * 世界坐标 → 网格浮点索引(Albers 解析逆投影)
   * 连续索引以"格元中心"为整数格:i = (lon−west)/dLon − 0.5
   */
  gridAt(x: number, z: number): { i: number; j: number } {
    const px = x / this.worldScale + this.worldOriginX;
    const py = -z / this.worldScale + this.worldOriginY;
    const dy = this.projRho0 - py;
    const th = Math.atan2(px, dy);
    const rho = Math.hypot(px, dy);
    const s = (this.projC - (rho * this.projN / this.projR) ** 2) / (2 * this.projN);
    const lat = Math.asin(Math.max(-1, Math.min(1, s))) / this.projD2R;
    const lon = th / this.projN / this.projD2R + this.projLon0;
    return {
      i: (lon - this.gridWest) / this.gridDLon - 0.5,
      j: (this.gridNorth - lat) / this.gridDLat - 0.5
    };
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

  /**
   * 环境光遮蔽采样(格索引 → 0..1 开阔度)
   * AO 表为全分辨率的 1/2,双线性插值;AO 是低频量,不随 LOD 变粗
   *
   * 口径(与 scripts/process/ao.mjs 一致):AO 格 (ci,ri) 聚合 DEM 格
   * (2ci,2ci+1)×(2ri,2ri+1),即 DEM 连续位置 [2ci, 2ci+2) 的平均。
   * 在 AO 的连续坐标里,DEM 连续位置 p 对应 AO 连续坐标 (p−0.5)/2;
   * DEM 格 i 的中心在 p = i+0.5 → AO 连续坐标 = i/2。
   */
  aoAtCell(i: number, j: number): number {
    if (!this.ao) return 1;
    const fc = i * 0.5, fr = j * 0.5;
    const { w, h, data } = this.ao;
    const c0 = Math.floor(fc), r0 = Math.floor(fr);
    const fx = fc - c0, fz = fr - r0;
    const g = (ci: number, ri: number) => {
      if (ci < 0 || ri < 0 || ci >= w || ri >= h) return 255;
      return data[ri * w + ci];
    };
    const v00 = g(c0, r0), v10 = g(c0 + 1, r0), v01 = g(c0, r0 + 1), v11 = g(c0 + 1, r0 + 1);
    const v = (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
    return v / 255;
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
    const { i: fc, j: fr } = this.gridAt(x, z);
    const i0 = Math.floor(fc), j0 = Math.floor(fr);
    const fx = fc - i0, fz = fr - j0;
    const v00 = this.elevAtCell(i0, j0), v10 = this.elevAtCell(i0 + 1, j0);
    const v01 = this.elevAtCell(i0, j0 + 1), v11 = this.elevAtCell(i0 + 1, j0 + 1);
    return (v00 * (1 - fx) + v10 * fx) * (1 - fz) + (v01 * (1 - fx) + v11 * fx) * fz;
  }

  /** 掩膜(0-255,含边缘衰减) */
  maskAtWorld(x: number, z: number): number {
    const { i, j } = this.gridAt(x, z);
    return this.maskAtCell(Math.round(i), Math.round(j));
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
    // 垂直量变了,已缓存的顶点高度全部失效(否则贴地对象会停在旧高度上)
    this.clearMeshCache();
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

  /** 地形表面视觉高度:即最细 LOD 渲染网格表面(掩膜过渡 + 近景微细节)。
   *  所有贴地对象(河流/道路/建筑/树/标签/裙墙)与近景地形严格一致(方案 §21/§62) */
  heightAt(x: number, z: number): number {
    return this.surfaceHeightAt(x, z, 1);
  }

  /** LOD→细节噪声幅度衰减(与 TerrainEngine 共用) */
  detailFadeFor(step: number): number {
    return step <= 1 ? 1 : step <= 2 ? 0.7 : step <= 4 ? 0.35 : 0;
  }

  private vertCache = new Map<number, number>();

  /** 网格点(i,j)在 step 下的高程(米):块平均高程 − 河谷下切(几何与着色共用) */
  carvedElevAtCell(i: number, j: number, step: number): number {
    return this.avgE(i, j, step) - this.avgValley(i, j, step);
  }

  /**
   * 渲染表面高度的唯一真源(方案 §59-12)。
   * 顺序固定:块平均高程 → 减河谷下切 → visualY → 掩膜下沉 → 叠加近景微细节。
   * 地形网格顶点与所有贴地对象共用本函数,杜绝"网格与对象各算一套"的错位。
   */
  vertexHeightAtCell(i: number, j: number, step: number): number {
    const k = (i * 100003 + j) * 8 + step;
    let v = this.vertCache.get(k);
    if (v !== undefined) return v;
    const e = this.carvedElevAtCell(i, j, step);
    const yRaw = this.visualY(e);
    const msk = this.maskAtCell(i, j) / 255;
    v = msk >= 0.5 ? yRaw : this.baseLowY + (yRaw - this.baseLowY) * (msk * 2);
    const fade = this.detailFadeFor(step);
    if (fade > 0) {
      const ic = Math.min(i, this.meta.grid.cols - 1), jc = Math.min(j, this.meta.grid.rows - 1);
      v += this.detailWorld(this.worldX(ic, jc), this.worldZ(ic, jc), fade);
    }
    this.vertCache.set(k, v);
    return v;
  }

  /** 渲染网格表面高度(在 step 网格上双线性插值),用于河流/道路/建筑/树贴地 */
  surfaceHeightAt(x: number, z: number, step: number): number {
    const { i: fc, j: fr } = this.gridAt(x, z);
    const i0 = Math.floor(fc / step) * step, j0 = Math.floor(fr / step) * step;
    const fx = (fc - i0) / step, fz = (fr - j0) / step;
    const i1 = i0 + step, j1 = j0 + step;
    return (this.vertexHeightAtCell(i0, j0, step) * (1 - fx) + this.vertexHeightAtCell(i1, j0, step) * fx) * (1 - fz) +
      (this.vertexHeightAtCell(i0, j1, step) * (1 - fx) + this.vertexHeightAtCell(i1, j1, step) * fx) * fz;
  }

  /**
   * 块平均高程(米)
   *
   * 窗口必须与 LOD 抽稀**对齐**:LOD 顶点位于格 i(= mi*step),它代表的是
   * 块 [i, i+step) 的平均。若用"以 i 为中心的 2r 窗口"(i-r … i+r-1),
   * 窗口会跨越整整一个顶点间距并偏移半格 —— 同一地点在 step=1 与 step=16
   * 下取到不同的地形,表现为 LOD 跳变与锯齿。
   */
  private avgE(i: number, j: number, s: number): number {
    if (s <= 1) return this.elevAtCell(i, j);
    const cols = this.meta.grid.cols, rows = this.meta.grid.rows;
    const i1 = Math.min(cols - 1, i + s - 1);
    const j1 = Math.min(rows - 1, j + s - 1);
    let sum = 0, n = 0;
    for (let jj = j; jj <= j1; jj++) for (let ii = i; ii <= i1; ii++) {
      sum += this.elevAtCell(ii, jj); n++;
    }
    return n ? sum / n : 0;
  }

  /** 块平均河谷下切深度(米):与 avgE 同窗口,LOD 变粗时河谷随之被抹平 */
  avgValley(i: number, j: number, s: number): number {
    if (!this.valley) return 0;
    if (s <= 1) return this.valleyAtCell(i, j);
    const cols = this.meta.grid.cols, rows = this.meta.grid.rows;
    const i1 = Math.min(cols - 1, i + s - 1);
    const j1 = Math.min(rows - 1, j + s - 1);
    let sum = 0, n = 0;
    for (let jj = j; jj <= j1; jj++) for (let ii = i; ii <= i1; ii++) {
      sum += this.valleyAtCell(ii, jj); n++;
    }
    return n ? sum / n : 0;
  }

  clearMeshCache() {
    this.vertCache.clear();
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
