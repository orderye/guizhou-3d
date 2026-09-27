// 下载贵州行政区划边界(DataV GeoAtlas,真实行政区边界)
// 省界 520000.json / 市州界 520000_full.json / 各市州县级 full
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log, fetchWithRetry } from '../config.mjs';

const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';
// 贵州省 9 个市州 adcode
export const PREFECTURES = [
  ['520100', '贵阳市'], ['520200', '六盘水市'], ['520300', '遵义市'], ['520400', '安顺市'],
  ['520500', '毕节市'], ['520600', '铜仁市'], ['522300', '黔西南布依族苗族自治州'],
  ['522600', '黔东南苗族侗族自治州'], ['522700', '黔南布依族苗族自治州']
];

async function get(code) {
  const fp = path.join(DIRS.rawAdmin, `${code}.json`);
  if (fs.existsSync(fp) && fs.statSync(fp).size > 500) { log('admin', `cached ${code}`); return; }
  const res = await fetchWithRetry(`${BASE}/${code}.json`, { tries: 3, timeoutMs: 30000 });
  fs.writeFileSync(fp, Buffer.from(await res.arrayBuffer()));
  log('admin', `saved ${code} (${(fs.statSync(fp).size / 1024).toFixed(0)}KB)`);
}

export async function downloadAdmin() {
  fs.mkdirSync(DIRS.rawAdmin, { recursive: true });
  await get('520000');            // 省界
  await get('520000_full');       // 市州界
  for (const [code] of PREFECTURES) await get(`${code}_full`); // 县级界
  fs.writeFileSync(path.join(DIRS.rawAdmin, 'meta.json'), JSON.stringify({
    source: 'DataV GeoAtlas areas_v3 (阿里云),省级/市州级/县级 GeoJSON',
    url: BASE, downloadedAt: new Date().toISOString(),
    prefectures: PREFECTURES
  }, null, 2));
  log('admin', 'DONE');
}
