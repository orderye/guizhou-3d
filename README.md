# 贵州三维地形沙盘 V3(Guizhou 3D Terrain Sandbox)

真实 DEM + 真实行政边界 + 真实 OSM 水系/城市/道路/林地驱动的"博物馆级"贵州省立体地形沙盘。
方案文档见上级目录 `Guizhou_3D_Terrain_Sandbox_V3_Agent_一体化实施方案.md`。

## 快速开始

```bash
npm install
npm run download      # 下载原始数据(DEM/边界/OSM,已执行过,幂等)
npm run preprocess    # 预处理 → public/runtime(已执行过)
npm run validate-data # 数据完整性检查(当前 PASS)
npm run dev           # http://127.0.0.1:5173
```

## 交付物

| 产物 | 路径 | 说明 |
| --- | --- | --- |
| 单文件版 | `dist/guizhou-terrain.html` | 57.3MB,数据全内嵌,浏览器直接打开,离线可用 |
| 外置数据版 | `dist/web/`(需 `npm run build` 后随 public/runtime 一起部署) | 轻量页面 + 40.5MB 数据 |
| 8 视角截图 | `screenshots/01-overview.png … 08-closeup.png` | 方案 §40 视觉验收 |
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
- 开场动画:`?intro=1`(高空缓降入场)
- **夜景**:`?night=1`;**实时阴影**:`?shadow=1`(M4 实测 60 FPS)
- 分享链接:`?cam=x,y,z&tgt=x,y,z&ex=2.8`(C 键一键生成)
- 调试:`?debug=1`(FPS / DrawCalls / Triangles / 相机距离 / 瓦片数;控制台 `__GZ_PERF__.getStats()`)

## 数据与许可

DEM(Mapzen/AWS Open Data)· 行政边界(DataV GeoAtlas)· OSM(© OpenStreetMap contributors, ODbL)。
详见 `docs/DATA_SOURCES.md`;程序化视觉内容均已明确标注。
