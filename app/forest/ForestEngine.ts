// ForestEngine:InstancedMesh 森林(方案 §16-18)
// 密度来自预处理:OSM 真实林地为主 + 地形/水系/城市约束
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';
import { mulberry32 } from '../terrain/noise';

interface ForestMeta { cols: number; rows: number; cell: number; originX: number; originY: number }

// 4 种树/灌木几何(低模,合并约 20-30 三角形)
function coneTree(radius: number, height: number, color: number): THREE.BufferGeometry {
  const g1 = new THREE.ConeGeometry(radius, height, 6);
  g1.translate(0, height / 2, 0);
  const g2 = new THREE.CylinderGeometry(radius * 0.12, radius * 0.16, height * 0.3, 5);
  g2.translate(0, height * 0.15, 0);
  const geo = mergeGeoms([g1, g2]);
  const c = new THREE.Color(color);
  const cnt = geo.attributes.position.count;
  const cols = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) { cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return geo;
}

function shrub(radius: number, color: number): THREE.BufferGeometry {
  const g = new THREE.IcosahedronGeometry(radius, 0);
  g.scale(1, 0.7, 1);
  g.translate(0, radius * 0.55, 0);
  const c = new THREE.Color(color);
  const cnt = g.attributes.position.count;
  const cols = new Float32Array(cnt * 3);
  for (let i = 0; i < cnt; i++) { cols[i * 3] = c.r; cols[i * 3 + 1] = c.g; cols[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(cols, 3));
  return g;
}

function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  // 轻量合并(仅 position/normal/color,非索引化)
  const pos: number[] = [], nor: number[] = [], col: number[] = [];
  for (const g of geoms) {
    const ng = g.toNonIndexed();
    const p = ng.attributes.position.array as Float32Array;
    const n = ng.attributes.normal.array as Float32Array;
    const c = ng.attributes.color ? ng.attributes.color.array as Float32Array : null;
    for (let i = 0; i < p.length; i++) {
      pos.push(p[i]); nor.push(n[i]);
      if (c) col.push(c[i]); else col.push(0.5);
    }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

export class ForestEngine {
  group = new THREE.Group();
  private meshes: THREE.InstancedMesh[] = [];
  private swayShader: { uniforms: { uTime: { value: number } } } | undefined;

  /** 树顶风摆(时间驱动,幅度随树高) */
  tick(t: number) {
    if (this.swayShader) this.swayShader.uniforms.uTime.value = t;
  }

  /** 远景隐藏树网(显隐磁滞防抖动),近景显示 */
  update(camDist: number) {
    if (!this.group.visible && camDist < 40) this.group.visible = true;
    else if (this.group.visible && camDist > 47) this.group.visible = false;
  }

  constructor(
    private sampler: TerrainSampler,
    forestBin: ArrayBuffer,
    meta: ForestMeta,
    enabled = true,
    maxTrees = 150000,
    densityScale = 1
  ) {
    if (!enabled) return;
    const dens = new Uint8Array(forestBin);
    const { cols, rows, cell, originX, originY } = meta;

    // 收集候选(分组:3×3 宏区域,利于视锥剔除)
    interface Cand { x: number; z: number; y: number; s: number; type: number; g: number }
    const cands: Cand[] = [];
    const rng = mulberry32(88);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const d = dens[r * cols + c];
        if (d < 20) continue;
        const px = originX + (c + 0.5) * cell;
        const py = originY + (r + 0.5) * cell;
        // 世界坐标(sampler 已知映射:wx = (px-originX)*scale? 森林网格 origin 用的是 WORLD.originX 米制 → world = (px - originX)*scale? 注意 originX 此处为世界左下角米制)
        const wx = (px - sampler.meta.world.originX) * sampler.meta.world.scale;
        const wz = -(py - sampler.meta.world.originY) * sampler.meta.world.scale;
        const p = (d / 255) * 0.20 * densityScale; // 每格期望树数(林地格约 0.18 → 30m 间距)
        if (rng() > p) continue;
        const x = wx + (rng() - 0.5) * cell * sampler.meta.world.scale;
        const z = wz + (rng() - 0.5) * cell * sampler.meta.world.scale;
        if (sampler.maskAtWorld(x, z) < 150) continue;
        const y = sampler.heightAt(x, z);
        const r3 = rng();
        const type = r3 < 0.5 ? 0 : r3 < 0.8 ? 1 : r3 < 0.94 ? 2 : 3;
        cands.push({ x, z, y, s: 0.9 + rng() * 0.9, type, g: 0 });
      }
    }
    // 子采样至预算
    if (cands.length > maxTrees) {
      for (let i = cands.length - 1; i > 0; i--) {
        const j = (rng() * (i + 1)) | 0;
        [cands[i], cands[j]] = [cands[j], cands[i]];
      }
      cands.length = maxTrees;
    }

    const geos = [
      // 尺寸参考:1 世界单位 ≈ 3.9km → 针叶高 0.017u ≈ 66m(沙盘可读尺度)
      coneTree(0.0042, 0.017, 0x3e6c33),
      coneTree(0.0055, 0.0124, 0x4d7a3a),
      coneTree(0.0029, 0.022, 0x35624a),
      shrub(0.0065, 0x5d8040)
    ];
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    // 树顶风摆(方案 §16 动态增强):按实例相位错开,幅度随树高
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = { value: 0 };
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
          vec2 ip = vec2(instanceMatrix[3][0], instanceMatrix[3][2]);
          float ph = ip.x * 13.7 + ip.y * 7.1;
          float sw = sin(uTime * 1.35 + ph) * 0.6 + sin(uTime * 2.3 + ph * 1.7) * 0.25;
          transformed.xz += vec2(sw, cos(uTime * 1.1 + ph) * 0.5) * max(position.y, 0.0) * 0.22;
        #endif`);
      this.swayShader = sh as unknown as { uniforms: { uTime: { value: number } } };
    };
    // 3×3 宏区域分组:近景/侧视时可整体剔除区域实例(方案 §33 Frustum Culling)
    const REG = 3;
    const hw = sampler.meta.world.widthUnits / 2, hh = sampler.meta.world.heightUnits / 2;
    const perGeoPerRegion: Cand[][][] = [];
    for (let g = 0; g < 4; g++) {
      const regions: Cand[][] = [];
      for (let r = 0; r < REG * REG; r++) regions.push([]);
      perGeoPerRegion.push(regions);
    }
    for (const t of cands) {
      let gx = Math.floor((t.x + hw) / (hw * 2) * REG);
      let gy = Math.floor((t.z + hh) / (hh * 2) * REG);
      gx = Math.max(0, Math.min(REG - 1, gx));
      gy = Math.max(0, Math.min(REG - 1, gy));
      perGeoPerRegion[t.type][gy * REG + gx].push(t);
    }
    const m4 = new THREE.Matrix4();
    const q = new THREE.Quaternion();
    const up = new THREE.Vector3(0, 1, 0);
    const pv = new THREE.Vector3();
    const sc = new THREE.Vector3();
    for (let gi = 0; gi < 4; gi++) {
      for (let ri = 0; ri < REG * REG; ri++) {
        const list = perGeoPerRegion[gi][ri];
        if (!list.length) continue;
        const mesh = new THREE.InstancedMesh(geos[gi], mat, list.length);
        for (let i = 0; i < list.length; i++) {
          const t = list[i];
          pv.set(t.x, t.y - 0.02, t.z);
          q.setFromAxisAngle(up, rng() * Math.PI * 2);
          sc.set(t.s, t.s * (0.85 + rng() * 0.3), t.s);
          m4.compose(pv, q, sc);
          mesh.setMatrixAt(i, m4);
        }
        mesh.instanceMatrix.needsUpdate = true;
        mesh.computeBoundingSphere(); // 包含实例偏移 → 视锥剔除生效
        mesh.castShadow = true;
        this.group.add(mesh);
        this.meshes.push(mesh);
      }
    }
  }
}
