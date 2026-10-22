# PERFORMANCE(性能报告,方案 §52–53)

采集方式:页面 `?debug=1` HUD 或控制台 `__GZ_PERF__.getStats()`。
采集环境:Mac mini(M 系列)· Chrome/Edge · 1920×1080 · devicePixelRatio 1。

> **采集口径(V3.11 起)**:浏览器后台标签的 rAF 被节流到 1 Hz,HUD 的 FPS 会失真。
> 改用 `scripts/benchmark-cdp.mjs` 走 CDP 采集(`Page.bringToFront` 保证前台渲染),
> 并等待地形瓦片渐进构建完成(三角形数连续 3 次不变)后再读数。
> **跨版本对比必须在同一环境、同一流程下采集**,否则数字不可比。

## Guizhou Sandbox Benchmark — V3.11(2026-10-22 河流水平面轮)

| 视角 | FPS | Draw Calls | Triangles | 备注 |
| --- | --- | --- | --- | --- |
| **overview(全省斜俯视,LOD3)** | **60** | 47 | 0.32M | 与 V3.10 基线**完全一致**——远景水系隐藏,水面几何零成本 |
| central(黔中中景) | 60 | 76 | 2.67M | 水面几何(曲线细分 ×3) |
| city(贵阳近景) | 60 | 69 | 2.64M | |
| closeup(兴义万峰林近景) | 60 | 81 | 3.07M | |
| river(乌江峡谷中景) | 60 | 77 | 3.21M | 一级河 110 m 密采样,段数最多 |

### 与 V3.10 同环境对比(同机、同分辨率、同采集流程)

| 视角 | V3.10 | V3.11 | 三角形增量 | DrawCalls 增量 |
| --- | --- | --- | --- | --- |
| overview | 60 / 47 / 0.32M | 60 / 47 / 0.32M | **0%** | 0 |
| central | 59 / 75 / 2.48M | 60 / 76 / 2.67M | +7.7 % | +1 |
| city | 59 / 68 / 2.20M | 60 / 69 / 2.64M | +20.0 % | +1 |
| closeup | 60 / 80 / 2.63M | 60 / 81 / 3.07M | +16.7 % | +1 |
| river | 60 / 76 / 3.02M | 60 / 77 / 3.21M | +6.3 % | +1 |

> 河流水平面化的性能代价:三角形 +6.3 %–20.0 %(水面段按 Catmull-Rom 细分 ×3,岸线平滑),
> DrawCalls +1(水面/跌水/湖面共 5 个 mesh),各视角帧率均维持 60 FPS。远景隐藏水系 → 零开销。
> 单文件体积 25.3MB → **26.9MB**(`valley.bin` 下切表 gzip 后约 +0.9MB,`riverbed.bin` 水位序列 +0.6MB)。

## Guizhou Sandbox Benchmark — V3.10(2026-10-22 真实太阳与大气轮)

| 视角 | 时刻 | FPS | Draw Calls | Triangles | 备注 |
| --- | --- | --- | --- | --- | --- |
| overview(全省斜俯视,LOD3) | 10:30 | 59–60 | 47 | 0.32M | 阴影默认开启,与 V3.9 基线一致 |
| central(黔中中景,LOD0/1) | 15:30 | 60 | 65 | 1.65M | 投影阴影清晰可见 |

> 实时阴影(PCFSoft 2048)每帧更新,阴影相机范围随视距分档切换,实测无帧率回退。
> Preetham 天空为单个 ShaderMaterial(1 个 draw call);PMREM 环境贴图仅在太阳状态变化时重建。

## Guizhou Sandbox Benchmark — V3.9(2026-10-22 卫星底图轮)

| 视角 | FPS | Draw Calls | Triangles | 备注 |
| --- | --- | --- | --- | --- |
| **overview(全省斜俯视,LOD3)** | **60** | 47 | 0.32M | 与 V3.8 基线**完全一致**——底图零性能代价 |
| **city(贵阳近景)** | **60** | 68 | 1.71M | 与 V3.8 基线一致(底图近景降权至 0.22) |
| overview(单文件产物) | 59 | 47 | 0.32M | dist/guizhou-terrain.html,底图自 `gz://` 内联解码 |

> 底图(3328×2901 JPEG)为单张纹理,采样在片元着色器完成,顶点侧仅做一次逆投影;
> 各向异性过滤 8×。新增开销可忽略。
> 单文件体积 21.7MB → **25.3MB**(底图 gzip+base64 计 +3.6MB)。

## Guizhou Sandbox Benchmark — V3.8(2026-09-27 交互与表现批次)

