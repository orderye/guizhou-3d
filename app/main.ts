// 贵州三维地形沙盘 V3 — 主入口
// 数据驱动:真实 DEM + DataV 行政边界 + OSM 水系/城市/道路/林地
import * as THREE from 'three';
import { parseParams } from './utils/params';
import { loadJSON, loadBin, loadImage } from './utils/loader';
import { TerrainSampler, parseAO, type TerrainMeta } from './utils/sampler';
import { setupScene, type SceneCtx } from './scene/SceneSetup';
import { computeSun, localTimeToDate } from './scene/sun';
import { TerrainEngine, type SatelliteBundle } from './terrain/TerrainEngine';
import { satelliteTexture, type SatelliteMeta } from './terrain/satellite';
import { HydroEngine, parseRiverbed } from './water/HydroEngine';
import { BaseEngine } from './scene/BaseEngine';
import { BoundaryEngine } from './scene/BoundaryEngine';
import { RoadEngine } from './roads/RoadEngine';
import { CityEngine, type City } from './cities/CityEngine';
import { LabelEngine } from './labels/LabelEngine';
import { ForestEngine } from './forest/ForestEngine';
import { DebugEngine } from './scene/DebugEngine';
import { FlyController } from './scene/FlyController';

const params = parseParams();
const container = document.getElementById('app')!;
const loadmsg = document.getElementById('loadmsg')!;
const loadbar = document.getElementById('loadbar')! as HTMLElement;

function setProgress(done: number, total: number, name: string) {
  loadbar.style.width = `${Math.round(done / total * 100)}%`;
  loadmsg.textContent = `加载运行时数据 ${done}/${total} — ${name}`;
}

// 视角预设(方案 §56)
function viewPreset(name: string, meta: TerrainMeta): { pos: [number, number, number]; target: [number, number, number] } {
  const W = meta.world.widthUnits, H = meta.world.heightUnits;
  const cx = 0, cz = 0;
  const overview = { pos: [0, 72, 120] as [number, number, number], target: [0, 8, 0] as [number, number, number] };
  const presets: Record<string, { pos: [number, number, number]; target: [number, number, number] }> = {
    overview,
    north: { pos: [0, 30, -135], target: [0, 8, 0] },
    west: { pos: [-135, 30, 0], target: [0, 8, 0] },
    south: { pos: [0, 30, 135], target: [0, 8, 0] },
    central: { pos: [4, 18, 22], target: [0, 6, -2] },          // 黔中(贵阳一带)
    river: { pos: [-8, 12, 26], target: [-6, 2, 14] },          // 乌江峡谷(江界河段方位)
    city: { pos: [3.2, 3.4, 7.5], target: [0, 0.6, 0] }         // 贵阳近景
  };
  return presets[name] || overview;
}

