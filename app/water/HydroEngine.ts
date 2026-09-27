// HydroEngine:河流(贴地条带,分级宽度)+ 湖泊/水库(贴地水面)
// 按等级合并为 3 个河流 Mesh + 1 个湖面 Mesh(draw call 预算,方案 §33)
// 河流 Y 与渲染网格逐级一致(meshHeightAt),消除弦线埋没;LOD 分级重建
import * as THREE from 'three';
import earcut from 'earcut';
import type { TerrainSampler } from '../utils/sampler';

interface RiverFeature { n: string; r: number; w: number; p: number[] }
interface LakeFeature { n: string; a: number; surf: number; p: number[] }

export class HydroEngine {
  group = new THREE.Group();
  private riverGroup = new THREE.Group();
  private builtStep = 0;
  private geos: THREE.BufferGeometry[] = [];

  constructor(private sampler: TerrainSampler, private rivers: RiverFeature[], private lakes: LakeFeature[], envTex?: THREE.Texture | null) {
    this.envTex = envTex || null;
    this.group.add(this.riverGroup);
    this.buildLakes();
    this.rebuild(4);
  }

  private envTex: THREE.Texture | null;
  private animatedMats: THREE.MeshStandardMaterial[] = [];

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

  private rebuild(step: number) {
    this.builtStep = step;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    this.riverGroup.clear();
    this.sampler.clearMeshCache();
    const acc: RibbonAcc[] = [new RibbonAcc(), new RibbonAcc(), new RibbonAcc()];
    const sink = [0.006, 0.004, 0.003];
    for (const f of this.rivers) {
      const r = Math.min(3, Math.max(1, f.r));
      const wReal = r === 1 ? 0.055 : r === 2 ? 0.030 : 0.014; // 乌江约 200m,二级 110m,溪流 50m
      acc[r - 1].addStrip(Float32Array.from(f.p), wReal / 2, sink[r - 1], true,
        (x, z) => this.sampler.meshHeightAt(x, z, step));
    }
    for (let r = 0; r < 3; r++) {
      const geo = acc[r].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, this.waterMat(r as 0 | 1 | 2));
      mesh.renderOrder = 2;
      this.riverGroup.add(mesh);
      this.geos.push(geo);
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

class RibbonAcc {
  pos: number[] = [];
  idx: number[] = [];
  vBase = 0;
  addStrip(pts: Float32Array, halfW: number, sink: number, taperEnds: boolean, heightAt: (x: number, z: number) => number) {
    const nPts = pts.length / 2;
    if (nPts < 2) return;
    for (let i = 0; i < nPts; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const xp = i > 0 ? pts[(i - 1) * 2] : x, zp = i > 0 ? pts[(i - 1) * 2 + 1] : z;
      const xn = i < nPts - 1 ? pts[(i + 1) * 2] : x, zn = i < nPts - 1 ? pts[(i + 1) * 2 + 1] : z;
      let tx = xn - xp, tz = zn - zp;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const nx = -tz, nz = tx;
      const y = heightAt(x, z) - sink;
      const taper = taperEnds && (i === 0 || i === nPts - 1) ? 0.55 : 1;
      const hw = halfW * taper;
      this.pos.push(x + nx * hw, y, z + nz * hw);
      this.pos.push(x - nx * hw, y, z - nz * hw);
      if (i > 0) {
        const a = this.vBase + (i - 1) * 2, b = this.vBase + i * 2;
        this.idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    this.vBase += nPts * 2;
  }
  build(): THREE.BufferGeometry | null {
    if (!this.idx.length) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setIndex(this.idx);
    geo.computeVertexNormals();
    geo.computeBoundingSphere();
    return geo;
  }
}
