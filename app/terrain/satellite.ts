// 卫星影像底图:把世界坐标反投影到 Web Mercator,采样底图纹理
//
// 配准方式:底图存为 Web Mercator 网格,运行时在顶点着色器里
//   世界坐标 → Albers 投影平面(米) → Albers 逆投影 → 经纬度 → Mercator UV
// 逐顶点从实际几何位置反算,因此与渲染出的地形严格贴合(零配准误差)。
import * as THREE from 'three';

export interface SatelliteMeta {
  provider: string;
  source?: string;
  outWidth: number;
  outHeight: number;
  mercatorRect: { x0: number; y0: number; x1: number; y1: number };
  approxResM?: number;
}

export interface ProjectionMeta {
  type: string;
  lon0: number;
  lat0: number;
  sp1: number;
  sp2: number;
  R: number;
}

export interface WorldMeta {
  scale: number;
  originX: number;
  originY: number;
}

/** Albers 等积圆锥逆投影参数(与 scripts/config.mjs、sampler.ts 一致) */
export function albersInverseParams(p: ProjectionMeta) {
  const D2R = Math.PI / 180;
  const lon0 = p.lon0 * D2R;
  const p1 = p.sp1 * D2R, p2 = p.sp2 * D2R;
  const n = (Math.sin(p1) + Math.sin(p2)) / 2;
  const C = Math.cos(p1) ** 2 + 2 * n * Math.sin(p1);
  const rho0 = p.R * Math.sqrt(C - 2 * n * Math.sin(p.lat0 * D2R)) / n;
  return { n, C, rho0, R: p.R, lon0Deg: p.lon0, D2R };
}

const VS_DECL = /* glsl */`
attribute float satW;
varying float vSatW;
varying vec2 vSatUv;
uniform float uInvScale, uOriginX, uOriginY, uN, uC, uRho0, uR, uD2R, uLon0;
uniform float uSatNear, uSatFar, uSatNearW;
uniform vec2 uRectMin, uRectSize;
`;

const VS_BODY = /* glsl */`
{
  float px = position.x * uInvScale + uOriginX;
  float py = -position.z * uInvScale + uOriginY;
  float dy = uRho0 - py;
  float th = atan(px, dy);
  float rho = sqrt(px * px + dy * dy);
  float phi = asin(clamp((uC - pow(rho * uN / uR, 2.0)) / (2.0 * uN), -1.0, 1.0));
  float lon = th / uN / uD2R + uLon0;
  float lat = phi / uD2R;
  float mx = (lon + 180.0) / 360.0;
  float rl = lat * uD2R;
  float my = (1.0 - log(tan(rl) + 1.0 / cos(rl)) / 3.141592653589793) * 0.5;
  vSatUv = vec2((mx - uRectMin.x) / uRectSize.x, 1.0 - (my - uRectMin.y) / uRectSize.y);
  // 底图是全省尺度(约 204m/px),近景放大后会糊——按相机距离衰减权重,
  // 近景交回高程色带与几何细节,远景由影像提供地表纹理。
  float camD = distance(position, cameraPosition);
  vSatW = satW * mix(uSatNearW, 1.0, smoothstep(uSatNear, uSatFar, camD));
}
`;

const FS_DECL = /* glsl */`
varying float vSatW;
varying vec2 vSatUv;
uniform sampler2D uSatMap;
uniform float uSatMix, uSatSat, uSatGain, uSatLift, uSatCloud;
`;

const FS_BODY = /* glsl */`
{
  vec3 sat = texture2D(uSatMap, clamp(vSatUv, 0.0, 1.0)).rgb;
  float lum = dot(sat, vec3(0.2126, 0.7152, 0.0722));
  // 影像中的厚云是高亮近中性像素:在底图混合中压制,避免在沙盘上形成突兀白斑。
  // 阈值取 0.78,只命中近乎纯白的高光,不会误伤城区/裸岩等偏亮地表。
  float neutral = 1.0 - smoothstep(0.02, 0.09, abs(sat.r - sat.b));
  float cloud = smoothstep(0.78, 0.93, lum) * neutral;
  vec3 satD = mix(vec3(lum), sat, uSatSat);
  satD = satD * uSatGain;
  satD = mix(satD, sqrt(satD), uSatLift);
  float w = clamp(uSatMix * vSatW * (1.0 - cloud * uSatCloud), 0.0, 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, satD, w);
}
`;

export interface SatelliteUniforms {
  uSatMap: { value: THREE.Texture | null };
  uSatMix: { value: number };
  uSatSat: { value: number };
  uSatGain: { value: number };
  uSatLift: { value: number };
  uSatCloud: { value: number };
  uSatNear: { value: number };
  uSatFar: { value: number };
  uSatNearW: { value: number };
  [k: string]: THREE.IUniform;
}

/**
 * 给地形材质注入底图混合。
 * mix  —— 底图占比(0=纯高程色带,1=纯影像)
 * sat  —— 底图饱和度(0=灰度,1=原始)
 * gain —— 整体亮度增益(卫星影像反射率低,需提亮才接近沙盘观感)
 * lift —— 暗部提亮强度(0=线性,1=完全开根号)
 */
export function applySatellite(
  mat: THREE.MeshStandardMaterial,
  texture: THREE.Texture,
  satMeta: SatelliteMeta,
  proj: ProjectionMeta,
  world: WorldMeta,
  mix: number,
  sat: number,
  gain = 1.18,
  lift = 0.35,
  cloud = 0.7,
  nearW = 0.22,
  near = 6,
  far = 26
): SatelliteUniforms {
  const ip = albersInverseParams(proj);
  const rect = satMeta.mercatorRect;
  const uniforms: SatelliteUniforms = {
    uSatMap: { value: texture },
    uSatMix: { value: mix },
    uSatSat: { value: sat },
    uSatGain: { value: gain },
    uSatLift: { value: lift },
    uSatCloud: { value: cloud },
    uSatNear: { value: near },
    uSatFar: { value: far },
    uSatNearW: { value: nearW },
    uInvScale: { value: 1 / world.scale },
    uOriginX: { value: world.originX },
    uOriginY: { value: world.originY },
    uN: { value: ip.n },
    uC: { value: ip.C },
    uRho0: { value: ip.rho0 },
    uR: { value: ip.R },
    uD2R: { value: ip.D2R },
    uLon0: { value: ip.lon0Deg },
    uRectMin: { value: new THREE.Vector2(rect.x0, rect.y0) },
    uRectSize: { value: new THREE.Vector2(rect.x1 - rect.x0, rect.y1 - rect.y0) }
  };

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = VS_DECL + shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n' + VS_BODY
    );
    shader.fragmentShader = FS_DECL + shader.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\n' + FS_BODY
    );
  };
  mat.customProgramCacheKey = () => 'gz-satellite-v1';
  mat.needsUpdate = true;
  return uniforms;
}

/** 由 ImageBitmap 构建底图纹理(flipY=false:解码阶段已翻转) */
export function satelliteTexture(bitmap: ImageBitmap): THREE.Texture {
  const tex = new THREE.Texture(bitmap);
  tex.flipY = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.generateMipmaps = true;
  tex.anisotropy = 8;
  tex.needsUpdate = true;
  return tex;
}