async function main() {
  const files = [
    'runtime/terrain/terrain.meta.json',
    'runtime/terrain/terrain.elev.bin',
    'runtime/terrain/terrain.mask.bin',
    'runtime/terrain/terrain.maskwide.bin',
    'runtime/terrain/valley.bin',
    'runtime/terrain/ao.bin',
    'runtime/rivers/riverbed.bin',
    'runtime/rivers/lakes.json',
    'runtime/rivers/rivertint.bin',
    'runtime/cities/cities.json',
    'runtime/cities/boundary.json',
    'runtime/cities/roads.json',
    'runtime/cities/buildings.json',
    'runtime/forests/forest.meta.json',
    'runtime/forests/forest.bin',
    'runtime/terrain/satellite.json',
    'runtime/terrain/satellite.jpg'
  ];
  const data: Record<string, any> = {};
  let done = 0;
  setProgress(0, files.length, '');
  await Promise.all(files.map(async (f) => {
    try {
      data[f] = f.endsWith('.bin') ? await loadBin(f)
        : f.endsWith('.jpg') ? await loadImage(f)
        : await loadJSON(f);
    } catch (e) {
      console.warn('optional data missing:', f);
      data[f] = null;
    }
    setProgress(++done, files.length, f.split('/').pop() || f);
  }));

  const meta = data['runtime/terrain/terrain.meta.json'] as TerrainMeta;
  const sampler = new TerrainSampler(
    meta,
    data['runtime/terrain/terrain.elev.bin'],
    data['runtime/terrain/terrain.mask.bin'],
    params.exaggeration,
    data['runtime/terrain/terrain.maskwide.bin'],
    data['runtime/terrain/valley.bin']
  );

  // 环境光遮蔽(真实 DEM 天空可见度,离线生成)
  sampler.ao = parseAO(data['runtime/terrain/ao.bin'] as ArrayBuffer);

  const ctx: SceneCtx = setupScene(container);
  const { scene, camera, controls, renderer } = ctx;

  // ── 真实太阳(NOAA 天文算法):高度角/方位角 → 光照、天空散射、雾、曝光 ──
  const SITE = { lonDeg: 106.5, latDeg: 26.8, utcOffsetH: 8 };
  const DEFAULT_DATE = '2026-10-22';
  let sunState = computeSun(localTimeToDate(params.date || DEFAULT_DATE, params.time || '10:30', SITE.utcOffsetH), SITE);
  ctx.setSun(sunState);

  // ── 实时阴影(默认开启,?shadow=0 关闭) ──
  if (params.shadow) {
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    ctx.sun.castShadow = true;
    ctx.sun.shadow.mapSize.set(2048, 2048);
    scene.add(ctx.sun.target);
  }

  // ── 卫星底图(全局持有纹理,world 热切换时复用,避免重复上传 GPU) ──
  const satMeta = data['runtime/terrain/satellite.json'] as SatelliteMeta | null;
  const satBitmap = data['runtime/terrain/satellite.jpg'] as ImageBitmap | null;
  const satBundle: SatelliteBundle | undefined = (satMeta && satBitmap) ? {
    texture: satelliteTexture(satBitmap),
    meta: satMeta,
    projection: meta.projection,
    world: meta.world,
    mix: params.sat ?? 0.78,   // 底图占比(其余保留高程色带,维持沙盘高度可读性)
    sat: params.satsat ?? 0.62, // 底图饱和度(降饱和使其贴近沙盘质感)
    gain: 1.18,               // 亮度增益(卫星影像反射率低)
    lift: 0.35,               // 暗部提亮
    cloud: 0.7,               // 厚云压制强度(0=不压制)
    nearW: 0.22,              // 近景底图权重(底图 204m/px,近景放大后会糊)
    near: 6,                  // 衰减起点(世界单位,1u ≈ 4.57km)
    far: 26                   // 完全启用距离
  } : undefined;

  // ── 世界构建(可拆卸,支持 exaggeration 热切换) ──
  const cities: City[] = data['runtime/cities/cities.json'].cities;
  interface WorldHandles {
    engines: Array<{ group: THREE.Group; update?: (cam: THREE.Vector3, dist: number) => void }>;
    terrain: TerrainEngine | null;
    labels: LabelEngine;
    tickWater?: (t: number) => void;
    tickForest?: (t: number) => void;
    setNight?: (on: boolean) => void;
  }

  function buildWorld(): WorldHandles {
    const engines: WorldHandles['engines'] = [];
    let terrain: TerrainEngine | null = null;
    let tickWater: ((t: number) => void) | undefined;
    let tickForest: ((t: number) => void) | undefined;
    let setNight: ((on: boolean) => void) | undefined = (on) => ctx.setNight(on);

    if (params.terrain) {
      terrain = new TerrainEngine(sampler, true, {
        bin: data['runtime/forests/forest.bin'],
        meta: data['runtime/forests/forest.meta.json']
      }, data['runtime/rivers/rivertint.bin'], satBundle);
      terrain.init(camera.position);
      scene.add(terrain.group);
      engines.push({ group: terrain.group, update: (cam) => terrain!.update(cam) });
    }

    const base = new BaseEngine(sampler, data['runtime/cities/boundary.json'].province);
    scene.add(base.group);

    const boundary = new BoundaryEngine(sampler, data['runtime/cities/boundary.json'], params.boundary);
    scene.add(boundary.group);
    engines.push({ group: boundary.group, update: (_cam, dist) => boundary.update(dist) });

    if (params.water && data['runtime/rivers/riverbed.bin']) {
      const bed = parseRiverbed(data['runtime/rivers/riverbed.bin']);
      const hydro = new HydroEngine(sampler, bed, data['runtime/rivers/lakes.json'].features, ctx.envTex);
      scene.add(hydro.group);
      engines.push({ group: hydro.group, update: (_cam, dist) => hydro.update(dist) });
      tickWater = (t) => hydro.tick(t);
    }

    if (params.road) {
      const roads = new RoadEngine(sampler, data['runtime/cities/roads.json'].features, true);
      scene.add(roads.group);
      engines.push({ group: roads.group, update: (_cam, dist) => roads.update(dist) });
    }

    const cities: City[] = data['runtime/cities/cities.json'].cities;
    let cityEngine: CityEngine | null = null;
    if (params.city) {
      cityEngine = new CityEngine(sampler, cities, data['runtime/cities/buildings.json'], true);
      scene.add(cityEngine.group);
      const base = setNight!;
      setNight = (on: boolean) => { base(on); cityEngine!.setNight(on); };
    }
    const labels = new LabelEngine(cities, (x, z) => sampler.heightAt(x, z), params.city);

    if (params.forest) {
      const forest = new ForestEngine(
        sampler,
        data['runtime/forests/forest.bin'],
        data['runtime/forests/forest.meta.json'],
        true,
        isMobile ? 90000 : 150000,
        isMobile ? 0.5 : 1
      );
      scene.add(forest.group);
      engines.push({ group: forest.group, update: (_cam, dist) => forest.update(dist) });
      tickForest = (t) => forest.tick(t);
    }

    return { engines, terrain, labels, tickWater, tickForest, setNight };
  }

  let world: WorldHandles;
  function disposeWorld(w: WorldHandles) {
    for (const e of w.engines) scene.remove(e.group);
    // 移除所有自有组并释放几何/材质
    for (const o of [...scene.children]) {
      if ((o as any).__gzOwned) {
        scene.remove(o);
        o.traverse((c: any) => {
          if (c.geometry) c.geometry.dispose();
          if (c.material) {
            const ms = Array.isArray(c.material) ? c.material : [c.material];
            for (const m of ms) m.dispose();
          }
        });
      }
    }
    // HTML 标签层清空(重建时重生成)
    const lc = document.getElementById('labels');
    if (lc) lc.innerHTML = '';
  }

  // 标记自有组(供 disposeWorld 识别)
  const _origAdd = scene.add.bind(scene);
  (scene as any).add = (...objs: any[]) => {
    for (const o of objs) (o as any).__gzOwned = true;
    return _origAdd(...objs);
  };
  // 天空穹顶在 buildWorld 之前添加 → 不带标记,不会被误删 ✓

  // ── 移动端自动降档(触屏/小屏):pixelRatio 与树密度在 buildWorld 内处理 ──
  const isMobile = matchMedia('(pointer: coarse)').matches || Math.min(window.innerWidth, window.innerHeight) < 700;

  // ── 夜景模式(N 键 / ?night=1) ──
  let night = params.night;
  function applyNight() {
    world.setNight?.(night);
    toast(night ? '夜景模式:开(按 N 切换)' : '夜景模式:关');
  }

  // ── 提示浮层 ──
  const toastEl = document.createElement('div');
  toastEl.style.cssText = 'position:fixed;left:50%;bottom:38px;transform:translateX(-50%);z-index:40;background:rgba(8,12,18,.78);color:#dbe7f0;font:12px/1.5 "PingFang SC",sans-serif;padding:7px 14px;border-radius:20px;opacity:0;transition:opacity .35s;pointer-events:none;';
  document.body.appendChild(toastEl);
  let toastTimer = 0;
  function toast(msg: string) {
    toastEl.textContent = msg;
    toastEl.style.opacity = '1';
    clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toastEl.style.opacity = '0'; }, 2200);
  }

  // ── 实用键:N 夜景 / C 分享链接 / P 截图 ──
  window.addEventListener('keydown', (e) => {
    if (e.code === 'KeyN' && !e.repeat) {
      night = !night;
      applyNight();
    } else if (e.code === 'KeyC' && !e.repeat) {
      const r2 = (v: number) => Math.round(v * 100) / 100;
      const url = `${location.origin}${location.pathname}?cam=${r2(camera.position.x)},${r2(camera.position.y)},${r2(camera.position.z)}&tgt=${r2(controls.target.x)},${r2(controls.target.y)},${r2(controls.target.z)}&ex=${(window as any).__GZ__.getExaggeration().toFixed(1)}${night ? '&night=1' : ''}`;
      navigator.clipboard?.writeText(url).then(
        () => toast('视角链接已复制到剪贴板'),
        () => toast('复制失败:' + url)
      );
    } else if (e.code === 'KeyP' && !e.repeat) {
      renderer.render(scene, camera); // 同帧捕获
      renderer.domElement.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `guizhou-sandbox-${Date.now()}.png`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
        toast('截图已保存');
      }, 'image/png');
    }
  });

  // ── 移动查看:键盘漫游 + 双击飞往(方案 §31 交互扩展) ──
  const fly = new FlyController(camera, controls, sampler, {
    x: meta.world.widthUnits / 2 + 6,
    z: meta.world.heightUnits / 2 + 6
  });
  let flyTween: {
    t0: number; dur: number;
    fromT: THREE.Vector3; toT: THREE.Vector3;
    fromC: THREE.Vector3; toC: THREE.Vector3;
  } | null = null;
  renderer.domElement.addEventListener('dblclick', (ev) => {
    const rect = renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((ev.clientX - rect.left) / rect.width) * 2 - 1,
      -((ev.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera);
    const o = raycaster.ray.origin.clone();
    const d = raycaster.ray.direction.clone();
    const p = o.clone();
    let hit: THREE.Vector3 | null = null;
    let step = 0.05;
    for (let i = 0; i < 6000 && p.distanceTo(o) < 260; i++) {
      p.addScaledVector(d, step);
      const g = sampler.heightAt(p.x, p.z);
      if (p.y <= g) { hit = p.clone(); hit.y = g + 0.05; break; }
      step = Math.min(0.35, 0.05 + p.distanceTo(o) * 0.012);
    }
    if (!hit) return;
    const delta = hit.clone().sub(controls.target);
    const toT = controls.target.clone().add(delta);
    const toC = camera.position.clone().add(delta);
    const g2 = sampler.heightAt(toC.x, toC.z);
    if (toC.y < g2 + 0.35) toC.y = g2 + 0.35;
    flyTween = { t0: performance.now(), dur: 900, fromT: controls.target.clone(), toT, fromC: camera.position.clone(), toC };
  });

  // ── 相机初始位(必须早于 buildWorld:地形按相机距离选 LOD,相机未定位会全部按最细档构建)──
  const vp = viewPreset(params.view, meta);
  camera.position.set(...vp.pos);
  controls.target.set(...vp.target);
  controls.update();
  // 贵阳城市视角 / 乌江峡谷 / 万峰林近景:把 target 对准锚点
  const anchor = (name: string) => cities.find(c => c.n === name || c.n === name + '市');
  if (params.view === 'city') {
    const gy = anchor('贵阳') || cities.find(c => c.t === 1) || cities[0];
    if (gy) {
      controls.target.set(gy.x, sampler.heightAt(gy.x, gy.z), gy.z);
      camera.position.set(gy.x + 2.2, sampler.heightAt(gy.x, gy.z) + 1.4, gy.z + 3.4);
      controls.update();
    }
  }
  if (params.view === 'river') {
    const wj = anchor('息烽');
    if (wj) {
      controls.target.set(wj.x, sampler.heightAt(wj.x, wj.z) - 2, wj.z - 4);
      camera.position.set(wj.x - 2, sampler.heightAt(wj.x, wj.z) + 5, wj.z + 6);
      controls.update();
    }
  }
  if (params.view === 'closeup') {
    const xy = anchor('兴义');
    if (xy) {
      const ty = sampler.heightAt(xy.x, xy.z);
      // 从西南侧望向东北省域内侧(万峰林方向),避免取到省界裙墙
      controls.target.set(xy.x + 2.6, ty + 0.5, xy.z - 2.2);
      camera.position.set(xy.x - 1.2, ty + 3.4, xy.z + 3.2);
      controls.update();
    }
  }

  // ── 构建世界(相机已就位 → 地形按正确距离选择 LOD)──
  world = buildWorld();
  if (night) world.setNight?.(night); // ?night=1 初始应用(不弹提示)

  // ── 开场缓降(?intro=1):从高空沿视线方向缓降至预设视角 ──
  let intro: { t0: number; fromPos: THREE.Vector3; toPos: THREE.Vector3 } | null = null;
  if (params.intro) {
    const toPos = camera.position.clone();
    const dir = toPos.clone().sub(controls.target).normalize();
    const fromPos = controls.target.clone()
      .add(dir.multiplyScalar(toPos.distanceTo(controls.target) * 2.8))
      .add(new THREE.Vector3(0, camera.position.y * 0.8 + 30, 0));
    intro = { t0: performance.now(), fromPos, toPos };
    camera.position.copy(fromPos);
  }

  // ── 分享链接中的相机/观察点(优先于 view 预设) ──
  if (params.cam && params.tgt) {
    camera.position.set(...params.cam);
    controls.target.set(...params.tgt);
    controls.update();
  } else if (params.cam) {
    camera.position.set(...params.cam);
    controls.update();
  }

   const debug = new DebugEngine(renderer, () => {
    const w = meta.world;
    return `World     ${w.widthUnits.toFixed(0)}×${w.heightUnits.toFixed(0)}u\n` +
      `Exagger   ×${(sampler.verticalScale / meta.world.verticalScale * meta.world.exaggerationDefault).toFixed(1)}`;
  }, params.debug);
  (window as any).__GZ__ = {
    sampler, data, meta, scene, camera, controls, world: () => world,
    setExaggeration(n: number) {
      const camPos = camera.position.clone();
      const tgt = controls.target.clone();
      sampler.setVerticalScale(meta.world.verticalScale * (n / meta.world.exaggerationDefault));
      disposeWorld(world);
      world = buildWorld();
      camera.position.copy(camPos);
      controls.target.copy(tgt);
      world.terrain?.update(camera.position);
      return sampler.verticalScale;
    },
    getExaggeration() {
      return sampler.verticalScale / meta.world.verticalScale * meta.world.exaggerationDefault;
    },
    /** 底图权重 0=纯高程色带 1=纯影像 */
    setSatMix(v: number) {
      world.terrain?.setSatMix(v);
      return v;
    },
    /** 底图饱和度 0=灰度 1=原始 */
    setSatSat(v: number) {
      world.terrain?.setSatSat(v);
      return v;
    },
    /** 设置太阳时刻(当地 HH:MM),返回高度角/方位角(度) */
    setSunTime(hhmm: string, dateStr?: string) {
      sunState = computeSun(localTimeToDate(dateStr || params.date || DEFAULT_DATE, hhmm, SITE.utcOffsetH), SITE);
      ctx.setSun(sunState);
      return {
        altitude: +(sunState.altitude * 180 / Math.PI).toFixed(2),
        azimuth: +(((sunState.azimuth * 180 / Math.PI) % 360 + 360) % 360).toFixed(2)
      };
    },
    getSun() {
      return {
        altitude: +(sunState.altitude * 180 / Math.PI).toFixed(2),
        azimuth: +(((sunState.azimuth * 180 / Math.PI) % 360 + 360) % 360).toFixed(2)
      };
    }
  };

  // ── 渲染循环 ──
  let lodThrottle = 0;
  let lastFrameT = 0;
  function loop(t: number) {
    requestAnimationFrame(loop);
    const dt = lastFrameT ? Math.min(0.05, (t - lastFrameT) / 1000) : 0.016;
    lastFrameT = t;
    controls.update();
    fly.update(dt);
    if (flyTween) {
      const k = Math.min(1, (t - flyTween.t0) / flyTween.dur);
      const e = 1 - Math.pow(1 - k, 3);
      controls.target.lerpVectors(flyTween.fromT, flyTween.toT, e);
      camera.position.lerpVectors(flyTween.fromC, flyTween.toC, e);
      if (k >= 1) flyTween = null;
    }
    if (intro) {
      const k = Math.min(1, (t - intro.t0) / 3800);
      const ease = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(intro.fromPos, intro.toPos, ease);
      if (k >= 1) intro = null;
    }
    if (t - lodThrottle > 300) {
      lodThrottle = t;
      const cam = camera.position;
      for (const e of world.engines) e.update?.(cam, cam.distanceTo(controls.target));
    }
    world.tickWater?.(t / 1000);
    world.tickForest?.(t / 1000);
    world.terrain?.tick(7); // 时间预算内逐瓦片重建(缩放流畅度)
    // 阴影相机跟随观察点;范围按视距分级(远景大范围低精度,近景小范围高精度)
    if (params.shadow) {
      const camDist = camera.position.distanceTo(controls.target);
      const range = camDist > 60 ? 90 : camDist > 30 ? 45 : camDist > 12 ? 22 : 9;
      const sc = ctx.sun.shadow.camera as THREE.OrthographicCamera;
      if (Math.abs(sc.right - range) > 0.5) {
        sc.left = -range; sc.right = range; sc.top = range; sc.bottom = -range;
        sc.near = 1; sc.far = range * 4;
        sc.updateProjectionMatrix();
        ctx.sun.shadow.bias = -0.0004 * (range / 34);
        ctx.sun.shadow.normalBias = 0.02 * (range / 34);
        ctx.sun.shadow.needsUpdate = true;
      }
      ctx.sun.position.copy(controls.target).addScaledVector(sunState.dir, range * 3);
      ctx.sun.target.position.copy(controls.target);
      ctx.sun.target.updateMatrixWorld();
    }
    // 天空盒跟随相机,保证任何观察位置都在天空内部
    ctx.sky.position.copy(camera.position);
    debug.update(camera, controls.target, world.terrain ? `${world.terrain.group.children.length}` : '-');
    world.labels.update(camera, camera.position.distanceTo(controls.target), window.innerWidth, window.innerHeight);
    renderer.render(scene, camera);
  }

  // 隐藏加载层
  const loading = document.getElementById('loading')!;
  loading.style.opacity = '0';
  setTimeout(() => loading.remove(), 700);

  requestAnimationFrame(loop);
}

main().catch(err => {
  loadmsg.textContent = `加载失败: ${err.message || err}`;
  loadmsg.style.color = '#e08a8a';
  console.error(err);
});
