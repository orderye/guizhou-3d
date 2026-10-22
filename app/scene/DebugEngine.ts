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
  // renderer.info.autoReset 已关闭(见 SceneSetup),统计由 main.ts 在渲染后
  // 读出并手动清零,这里保存"刚渲染完的这一帧"的值。
  private frameCalls = 0;
  private frameTriangles = 0;

  constructor(private renderer: THREE.WebGLRenderer, private getExtra: () => string, enabled: boolean) {
    this.el = document.getElementById('debug')!;
    this.el.style.display = enabled ? 'block' : 'none';
    this.enabled = enabled;
    (window as any).__GZ_PERF__ = {
      getStats: () => ({
        fps: this.perf.fps,
        drawCalls: this.frameCalls,
        triangles: this.frameTriangles,
        extra: this.getExtra()
      })
    };
  }
  enabled: boolean;

  /** 由渲染循环在 render() 之后调用:传入本帧的统计并清零累积器 */
  setFrameStats(calls: number, triangles: number) {
    this.frameCalls = calls;
    this.frameTriangles = triangles;
  }

  update(camera: THREE.PerspectiveCamera, target: THREE.Vector3, tiles: string) {
    const fresh = this.perf.tick();
    if (!this.enabled) return;
    if (fresh) {
      const bs = (window as any).__GZ__?.terrainBuildStats?.();
      this.el.textContent =
        `FPS        ${this.perf.fps}\n` +
        `DrawCalls  ${this.frameCalls}\n` +
        `Triangles  ${(this.frameTriangles / 1e6).toFixed(2)}M\n` +
        `CamDist    ${camera.position.distanceTo(target).toFixed(1)}\n` +
        `Tiles      ${tiles}\n` +
        (bs ? `Built      ${bs.built} (avg ${bs.avgMs.toFixed(1)}ms)\n` : '') +
        this.getExtra();
    }
  }
}
