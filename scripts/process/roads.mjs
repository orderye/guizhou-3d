// 道路预处理:OSM 高速/国道/省道 → 贵州裁剪、简化、世界坐标
import fs from 'node:fs';
import path from 'node:path';
import { DIRS, log } from '../config.mjs';
import { clipLine, projToWorldArr, loadMask } from './hydro.mjs';

export function run() {
  const t0 = Date.now();
  const { mask, meta } = loadMask();
  const fp = path.join(DIRS.rawOsm, 'roads.json');
  const fp2 = path.join(DIRS.rawOsm, 'roads-secondary.json');
  if (!fs.existsSync(fp)) { log('roads', 'roads.json 缺失,跳过'); return; }
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const raw2 = fs.existsSync(fp2)
    ? JSON.parse(fs.readFileSync(fp2, 'utf8')) : { elements: [] };
  const features = [];
  const classify = (hw) => {
    if (hw.startsWith('motorway') || hw.startsWith('trunk')) return 1;
    if (hw.startsWith('primary')) return 2;
    return 3; // secondary/tertiary 主要省道
  };
  for (const el of [...raw.elements, ...raw2.elements]) {
    if (el.type !== 'way' || !el.geometry) continue;
    const hw = (el.tags || {}).highway || '';
    const cls = classify(hw);
    const lonlat = el.geometry.map(g => [g.lon, g.lat]);
    const runs = clipLine(lonlat, mask, meta, 260, 600);
    for (const runProj of runs) {
      if (runProj.length / 2 < 3) continue;
      const simp = simplify(runProj, cls === 3 ? 260 : 200);
      features.push({ c: cls, p: Array.from(projToWorldArr(simp)) });
    }
  }
  const cc = [0, 0, 0, 0];
  features.forEach(f => cc[f.c]++);
  log('roads', `segments: ${features.length} (高速/国道 ${cc[1]}, 国省道 ${cc[2]}, 主要省道 ${cc[3]}) in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  fs.mkdirSync(path.join(DIRS.runtime, 'cities'), { recursive: true });
  fs.writeFileSync(path.join(DIRS.runtime, 'cities/roads.json'), JSON.stringify({ features }));
}

// 局部引用避免循环依赖(同 hydro 的 simplifyDP)
import { simplifyDP } from './geometry.mjs';
function simplify(line, tol) { return simplifyDP(line, tol); }

if (process.argv[1] && process.argv[1].endsWith('roads.mjs')) run();
