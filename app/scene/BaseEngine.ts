// BaseEngine:实体沙盘底座(方案 §28)—— 省界垂直裙墙 + 基座外沿
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';

export class BaseEngine {
  group = new THREE.Group();
  baseY: number;

  constructor(private sampler: TerrainSampler, provincePts: number[]) {
    // 与 sampler 一致(方案 §28)
    this.baseY = sampler.baseY;
    this.buildWall(provincePts);
    this.buildPlinth(provincePts);
    this.buildGround();
  }

  private buildWall(pts: number[]) {
    const s = this.sampler;
    const n = pts.length / 2;
    const pos: number[] = [];
    const col: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const top = s.heightAt(x, z);
      pos.push(x, top + 0.05, z);
      // 层状岩色(按深度条带)
      const depth = (top - this.baseY);
      pos.push(x, this.baseY, z);
      const shade = 0.14 + 0.03 * Math.sin(i * 0.7);
      col.push(0.30, 0.28, 0.26, shade, shade * 0.92, shade * 0.82);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 2, a + 1, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    this.group.add(new THREE.Mesh(geo, mat));
  }

  private buildPlinth(pts: number[]) {
    // 底座外沿:统一按环向一致性偏移(避免凹段方向翻转穿模)
    const n = pts.length / 2;
    const off = 0.7;
    // 环向有向面积决定法线朝向
    let area = 0;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      area += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
    }
    const ccw = area > 0; // (x,z) 平面逆时针
    const pos: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i < n; i++) {
      const p0 = i > 0 ? i - 1 : n - 1, p1 = i < n - 1 ? i + 1 : 0;
      let tx = pts[p1 * 2] - pts[p0 * 2], tz = pts[p1 * 2 + 1] - pts[p0 * 2 + 1];
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      // 一致朝外的一侧法线
      const nx = ccw ? tz : -tz;
      const nz = ccw ? -tx : tx;
      pos.push(pts[i * 2], this.baseY + 0.02, pts[i * 2 + 1]);
      pos.push(pts[i * 2] + nx * off, this.baseY - 0.5, pts[i * 2 + 1] + nz * off);
    }
    for (let i = 0; i < n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshLambertMaterial({ color: 0x191b1f, side: THREE.DoubleSide });
    this.group.add(new THREE.Mesh(geo, mat));
  }

  private buildGround() {
    // 底部深色地面(轻微承接阴影感)
    const g = new THREE.CircleGeometry(88, 48);
    const mat = new THREE.MeshLambertMaterial({ color: 0x0b0d10 });
    const m = new THREE.Mesh(g, mat);
    m.rotation.x = -Math.PI / 2;
    m.position.y = this.baseY - 0.52;
    this.group.add(m);
  }
}
