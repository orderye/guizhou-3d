// TerrainEngine:分块 LOD 地形 + 边界裁剪 + 高程夸张 + 高程分层色/Hillshade/坡度着色
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';

export const TILE_CELLS = 512; // 每 tile 覆盖的格元数

interface Tile {
  ti: number; tj: number;
  level: number;           // 0=最细(step1) 3=最粗(step16)
  pending: number;         // 磁滞候选级别
  pendingSince: number;
  mesh: THREE.Mesh | null;
  center: THREE.Vector3;
}

const STEP_FOR_LEVEL = [1, 2, 4, 16];

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

function elevColor(e: number, out: THREE.Color) {
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

// Hillshade(az=315°, alt=45°)由法线计算
function hillshade(nx: number, ny: number, nz: number): number {
  // 太阳方向(315° 方位,45° 高度):与场景方向光一致
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const sx = Math.sin(az) * Math.cos(alt);
  const sy = Math.cos(az) * Math.cos(alt);
  const sz = Math.sin(alt);
  const d = nx * sx + ny * sy + nz * sz;
  return Math.max(0.32, Math.min(1.16, 0.34 + 0.92 * d));
}

export class TerrainEngine {
  group = new THREE.Group();
  private tiles: Tile[] = [];
  private mat: THREE.MeshStandardMaterial;
  private tcols = 0; private trows = 0;
  private baseLowY = 0;
  private forest: { dens: Uint8Array; cols: number; rows: number; cell: number; fx0: number; fy0: number } | null = null;
  private riverTint: Uint8Array | null = null;

  constructor(private sampler: TerrainSampler, enabled = true, forestData?: { bin: ArrayBuffer; meta: { cols: number; rows: number; cell: number; originX: number; originY: number } }, riverTintBin?: ArrayBuffer) {
    this.mat = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.96,
      metalness: 0.0
    });
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

  /** 块平均高程(LOD 平滑,避免稀疏采样混叠成尖刺) */
  private avgElev(i: number, j: number, s: number): number {
    if (s <= 1) return this.sampler.elevAtCell(i, j);
    const r = s >> 1;
    const { cols, rows } = this.sampler.meta.grid;
    const i0 = Math.max(0, i - r), i1 = Math.min(cols - 1, i + r - 1);
    const j0 = Math.max(0, j - r), j1 = Math.min(rows - 1, j + r - 1);
    let sum = 0, n = 0;
    for (let jj = j0; jj <= j1; jj++) for (let ii = i0; ii <= i1; ii++) {
      sum += this.sampler.elevAtCell(ii, jj); n++;
    }
    return n ? sum / n : 0;
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
        const x0 = this.sampler.colX[ci0], x1 = this.sampler.colX[ci1];
        const z0 = this.sampler.rowZ[cj0], z1 = this.sampler.rowZ[cj1];
        const cxs = (x0 + x1) / 2, czs = (z0 + z1) / 2;
        const cy = this.sampler.heightAt(cxs, czs);
        this.tiles.push({
          ti, tj, level: 3, pending: -1, pendingSince: 0, mesh: null,
          center: new THREE.Vector3(cxs, cy, czs)
        });
      }
    }
  }

  private rebuildQueue: Tile[] = [];
  private lastCam = new THREE.Vector3();

  levelFor(d: number): number {
    if (d > 64) return 3;
    if (d > 30) return 2;
    if (d > 12) return 1;
    return 0;
  }

  /** 相机更新(节流调用):LOD 磁滞判定,变更瓦片入重建队列(方案 §33 流畅度) */
  update(camPos: THREE.Vector3) {
    this.lastCam.copy(camPos);
    const now = performance.now();
    const changed: Tile[] = [];
    for (const t of this.tiles) {
      const want = this.levelFor(camPos.distanceTo(t.center));
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
  }

  /** 入队(去重)并按相机距离排序——近者优先重建 */
  private enqueue(tiles: Tile[]) {
    const inQueue = new Set(this.rebuildQueue);
    for (const t of tiles) if (!inQueue.has(t)) this.rebuildQueue.push(t);
    this.rebuildQueue.sort((a, b) =>
      a.center.distanceToSquared(this.lastCam) - b.center.distanceToSquared(this.lastCam));
  }

  /** 每帧调用:在时间预算内逐瓦片重建,避免多瓦片同帧停顿 */
  tick(maxMs = 7) {
    if (!this.rebuildQueue.length) return;
    const t0 = performance.now();
    while (this.rebuildQueue.length && performance.now() - t0 < maxMs) {
      const t = this.rebuildQueue.shift()!;
      if (t.mesh) { this.group.remove(t.mesh); t.mesh.geometry.dispose(); t.mesh = null; }
      t.mesh = this.buildTileMesh(t);
      this.group.add(t.mesh);
    }
  }

  private buildTileMesh(t: Tile): THREE.Mesh {
    const s = this.sampler;
    const { cols, rows } = s.meta.grid;
    const step = STEP_FOR_LEVEL[t.level];
    const ci0 = t.ti * TILE_CELLS, cj0 = t.tj * TILE_CELLS;
    const ci1 = Math.min(ci0 + TILE_CELLS, cols - 1); // 含端点
    const cj1 = Math.min(cj0 + TILE_CELLS, rows - 1);
    const n = Math.floor((ci1 - ci0) / step) + 1;
    const m = Math.floor((cj1 - cj0) / step) + 1;
    const vCount = n * m;
    const skirt = 0.6;
    const totalV = vCount * 2; // 主体 + 裙边(边缘顶点复制)
    const pos = new Float32Array(totalV * 3);
    const nor = new Float32Array(totalV * 3);
    const col = new Float32Array(totalV * 3);
    const c = new THREE.Color();

    const heightCache = new Float32Array(vCount);
    let k = 0;
    for (let mj = 0; mj < m; mj++) {
      const j = cj0 + mj * step;
      for (let mi = 0; mi < n; mi++, k++) {
        const i = ci0 + mi * step;
        const x = s.colX[i], z = s.rowZ[j];
        const e = this.avgElev(i, j, step);
        const msk = s.maskAtCell(i, j) / 255;
        // 省界外缘下沉过渡(Edge Fade,方案 §7),与 sampler 一致
        const yRaw = s.visualY(e);
        let y = msk >= 0.5 ? yRaw : s.baseLowY + (yRaw - s.baseLowY) * (msk * 2);
        // 近景微地形细节(程序化视觉增强):LOD 分级衰减,与 meshHeightAt 同公式
        const fade = s.detailFadeFor(step);
        if (fade > 0) y += s.detailWorld(x, z, fade);
        pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
        heightCache[k] = y;

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
        col[k * 3] = r; col[k * 3 + 1] = g; col[k * 3 + 2] = b;
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
        const dxw = (Math.abs(s.colX[Math.min(ci0 + iR * step, cols - 1)] - s.colX[Math.max(ci0 + iL * step, 0)]) || 1e-4);
        const dzw = (Math.abs(s.rowZ[Math.min(cj0 + jU * step, rows - 1)] - s.rowZ[Math.max(cj0 + jD * step, 0)]) || 1e-4);
        let nx = (hL - hR) / (2 * dxw);
        let nzz = (hD - hU) / (2 * dzw);
        const len = Math.hypot(nx, 1, nzz);
        nx /= len; nzz /= len;
        const ny = 1 / len;
        nor[k * 3] = nx; nor[k * 3 + 1] = ny; nor[k * 3 + 2] = nzz;
        // hillshade 与坡度融入颜色(乘法)
        const kIdx = k;
        const slope = Math.hypot((hR - hL) / (2 * dxw), (hU - hD) / (2 * dzw));
        const slopeF = 1 - Math.min(0.38, slope * 0.30);
        const hs = hillshade(nx, ny, nzz);
        const msk = s.maskAtCell(i, j) / 255;
        if (msk > 0) {
          const f = slopeF * hs * (msk < 1 ? 0.6 + 0.4 * msk : 1);
          col[kIdx * 3] *= f; col[kIdx * 3 + 1] *= f; col[kIdx * 3 + 2] *= f;
        }
      }
    }

    // 索引:缓冲带外剔除(maskWide) + 边缘裙边(遮蔽 LOD 接缝)
    const quadsX = n - 1, quadsY = m - 1;
    const idx: number[] = [];
    for (let mj = 0; mj < quadsY; mj++) {
      for (let mi = 0; mi < quadsX; mi++) {
        const a = mj * n + mi, b = a + 1, d = a + n, e2 = d + 1;
        const mA = s.maskWideAtCell(ci0 + mi * step, cj0 + mj * step);
        const mB = s.maskWideAtCell(ci0 + Math.min((mi + 1) * step, ci1 - ci0), cj0 + mj * step);
        const mD = s.maskWideAtCell(ci0 + mi * step, cj0 + Math.min((mj + 1) * step, cj1 - cj0));
        const mE = s.maskWideAtCell(ci0 + Math.min((mi + 1) * step, ci1 - ci0), cj0 + Math.min((mj + 1) * step, cj1 - cj0));
        if (mA + mB + mD + mE === 0) continue;
        idx.push(a, d, b, b, d, e2);
      }
    }
    // 裙边:边缘顶点向下复制(仅缓冲带内),颜色压暗继承(遮蔽 LOD 接缝)
    for (let mi = 0; mi < n; mi++) {
      for (const mj of [0, m - 1]) {
        const gi = ci0 + mi * step, gj = cj0 + mj * step;
        if (s.maskWideAtCell(gi, gj) === 0) continue;
        const a = mj * n + mi, sv = vCount + mj * n + mi;
        pos[sv * 3] = pos[a * 3]; pos[sv * 3 + 1] = pos[a * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[a * 3 + 2];
        nor[sv * 3] = 0; nor[sv * 3 + 1] = 1; nor[sv * 3 + 2] = 0;
        col[sv * 3] = col[a * 3] * 0.35; col[sv * 3 + 1] = col[a * 3 + 1] * 0.35; col[sv * 3 + 2] = col[a * 3 + 2] * 0.35;
        if (mi < n - 1 && s.maskWideAtCell(Math.min(gi + step, cols - 1), gj) !== 0) {
          const b = a + 1, bv = sv + 1;
          idx.push(a, sv, b, b, sv, bv);
        }
      }
    }
    for (let mj = 0; mj < m; mj++) {
      for (const mi of [0, n - 1]) {
        const gi = ci0 + mi * step, gj = cj0 + mj * step;
        if (s.maskWideAtCell(gi, gj) === 0) continue;
        const a = mj * n + mi, sv = vCount + mj * n + mi;
        pos[sv * 3] = pos[a * 3]; pos[sv * 3 + 1] = pos[a * 3 + 1] - skirt; pos[sv * 3 + 2] = pos[a * 3 + 2];
        nor[sv * 3] = 0; nor[sv * 3 + 1] = 1; nor[sv * 3 + 2] = 0;
        col[sv * 3] = col[a * 3] * 0.35; col[sv * 3 + 1] = col[a * 3 + 1] * 0.35; col[sv * 3 + 2] = col[a * 3 + 2] * 0.35;
        if (mj < m - 1 && s.maskWideAtCell(gi, Math.min(gj + step, rows - 1)) !== 0) {
          const d = a + n, dv = sv + n;
          idx.push(a, d, sv, sv, d, dv);
        }
      }
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, this.mat);
    mesh.frustumCulled = true;
    mesh.receiveShadow = true;
    return mesh;
  }

  /** 初始构建 */
  /** 初始构建:目标级别直接入队,渲染循环渐进生成(配合 intro 缓降无停顿) */
  init(camPos: THREE.Vector3) {
    this.lastCam.copy(camPos);
    for (const t of this.tiles) {
      t.level = this.levelFor(camPos.distanceTo(t.center));
      t.pending = -1;
    }
    this.enqueue(this.tiles.slice());
  }

  dispose() {
    this.rebuildQueue.length = 0;
    for (const t of this.tiles) if (t.mesh) { t.mesh.geometry.dispose(); }
    this.mat.dispose();
  }
}
