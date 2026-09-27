// CityEngine:城市建筑(Tier1/Tier2 = OSM 真实 footprint 合并实例;其余 = 程序化低模建筑群)
// 全部贴地(方案 §21),InstancedMesh(方案 §33)
import * as THREE from 'three';
import type { TerrainSampler } from '../utils/sampler';
import { mulberry32, hashStr } from '../terrain/noise';

export interface City { n: string; t: number; pop: number; x: number; z: number; r: number; lon: number; lat: number }
export interface BuildingItem { cities: Array<{ city: string; items: number[][] }> } // [x,z,wM,dM,rot,hM]

/** 程序化窗光纹理(夜景模式 emissiveMap):暗立面 + 随机亮窗 */
function makeWindowTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#000000';
  g.fillRect(0, 0, 64, 128);
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let y = 4; y < 124; y += 8) {
    for (let x = 4; x < 60; x += 10) {
      if (rnd() < 0.42) {
        const warm = 0.75 + rnd() * 0.25;
        g.fillStyle = `rgba(255,${(190 * warm) | 0},${(120 * warm) | 0},${0.5 + rnd() * 0.5})`;
        g.fillRect(x, y, 6, 4);
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  return tex;
}

export class CityEngine {
  group = new THREE.Group();
  private nightMats: THREE.MeshLambertMaterial[] = [];

  /** 夜景模式:建筑窗光开关 */
  setNight(on: boolean) {
    for (const m of this.nightMats) m.emissiveIntensity = on ? 1.25 : 0;
  }

  constructor(
    private sampler: TerrainSampler,
    cities: City[],
    buildings: BuildingItem | null,
    enabled = true
  ) {
    if (!enabled) return;
    const w = sampler.meta.world;
    const mPerUnit = 1 / w.scale; // 米/世界单位

    // ── 全部城市真实建筑 footprint(单实例网格) ──
    let realCount = 0;
    const realItems: number[][] = [];
    const realCities = new Map<string, number>();
    if (buildings && buildings.cities) {
      for (const grp of buildings.cities) {
        realCities.set(grp.city, grp.items.length);
        for (const it of grp.items) realItems.push(it);
      }
      if (realItems.length) {
        realCount = this.buildRealFootprints(realItems, mPerUnit);
      }
    }

    // ── 程序化建筑群(无真实数据的 Tier1/2 + Tier3/4) ──
    let instanced = 0;
    const rng = mulberry32(520000);
    interface Inst { m: THREE.Matrix4; c: THREE.Color }
    const instances: Inst[] = [];
    const tmpM = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpP = new THREE.Vector3();
    const tmpS = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

    for (const city of cities) {
      const realN = realCities.get(city.n) ?? 0;
      if (city.t <= 2 && realN >= 800) continue; // 真实数据充分,不再程序化补充
      if (city.t === 3 && realN >= 40) continue; // 县城真实建筑足够
      const scaleM = city.r; // 建成区半径(米)
      const rUnits = scaleM / mPerUnit;
      // 程序化数量:真实覆盖不足时按缺口比例补充
      const fullCount = city.t === 1 ? 1500 : city.t === 2 ? 620 : city.t === 3 ? 80 : 14;
      let count = fullCount;
      if (city.t === 1 || city.t === 2) count = Math.max(120, Math.round(fullCount * (1 - realN / 800)));
      else if (city.t === 3) count = 60;
      const seed = hashStr(city.n);
      const crng = mulberry32(seed);
      for (let i = 0; i < count; i++) {
        // 高斯分布聚中心
        const u = Math.max(1e-9, crng()), v = crng();
        const rr = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.42;
        const ang = crng() * Math.PI * 2;
        const dx = Math.cos(ang) * Math.abs(rr) * rUnits;
        const dz = Math.sin(ang) * Math.abs(rr) * rUnits;
        const x = city.x + dx, z = city.z + dz;
        if (sampler.maskAtWorld(x, z) < 140) continue;
        // 4 向坡度检查:山顶/陡坡不放建筑(贴地且避免悬空观感)
        const y = sampler.heightAt(x, z);
        const e = 0.015;
        const yx = sampler.heightAt(x + e, z), yz = sampler.heightAt(x, z + e);
        const yx2 = sampler.heightAt(x - e, z), yz2 = sampler.heightAt(x, z - e);
        const slopeMax = Math.max(Math.abs(yx - y), Math.abs(yz - y), Math.abs(yx2 - y), Math.abs(yz2 - y)) / e;
        if (slopeMax > 0.45) continue;
        // 建筑块尺寸(低模:代表街区,非单栋);补充块体更宽更矮,避免针状观感
        const sizeBase = city.t === 1 ? 90 : city.t === 2 ? 95 : city.t === 3 ? 55 : 34;
        const wM = sizeBase * (0.5 + crng()) ;
        const dM = sizeBase * (0.5 + crng());
        // 高度:中心更高(摩天感),米制 → 视觉夸张同地形
        const distK = 1 - Math.min(1, Math.hypot(dx, dz) / rUnits);
        const hM = (city.t === 1 ? 22 + distK * 65 : city.t === 2 ? 14 + distK * 26 : 10 + distK * 12) * (0.6 + crng() * 0.8);
        // 视觉高度:与地形垂直夸张一致(米 → 世界单位)
        const vertPerM = w.verticalScale / (sampler.meta.elev.max - sampler.meta.elev.min);
        const hWorld = Math.max(0.02, hM * vertPerM);
        tmpP.set(x, y + hWorld / 2, z);
        tmpQ.setFromAxisAngle(up, crng() * Math.PI);
        tmpS.set(wM / mPerUnit, hWorld, dM / mPerUnit);
        tmpM.compose(tmpP, tmpQ, tmpS);
        const shade = 0.72 + crng() * 0.25;
        const col = new THREE.Color(shade * 0.98, shade * 0.99, shade * 1.04);
        if (city.t <= 2 && crng() < 0.25) col.setRGB(shade * 0.8, shade * 0.9, shade * 1.1); // 玻璃蓝
        instances.push({ m: tmpM.clone(), c: col });
        instanced++;
      }
    }

    const box = new THREE.BoxGeometry(1, 1, 1);
    const winTex = makeWindowTexture();
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: 0xffc66e, emissiveMap: winTex, emissiveIntensity: 0
    });
    this.nightMats.push(mat);
    const mesh = new THREE.InstancedMesh(box, mat, Math.max(1, instanced));
    let k = 0;
    for (const inst of instances) {
      mesh.setMatrixAt(k, inst.m);
      mesh.setColorAt(k, inst.c);
      k++;
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false; // 单一大实例网格,避免整体误剔除
    mesh.castShadow = true;
    this.group.add(mesh);
  }

  private buildRealFootprints(items: number[][], mPerUnit: number): number {
    const s = this.sampler;
    const w = s.meta.world;
    const vertPerM = w.verticalScale / (s.meta.elev.max - s.meta.elev.min);
    const box = new THREE.BoxGeometry(1, 1, 1);
    const winTex = makeWindowTexture();
    const mat = new THREE.MeshLambertMaterial({
      color: 0xffffff,
      emissive: 0xffc66e, emissiveMap: winTex, emissiveIntensity: 0
    });
    this.nightMats.push(mat);
    const mesh = new THREE.InstancedMesh(box, mat, items.length);
    const tmpM = new THREE.Matrix4();
    const tmpQ = new THREE.Quaternion();
    const tmpP = new THREE.Vector3();
    const tmpS = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);
    let k = 0;
    for (const [x, z, wM, dM, rot, hM] of items) {
      const y = s.heightAt(x, z);
      const hWorld = Math.max(0.015, hM * vertPerM);
      tmpP.set(x, y + hWorld / 2, z);
      tmpQ.setFromAxisAngle(up, rot);
      tmpS.set(Math.max(0.004, wM / mPerUnit), hWorld, Math.max(0.004, dM / mPerUnit));
      tmpM.compose(tmpP, tmpQ, tmpS);
      const shade = 0.66 + ((k * 37) % 100) / 300;
      mesh.setMatrixAt(k, tmpM);
      mesh.setColorAt(k, new THREE.Color(shade, shade, shade * 1.05));
      k++;
    }
    mesh.count = k;
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    this.group.add(mesh);
    return k;
  }
}
