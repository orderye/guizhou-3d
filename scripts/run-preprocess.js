// 预处理总入口:npm run preprocess
import { log } from './config.mjs';
import { run as runAdmin } from './process/admin.mjs';
import { run as runMask } from './process/mask.mjs';
import { run as runElev } from './process/elev.mjs';
import { run as runSatellite } from './process/satellite.mjs';
import { run as runHydro } from './process/hydro.mjs';
import { run as runValley } from './process/valley.mjs';
import { run as runAo } from './process/ao.mjs';
import { run as runCities } from './process/cities.mjs';
import { run as runRoads } from './process/roads.mjs';
import { run as runVegetation } from './process/vegetation.mjs';
import { run as runBuildings } from './process/buildings.mjs';

// 步骤顺序即依赖顺序:掩膜 → 高程 → 卫星 → 水系 → 河谷 → AO → 城市 → 道路 → 植被 → 建筑
// (河谷下切与 AO 都读高程;植被读高程 + 水系 + 城市)
const steps = [
  ['admin 边界', runAdmin],
  ['mask 省界掩膜', runMask],
  ['elev 高程', runElev],
  ['satellite 底图', runSatellite],
  ['hydro 水系', runHydro],
  ['valley 河谷下切', runValley],
  ['ao 环境光遮蔽', runAo],
  ['cities 城市', runCities],
  ['roads 道路', runRoads],
  ['vegetation 植被', runVegetation],
  ['buildings 建筑', runBuildings]
];

// 只跑指定步骤:npm run preprocess mask / npm run preprocess -- --legacy-terrarium
// (第一个非 -- 开头参数视为步骤名过滤)
const only = process.argv.slice(2).find(a => !a.startsWith('--'));
let failed = [];
for (const [name, fn] of steps) {
  if (only && !name.startsWith(only)) continue;
  try {
    log('pre', `>>> ${name}`);
    fn();
  } catch (e) {
    failed.push(name);
    log('pre', `${name} FAILED: ${e.stack || e.message}`);
  }
}
log('pre', failed.length ? `PREPROCESS FAILED: ${failed.join(', ')}` : 'PREPROCESS ALL OK');
process.exit(failed.length ? 1 : 0);
