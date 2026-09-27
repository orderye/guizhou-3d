// 场景基础:渲染器/相机/光照/雾/天空/控制器(方案 §29-§32)
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

export interface SceneCtx {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  sun: THREE.DirectionalLight;
  hemi: THREE.HemisphereLight;
  fill: THREE.DirectionalLight;
  skyMat: THREE.ShaderMaterial;
  envTex: THREE.Texture;
  setNight(on: boolean): void;
}

// 昼/夜环境参数(方案 §29;夜景为演示增强)
const DAY = { top: 0x8fb3cf, mid: 0xd7e0e2, bot: 0x2c333c, fog: 0xc3ccc9, hemi: 0.85, sun: 1.75, fill: 0.35, sunColor: 0xfff2dd };
const NIGHT = { top: 0x0a1220, mid: 0x14202e, bot: 0x04060a, fog: 0x060a12, hemi: 0.16, sun: 0.28, fill: 0.06, sunColor: 0x8fa8d8 };

// 天空渐变材质(穹顶与 PMREM 环境共用)
function makeSkyMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      top: { value: new THREE.Color(0x8fb3cf) },
      mid: { value: new THREE.Color(0xd7e0e2) },
      bot: { value: new THREE.Color(0x2c333c) }
    },
    vertexShader: `
      varying vec3 vP;
      void main(){ vP = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
    fragmentShader: `
      varying vec3 vP; uniform vec3 top; uniform vec3 mid; uniform vec3 bot;
      void main(){
        float h = normalize(vP).y;
        vec3 c = h > 0.12 ? mix(mid, top, smoothstep(0.12, 0.7, h))
               : mix(bot, mid, smoothstep(-0.25, 0.12, h));
        gl_FragColor = vec4(c, 1.0);
      }`
  });
}

export function setupScene(container: HTMLElement): SceneCtx {
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  // 天空渐变(穹顶;保留材质引用供昼夜切换)
  const skyMat = makeSkyMaterial();
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(600, 24, 12), skyMat));

  // PMREM 环境贴图(供水面反射天空)
  const envScene = new THREE.Scene();
  envScene.add(new THREE.Mesh(new THREE.SphereGeometry(50, 16, 8), makeSkyMaterial()));
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTex = pmrem.fromScene(envScene, 0.04).texture;
  pmrem.dispose();
  // 雾(轻量,增强远山层次)
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
  // 与 hillshade 一致:az 315°, alt 45°
  const az = 315 * Math.PI / 180, alt = 45 * Math.PI / 180;
  const R = 120;
  sun.position.set(Math.sin(az) * Math.cos(alt) * R, Math.sin(alt) * R, Math.cos(az) * Math.cos(alt) * R);
  scene.add(sun);
  const fill = new THREE.DirectionalLight(0xbcc8d8, 0.35);
  fill.position.set(-60, 40, -80);
  scene.add(fill);

  const onResize = () => {
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(container.clientWidth, container.clientHeight);
  };
  window.addEventListener('resize', onResize);

  // 昼夜切换(夜景:暗天空 + 月光;窗光由建筑材质 emissive 实现)
  function setNight(on: boolean) {
    const P = on ? NIGHT : DAY;
    (skyMat.uniforms.top.value as THREE.Color).setHex(P.top);
    (skyMat.uniforms.mid.value as THREE.Color).setHex(P.mid);
    (skyMat.uniforms.bot.value as THREE.Color).setHex(P.bot);
    (scene.fog as THREE.FogExp2).color.setHex(P.fog);
    hemi.intensity = P.hemi;
    sun.intensity = P.sun;
    sun.color.setHex(P.sunColor);
    fill.intensity = P.fill;
    renderer.toneMappingExposure = on ? 0.92 : 1.05;
  }

  return { renderer, scene, camera, controls, sun, hemi, fill, skyMat, envTex, setNight };
}
