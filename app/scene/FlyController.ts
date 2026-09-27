// FlyController:键盘漫游(移动查看)
// WASD/方向键平移 · Q/E(空格)升降 · Shift 加速
// 与 OrbitControls 共存:相机与 target 同步平移,旋转/缩放不受影响
// 自动贴地钳制(不穿山)+ 省域边界钳制
import * as THREE from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { TerrainSampler } from '../utils/sampler';

const HANDLED = new Set(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'Space',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

export class FlyController {
  private keys = new Set<string>();
  private vel = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private right = new THREE.Vector3();
  private move = new THREE.Vector3();
  private np = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  enabled = true;
  baseSpeed = 8; // 世界单位/秒(1u ≈ 3.9km)

  constructor(
    private camera: THREE.PerspectiveCamera,
    private controls: OrbitControls,
    private sampler: TerrainSampler,
    private bounds: { x: number; z: number }
  ) {
    window.addEventListener('keydown', (e) => {
      if (!HANDLED.has(e.code)) return;
      if (HANDLED.has(e.code) && (e.code === 'Space' || e.code.startsWith('Arrow'))) e.preventDefault();
      this.keys.add(e.code);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => this.keys.clear());
  }

  update(dt: number) {
    if (!this.enabled || dt <= 0 || dt > 0.2) return;
    const k = this.keys;
    this.camera.getWorldDirection(this.dir);
    this.right.crossVectors(this.dir, this.up);
    if (this.right.lengthSq() < 1e-8) this.right.set(1, 0, 0);
    this.right.normalize();

    this.move.set(0, 0, 0);
    if (k.has('KeyW') || k.has('ArrowUp')) this.move.add(this.dir);
    if (k.has('KeyS') || k.has('ArrowDown')) this.move.sub(this.dir);
    if (k.has('KeyD') || k.has('ArrowRight')) this.move.add(this.right);
    if (k.has('KeyA') || k.has('ArrowLeft')) this.move.sub(this.right);
    if (k.has('KeyE') || k.has('Space')) this.move.y += 1;
    if (k.has('KeyQ')) this.move.y -= 1;

    const boost = k.has('ShiftLeft') || k.has('ShiftRight') ? 3.2 : 1;
    if (this.move.lengthSq() > 0) {
      this.move.normalize().multiplyScalar(this.baseSpeed * boost);
      this.vel.lerp(this.move, Math.min(1, dt * 8));
    } else {
      this.vel.multiplyScalar(Math.max(0, 1 - dt * 7));
    }
    if (this.vel.lengthSq() < 1e-10) return;

    this.np.copy(this.camera.position).addScaledVector(this.vel, dt);
    // 边界钳制(省域外围缓冲)
    this.np.x = Math.max(-this.bounds.x, Math.min(this.bounds.x, this.np.x));
    this.np.z = Math.max(-this.bounds.z, Math.min(this.bounds.z, this.np.z));
    // 贴地钳制(防穿山)
    const ground = this.sampler.heightAt(this.np.x, this.np.z);
    const minY = ground + 0.22;
    if (this.np.y < minY) this.np.y = minY;

    this.np.sub(this.camera.position);
    this.camera.position.add(this.np);
    this.controls.target.add(this.np);
  }
}
