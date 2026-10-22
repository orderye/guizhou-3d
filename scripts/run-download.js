// 数据下载总入口:npm run download
import { downloadDem } from './download/dem.mjs';
import { downloadAdmin } from './download/admin.mjs';
import { downloadOsm } from './download/osm.mjs';
import { downloadSatellite } from './download/satellite.mjs';
import { log } from './config.mjs';

const only = process.argv[2]; // dem | admin | osm | sat | (空=全部)

async function main() {
  const tasks = [];
  if (!only || only === 'dem') tasks.push(['dem', downloadDem]);
  if (!only || only === 'admin') tasks.push(['admin', downloadAdmin]);
  if (!only || only === 'osm') tasks.push(['osm', downloadOsm]);
  if (!only || only === 'sat') tasks.push(['sat', downloadSatellite]);
  let ok = true;
  for (const [name, fn] of tasks) {
    try {
      log('run', `>>> ${name}`);
      const r = await fn();
      if (r === false) ok = false;
    } catch (e) {
      ok = false;
      log('run', `${name} CRASHED: ${e.stack || e.message}`);
    }
  }
  log('run', ok ? 'ALL DOWNLOADS OK' : 'DOWNLOADS FINISHED WITH FAILURES');
  process.exit(ok ? 0 : 1);
}
main();
