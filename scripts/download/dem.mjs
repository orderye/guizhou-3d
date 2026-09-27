// 下载覆盖贵州的 Terrarium DEM 瓦片(AWS Open Data,Mapzen Terrain Tiles)
// 数据为真实 DEM(SRTM/NED/GMTED 等混合源),terrarium 编码:elev = R*256 + G + B/256 - 32768
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, DEM_Z, DEM_BBOX, log, fetchWithRetry } from '../config.mjs';

const BASE = 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium';

function lonToTileX(lon, z) { return Math.floor(((lon + 180) / 360) * 2 ** z); }
function latToTileY(lat, z) {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
}

export async function downloadDem() {
  fs.mkdirSync(DIRS.rawDem, { recursive: true });
  const { south, west, north, east } = DEM_BBOX;
  const x0 = lonToTileX(west, DEM_Z), x1 = lonToTileX(east, DEM_Z);
  const y0 = latToTileY(north, DEM_Z), y1 = latToTileY(south, DEM_Z);
  const jobs = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) jobs.push({ x, y });
  log('dem', `z${DEM_Z} tiles: ${jobs.length} (x ${x0}-${x1}, y ${y0}-${y1})`);

  let done = 0, skipped = 0, failed = 0;
  const CONC = 12;
  let idx = 0;
  async function worker() {
    while (idx < jobs.length) {
      const { x, y } = jobs[idx++];
      const fp = path.join(DIRS.rawDem, `z${DEM_Z}_${x}_${y}.png`);
      if (fs.existsSync(fp) && fs.statSync(fp).size > 100) { skipped++; done++; continue; }
      try {
        const res = await fetchWithRetry(`${BASE}/${DEM_Z}/${x}/${y}.png`, { tries: 4, timeoutMs: 45000 });
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 200) throw new Error('too small');
        fs.writeFileSync(fp, buf);
        done++;
      } catch (e) {
        failed++;
        log('dem', `FAIL ${x}/${y}: ${e.message}`);
      }
      if (done % 50 === 0) log('dem', `progress ${done}/${jobs.length} (skip ${skipped}, fail ${failed})`);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));
  log('dem', `DONE total=${jobs.length} ok=${done - skipped} skip=${skipped} fail=${failed}`);
  fs.writeFileSync(path.join(DIRS.rawDem, 'meta.json'), JSON.stringify({
    source: 'Mapzen Terrain Tiles (AWS Open Data) terrarium PNG',
    url: BASE, zoom: DEM_Z, tileRange: { x0, x1, y0, y1 }, bbox: DEM_BBOX,
    downloadedAt: new Date().toISOString(), tiles: jobs.length, failed
  }, null, 2));
  return failed === 0;
}
