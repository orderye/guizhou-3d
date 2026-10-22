// TerrainEngine:分块 LOD 地形 + 边界裁剪 + 高程夸张 + 高程分层色/坡度着色 + 卫星底图
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';
import {
  applySatellite,
  albersInverseParams,
  type SatelliteMeta, type ProjectionMeta, type WorldMeta, type SatelliteUniforms
} from './satellite';

/**
 * 每瓦片覆盖的格元数。
 *
 * 256(55.8 km)会把全省切成 12×11=132 块:瓦片重建总工作量暴增 3.7 倍,
 * 渐进构建要几十秒才能铺满(首屏长时间缺块)。
 * 512(111.6 km)保持 36 块,配合屏幕空间误差 LOD
 * (TerrainEngine.levelForDistance)仍能得到"近处细、远处粗"的正确分布。
 */
export const TILE_CELLS = 512;

interface Tile {
  ti: number; tj: number;
  level: number;           // 0=最细(step1) 3=最粗(step16)
  targetLevel: number;     // 屏幕空间误差算出的目标档位(细化队列用)
  pending: number;         // 磁滞候选级别
  pendingSince: number;
  mesh: THREE.Mesh | null;
  center: THREE.Vector3;
  // 瓦片在世界 XZ 上的footprint(用于按"到瓦片最近距离"判 LOD —— 用中心距离会让
  // 相机正好站在瓦片一角时该瓦片被降到粗档,极近景直接糊掉)
  x0: number; x1: number; z0: number; z1: number;
}

const STEP_FOR_LEVEL = [1, 2, 4, 16];

/**
 * 屏幕空间误差阈值:一个格元投影到屏幕后的最大像素尺寸。
 * 218 m 的格元在 4 px 时 ≈ 视距 55 km 处仍能分辨山脊/沟谷;
 * 再远就不必细分(远处的锯齿被雾与卫星底图掩盖)。
 */
const MAX_CELL_PX = 4.0;

// 高程分层色(方案 §14)
const STOPS: Array<[number, number, number, number]> = [
  // elev_m, r, g, b
  [200, 0.55, 0.56, 0.32],   // 河谷黄绿
  [600, 0.28, 0.44, 0.21],   // 深绿
  [1100, 0.25, 0.42, 0.22],  // 深绿
  [1500, 0.35, 0.44, 0.27],  // 灰绿
  [1900, 0.44, 0.44, 0.31],  // 灰绿偏黄
  [2300, 0.50, 0.47, 0.38],  // 灰褐
  [2700, 0.55, 0.53, 0.47],  // 裸岩灰白
  [3200, 0.62, 0.61, 0.58]
];

export function elevColor(e: number, out: THREE.Color) {
  let a = STOPS[0], b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (e >= STOPS[i][0] && e <= STOPS[i + 1][0]) { a = STOPS[i]; b = STOPS[i + 1]; break; }
    if (e < STOPS[0][0]) { a = b = STOPS[0]; break; }
    if (e > STOPS[STOPS.length - 1][0]) { a = b = STOPS[STOPS.length - 1]; break; }
  }
  const t = b[0] === a[0] ? 0 : (e - a[0]) / (b[0] - a[0]);
  out.setRGB(a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t);
  return out;
}

