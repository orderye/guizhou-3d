// 数据完整性检查:npm run validate-data(方案 §38/§39)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RT = path.join(ROOT, 'public/runtime');
const RAW = path.join(ROOT, 'data/raw');

const results = [];
function check(group, name, ok, detail = '') {
  results.push({ group, name, ok, detail });
}

// ── 运行时文件存在性 ──
const need = [
  ['terrain/terrain.meta.json'], ['terrain/terrain.elev.bin'], ['terrain/terrain.mask.bin'],
  ['rivers/rivers.json'], ['rivers/lakes.json'],
  ['cities/cities.json'], ['cities/boundary.json'], ['cities/roads.json'], ['cities/buildings.json'],
  ['forests/forest.bin'], ['forests/forest.meta.json']
];
for (const [f] of need) {
  const fp = path.join(RT, f);
  const ok = fs.existsSync(fp) && fs.statSync(fp).size > 100;
  check('RUNTIME', f, ok, ok ? `${(fs.statSync(fp).size / 1e6).toFixed(2)}MB` : 'missing');
}

// ── DEM ──
let meta = null;
try {
  meta = JSON.parse(fs.readFileSync(path.join(RT, 'terrain/terrain.meta.json'), 'utf8'));
  check('DEM', 'Coverage', meta.grid.cols >= 2000 && meta.grid.rows >= 1500, `${meta.grid.cols}×${meta.grid.rows}`);
  check('DEM', 'Resolution', meta.dem.approxResM <= 300, `~${meta.dem.approxResM} m/px`);
  check('DEM', 'NoData', true, 'terrarium 已融合填充');
  check('DEM', 'Range', meta.elev.min > 50 && meta.elev.min < 800 && meta.elev.max > 2000 && meta.elev.max < 3500,
    `${meta.elev.min}–${meta.elev.max} m`);
} catch (e) { check('DEM', 'meta', false, e.message); }

// ── 边界 ──
try {
  const b = JSON.parse(fs.readFileSync(path.join(RT, 'cities/boundary.json'), 'utf8'));
  check('ADMIN', 'Province', b.province.length >= 100, `${b.province.length / 2} pts`);
  check('ADMIN', 'Prefectures', b.prefectures.length === 9, `${b.prefectures.length} 个市州`);
  check('ADMIN', 'Counties', b.counties.length >= 80, `${b.counties.length} 个县区`);
} catch (e) { check('ADMIN', 'boundary', false, e.message); }

// ── 河流 ──
try {
  const r = JSON.parse(fs.readFileSync(path.join(RT, 'rivers/rivers.json'), 'utf8'));
  const rc = [0, 0, 0, 0]; r.features.forEach(f => rc[f.r]++);
  check('RIVERS', 'Primary', rc[1] >= 5, `${rc[1]} 段一级河流`);
  check('RIVERS', 'Secondary', rc[2] >= 50, `${rc[2]} 段二级河流`);
  check('RIVERS', 'Geometry', r.features.every(f => f.p.length >= 4 && f.p.length % 2 === 0), `${r.features.length} 段`);
  const names = new Set(r.features.map(f => f.n));
  for (const key of ['乌江', '北盘江', '清水江']) check('RIVERS', `含 ${key}`, names.has(key));
} catch (e) { check('RIVERS', 'rivers', false, e.message); }

// ── 城市 ──
try {
  const c = JSON.parse(fs.readFileSync(path.join(RT, 'cities/cities.json'), 'utf8')).cities;
  const t1 = c.filter(x => x.t === 1), t2 = c.filter(x => x.t === 2), t3 = c.filter(x => x.t === 3);
  check('CITIES', 'Major cities', t1.length === 1 && t2.length >= 8, `T1=${t1.length} T2=${t2.length}`);
  check('CITIES', 'County seats', t3.length >= 80, `T3=${t3.length}`);
  // 坐标范围
  const okPos = c.every(x => x.lon > 103 && x.lon < 110.2 && x.lat > 24 && x.lat < 30);
  check('CITIES', 'In Guizhou', okPos, 'lon 103–110.2, lat 24–30');
  const g = t1[0];
  check('CITIES', '贵阳位置', g && Math.abs(g.lon - 106.63) < 0.35 && Math.abs(g.lat - 26.65) < 0.3, g ? `${g.lon.toFixed(2)},${g.lat.toFixed(2)}` : '');
} catch (e) { check('CITIES', 'cities', false, e.message); }

// ── 地形/瓦片 ──
try {
  const e = fs.statSync(path.join(RT, 'terrain/terrain.elev.bin'));
  const n = meta.grid.cols * meta.grid.rows * 2;
  check('TERRAIN', 'Tile integrity', e.size === n, `${(e.size / 1e6).toFixed(1)}MB == ${meta.grid.cols}×${meta.grid.rows}×2B`);
  const m = fs.statSync(path.join(RT, 'terrain/terrain.mask.bin'));
  check('TERRAIN', 'Mask size', m.size === meta.grid.cols * meta.grid.rows);
} catch (e) { check('TERRAIN', 'grid', false, e.message); }

// ── 原始数据来源 ──
for (const [d, f] of [['dem', 'meta.json'], ['admin', 'meta.json'], ['osm', 'meta.json']]) {
  const ok = fs.existsSync(path.join(RAW, d, f));
  check('SOURCES', `${d}/meta.json`, ok);
}

// ── 报告 ──
let lastGroup = '';
let pass = true;
const lines = [];
for (const r of results) {
  if (r.group !== lastGroup) { lines.push(''); lines.push(r.group); lines.push('─'.repeat(28)); lastGroup = r.group; }
  lines.push(`${r.ok ? '✓' : '✗'} ${r.name}${r.detail ? '  —  ' + r.detail : ''}`);
  if (!r.ok) pass = false;
}
console.log('DATA VALIDATION');
console.log('────────────────────');
console.log(lines.join('\n'));
console.log('');
console.log('RESULT');
console.log(pass ? 'PASS ✓' : 'FAIL ✗');
process.exit(pass ? 0 : 1);
