// HydroEngine:河流(分段水平水面)+ 湖泊/水库(水平水面)
// 静止水体在谷中是水平的:每段水面在段内严格水平,段间由跌水面衔接 → 梯级河。
// 河床由地形侧下切提供(terrain/valley.bin,沟底削平到真实水位),水面即躺在沟中。
// 水位序列为真实高程(米),由预处理离线生成(rivers/riverbed.bin),与垂直夸张无关。
import * as THREE from 'three';
import earcut from 'earcut';
import type { TerrainSampler } from '../utils/sampler';

interface LakeFeature { n: string; a: number; surf: number; p: number[] }

/** riverbed.bin 解析结果:各河的采样点坐标与水位(米) */
export interface Riverbed {
  count: number;
  offsets: Uint32Array;
  rank: Uint8Array;
  x: Float32Array;
  z: Float32Array;
  water: Uint16Array;
  width: Uint8Array;   // 逐点允许走廊半宽(米/2,曲率限幅)
}

/** 解析 riverbed.bin:magic|count|total|offsets[count+1]|x[f32]|z[f32]|water[u16]|rank[u8] */
export function parseRiverbed(buf: ArrayBuffer): Riverbed {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x42445256) throw new Error('riverbed.bin 格式错误');
  const count = dv.getUint32(4, true);
  const total = dv.getUint32(8, true);
  const offOff = 12;
  const xOff = offOff + (count + 1) * 4;
  const zOff = xOff + total * 4;
  const wOff = zOff + total * 4;
  const dOff = wOff + total * 2;
  const rOff = dOff + total;
  return {
    count,
    offsets: new Uint32Array(buf, offOff, count + 1),
    x: new Float32Array(buf, xOff, total),
    z: new Float32Array(buf, zOff, total),
    water: new Uint16Array(buf, wOff, total),
    width: new Uint8Array(buf, dOff, total),
    rank: new Uint8Array(buf, rOff, count)
  };
}

// 河宽(世界单位):一/二/三级
const RIVER = [
  { win: 0.100 },
  { win: 0.055 },
  { win: 0.028 }
];
// 段抽稀(按等级):一级河用密采样(110m)保证水面不偏离沟心;
// 二/三级河受 218m DEM 分辨率限制,段长可放粗
const STRIDE = [1, 2, 2];

export class HydroEngine {
  group = new THREE.Group();
  private riverGroup = new THREE.Group();
  private builtStep = 0;
  private geos: THREE.BufferGeometry[] = [];
  private animatedMats: THREE.MeshStandardMaterial[] = [];
  private envTex: THREE.Texture | null;

  constructor(private sampler: TerrainSampler, private bed: Riverbed, private lakes: LakeFeature[], envTex?: THREE.Texture | null) {
    this.envTex = envTex || null;
    this.group.add(this.riverGroup);
    this.buildLakes();
    this.rebuild(4);
  }

