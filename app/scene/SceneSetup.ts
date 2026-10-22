// 场景基础:渲染器/相机/真实太阳/Preetham 大气天空/雾/控制器(方案 §29-§32)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Sky } from 'three/addons/objects/Sky.js';
import { sunLook, type SunState } from './sun';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  sky: Sky;
  envTex: THREE.Texture;
  setNight(on: boolean): void;
  /** 应用真实太阳状态(高度角/方位角 → 光照、天空、雾、曝光) */
  setSun(state: SunState): void;
}

/**
 * 创建天空实例。
 * Preetham 模型输出的是物理亮度(地平线附近可达数倍),而场景曝光按地形调校为 1.0,
 * 直接使用会被 ACES 压成白色。故给显示用的天空加独立增益;
 * envSky 用于 PMREM 环境贴图(线性渲染,不经色调映射),保持物理亮度以供水面反射。
 *
 * horizonBlue —— 地平线蓝移:Preetham 在低仰角因长光程多次散射而发白(物理正确),
 * 但沙盘的观察视角多接近水平,大片白天空不耐看,故对近地平线去饱和并推向淡蓝。
 */
function makeSky(gain: number, horizonBlue = 0): Sky {
  const s = new Sky();
  const mat = s.material as THREE.ShaderMaterial;
  mat.uniforms.uSkyGain = { value: gain };
  mat.uniforms.uHorizonBlue = { value: horizonBlue };
  mat.fragmentShader = mat.fragmentShader
    .replace('void main() {', 'uniform float uSkyGain;\nuniform float uHorizonBlue;\nvoid main() {')
    .replace(
      'gl_FragColor = vec4( retColor, 1.0 );',
      `float hz = 1.0 - smoothstep( 0.0, 0.42, direction.y );
       vec3 hzBlue = vec3( dot( retColor, vec3( 0.299, 0.587, 0.114 ) ) ) * vec3( 0.74, 0.88, 1.16 );
       retColor = mix( retColor, hzBlue, hz * uHorizonBlue );
       gl_FragColor = vec4( retColor * uSkyGain, 1.0 );`
    );
  mat.needsUpdate = true;
  return s;
}

export function setupScene(container: HTMLElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();

  // ── Preetham 大气散射天空(替代原三色渐变穹顶) ──
  // 盒子跟随相机,保证任何观察位置都处于天空内部且在裁剪范围内
  const sky = makeSky(0.28, 0.85);
  sky.scale.setScalar(800);
  scene.add(sky);

  // PMREM 环境贴图(供水面反射天空);用独立 Sky 实例,尺度需落在 PMREM 的 near/far 内
  const envSky = makeSky(1.0);
  envSky.scale.setScalar(30);
  const envScene = new THREE.Scene();
  envScene.add(envSky);
  const pmrem = new THREE.PMREMGenerator(renderer);
  let envRT: THREE.WebGLRenderTarget | null = null;
  let envTex!: THREE.Texture;

  function refreshEnv() {
    const rt = pmrem.fromScene(envScene, 0.04);
    if (envRT) envRT.dispose();
    envRT = rt;
    envTex = rt.texture;
    // 替换已有材质的 envMap(水面反射),不改动全局 scene.environment 以免压平光照
    scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.isMeshStandardMaterial && m.envMap) {
        m.envMap = envTex;
        m.needsUpdate = true;
      }
    });
  }
  refreshEnv();

  // 雾(轻量,增强远山层次;色/浓度随太阳高度角变化)
  scene.fog = new THREE.FogExp2(0xc3ccc9, 0.0042);

  const camera = new THREE.PerspectiveCamera(40, container.clientWidth / container.clientHeight, 0.05, 1500);
  camera.position.set(52, 58, 96);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.8;
  controls.maxDistance = 320;
  controls.target.set(0, 6, 0);

  // 光照:半球 + 方向光(方案 §29)
  const hemi = new THREE.HemisphereLight(0xcfe0ee, 0x5c554a, 0.85);
  scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff2dd, 1.75);
  const R = 160;
  sun.position.set(-113, 113, 113);  // 初始占位,首次 setSun 后由真实太阳覆盖
  scene.add(sun);
  scene.add(sun.target);
  const fill = new THREE.DirectionalLight(0xbcc8d8, 0.35);
  fill.position.set(-60, 40, -80);
  scene.add(fill);

  const onResize = () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener('resize', onResize);

  let currentSun: SunState | null = null;
  let nightOn = false;

  /** 真实太阳:天空散射参数 + 光照 + 雾 + 曝光 */
  function setSun(state: SunState) {
    currentSun = state;
    nightOn = false;
    const look = sunLook(state.altitude);
    const u = sky.material.uniforms;
    u.sunPosition.value.copy(state.dir);   // 单位长度(官方 Sky 用法)
    u.turbidity.value = look.turbidity;
    u.rayleigh.value = look.rayleigh;
    u.mieCoefficient.value = look.mieCoefficient;
    const eu = envSky.material.uniforms;
    eu.sunPosition.value.copy(state.dir);
    eu.turbidity.value = look.turbidity;
    eu.rayleigh.value = look.rayleigh;
    eu.mieCoefficient.value = look.mieCoefficient;

    sun.color.setHex(look.sunColor);
    sun.intensity = look.sunIntensity;
    hemi.color.setHex(look.hemiColor);
    hemi.groundColor.setHex(look.hemiGround);
    hemi.intensity = look.hemiIntensity;
    fill.intensity = look.fillIntensity;
    (scene.fog as THREE.FogExp2).color.setHex(look.fogColor);
    (scene.fog as THREE.FogExp2).density = look.fogDensity;
    renderer.toneMappingExposure = look.exposure;
    refreshEnv();
  }

  // 昼夜切换(夜景:暗天空 + 月光低照度;窗光由建筑材质 emissive 实现)
  function setNight(on: boolean) {
    nightOn = on;
    if (on) {
      const u = sky.material.uniforms;
      // 太阳落到地平线下 → Preetham 模型自然给出暗色天空
      u.sunPosition.value.set(0.35, -0.22, -0.91).normalize();
      u.turbidity.value = 8;
      u.rayleigh.value = 0.4;
      u.mieCoefficient.value = 0.012;
      const eu = envSky.material.uniforms;
      eu.sunPosition.value.set(0.35, -0.22, -0.91).normalize();
      eu.turbidity.value = 8;
      eu.rayleigh.value = 0.4;
      eu.mieCoefficient.value = 0.012;
      sun.color.setHex(0x8fa8d8);
      sun.intensity = 0.28;
      hemi.color.setHex(0x1a2436);
      hemi.groundColor.setHex(0x0a0c10);
      hemi.intensity = 0.16;
      fill.intensity = 0.06;
      (scene.fog as THREE.FogExp2).color.setHex(0x060a12);
      (scene.fog as THREE.FogExp2).density = 0.0075;
      renderer.toneMappingExposure = 0.92;
      refreshEnv();
    } else if (currentSun) {
      setSun(currentSun);
    }
  }

  return { renderer, scene, camera, controls, sun, hemi, fill, sky, envTex, setNight, setSun };
}