// 简单确定性噪声
function noise2(x: number, y: number): number {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** 卫星底图注入包(纹理由外部持有,引擎重建时不重复上传) */
export interface SatelliteBundle {
  texture: THREE.Texture;
  meta: SatelliteMeta;
  projection: ProjectionMeta;
  world: WorldMeta;
  mix: number;
  sat: number;
  gain?: number;
  lift?: number;
  cloud?: number;
  nearW?: number;
  near?: number;
  far?: number;
}

export class TerrainEngine {
  group = new THREE.Group();
  private tiles: Tile[] = [];
  private mat: THREE.MeshStandardMaterial;
  private satUniforms: SatelliteUniforms | null = null;
  private tcols = 0; private trows = 0;
  private baseLowY = 0;
  private forest: { dens: Uint8Array; cols: number; rows: number; cell: number; fx0: number; fy0: number } | null = null;
  private riverTint: Uint8Array | null = null;
  private aoTexture: THREE.DataTexture | null = null;

  constructor(private sampler: TerrainSampler, enabled = true, forestData?: { bin: ArrayBuffer; meta: { cols: number; rows: number; cell: number; originX: number; originY: number } }, riverTintBin?: ArrayBuffer, satellite?: SatelliteBundle) {
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0
    });
    if (satellite) {
      this.satUniforms = applySatellite(
        this.mat, satellite.texture, satellite.meta, satellite.projection, satellite.world,
        satellite.mix, satellite.sat, satellite.gain, satellite.lift, satellite.cloud,
        satellite.nearW, satellite.near, satellite.far
      );
    }
    this.aoTexture = this.buildAOTexture();
    this.attachAO(this.mat);
    this.baseLowY = sampler.baseLowY;
    if (forestData) {
      this.forest = {
        dens: new Uint8Array(forestData.bin),
        cols: forestData.meta.cols, rows: forestData.meta.rows, cell: forestData.meta.cell,
        fx0: forestData.meta.originX, fy0: forestData.meta.originY
      };
    }
    if (riverTintBin && this.forest) this.riverTint = new Uint8Array(riverTintBin);
    if (enabled) this.buildTiles();
  }

  /** AO 表(1/2 分辨率 R8)→ DataTexture,供片元着色器采样 */
  private buildAOTexture(): THREE.DataTexture | null {
    const ao = this.sampler.ao;
    if (!ao) return null;
    const tex = new THREE.DataTexture(ao.data, ao.w, ao.h, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.generateMipmaps = false;
    tex.needsUpdate = true;
    return tex;
  }

  /**
   * 注入环境光遮蔽(方案 §51 真实感清单):地形按真实 DEM 天空可见度压暗。
   * 乘算点放在 aomap_fragment(底图混合之后),使底图与色带都受遮蔽影响。
   *
   * AO 从"逐顶点属性"改为**纹理采样**:
   *   ① 地形顶点属性从 5 个降到 4 个(每顶点省 4 B)
   *   ② AO 分辨率不再随网格 LOD 变化(LOD 变粗时 AO 不再跟着顶点间距变糊)
   * AO 表是 DEM 网格的 1/2 分辨率、按格心对齐,因此在顶点着色器里
   * 把世界坐标反投影回经纬度 → 换算成 AO 网格 UV → 传 varying 给片元采样。
   */
  private attachAO(mat: THREE.MeshStandardMaterial) {
    const prev = mat.onBeforeCompile;
    mat.onBeforeCompile = (shader, renderer) => {
      if (prev) prev(shader, renderer);
      const P = this.sampler.meta.projection;
      const ip = albersInverseParams(P);
      const w = this.sampler.meta.world;
      const g = this.sampler.meta.grid;
      shader.uniforms.uAoMap = { value: this.aoTexture };
      shader.uniforms.uAoOrigin = { value: new THREE.Vector2(g.west, g.north) };
      shader.uniforms.uAoStep = { value: new THREE.Vector2(g.dLon, g.dLat) };
      shader.uniforms.uAoSize = { value: new THREE.Vector2(g.cols * 0.5, g.rows * 0.5) };
      shader.uniforms.uAoInvScale = { value: 1 / w.scale };
      shader.uniforms.uAoOriginXY = { value: new THREE.Vector2(w.originX, w.originY) };
      shader.uniforms.uAoN = { value: ip.n };
      shader.uniforms.uAoC = { value: ip.C };
      shader.uniforms.uAoRho0 = { value: ip.rho0 };
      shader.uniforms.uAoR = { value: ip.R };
      shader.uniforms.uAoD2R = { value: ip.D2R };
      shader.uniforms.uAoLon0 = { value: ip.lon0Deg };

      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', `#include <common>
varying vec2 vAoUv;
uniform sampler2D uAoMap;
uniform vec2 uAoOrigin, uAoStep, uAoSize, uAoOriginXY;
uniform float uAoInvScale, uAoN, uAoC, uAoRho0, uAoR, uAoD2R, uAoLon0;`)
        .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  // 世界坐标 → Albers 逆投影 → 经纬度 → AO 网格 UV
  float px = position.x * uAoInvScale + uAoOriginXY.x;
  float py = -position.z * uAoInvScale + uAoOriginXY.y;
  float dy = uAoRho0 - py;
  float th = atan(px, dy);
  float rho = sqrt(px * px + dy * dy);
  float sLat = clamp((uAoC - pow(rho * uAoN / uAoR, 2.0)) / (2.0 * uAoN), -1.0, 1.0);
  float lat = asin(sLat) / uAoD2R;
  float lon = th / uAoN / uAoD2R + uAoLon0;
  // AO 表是 DEM 网格的 1/2 分辨率、格心对齐:DEM 连续位置 p → AO 连续位置 (p-0.5)/2
  float ac = (lon - uAoOrigin.x) / uAoStep.x - 0.5;
  float ar = (uAoOrigin.y - lat) / uAoStep.y - 0.5;
  vAoUv = vec2((ac + 0.5) / uAoSize.x, (ar + 0.5) / uAoSize.y);
}`);
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
varying vec2 vAoUv;
uniform sampler2D uAoMap;`)
        .replace('#include <aomap_fragment>', `#include <aomap_fragment>
{
  float ao = texture2D(uAoMap, vAoUv).r;
  diffuseColor.rgb *= mix(1.0, ao, 0.45);
}`);
    };
  }

  /** 投影对齐网格采样(森林/河流烙印共用);win>1 时做窗口平均以匹配粗 LOD */
  private gridAt(dens: Uint8Array, x: number, z: number, win = 1): number {
    const f = this.forest!;
    const w = this.sampler.meta.world;
    const px = x / w.scale + w.originX;
    const py = -z / w.scale + w.originY;
    const c = Math.floor((px - f.fx0) / f.cell);
    const r = Math.floor((py - f.fy0) / f.cell);
    if (c < 0 || r < 0 || c >= f.cols || r >= f.rows) return 0;
    if (win <= 1) return dens[r * f.cols + c];
    const h = win >> 1;
    let sum = 0, n = 0;
    for (let jj = Math.max(0, r - h); jj <= Math.min(f.rows - 1, r + h); jj++) {
      for (let ii = Math.max(0, c - h); ii <= Math.min(f.cols - 1, c + h); ii++) {
        sum += dens[jj * f.cols + ii]; n++;
      }
    }
    return n ? sum / n : 0;
  }

  /** 森林密度 0-1(随 LOD 窗口平均) */
  private forestAt(x: number, z: number, step = 1): number {
    if (!this.forest) return 0;
    // DEM 格 ≈218m,森林格 ≈430m → 窗口 ≈ step/2
    const win = Math.max(1, Math.round(step / 2));
    return this.gridAt(this.forest.dens, x, z, win) / 255;
  }

  private buildTiles() {
    const { cols, rows } = this.sampler.meta.grid;
    this.tcols = Math.ceil(cols / TILE_CELLS);
    this.trows = Math.ceil(rows / TILE_CELLS);
    for (let tj = 0; tj < this.trows; tj++) {
      for (let ti = 0; ti < this.tcols; ti++) {
        // tile 中心
        const ci0 = ti * TILE_CELLS, cj0 = tj * TILE_CELLS;
        const ci1 = Math.min(ci0 + TILE_CELLS, cols) - 1, cj1 = Math.min(cj0 + TILE_CELLS, rows) - 1;
        // footprint:四角格元的完整 Albers 投影(网格随纬度弯曲,不能用矩形近似)
        const x0 = this.sampler.worldX(ci0, cj0), x1 = this.sampler.worldX(ci1, cj1);
        const z0 = this.sampler.worldZ(ci0, cj0), z1 = this.sampler.worldZ(ci1, cj1);
        const xMin = Math.min(this.sampler.worldX(ci0, cj1), this.sampler.worldX(ci1, cj0), x0, x1);
        const xMax = Math.max(this.sampler.worldX(ci0, cj1), this.sampler.worldX(ci1, cj0), x0, x1);
        const zMin = Math.min(this.sampler.worldZ(ci0, cj1), this.sampler.worldZ(ci1, cj0), z0, z1);
        const zMax = Math.max(this.sampler.worldZ(ci0, cj1), this.sampler.worldZ(ci1, cj0), z0, z1);
        const cxs = (x0 + x1) / 2, czs = (z0 + z1) / 2;
        const cy = this.sampler.heightAt(cxs, czs);
        this.tiles.push({
          ti, tj, level: 3, targetLevel: 3, pending: -1, pendingSince: 0, mesh: null,
          center: new THREE.Vector3(cxs, cy, czs),
          x0: xMin, x1: xMax, z0: zMin, z1: zMax
        });
      }
    }
  }

  private rebuildQueue: Tile[] = [];
  private lastCam = new THREE.Vector3();
  private camGroundY = 0;
  /** 三角形预算(0 = 不限)。桌面 3.0M / 移动端 1.2M(方案 §32) */
  maxTriangles = 3_000_000;

  /**
   * 屏幕空间误差 LOD(方案 §9 + M2)
   *
   * 选档依据:一个格元(cell)在该瓦片距离处的**投影像素尺寸**。
   *   pxPerCell = cellU × step × (viewportH/2) / (d × tan(fov/2))
   * 选最大的 step 使 pxPerCell ≤ MAX_CELL_PX(误差阈值)。
   *
   * 与"固定距离阈值"相比:
   *   ① 与 FOV/窗口尺寸/相机高度解耦 —— 高空全景不会与贴地近景用同一档
   *   ② 距离用瓦片**最近点**(footprint 到相机的水平距离)——
   *      相机贴着瓦片一角时,整块瓦片都按最近点定档,不会误降为粗档
   *      (旧实现用"到瓦片中心距离",正是极近景糊成一团的原因)
   *   ③ 离地高度不参与:垂直方向由 FOV/视高已隐含,再叠加只会让近处变粗
   */
  private levelForDistance(d: number, cellU: number, viewportH: number, tanHalfFov: number): number {
    // d 过小时(相机贴在瓦片上)退化为最细档
    const dSafe = Math.max(d, 0.35);
    for (let level = 0; level < STEP_FOR_LEVEL.length; level++) {
      const step = STEP_FOR_LEVEL[level];
      const px = cellU * step * (viewportH * 0.5) / (dSafe * tanHalfFov);
      if (px > MAX_CELL_PX) {
        // 上一档(更细)一定满足
        return Math.max(0, level - 1);
      }
      if (level === STEP_FOR_LEVEL.length - 1) return level;
    }
    return 0;
  }

  /** 相机到瓦片footprint 的最近水平距离(世界单位) */
  private tileDistance(t: Tile, cam: THREE.Vector3): number {
    const dx = Math.max(t.x0 - cam.x, 0, cam.x - t.x1);
    const dz = Math.max(t.z0 - cam.z, 0, cam.z - t.z1);
    return Math.hypot(dx, dz);
  }

  /** 该点所在瓦片的当前 LOD 步长 —— 贴地对象据此采样,避免与地形错位 */
  stepAt(x: number, z: number): number {
    const { cols, rows } = this.sampler.meta.grid;
    const { i, j } = this.sampler.gridAt(x, z);
    const ci = Math.round(i), cj = Math.round(j);
    if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) return STEP_FOR_LEVEL[3];
    const ti = Math.min(this.tcols - 1, Math.max(0, Math.floor(ci / TILE_CELLS)));
    const tj = Math.min(this.trows - 1, Math.max(0, Math.floor(cj / TILE_CELLS)));
    const t = this.tiles[tj * this.tcols + ti];
    return t ? STEP_FOR_LEVEL[t.level] : STEP_FOR_LEVEL[3];
  }

  /**
   * 相机更新(节流调用):LOD 磁滞判定,变更瓦片入重建队列(方案 §33 流畅度)
   *
   * 选档用屏幕空间误差(见 levelForDistance),需要相机的 FOV 与视口高度。
   */
  update(camPos: THREE.Vector3, fovDeg = 50, viewportH = 800) {
    this.lastCam.copy(camPos);
    this.camGroundY = this.sampler.heightAt(camPos.x, camPos.z);
    const now = performance.now();
    const tanHalfFov = Math.tan((fovDeg * Math.PI / 180) / 2);
    const cellU = (this.sampler.meta.grid.cellM ?? 218) * this.sampler.meta.world.scale;
    const changed: Tile[] = [];
    for (const t of this.tiles) {
      const want = this.levelForDistance(this.tileDistance(t, camPos), cellU, viewportH, tanHalfFov);
      t.targetLevel = want;
      // 磁滞:候选级别需持续 500ms 且两次判定一致才切换,避免边界抖动
      if (want !== t.level) {
        if (t.pending === want && now - t.pendingSince > 500) {
          t.level = want;
          t.pending = -1;
          changed.push(t);
        } else if (t.pending !== want) {
          t.pending = want;
          t.pendingSince = now;
        }
      } else {
        t.pending = -1;
      }
    }
    if (changed.length) this.enqueue(changed);
    this.enforceTriangleBudget();
  }

  /** 入队(去重)并按相机距离排序——近者优先重建 */
  private enqueue(tiles: Tile[]) {
    const inQueue = new Set(this.rebuildQueue);
    for (const t of tiles) if (!inQueue.has(t)) this.rebuildQueue.push(t);
    this.rebuildQueue.sort((a, b) =>
      a.center.distanceToSquared(this.lastCam) - b.center.distanceToSquared(this.lastCam));
  }

  /**
   * 三角形预算调度(方案 §32 性能目标)。
   *
   * 屏幕空间误差给的是"每瓦片该多细",但总预算仍可能超标
   * (极端近景:多块瓦片同时 step1 → 三角形暴涨)。
   * 这里在每次 LOD 更新后:若总三角形超预算,按"离相机由远及近"
   * 把最远的瓦片降一级(粗档),直到达标;有余量时反向回收。
   */
  private enforceTriangleBudget() {
    const budget = this.maxTriangles;
    if (budget <= 0) return;
    // 每块瓦片的三角形数(step 决定网格密度)
    const trisOf = (t: Tile) => {
      const { cols, rows } = this.sampler.meta.grid;
      const step = STEP_FOR_LEVEL[t.level];
      const ci0 = t.ti * TILE_CELLS, cj0 = t.tj * TILE_CELLS;
      const ci1 = Math.min(ci0 + TILE_CELLS, cols - 1);
      const cj1 = Math.min(cj0 + TILE_CELLS, rows - 1);
      const n = Math.floor((ci1 - ci0) / step) + 1;
      const m = Math.floor((cj1 - cj0) / step) + 1;
      return (n - 1) * (m - 1) * 2;
    };
    let total = 0;
    for (const t of this.tiles) total += trisOf(t);
    if (total <= budget) return;
    // 由远及近降级:远处瓦片先牺牲(它们本来就看不清细节)
    const byDist = [...this.tiles].sort((a, b) =>
      b.center.distanceToSquared(this.lastCam) - a.center.distanceToSquared(this.lastCam));
    for (const t of byDist) {
      if (total <= budget) break;
      if (t.level >= STEP_FOR_LEVEL.length - 1) continue;
      const before = trisOf(t);
      t.level++;
      // 预算降级后,目标档位同步下调(否则 update() 会立刻把它改回细档)
      t.targetLevel = Math.max(t.targetLevel, t.level);
      const after = trisOf(t);
      total -= before - after;
      this.enqueue([t]);
    }
  }

  /** 构建计数与耗时(诊断用):{ built, total, lastMs, avgMs } */
  buildStats = { built: 0, total: 0, lastMs: 0, avgMs: 0 };

  private buildTileMesh(t: Tile): THREE.Mesh {
    const __t0 = performance.now();
    const s = this.sampler;
    const { cols, rows } = s.meta.grid;
    const step = STEP_FOR_LEVEL[t.level];
    const ci0 = t.ti * TILE_CELLS, cj0 = t.tj * TILE_CELLS;
    const ci1 = Math.min(ci0 + TILE_CELLS, cols - 1); // 含端点
    const cj1 = Math.min(cj0 + TILE_CELLS, rows - 1);    const n = Math.floor((ci1 - ci0) / step) + 1;
    const m = Math.floor((cj1 - cj0) / step) + 1;
    const vCount = n * m;
    const skirt = 0.6;

    // 裙边只分配"边缘环"顶点(不是全部顶点复制一份)——原实现 totalV = vCount*2,
    // 其中只有 2(n+m) 个环顶点被索引,却按 2× 分配了所有属性缓冲 → 一半显存是浪费的。
    const ringCount = 2 * (n + m);
    const totalV = vCount + ringCount;

    // 属性打包(每顶点 22 B,原 44 B):
    //   pos  F32×3 (12 B) | nor I16×3 normalized (6 B) | col U8×3 normalized (3 B) | satW U8 (1 B)
    // AO 改为纹理采样(见 attachAO),不再逐顶点携带(原 F32 = 4 B)。
    const pos = new Float32Array(totalV * 3);
    const nor = new Int16Array(totalV * 3);
    const col = new Uint8Array(totalV * 3);
    const satW = new Uint8Array(totalV); // 底图混合权重(省界外为 0)
    const c = new THREE.Color();

    const heightCache = new Float32Array(vCount);
    let k = 0;
    for (let mj = 0; mj < m; mj++) {
      const j = cj0 + mj * step;
      for (let mi = 0; mi < n; mi++, k++) {
        const i = ci0 + mi * step;
        const x = s.worldX(i, j), z = s.worldZ(i, j);
        // 高度真源(与河流/道路/建筑/树共用):块平均高程 − 河谷下切 → visualY → 掩膜下沉 → 微细节
        const e = s.carvedElevAtCell(i, j, step);
        const msk = s.maskAtCell(i, j) / 255;
        const y = s.vertexHeightAtCell(i, j, step);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        heightCache[k] = y;
        satW[k] = Math.round(msk * 255); // 掩膜=1 为省内,边沿渐隐到基座

        // 颜色 = 高程色 × 森林覆盖 × 河流烙印 × 连续噪声
        elevColor(e, c);
        const forestD = msk > 0.6 ? this.forestAt(x, z, step) : 0;
        if (forestD > 0.05) {
          // 真实林地:混入更深的林绿色(方案 §16 大面积真实植被覆盖)
          const t = Math.min(0.7, forestD * 0.95);
          c.setRGB(c.r + (0.13 - c.r) * t, c.g + (0.30 - c.g) * t, c.b + (0.14 - c.b) * t);
        }
        if (this.riverTint && msk > 0.3) {
          const rt = this.gridAt(this.riverTint, x, z, Math.max(1, Math.round(step / 2))) / 255;
          if (rt > 0.03) {
            // 河谷水色烙印(远景河流表现,方案 §22)
            const t = Math.min(0.85, rt);
            c.setRGB(c.r + (0.09 - c.r) * t, c.g + (0.21 - c.g) * t, c.b + (0.32 - c.b) * t);
          }
        }
        const nz2 = 0.90 + 0.20 * noise2(i >> 2, j >> 2);
        let r = c.r * nz2, g = c.g * nz2, b = c.b * nz2;
        // 掩膜边缘:向基座岩色过渡,外围压暗融入底座
        if (msk < 1) {
          const dk = 0.4 + 0.6 * msk;
          const rock = (0.15 + 0.03 * noise2(i >> 3, j >> 3)) * dk;
          r = rock + (r - rock) * msk;
          g = rock * 0.96 + (g - rock * 0.96) * msk;
          b = rock * 0.9 + (b - rock * 0.9) * msk;
        }
        // 颜色写回 U8(量化 1/255,肉眼不可见)
        col[k * 3] = Math.round(r * 255); col[k * 3 + 1] = Math.round(g * 255); col[k * 3 + 2] = Math.round(b * 255);
      }
    }
    // 法线(网格差分,第二遍:依赖 heightCache)
    k = 0;
    for (let mj = 0; mj < m; mj++) {
      for (let mi = 0; mi < n; mi++, k++) {
        const i = ci0 + mi * step, j = cj0 + mj * step;
        const iL = Math.max(0, mi - 1), iR = Math.min(n - 1, mi + 1);
        const jD = Math.max(0, mj - 1), jU = Math.min(m - 1, mj + 1);
        const hL = heightCache[mj * n + iL], hR = heightCache[mj * n + iR];
        const hD = heightCache[jD * n + mi], hU = heightCache[jU * n + mi];
        const dxw = (Math.abs(s.worldX(Math.min(ci0 + iR * step, cols - 1), j) - s.worldX(Math.max(ci0 + iL * step, 0), j)) || 1e-4);
        const dzw = (Math.abs(s.worldZ(i, Math.min(cj0 + jU * step, rows - 1)) - s.worldZ(i, Math.max(cj0 + jD * step, 0))) || 1e-4);
        let nx = (hL - hR) / (2 * dxw);
        let nzz = (hD - hU) / (2 * dzw);
        const len = Math.hypot(nx, 1, nzz);
        nx /= len; nzz /= len;
        const ny = 1 / len;
        // I16 normalized:量化步长 2/32767 ≈ 6e-5,肉眼不可见
        nor[k * 3] = Math.round(nx * 32767); nor[k * 3 + 1] = Math.round(ny * 32767); nor[k * 3 + 2] = Math.round(nzz * 32767);
        // 坡度融入颜色(乘法)。山体明暗交给实时光照——不再烘焙静态 hillshade,
        // 否则固定方位的烘焙阴影会与真实太阳方向打架。
        const kIdx = k;
        const slope = Math.hypot((hR - hL) / (2 * dxw), (hU - hD) / (2 * dzw));
        const slopeF = 1 - Math.min(0.38, slope * 0.30);
        const msk = s.maskAtCell(i, j) / 255;
        if (msk > 0) {
          const f = slopeF * (msk < 1 ? 0.6 + 0.4 * msk : 1);
          col[kIdx * 3] = Math.min(255, col[kIdx * 3] * f);
          col[kIdx * 3 + 1] = Math.min(255, col[kIdx * 3 + 1] * f);
          col[kIdx * 3 + 2] = Math.min(255, col[kIdx * 3 + 2] * f);
        }
      }
    }

    // 索引:缓冲带外剔除(maskWide) + 边缘裙边(遮蔽 LOD 接缝)
    // 预分配定长数组(原 number[] 会在每次瓦片重建时产生数十 MB 瞬时垃圾)
    //
    // 索引宽度自适应:顶点数 < 65536 时用 Uint16(省一半索引显存)。
    // LOD0(step=1)的 256×256 瓦片有 66k 顶点,超出 Uint16 上限 → 用 Uint32;
    // 其余档位(≤16.6k 顶点)用 Uint16。
    const quadsX = n - 1, quadsY = m - 1;
    const maxIdx = quadsX * quadsY * 6 + ringCount * 6;
    const useU16 = totalV <= 65535;
    const idxBuf = useU16 ? new Uint16Array(maxIdx) : new Uint32Array(maxIdx);
    let idxN = 0;
    const pushIdx = (a: number, b: number, c: number) => {
      idxBuf[idxN++] = a; idxBuf[idxN++] = b; idxBuf[idxN++] = c;
    };
    for (let mj = 0; mj < quadsY; mj++) {
      for (let mi = 0; mi < quadsX; mi++) {
        const a = mj * n + mi, b = a + 1, d = a + n, e2 = d + 1;
        const cA = ci0 + mi * step, rA = cj0 + mj * step;
        const mA = s.maskWideAtCell(cA, rA);
        const mB = s.maskWideAtCell(ci0 + Math.min((mi + 1) * step, ci1 - ci0), rA);
        const mD = s.maskWideAtCell(cA, cj0 + Math.min((mj + 1) * step, cj1 - cj0));
        const mE = s.maskWideAtCell(ci0 + Math.min((mi + 1) * step, ci1 - ci0), cj0 + Math.min((mj + 1) * step, cj1 - cj0));
        if (mA + mB + mD + mE === 0) continue;
        pushIdx(a, d, b); pushIdx(b, d, e2);
      }
    }
    // 裙边:边缘顶点向下复制(仅缓冲带内),颜色压暗继承(遮蔽 LOD 接缝)
    //
    // 环顶点布局(共 2n + 2(m−2) 个,角点不重复):
    //   上边 (mi,0)     mi=0..n-1        → 0            .. n-1
    //   下边 (mi,m-1)   mi=0..n-1        → n            .. 2n-1
    //   左边 (0,mj)     mj=1..m-2        → 2n           .. 2n+(m-3)
    //   右边 (n-1,mj)   mj=1..m-2        → 2n+(m-2)     .. 2n+2(m-2)-1
    // 注意:**同一侧相邻点的环序号不连续**(左边/右边各自递增,但上边→左边不连续),
    // 因此索引时必须通过 ringIdx() 查表,不能用 sv+1 / sv+n 之类的偏移。
    const ringIdx = (mi: number, mj: number): number => {
      if (mj === 0) return mi;
      if (mj === m - 1) return n + mi;
      if (mi === 0) return 2 * n + (mj - 1);
      return 2 * n + (m - 2) + (mj - 1);
    };
    // 裙边顶点:位置下移 skirt,法线朝上,颜色压暗
    const writeSkirt = (a: number, sv: number) => {
      pos[sv * 3] = pos[a * 3]; pos[sv * 3 + 1] = pos[a * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[a * 3 + 2];
      nor[sv * 3] = 0; nor[sv * 3 + 1] = 32767; nor[sv * 3 + 2] = 0;
      col[sv * 3] = Math.round(col[a * 3] * 0.35); col[sv * 3 + 1] = Math.round(col[a * 3 + 1] * 0.35); col[sv * 3 + 2] = Math.round(col[a * 3 + 2] * 0.35);
      satW[sv] = satW[a];
    };
    for (let mi = 0; mi < n; mi++) {
      for (const mj of [0, m - 1]) {
        const gi = ci0 + mi * step, gj = cj0 + mj * step;
        if (s.maskWideAtCell(gi, gj) === 0) continue;
        const a = mj * n + mi, sv = vCount + ringIdx(mi, mj);
        writeSkirt(a, sv);
        if (mi < n - 1 && s.maskWideAtCell(Math.min(gi + step, cols - 1), gj) !== 0) {
          const b = a + 1, bv = vCount + ringIdx(mi + 1, mj);
          pushIdx(a, sv, b); pushIdx(b, sv, bv);
        }
      }
    }
    for (let mj = 0; mj < m; mj++) {
      for (const mi of [0, n - 1]) {
        const gi = ci0 + mi * step, gj = cj0 + mj * step;
        if (s.maskWideAtCell(gi, gj) === 0) continue;
        const a = mj * n + mi, sv = vCount + ringIdx(mi, mj);
        writeSkirt(a, sv);
        if (mj < m - 1 && s.maskWideAtCell(gi, Math.min(gj + step, rows - 1)) !== 0) {
          const d = a + n, dv = vCount + ringIdx(mi, mj + 1);
          pushIdx(a, d, sv); pushIdx(sv, d, dv);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3, true));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3, true));
    geo.setAttribute('satW', new THREE.BufferAttribute(satW, 1, true));
    geo.setIndex(new THREE.BufferAttribute(idxBuf.subarray(0, idxN), 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    const dt = performance.now() - __t0;
    this.buildStats.built++;
    this.buildStats.total++;
    this.buildStats.lastMs = dt;
    this.buildStats.avgMs = this.buildStats.avgMs * 0.8 + dt * 0.2;
    return mesh;
  }

  /** 运行时调节底图权重(0=纯高程色带,1=纯影像) */
  setSatMix(v: number) {
    if (this.satUniforms) this.satUniforms.uSatMix.value = Math.max(0, Math.min(1, v));
  }
  /** 运行时调节底图饱和度(0=灰度,1=原始) */
  setSatSat(v: number) {
    if (this.satUniforms) this.satUniforms.uSatSat.value = Math.max(0, Math.min(1, v));
  }

  /**
   * 初始构建:两阶段渐进(方案 §33 流畅度)
   *
   * ① 先把**所有**瓦片按最粗档(step16)建出来 —— 36 块 × 289 顶点,几毫秒完成,
   *    首屏立刻出现完整省域(不再有"缺块"的黑区);
   * ② 再把每块瓦片按目标档位排队细化,近处优先(见 tick)。
   *
   * 之前是"直接按目标档位排队",导致 step1 的近景瓦片(66k 顶点)排在前面、
   * 粗档远景瓦片迟迟建不出来 —— 画面长时间只显示几块。
   */
  init(camPos: THREE.Vector3, fovDeg = 50, viewportH = 800) {
    this.lastCam.copy(camPos);
    this.camGroundY = this.sampler.heightAt(camPos.x, camPos.z);
    const tanHalfFov = Math.tan((fovDeg * Math.PI / 180) / 2);
    const cellU = (this.sampler.meta.grid.cellM ?? 218) * this.sampler.meta.world.scale;
    const coarsest = STEP_FOR_LEVEL.length - 1;
    // 阶段 ①:全部先建粗档
    for (const t of this.tiles) {
      t.level = coarsest;
      t.targetLevel = this.levelForDistance(this.tileDistance(t, camPos), cellU, viewportH, tanHalfFov);
      t.pending = -1;
    }
    this.enqueue(this.tiles.slice());
    // 阶段 ②:粗档建完后,按目标档位逐块细化(见 tick 的 refine 队列)
    this.refineQueue = this.tiles.filter(t => t.targetLevel < coarsest);
  }

  /** 阶段 ② 的细化队列(按目标档位由细到粗排序) */
  private refineQueue: Tile[] = [];

  /**
   * 每帧调用:在时间预算内逐瓦片重建,避免多瓦片同帧停顿
   *
   * 先铺粗档(阶段 ①,保证画面完整),再逐块细化(阶段 ②,提升近处细节)。
   */
  tick(maxMs = 7) {
    const t0 = performance.now();
    // 阶段 ①:粗档铺满
    while (this.rebuildQueue.length && performance.now() - t0 < maxMs) {
      const t = this.rebuildQueue.shift()!;
      if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
      t.mesh = this.buildTileMesh(t);
      this.group.add(t.mesh);
    }
    // 阶段 ②:细化(粗档已铺满后才做,避免近处细节挤占首屏时间)
    if (!this.rebuildQueue.length && this.refineQueue.length) {
      while (this.refineQueue.length && performance.now() - t0 < maxMs) {
        const t = this.refineQueue.shift()!;
        t.level = t.targetLevel;
        if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
        t.mesh = this.buildTileMesh(t);
        this.group.add(t.mesh);
      }
    }
  }

  /**
   * 地形几何显存统计(M1 瘦身验收):按属性名汇总字节数
   * 每顶点字节 = (属性总字节)/(顶点数);M1 目标 ≤26 B/顶点(原 88 B)
   */
  geometryBytes(): { total: number; byName: Record<string, number>; vertices: number; bytesPerVertex: number } {
    const byName: Record<string, number> = {};
    let total = 0, vertices = 0;
    for (const t of this.tiles) {
      const g = t.mesh?.geometry;
      if (!g) continue;
      const count = g.getAttribute('position')?.count ?? 0;
      vertices += count;
      for (const [name, attr] of Object.entries(g.attributes)) {
        const bytes = (attr as THREE.BufferAttribute).array.byteLength;
        total += bytes;
        byName[name] = (byName[name] ?? 0) + bytes;
      }
      const idx = g.getIndex();
      if (idx) {
        const bytes = idx.array.byteLength;
        total += bytes;
        byName['index'] = (byName['index'] ?? 0) + bytes;
      }
    }
    return { total, byName, vertices, bytesPerVertex: vertices ? total / vertices : 0 };
  }

  dispose() {
    this.rebuildQueue.length = 0;
    for (const t of this.tiles) if (t.mesh) { t.mesh.geometry.dispose(); }
    this.mat.dispose();
  }
}
