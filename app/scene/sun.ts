// 真实太阳:天文年历 → 太阳高度角/方位角,并派生光照与大气参数
// 算法为 NOAA 简化版(黄经/赤纬/时角),精度约 0.01°,足够沙盘日照表达。
import * as THREE from 'three';

export interface SunSite {
  lonDeg: number;      // 观察点经度(贵州 106.5°E)
  latDeg: number;      // 观察点纬度(贵州 26.8°N)
  utcOffsetH: number;  // 时区偏移(北京 +8)
}

export interface SunState {
  altitude: number;    // 太阳高度角(弧度)
  azimuth: number;     // 方位角(弧度,北 0 顺时针)
  dir: THREE.Vector3;  // 场景坐标下的太阳方向(单位向量,指向太阳)
  daylight: number;    // 归一化日照强度 0..1
}

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function computeSun(date: Date, site: SunSite): SunState {
  // 儒略日 → 距 J2000.0 的天数
  const n = date.getTime() / 86400000 + 2440587.5 - 2451545.0;
  const L = (280.460 + 0.9856474 * n) % 360;             // 平黄经
  const g = ((357.528 + 0.9856003 * n) % 360) * D2R;      // 平近点角
  const lambda = (L + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * D2R; // 黄经
  const eps = (23.439 - 0.0000004 * n) * D2R;            // 黄赤交角
  const ra = Math.atan2(Math.cos(eps) * Math.sin(lambda), Math.cos(lambda)); // 赤经
  const dec = Math.asin(Math.sin(eps) * Math.sin(lambda));                  // 赤纬

  // 格林尼治平恒星时 → 当地平恒星时 → 时角(西向为正)
  const gmst = (280.46061837 + 360.98564736629 * n) % 360;
  const lst = (gmst + site.lonDeg) % 360;
  let ha = (lst - ra * R2D + 540) % 360 - 180;  // 归一到 [-180,180]
  const haR = ha * D2R;

  const latR = site.latDeg * D2R;
  const sinAlt = Math.sin(latR) * Math.sin(dec) + Math.cos(latR) * Math.cos(dec) * Math.cos(haR);
  const alt = Math.asin(Math.max(-1, Math.min(1, sinAlt)));

  // 方位角(北 0 顺时针):atn2(-sin HA cos δ, cos HA sin φ − sin δ cos φ)
  const az = Math.atan2(
    -Math.sin(haR) * Math.cos(dec),
    Math.cos(haR) * Math.sin(latR) - Math.sin(dec) * Math.cos(latR)
  );

  // 场景坐标:X=东,Z=−北,Y=上
  const dir = new THREE.Vector3(
    Math.sin(az) * Math.cos(alt),
    Math.sin(alt),
    -Math.cos(az) * Math.cos(alt)
  ).normalize();

  // 日照过渡:−6°(民用暮光)以下为 0,10° 以上为满
  const t = Math.max(0, Math.min(1, (alt + 6 * D2R) / (16 * D2R)));
  const daylight = t * t * (3 - 2 * t);

  return { altitude: alt, azimuth: az, dir, daylight };
}

export interface SunLook {
  sunColor: number;      // 直射光颜色
  sunIntensity: number;  // 直射光强度
  hemiColor: number;     // 天空半球光
  hemiGround: number;    // 地面反射色
  hemiIntensity: number;
  fillIntensity: number;
  fogColor: number;
  fogDensity: number;
  exposure: number;
  turbidity: number;     // Preetham 大气浊度
  rayleigh: number;      // 瑞利散射
  mieCoefficient: number;
}

// 高度角锚点表(自上而下):正午 → 黄昏 → 日落
// rayleigh 取值高于 three 官方示例(3)偏低区间:增强蓝天的瑞利散射占比
const LOOK_KEYS: Array<[number, SunLook]> = [
  [90, { sunColor: 0xfff6e8, sunIntensity: 2.45, hemiColor: 0xcfe2f2, hemiGround: 0x6a6252, hemiIntensity: 0.52, fillIntensity: 0.22, fogColor: 0xc6d3dc, fogDensity: 0.0030, exposure: 1.00, turbidity: 2.2, rayleigh: 2.10, mieCoefficient: 0.004 }],
  [45, { sunColor: 0xfff1dc, sunIntensity: 2.20, hemiColor: 0xc9dcec, hemiGround: 0x665f50, hemiIntensity: 0.48, fillIntensity: 0.24, fogColor: 0xc2cfda, fogDensity: 0.0034, exposure: 1.02, turbidity: 2.4, rayleigh: 2.20, mieCoefficient: 0.005 }],
  [18, { sunColor: 0xffdcae, sunIntensity: 1.85, hemiColor: 0xc3d4e4, hemiGround: 0x5f5849, hemiIntensity: 0.42, fillIntensity: 0.26, fogColor: 0xbcc6cd, fogDensity: 0.0042, exposure: 1.04, turbidity: 3.4, rayleigh: 2.40, mieCoefficient: 0.007 }],
  [6,  { sunColor: 0xffb878, sunIntensity: 1.25, hemiColor: 0xc0cbdc, hemiGround: 0x5a5142, hemiIntensity: 0.36, fillIntensity: 0.28, fogColor: 0xc4b0a0, fogDensity: 0.0056, exposure: 1.06, turbidity: 5.2, rayleigh: 2.70, mieCoefficient: 0.010 }],
  [0,  { sunColor: 0xff8a4a, sunIntensity: 0.42, hemiColor: 0xaebdd2, hemiGround: 0x4e463a, hemiIntensity: 0.30, fillIntensity: 0.22, fogColor: 0xb19383, fogDensity: 0.0072, exposure: 1.05, turbidity: 7.2, rayleigh: 2.90, mieCoefficient: 0.013 }],
  [-6, { sunColor: 0x6a7ea8, sunIntensity: 0.10, hemiColor: 0x8b9ab4, hemiGround: 0x3a352c, hemiIntensity: 0.20, fillIntensity: 0.12, fogColor: 0x6b7488, fogDensity: 0.0080, exposure: 1.00, turbidity: 8.2, rayleigh: 3.00, mieCoefficient: 0.014 }]
];

function lerpHex(a: number, b: number, t: number) {
  const ar = (a >> 16) & 255, ag = (a >> 8) & 255, ab = a & 255;
  const br = (b >> 16) & 255, bg = (b >> 8) & 255, bb = b & 255;
  return (Math.round(ar + (br - ar) * t) << 16) | (Math.round(ag + (bg - ag) * t) << 8) | Math.round(ab + (bb - ab) * t);
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** 按太阳高度角插值出光照与大气参数 */
export function sunLook(altRad: number): SunLook {
  const alt = altRad * R2D;
  const keys = LOOK_KEYS;
  if (alt >= keys[0][0]) return { ...keys[0][1] };
  for (let i = 0; i < keys.length - 1; i++) {
    const [aHi, kHi] = keys[i];
    const [aLo, kLo] = keys[i + 1];
    if (alt <= aHi && alt >= aLo) {
      const t = (aHi - alt) / (aHi - aLo);
      return {
        sunColor: lerpHex(kHi.sunColor, kLo.sunColor, t),
        sunIntensity: mix(kHi.sunIntensity, kLo.sunIntensity, t),
        hemiColor: lerpHex(kHi.hemiColor, kLo.hemiColor, t),
        hemiGround: lerpHex(kHi.hemiGround, kLo.hemiGround, t),
        hemiIntensity: mix(kHi.hemiIntensity, kLo.hemiIntensity, t),
        fillIntensity: mix(kHi.fillIntensity, kLo.fillIntensity, t),
        fogColor: lerpHex(kHi.fogColor, kLo.fogColor, t),
        fogDensity: mix(kHi.fogDensity, kLo.fogDensity, t),
        exposure: mix(kHi.exposure, kLo.exposure, t),
        turbidity: mix(kHi.turbidity, kLo.turbidity, t),
        rayleigh: mix(kHi.rayleigh, kLo.rayleigh, t),
        mieCoefficient: mix(kHi.mieCoefficient, kLo.mieCoefficient, t)
      };
    }
  }
  return { ...keys[keys.length - 1][1] };
}

/** 把 "HH:MM" + 时区偏移转成世界时(UTC)的 Date */
export function localTimeToDate(dateStr: string, timeStr: string, utcOffsetH: number): Date {
  const d = new Date(`${dateStr}T00:00:00Z`);
  if (isNaN(d.getTime())) d.setTime(Date.UTC(2000, 0, 1));
  const [hh, mm] = (timeStr || '00:00').split(':').map(Number);
  const t = d.getTime() + (hh * 60 + (mm || 0)) * 60000 - utcOffsetH * 3600000;
  return new Date(t);
}
