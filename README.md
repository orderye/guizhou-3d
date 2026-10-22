# 贵州三维地形沙盘 V3(Guizhou 3D Terrain Sandbox)

<!-- kimi-badge -->
[![powered by KimiCode](.github/assets/kimi-badge.svg)](https://www.kimi.com/code)

真实 DEM + 真实卫星影像底图 + 真实太阳与大气散射 + 真实行政边界 + 真实 OSM 水系/城市/道路/林地驱动的"博物馆级"贵州省立体地形沙盘。
方案文档见上级目录 `Guizhou_3D_Terrain_Sandbox_V3_Agent_一体化实施方案.md`。

## 快速开始

```bash
npm install
npm run download      # 下载原始数据(DEM/边界/OSM/卫星,已执行过,幂等)
npm run preprocess    # 预处理 → public/runtime(已执行过)
npm run validate-data # 数据完整性检查(当前 PASS)
npm run dev           # http://127.0.0.1:5173
```

> 河流水位与河谷下切表由 `npm run preprocess`(含 `valley` 步骤)生成:`terrain/valley.bin`(逐格下切米数)+ `rivers/riverbed.bin`(各河采样点与真实水位);`terrain/ao.bin` 为基于真实 DEM 的环境光遮蔽。
> DEM 为 **Copernicus GLO-30**(30 m,EGM2008 改正为正高),运行时 218 m/格。重新抓取需 Python 依赖:
> `python3 -m venv .venv && .venv/bin/pip install numpy rasterio`,大地水准面格网取自 `https://cdn.proj.org/us_nga_egm08_25.tif` → `data/raw/geoid/egm2008.tif`,然后
> `.venv/bin/python scripts/download/glo30.py --res 218 --from-cache 120`(可由已缓存的 120 m 网格重采样)。
> 高程重采样与 `terrain.meta.json` 生成由 `npm run preprocess`(elev 步骤)自动完成,网格真源统一在 `scripts/config.mjs` 的 `GRID` 常量(格心约定)。
> 卫星底图单独下载:`npm run download sat`;单独合成:`npm run preprocess satellite`;
> 配准验证:`node scripts/validate-satellite.mjs`(输出 `data/processed/validate/sat_overlay.png`)。

## 交付物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 单文件版 | `dist/guizhou-terrain.html` | 25.3MB,数据全内嵌,浏览器直接打开,离线可用 |
| 外置数据版 | `dist/web/`(需 `npm run build` 后随 public/runtime 一起部署) | 轻量页面 + 43.2MB 数据 |
| 截图 | `screenshots/01-overview.png … 08-closeup.png` | 方案 §40 视觉验收 |
| 水平河面截图 | `screenshots/16-river-horizontal.png`、`17-overview-horizontal.png` | V3.11 河流水平面 |
| 卫星底图截图 | `screenshots/09-overview-satellite.png`、`10-city-satellite.png`、`11-singlefile-overview.png` | V3.9 底图效果 |
| 文档 | `docs/DATA_SOURCES.md` `docs/ARCHITECTURE.md` `docs/PERFORMANCE.md` `docs/CHANGELOG.md` | 数据来源/结构/性能/变更 |

## 交互

- 鼠标:左键旋转 / 右键平移 / 滚轮缩放 / **双击飞往该点**
- 键盘:**WASD**/方向键移动 · **Q/E** 或空格升降 · **Shift** 加速 3.2×
- **N** 夜景模式 · **C** 复制当前视角链接 · **P** 截图导出 PNG
- 触屏:单指旋转 / 双指缩放平移(移动端自动降档:pixelRatio/树密度)
- 自动贴地:漫游不会穿入山体,且被限制在省域范围内

## URL 参数(方案 §56)

- 视角:`?view=overview|north|west|central|south|city|river|closeup`
- 开关:`?terrain=0&water=0&forest=0&city=0&road=0&boundary=0`
- 高程夸张:`?exaggeration=3`(默认 2.8;运行时可控制台 `__GZ__.getExaggeration()`/`setExaggeration(n)` 热切换)
- **卫星底图**:`?sat=0.8`(权重 0–1,默认 0.78)、`?satsat=0.6`(饱和度,默认 0.62);运行时 `__GZ__.setSatMix(v)`/`setSatSat(v)` 热调
- **太阳时刻**:`?time=17:40`(当地 HH:MM)、`?date=2026-10-22`;运行时 `__GZ__.setSunTime('17:40')`/`getSun()`
- 开场动画:`?intro=1`(高空缓降入场)
- **夜景**:`?night=1`;**实时阴影**:默认开启,`?shadow=0` 关闭
- 分享链接:`?cam=x,y,z&tgt=x,y,z&ex=2.8`(C 键一键生成)
- 调试:`?debug=1`(FPS / DrawCalls / Triangles / 相机距离 / 瓦片数;控制台 `__GZ_PERF__.getStats()`)

## 数据与许可

DEM(Mapzen/AWS Open Data)· 卫星影像(Esri World Imagery)· 行政边界(DataV GeoAtlas)· OSM(© OpenStreetMap contributors, ODbL)。
详见 `docs/DATA_SOURCES.md`;程序化视觉内容均已明确标注。
