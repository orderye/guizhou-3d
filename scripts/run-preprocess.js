// 预处理总入口:npm run preprocess
import { log } from './config.mjs';
import { run as runAdmin } from './process/admin.mjs';
import { run as runDem } from './process/dem.mjs';
import { run as runSatellite } from './process/satellite.mjs';
import { run as runHydro } from './process/hydro.mjs';
import { run as runValley } from './process/valley.mjs';
import { run as runAo } from './process/ao.mjs';
import { run as runCities } from './process/cities.mjs';
import { run as runRoads } from './process/roads.mjs';
import { run as runVegetation } from './process/vegetation.mjs';
import { run as runBuildings } from './process/buildings.mjs';

const steps = [
  ['admin 边界', runAdmin],
  ['dem 地形', runDem],
  ['satellite 底图', runSatellite],
  ['hydro 水系', runHydro],
  ['valley 河谷下切', runValley],
  ['ao 环境光遮蔽', runAo],
  ['cities 城市', runCities],
  ['roads 道路', runRoads],
  ['vegetation 植被', runVegetation],
  ['buildings 建筑', runBuildings]
];

const only = process.argv[2];
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
