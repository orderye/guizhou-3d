// 卫星底图合成:Web Mercator 瓦片 → 拼图 → 重采样为单张底图
// 输出 public/runtime/terrain/satellite.jpg(约 209m/px)+ satellite.json(运行时反投影用)
//
// 网格选择:输出采用 Web Mercator 网格而非 EPSG:4326 网格——
//   · Esri 原始瓦片本身就是 Mercator,可直接拼图,无需逐像素重采样
//   · Mercator 在贵州纬度带(24.35°N-29.55°N)地面分辨率仅随纬度变化 ±3%,远优于
//     4326 网格在 Mercator 源上做非线性纬度重映射
//   · 运行时在顶点着色器里做 Albers 逆投影精确反算,配准零误差
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DIRS, SAT_OUT_W, log } from '../config.mjs';

const FFMPEG = 'ffmpeg';

function haveFfmpeg() {
  try { execFileSync(FFMPEG, ['-version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** 缺失瓦片生成灰色占位(保证拼图帧数与顺序严格正确) */
function makePlaceholder(out, ext) {
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=c=0x4a4a4a:s=256x256',
    '-frames:v', '1', '-q:v', '8', out
  ], { stdio: 'ignore' });
  return out;
}

export function run() {
  const t0 = Date.now();
  const rawMetaPath = path.join(DIRS.rawSat, 'meta.json');
  if (!fs.existsSync(rawMetaPath)) throw new Error('缺少 data/raw/sat/meta.json,请先执行 npm run download sat');
  if (!haveFfmpeg()) {
    // 底图是增强项,缺失不应阻塞构建——运行时自动降级为纯高程色带
    log('sat', '未找到 ffmpeg,跳过卫星底图合成(brew install ffmpeg 可启用;运行时降级为纯色带)');
    return;
  }

  const meta = JSON.parse(fs.readFileSync(rawMetaPath, 'utf8'));
  const { x0, x1, y0, y1 } = meta.tileRange;
  const cols = x1 - x0 + 1, rows = y1 - y0 + 1;
  const ext = meta.provider === 'gibs' ? 'jpg' : 'jpg';

  // ── 1. 校验瓦片完整性,缺失的用占位补齐 ──
  const seqDir = path.join(DIRS.rawSat, 'seq');
  fs.rmSync(seqDir, { recursive: true, force: true });
  fs.mkdirSync(seqDir, { recursive: true });

  const missing = [];
  let n = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const src = path.join(DIRS.rawSat, `z${meta.zoom}_${x}_${y}.${ext}`);
      if (!fs.existsSync(src) || fs.statSync(src).size < 1000) missing.push(src);
      n++;
    }
  }
  if (missing.length) {
    log('sat', `缺失 ${missing.length}/${n} 张瓦片,生成占位图`);
    const ph = path.join(DIRS.rawSat, '_placeholder.' + ext);
    if (!fs.existsSync(ph)) makePlaceholder(ph, ext);
    for (const m of missing) fs.copyFileSync(ph, m);
  }

  // ── 2. 建立顺序符号链接(image2 demuxer 要求连续编号) ──
  let i = 0;
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const src = path.join(DIRS.rawSat, `z${meta.zoom}_${x}_${y}.${ext}`);
      const link = path.join(seqDir, String(i++).padStart(5, '0') + '.' + ext);
      fs.symlinkSync(path.relative(seqDir, src), link);
    }
  }
  log('sat', `seq 链接 ${i} 个`);

  // ── 3. 拼图 + 重采样 + 编码 ──
  const srcW = cols * 256, srcH = rows * 256;
  const downscale = srcW / SAT_OUT_W;
  const outH = Math.round(srcH / downscale);
  const outDir = path.join(DIRS.runtime, 'terrain');
  fs.mkdirSync(outDir, { recursive: true });
  const outJpg = path.join(outDir, 'satellite.jpg');
  const outPng = path.join(outDir, '_satellite_tmp.png');

  log('sat', `拼图 ${srcW}×${srcH} → ${SAT_OUT_W}×${outH} (降采样 ${downscale.toFixed(2)}×)`);
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-framerate', '1', '-start_number', '0', '-i', path.join(seqDir, '%05d.' + ext),
    '-vf', `tile=${cols}x${rows},scale=${SAT_OUT_W}:${outH}:flags=area`,
    '-frames:v', '1', '-pix_fmt', 'yuvj420p', '-q:v', '4', outPng
  ], { stdio: 'inherit' });

  // PNG → JPEG(q:v 4);JPEG 已是压缩格式,build-single 再 gzip 无收益
  execFileSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', outPng, '-q:v', '4', outJpg
  ], { stdio: 'inherit' });
  fs.rmSync(outPng, { force: true });
  fs.rmSync(seqDir, { recursive: true, force: true });

  // ── 4. 运行时元数据:Mercator UV 矩形 ──
  const n2 = 2 ** meta.zoom;
  const rect = {
    x0: x0 / n2, y0: y0 / n2,
    x1: (x1 + 1) / n2, y1: (y1 + 1) / n2
  };
  const sizeMB = fs.statSync(outJpg).size / 1e6;
  fs.writeFileSync(path.join(outDir, 'satellite.json'), JSON.stringify({
    provider: meta.provider,
    source: meta.source,
    zoom: meta.zoom,
    outWidth: SAT_OUT_W,
    outHeight: outH,
    mercatorRect: rect,
    downscale: Number(downscale.toFixed(4)),
    approxResM: Math.round(156543.03392 * Math.cos(27 * Math.PI / 180) / 2 ** meta.zoom * downscale),
    missingTiles: missing.length,
    generatedAt: new Date().toISOString()
  }, null, 2));

  log('sat', `DONE ${outJpg} (${sizeMB.toFixed(1)}MB, ${SAT_OUT_W}×${outH}, ${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
