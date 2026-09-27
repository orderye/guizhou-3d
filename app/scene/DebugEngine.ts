// DebugEngine + PerformanceMonitor(方案 §55):?debug=1 显示 FPS/DrawCalls/Triangles/LOD
import * as THREE from 'three';

export class PerformanceMonitor {
  frames = 0;
  fps = 0;
  private last = performance.now();
  private ema = 60;
  tick() {
    this.frames++;
    const now = performance.now();
    if (now - this.last >= 500) {
      const f = this.frames * 1000 / (now - this.last);
      this.ema = this.ema * 0.6 + f * 0.4;
      this.fps = Math.round(this.ema);
      this.frames = 0;
      this.last = now;
      return true; // 统计刷新
    }
    return false;
  }
}

export class DebugEngine {
  private el: HTMLElement;
  private perf = new PerformanceMonitor();

  constructor(private renderer: THREE.WebGLRenderer, private getExtra: () => string, enabled: boolean) {
    this.el = document.getElementById('debug')!;
    this.el.style.display = enabled ? 'block' : 'none';
    this.enabled = enabled;
    (window as any).__GZ_PERF__ = {
      getStats: () => ({
        fps: this.perf.fps,
        drawCalls: this.renderer.info.render.calls,
        triangles: this.renderer.info.render.triangles,
        extra: this.getExtra()
      })
    };
  }
  enabled: boolean;

  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, tiles: string) {
    const fresh = this.perf.tick();
    if (!this.enabled) return;
    if (fresh) {
      const i = this.renderer.info.render;
      this.el.textContent =
        `FPS        ${this.perf.fps}\n` +
        `DrawCalls  ${i.calls}\n` +
        `Triangles  ${(i.triangles / 1e6).toFixed(2)}M\n` +
        `CamDist    ${camera.position.distanceTo(target).toFixed(1)}\n` +
        `Tiles      ${tiles}\n` +
        this.getExtra();
    }
  }
}
