// 下载卫星影像瓦片(Web Mercator),作为沙盘地表底图
// 默认源:Esri World Imagery(ArcGIS Online)—— 匿名可访问,约 39m/px(z12)
// 备选源:NASA GIBS VIIRS TrueColor —— 无需凭据,但仅 250m/px(z9)
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, SAT_PROVIDER, SAT_BBOX, log, fetchWithRetry } from '../config.mjs';

const SAT_DATE = '2023-06-15';

const PROVIDERS = {
  esri: {
    name: 'Esri World Imagery (ArcGIS Online)',
    zoom: 12,
    ext: 'jpg',
    url: (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`
  },
  gibs: {
    name: 'NASA GIBS VIIRS CorrectedReflectance TrueColor',
    zoom: 9,
    ext: 'jpg',
    url: (z, x, y) => `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/VIIRS_SNPP_CorrectedReflectance_TrueColor/default/${SAT_DATE}/GoogleMapsCompatible_Level${z}/${z}/${y}/${x}.jpg`
  }
};

export function getProvider(name = SAT_PROVIDER) {
  const p = PROVIDERS[name];
  if (!p) throw new Error(`未知影像源 ${name}(可选:${Object.keys(PROVIDERS).join(', ')})`);
  return { key: name, ...p };
}

export function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
export function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

/** 计算覆盖 BBOX 的瓦片范围与拼图尺寸 */
export function tileRange(bbox, zoom) {
  const x0 = lonToTileX(bbox.west, zoom), x1 = lonToTileX(bbox.east, zoom);
  const y0 = latToTileY(bbox.north, zoom), y1 = latToTileY(bbox.south, zoom);
  return {
    x0, x1, y0, y1,
    cols: x1 - x0 + 1,
    rows: y1 - y0 + 1,
    total: (x1 - x0 + 1) * (y1 - y0 + 1),
    srcW: (x1 - x0 + 1) * 256,
    srcH: (y1 - y0 + 1) * 256
  };
}

export async function downloadSatellite() {
  const prov = getProvider();
  const range = tileRange(SAT_BBOX, prov.zoom);
  fs.mkdirSync(DIRS.rawSat, { recursive: true });
  log('sat', `${prov.name} z${prov.zoom} tiles: ${range.total} (x ${range.x0}-${range.x1}, y ${range.y0}-${range.y1})`);

  const jobs = [];
  for (let y = range.y0; y <= range.y1; y++) {
    for (let x = range.x0; x <= range.x1; x++) jobs.push({ x, y });
  }

  let done = 0, skipped = 0, failed = 0;
  const CONC = 16;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const { x, y } = jobs[idx++];
      const fp = path.join(DIRS.rawSat, `z${prov.zoom}_${x}_${y}.${prov.ext}`);
      if (fs.existsSync(fp) && fs.statSync(fp).size > 1000) { skipped++; done++; continue; }
      try {
        const res = await fetchWithRetry(prov.url(prov.zoom, x, y), { tries: 4, timeoutMs: 45000 });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 1000) throw new Error(`too small (${buf.length}B)`);
        fs.writeFileSync(fp, buf);
        done++;
      } catch (e) {
        failed++;
        log('sat', `FAIL ${x}/${y}: ${e.message}`);
      }
      if (done % 200 === 0) log('sat', `progress ${done}/${jobs.length} (skip ${skipped}, fail ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  fs.writeFileSync(path.join(DIRS.rawSat, 'meta.json'), JSON.stringify({
    provider: prov.key,
    source: prov.name,
    zoom: prov.zoom,
    bbox: SAT_BBOX,
    tileRange: { x0: range.x0, x1: range.x1, y0: range.y0, y1: range.y1 },
    cols: range.cols,
    rows: range.rows,
    tiles: range.total,
    srcW: range.srcW,
    srcH: range.srcH,
    downloadedAt: new Date().toISOString(),
    failed
  }, null, 2));

  log('sat', failed ? `DONE total=${range.total} ok=${done - skipped} skip=${skipped} FAIL=${failed}` : `DONE total=${range.total} ok=${done - skipped} skip=${skipped}`);
  return failed === 0;
}
