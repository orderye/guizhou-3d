// RoadEngine:高速/国道/省道(贴地条带,方案 §27)
// 按等级合并为 2 个 Mesh;贴地与渲染网格逐级一致(surfaceHeightAt),LOD 分级重建
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';

interface RoadFeature { c: number; p: number[] }

export class RoadEngine {
  group = new THREE.Group();
  private roadGroup = new THREE.Group();
  private builtStep = 0;
  private matC1!: THREE.MeshLambertMaterial;
  private matC2!: THREE.MeshLambertMaterial;
  private geos: THREE.BufferGeometry[] = [];

  constructor(private sampler: TerrainSampler, private roads: RoadFeature[], enabled = true) {
    if (!enabled) return;
    this.matC1 = new THREE.MeshLambertMaterial({
      color: 0xd9c98a, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    });
    this.matC2 = new THREE.MeshLambertMaterial({
      color: 0xc9cbc2, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    this.group.add(this.roadGroup);
    this.rebuild(4);
  }

  update(camDist: number) {
    if (!this.matC1) return;
    // 距离带磁滞(进出阈值分离,防抖动)
    let want = this.builtStep;
    if (this.builtStep === 4 && camDist < 30) want = 2;
    else if (this.builtStep === 2) { if (camDist < 12) want = 1; else if (camDist > 38) want = 4; }
    else if (this.builtStep === 1 && camDist > 15) want = 2;
    if (want !== this.builtStep) this.rebuild(want);
  }

  private rebuild(step: number) {
    this.builtStep = step;
    for (const g of this.geos) g.dispose();
    this.geos = [];
    this.roadGroup.clear();
    this.sampler.clearMeshCache();
    const acc: RibbonAcc[] = [new RibbonAcc(), new RibbonAcc(), new RibbonAcc()];
    const halfW = [0.011, 0.007, 0.0045]; // 高速走廊 ~85m / 国省道 ~55m / 主要省道 ~35m
    const lift = [0.006, 0.004, 0.003];
    for (const f of this.roads) {
      const k = f.c === 1 ? 0 : f.c === 2 ? 1 : 2;
      acc[k].addStrip(Float32Array.from(f.p), halfW[k], -lift[k],
        (x, z) => this.sampler.surfaceHeightAt(x, z, step));
    }
    const matC3 = new THREE.MeshLambertMaterial({
      color: 0xbfc2ba, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    });
    const mats = [this.matC1, this.matC2, matC3];
    for (let k = 0; k < 3; k++) {
      const geo = acc[k].build();
      if (!geo) continue;
      const mesh = new THREE.Mesh(geo, mats[k]);
      mesh.renderOrder = 1;
      this.roadGroup.add(mesh);
      this.geos.push(geo);
    }
  }
}

class RibbonAcc {
  pos: number[] = [];
  idx: number[] = [];
  vBase = 0;
  addStrip(pts: Float32Array, halfW: number, sink: number, heightAt: (x: number, z: number) => number) {
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
      this.pos.push(x + nx * halfW, y, z + nz * halfW);
      this.pos.push(x - nx * halfW, y, z - nz * halfW);
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
