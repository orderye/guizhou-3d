// LabelEngine:城市标签(HTML 覆盖层,逐标签距离 LOD,方案 §25)
import * as THREE from 'three';
import type { City } from '../cities/CityEngine';

const TIER_DIST: Record<number, number> = { 1: 1e9, 2: 1e9, 3: 15, 4: 5.5 };
const MAX_LABELS = 90;

export class LabelEngine {
  private container: HTMLElement;
  private items: Array<{
    el: HTMLDivElement; city: City; pos: THREE.Vector3; tier: number;
  }> = [];

  constructor(cities: City[], samplerH: (x: number, z: number) => number, enabled = true) {
    this.container = document.getElementById('labels')!;
    if (!enabled) return;
    for (const city of cities) {
      if (city.t >= 3 && !city.n) continue;
      const el = document.createElement('div');
      el.className = `lbl t${city.t}`;
      if (city.t <= 2) el.innerHTML = `<span class="dot"></span>${city.n}`;
      else if (city.t === 3) el.innerHTML = `<span class="dot s"></span>${city.n}`;
      else el.textContent = city.n;
      el.style.display = 'none';
      this.container.appendChild(el);
      this.items.push({
        el, city,
        pos: new THREE.Vector3(city.x, samplerH(city.x, city.z), city.z),
        tier: city.t
      });
    }
  }

  update(camera: THREE.PerspectiveCamera, _camDist: number, width: number, height: number) {
    const v = new THREE.Vector3();
    // 收集可见标签,按(层级,距离)排序限量,避免近景标签风暴
    interface VisEntry { it: { el: HTMLDivElement; pos: THREE.Vector3; tier: number }; sx: number; sy: number; d: number; key: number }
    const visible: VisEntry[] = [];
    for (const it of this.items) {
      const d = camera.position.distanceTo(it.pos);
      const maxDist = TIER_DIST[it.tier] ?? 5.5;
      if (d > maxDist) { it.el.style.display = 'none'; continue; }
      v.copy(it.pos).project(camera);
      if (v.z > 1 || v.x < -1.05 || v.x > 1.05 || v.y < -1.05 || v.y > 1.05) {
        it.el.style.display = 'none';
        continue;
      }
      visible.push({
        it, d,
        sx: (v.x * 0.5 + 0.5) * width,
        sy: (-v.y * 0.5 + 0.5) * height,
        key: it.tier * 1e6 + (it.tier >= 3 ? d : -d)
      });
    }
    visible.sort((a, b) => a.key - b.key);
    // 屏幕空间网格去重:约 110px 网格内只保留优先级最高的标签(防重叠)
    const CELL = 110;
    const occupied = new Set<number>();
    const shown: VisEntry[] = [];
    for (const s of visible) {
      const gx = Math.floor(s.sx / CELL), gy = Math.floor(s.sy / CELL);
      const k = gy * 4096 + gx;
      if (occupied.has(k)) continue;
      occupied.add(k);
      shown.push(s);
      if (shown.length >= MAX_LABELS) break;
    }
    // 先全部隐藏,再显示选中的
    for (const it of this.items) it.el.style.display = 'none';
    for (const s of shown) {
      const el = s.it.el;
      el.style.display = 'block';
      el.style.left = `${s.sx.toFixed(1)}px`;
      el.style.top = `${s.sy.toFixed(1)}px`;
      el.style.opacity = s.it.tier >= 3 ? String(Math.max(0.3, Math.min(1, (TIER_DIST[s.it.tier] - s.d) / 8))) : '1';
    }
  }
}
