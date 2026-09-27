# PERFORMANCE(性能报告,方案 §52–53)

采集方式:页面 `?debug=1` HUD 或控制台 `__GZ_PERF__.getStats()`。
采集环境:Mac mini(M 系列)· Chrome · 1600×1000 · devicePixelRatio ≤ 2。

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
- 树木:4 类 InstancedMesh 合计 ~4.4 万实例(camDist<42 显示)
- 建筑:贵阳真实 footprint 2823 栋 1 个 InstancedMesh + 程序化 1 个
- 水系:河流 3 个合并 Mesh(按等级)+ 湖泊 1 个;道路 2 个合并 Mesh;边界 2 个 LineSegments + 省界 1 条带
- 运行时数据合计 ≈ 40.5MB(dev/外置);单文件版 ≈ 57.3MB

## 优化手段(方案 §33)

InstancedMesh ✓ / Frustum Culling ✓(瓦片级)/ Distance Culling ✓(树/水面/标签/县界)/ LOD ✓(地形四级、标签分级、水面烙印替代)/ Geometry Merge ✓(河流/道路/边界按级合并)/ Texture Atlas —(未用贴图,顶点色方案)

## 已知瓶颈

- 城市近景 2.5M 三角形来自 LOD0/1 地形(网格 218m)+ 4 万树;如需更高帧率可提升 LOD 切换距离
- 峡谷近景河道弦差问题已通过 meshHeightAt 贴地 + 远景烙印缓解,极深 V 谷内水面仍可能部分嵌入谷壁