  /** 分层水面 Standard 材质(带天空环境反射 + 流光动画,方案 §22) */
  private waterMat(rank: 0 | 1 | 2): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: rank === 0 ? 0x1d4f78 : rank === 1 ? 0x2b6a95 : 0x3d7fa6,
      roughness: 0.10, metalness: 0.0,
      envMap: this.envTex || undefined,
      envMapIntensity: 1.15,
      transparent: true, opacity: rank === 0 ? 0.95 : rank === 1 ? 0.92 : 0.85,
      polygonOffset: true, polygonOffsetFactor: -2 - rank, polygonOffsetUnits: -2 - rank
    });
    this.addSparkle(m, rank === 0 ? 0.30 : 0.22);
    return m;
  }

  /** 跌水/白沫面:段间落差的竖直面 */
  private fallMat(): THREE.MeshStandardMaterial {
    return new THREE.MeshStandardMaterial({
      color: 0xbcd6e4, roughness: 0.45, metalness: 0.0,
      envMap: this.envTex || undefined, envMapIntensity: 0.8,
      transparent: true, opacity: 0.88,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
  }

  private lakeMat(): THREE.MeshStandardMaterial {
    const m = new THREE.MeshStandardMaterial({
      color: 0x2e6f9c, roughness: 0.08, metalness: 0.0,
      envMap: this.envTex || undefined,
      envMapIntensity: 1.25,
      transparent: true, opacity: 0.94,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    this.addSparkle(m, 0.26);
    return m;
  }

  /** 注入时间驱动的流光波纹(发射项),材质注册到 animatedMats 供主循环更新 */
  private addSparkle(m: THREE.MeshStandardMaterial, strength: number) {
    m.onBeforeCompile = (shader) => {
      shader.uniforms.uTime = { value: 0 };
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
        .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;\nuniform float uTime;')
        .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec2 p = vWPos.xz * 42.0;
          float sp = sin(p.x * 3.1 + uTime * 2.1) * sin(p.y * 2.7 - uTime * 1.7) * sin((p.x + p.y) * 1.9 + uTime * 0.9);
          totalEmissiveRadiance += vec3(0.34, 0.50, 0.60) * smoothstep(0.62, 1.0, sp) * ${strength.toFixed(2)};
        }`);
      m.userData.shader = shader;
      this.animatedMats.push(m);
    };
  }

  /** 主循环调用:推进流光时间 */
  tick(t: number) {
    for (const m of this.animatedMats) {
      const sh = m.userData.shader;
      if (sh) sh.uniforms.uTime.value = t;
    }
  }

  /** 距离带磁滞切换(进出阈值分离,防抖动);远景隐藏(地形烙印替代) */
  update(camDist: number) {
    const want = this.bandFor(camDist, this.builtStep);
    this.group.visible = camDist < 70;
    if (want !== this.builtStep) this.rebuild(want);
  }

  private bandFor(d: number, cur: number): number {
    // 进出阈值分离:1↔2 边界 12/15,2↔4 边界 30/38
    if (cur === 4 && d < 30) return 2;
    if (cur === 2) { if (d < 12) return 1; if (d > 38) return 4; }
    if (cur === 1 && d > 15) return 2;
    return cur;
  }

  /** 重建河流:按等级生成水平水面 + 跌水衔接面 */
  private rebuild(step: number) {
    this.builtStep = step;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    this.riverGroup.clear();
    const strideBase = step;
    const water = [new QuadAcc(), new QuadAcc(), new QuadAcc()];
    const fall = new QuadAcc();

    for (let r = 0; r < this.bed.count; r++) {
      const rank = this.bed.rank[r] - 1;
      if (rank < 0 || rank > 2) continue;
      const s = this.bed.offsets[r], e = this.bed.offsets[r + 1];
      if (e - s < 2) continue;
      const cfg = RIVER[rank];
      const hw = cfg.win * 0.5;

      // 段端点索引(按 stride 抽稀,末尾点必取且不重复)
      const stride = strideBase * STRIDE[rank];
      const ends: number[] = [];
      for (let i = s; i < e - 1; i += stride) ends.push(i);
      if (!ends.length || ends[ends.length - 1] !== e - 1) ends.push(e - 1);
      if (ends.length < 2) continue;

      // 采样点视觉高程(米→视觉)
      const yOf = (i: number) => this.sampler.visualY(this.bed.water[i]);
      // 流向:水位序列本身单调,若首端低于末端则该河在数组中上游在后 → 反向取用
      // 流向:水位序列本身单调,若首端低于末端则该河在数组中上游在后 → 反向取用
      const rev = yOf(ends[ends.length - 1]) > yOf(ends[0]);
      const ord: number[] = rev ? ends.slice().reverse() : ends;

      // 每个采样点的切向法向(水平面内):n = (t.z, -t.x)
      const nx = new Float64Array(ord.length), nz = new Float64Array(ord.length);
      for (let k = 0; k < ord.length; k++) {
        const ia = ord[Math.max(0, k - 1)], ib = ord[Math.min(ord.length - 1, k + 1)];
        let tx = this.bed.x[ib] - this.bed.x[ia], tz = this.bed.z[ib] - this.bed.z[ia];
        const tl = Math.hypot(tx, tz) || 1;
        tx /= tl; tz /= tl;
        nx[k] = tz; nz[k] = -tx;
      }

      // 逐段生成:段内水面水平,高度取段末水位(序列单调 → 段间严格下降)
      let prevH = 0, hasPrev = false;
      for (let k = 0; k < ord.length - 1; k++) {
        const i0 = ord[k], i1 = ord[k + 1];
        const h = yOf(i1);
        const taper0 = k === 0 ? 0.55 : 1;
        const taper1 = k === ord.length - 2 ? 0.55 : 1;
        const x0 = this.bed.x[i0], z0 = this.bed.z[i0];
        const x1 = this.bed.x[i1], z1 = this.bed.z[i1];
        const w0 = hw * taper0, w1 = hw * taper1;
        water[rank].addQuad(
          x0 + nx[k] * w0, z0 + nz[k] * w0,
          x0 - nx[k] * w0, z0 - nz[k] * w0,
          x1 + nx[k + 1] * w1, z1 + nz[k + 1] * w1,
          x1 - nx[k + 1] * w1, z1 - nz[k + 1] * w1,
          h, h, 0, 1, 0
        );
        // 跌水面:前段水面 → 本段水面(竖直,法线朝上游)
        if (hasPrev && prevH - h > 0.002) {
          const ip = ord[k - 1];
          let ux = this.bed.x[ip] - x0, uz = this.bed.z[ip] - z0;
          const ul = Math.hypot(ux, uz) || 1;
          ux /= ul; uz /= ul;
          fall.addQuad(
            x0 + nx[k] * w0, z0 + nz[k] * w0,
            x0 - nx[k] * w0, z0 - nz[k] * w0,
            x0 + nx[k] * w0, z0 + nz[k] * w0,
            x0 - nx[k] * w0, z0 - nz[k] * w0,
            h, prevH, ux, 0, uz
          );
        }
        prevH = h; hasPrev = true;
      }
    }

    for (let r = 0; r < 3; r++) {
      const geo = water[r].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.waterMat(r as 0 | 1 | 2));
      mesh.renderOrder = 2;
      this.riverGroup.add(mesh);
      this.geos.push(geo);
    }
    const fg = fall.build();
    if (fg) {
      const mesh = new THREE.Mesh(fg, this.fallMat());
      mesh.renderOrder = 3;
      this.riverGroup.add(mesh);
      this.geos.push(fg);
    }
  }

  private buildLakes() {
    if (!this.lakes.length) return;
    const pos: number[] = [];
    const idx: number[] = [];
    let vBase = 0;
    for (const f of this.lakes) {
      const vCount = f.p.length / 2;
      if (vCount < 3) continue;
      const surfY = this.sampler.visualY(f.surf);
      for (let i = 0; i < vCount; i++) {
        const tY = this.sampler.heightAt(f.p[i * 2], f.p[i * 2 + 1]);
        const y = Math.min(surfY, tY + 0.01);
        pos.push(f.p[i * 2], Math.max(y, surfY - 0.12), f.p[i * 2 + 1]);
      }
      const tris = earcut(f.p);
      for (const t of tris) idx.push(t + vBase);
      vBase += vCount;
    }
    if (!idx.length) return;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, this.lakeMat());
    mesh.renderOrder = 2;
    this.group.add(mesh);
    this.geos.push(geo);
  }
}

/** 水平四边形累加器(yLo/yHi 相等时为水平面,不等时为竖直跌水面) */
class QuadAcc {
  pos: number[] = [];
  nor: number[] = [];
  idx: number[] = [];
  vBase = 0;
  /**
   * @param lx0,lz0 左前点  @param rx0,rz0 右前点  @param lx1,lz1 左后点  @param rx1,rz1 右后点
   * @param yLo 低面高度 @param yHi 高面高度(==yLo 即水平面)
   * @param nx,ny,nz 该面法线
   */
  addQuad(lx0: number, lz0: number, rx0: number, rz0: number,
          lx1: number, lz1: number, rx1: number, rz1: number,
          yLo: number, yHi: number, nx: number, ny: number, nz: number) {
    const b = this.vBase;
    // 水平面:yLo==yHi → 四点同高;跌水面 → 前两点高、后两点低
    this.pos.push(lx0, yHi, lz0, rx0, yHi, rz0, lx1, yLo, lz1, rx1, yLo, rz1);
    for (let i = 0; i < 4; i++) this.nor.push(nx, ny, nz);
    if (yHi === yLo) {
      // 水平面:绕序使法线朝上
      this.idx.push(b, b + 1, b + 2, b + 1, b + 3, b + 2);
    } else {
      // 竖直跌水面:绕序使法线朝上游
      this.idx.push(b, b + 2, b + 3, b, b + 3, b + 1);
    }
    this.vBase += 4;
  }

  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setIndex(this.idx);
    geo.computeBoundingSphere();
    return geo;
  }
}