| 视角 | FPS | Draw Calls | Triangles | 备注 |
| --- | --- | --- | --- | --- |
| city + 夜景 | 60 | 68 | 2.20M | V3.8 实测 |
| **city + 实时阴影** | **60** | 68 | 2.20M | V3.8 实测(PCFSoft 2048,无性能风险) |
| 移动端降档后 | — | — | — | pixelRatio≤1.5 + 树密度×0.5(触屏/短边<700) |

> Brotli 预压缩尝试后回退 gzip:浏览器 `DecompressionStream` 不支持 br。单文件 **21.7MB**。

## Guizhou Sandbox Benchmark — V3.6(2026-09-27 缩放流畅度轮)

### 缩放全程 FPS 采样(intro 飞入城市,每 0.8s 采样)
```
0fps(加载) → 55 → 58 → 57 → 58 → 59 → 60 → 60 → 60 → 60
三角形:0.36M → 1.89M → 2.47M(渐进增长,无突跳)
```
此前版本同类缩放会出现 36–50 FPS 深谷(多瓦片同帧重建)。

### 静态视角

| 视角 | FPS | Draw Calls | Triangles | 备注 |
| --- | --- | --- | --- | --- |
| overview(全省斜俯视,LOD3) | 60 | 47 | 0.32M | V3.5 实测 |
| river(乌江峡谷中近景,LOD0/1) | 60 | 56 | 3.21M | V3.2 实测 |
| city(贵阳近景) | 57–60 | 55–68 | 2.7M | V3.2–3.5 实测 |
| closeup(万峰林近景,LOD0) | 60 | 84 | 2.72M | V3.5 实测(微地形+树分区) |

### 单文件体积演进
- V3.3:60.5MB(base64 明文)→ **V3.5:21.7MB**(gzip+base64,DecompressionStream 解压)

> 注:后台标签页 rAF 暂停会显示 FPS 0,为浏览器行为;基准均在页面前台时采集。

## V3.0 基准(2026-09-26 首版)

| 视角 | FPS | Draw Calls | Triangles |
| --- | --- | --- | --- |
| overview | 60 | 46 | 0.27M |
| city | 60 | 55 | 2.46M |
| closeup | 60 | 34 | 2.23M |

## 目标对照(方案 §32 / §33)

| 指标 | 目标 | 实测 | 结论 |
| --- | --- | --- | --- |
| 全省 FPS | ≥ 50 | 60 | ✓ |
| 正常观察 FPS | ≥ 60 | 60 | ✓ |
| 近距离 FPS | ≥ 45 | 50–60 | ✓ |
| Draw Calls | < 300(理想 < 150) | 34–55 | ✓ 理想区间 |

## 资源账

- 地形:36 瓦片(512×512 格/瓦),LOD 步长 {1,2,4,16},LOD 距离 {12,30,64} 世界单位;裙边遮蔽接缝
- 高程栅格:3072×2654 Uint16(16.3MB)+ 掩膜/缓冲带 Uint8 ×2
- 卫星底图:3328×2901 JPEG(2.7MB,≈204m/px),单张纹理 + mipmap,各向异性 8×
- 树木:4 类 InstancedMesh 合计 ~4.4 万实例(camDist<42 显示)
- 建筑:贵阳真实 footprint 2823 栋 1 个 InstancedMesh + 程序化 1 个
- 水系:河流 3 个合并 Mesh(按等级)+ 湖泊 1 个;道路 2 个合并 Mesh;边界 2 个 LineSegments + 省界 1 条带
- 运行时数据合计 ≈ 43.2MB(dev/外置);单文件版 25.3MB

## 优化手段(方案 §33)

InstancedMesh ✓ / Frustum Culling ✓(瓦片级)/ Distance Culling ✓(树/水面/标签/县界/底图权重)/ LOD ✓(地形四级、标签分级、水面烙印替代)/ Geometry Merge ✓(河流/道路/边界按级合并)/ 卫星底图 ✓(单张纹理 + 逐顶点反投影,零配准误差)

## 已知瓶颈

- 城市近景 2.5M 三角形来自 LOD0/1 地形(网格 218m)+ 4 万树;如需更高帧率可提升 LOD 切换距离
- 峡谷近景河道弦差问题已通过 meshHeightAt 贴地 + 远景烙印缓解,极深 V 谷内水面仍可能部分嵌入谷壁

<!-- kimi-badge -->
[![powered by KimiCode](../.github/assets/kimi-badge.svg)](https://www.kimi.com/code)
