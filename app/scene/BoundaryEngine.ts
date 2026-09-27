// BoundaryEngine:省界(明显条带)/ 市州界(淡)/ 县界(默认关,近距离显示)
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';

export class BoundaryEngine {
  group = new THREE.Group();
  private countyLines = new THREE.Group();
  private prefectureLines = new THREE.Group();

  constructor(private sampler: TerrainSampler, data: { province: number[]; prefectures: { n: string; p: number[] }[]; counties: { n: string; c: number[] | null; p: number[] }[] }, enabled = true) {
    if (!enabled) return;
    this.buildProvince(data.province);
    // 市州界 / 县界:合并为单一线段集(draw call 预算)
    for (const [src, target] of [[data.prefectures.map(p => p.p), this.prefectureLines], [data.counties.filter(c => c.p.length > 8).map(c => c.p), this.countyLines]] as const) {
      const pos: number[] = [];
      for (const poly of src) {
        const n = poly.length / 2;
        for (let i = 0; i < n; i++) {
          const x = poly[i * 2], z = poly[i * 2 + 1];
          pos.push(x, this.sampler.heightAt(x, z) + 0.03, z);
          const j = (i + 1) % n;
          const x2 = poly[j * 2], z2 = poly[j * 2 + 1];
          pos.push(x2, this.sampler.heightAt(x2, z2) + 0.03, z2);
        }
      }
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      const line = new THREE.LineSegments(geo, new THREE.LineBasicMaterial({
        color: 0xf2f6f8, transparent: true, opacity: 0.15,
        polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
      }));
      line.renderOrder = 3;
      target.add(line);
    }
    this.countyLines.visible = false;
    this.group.add(this.prefectureLines, this.countyLines);
  }

  private buildProvince(pts: number[]) {
    const s = this.sampler;
    const n = pts.length / 2;
    const pos: number[] = [];
    const idx: number[] = [];
    const halfW = 0.16;
    const lift = 0.10;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      const xp = i > 0 ? pts[(i - 1) * 2] : x, zp = i > 0 ? pts[(i - 1) * 2 + 1] : z;
      const xn = i < n - 1 ? pts[(i + 1) * 2] : x, zn = i < n - 1 ? pts[(i + 1) * 2 + 1] : z;
      let tx = xn - xp, tz = zn - zp;
      const l = Math.hypot(tx, tz) || 1;
      tx /= l; tz /= l;
      const nx = -tz, nz = tx;
      const y = s.heightAt(x, z) + lift;
      pos.push(x + nx * halfW, y, z + nz * halfW);
      pos.push(x - nx * halfW, y, z - nz * halfW);
      if (i > 0) {
        const a = (i - 1) * 2, b = i * 2;
        idx.push(a, a + 1, b, b, a + 1, b + 1);
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    geo.setIndex(idx);
    geo.computeVertexNormals();
    const mat = new THREE.MeshBasicMaterial({ color: 0x2c3138, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    this.group.add(mesh);
  }

  private buildSimpleLine(group: THREE.Group, pts: number[], lift: number) {
    const s = this.sampler;
    const n = pts.length / 2;
    const pos: number[] = [];
    for (let i = 0; i < n; i++) {
      const x = pts[i * 2], z = pts[i * 2 + 1];
      pos.push(x, s.heightAt(x, z) + lift, z);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    const line = new THREE.Line(geo, new THREE.LineBasicMaterial({
      color: 0xf2f6f8, transparent: true, opacity: 0.16,
      polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3
    }));
    line.renderOrder = 3;
    group.add(line);
  }

  update(camDist: number) {
    this.countyLines.visible = camDist < 26;
  }
}
