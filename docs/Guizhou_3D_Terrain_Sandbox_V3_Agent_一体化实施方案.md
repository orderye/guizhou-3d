# Guizhou 3D Terrain Sandbox V3
## 贵州真实三维地形立体沙盘 Agent 一体化实施方案

**版本：V3.0**  
**目标平台：Web / Chrome / Edge / Safari**  
**核心引擎：Three.js + WebGL/WebGPU 可选**  
**最终形态：模块化工程 + 单 HTML 发布版本**

---

## 1. 项目总目标

制作一个“真实数据驱动的贵州省三维立体地形沙盘”。

它不是普通二维地图，也不是游戏地图，而是类似博物馆实体地形模型的数字化版本。

### 核心视觉目标

1. 贵州真实地形必须来自真实 DEM。
2. 山脉、峡谷、河流、盆地、平坝必须保持真实空间关系。
3. 允许垂直高程夸张，但不能破坏真实地形结构。
4. 河流必须贴合真实地形并表现河谷切割。
5. 森林必须形成大面积真实植被覆盖，而不是简单撒满小树。
6. 县级城市和乡镇必须真实存在于正确地理位置。
7. 城市采用低模化表达，不追求单栋建筑真实建模。
8. 贵州省行政区边界必须真实。
9. 支持自由旋转、缩放、平移。
10. 默认采用具有立体感的第三视角斜俯视镜头。
11. 不显示传统 GIS UI。
12. 默认界面尽可能干净，只呈现三维沙盘。
13. 最终能够输出单 HTML 版本。
14. 任何数据不能伪造成“真实数据”。
15. 如果某一数据源无法获得，必须明确标记为 placeholder，而不是编造。

### 总体原则

> REAL DATA > PROCEDURAL VISUALIZATION > DECORATION

真实 DEM、河流、行政区、城市位置优先；程序化生成森林、岩石、材质、建筑群；装饰效果最后考虑。

---

# 2. 总体技术架构

```text
                     ┌──────────────────┐
                     │  Raw GIS Data    │
                     └────────┬─────────┘
                              ↓
                 ┌────────────────────────┐
                 │ GIS Data Preprocessor  │
                 └────────────┬───────────┘
                              ↓
        ┌─────────────────────┼────────────────────┐
        ↓                     ↓                    ↓
      DEM                  Hydrography          OSM/GIS
        ↓                     ↓                    ↓
      Terrain              Rivers/Lakes       City/Road
        └─────────────────────┼────────────────────┘
                              ↓
                    ┌──────────────────┐
                    │ Terrain Builder  │
                    └────────┬─────────┘
                             ↓
                   ┌──────────────────┐
                   │ Three.js Engine  │
                   └────────┬─────────┘
                            ↓
       ┌──────────┬─────────┼─────────┬──────────┐
       ↓          ↓         ↓         ↓          ↓
   Terrain     Water      Forest    Cities     Roads
       │          │         │         │          │
       └──────────┴─────────┼─────────┴──────────┘
                            ↓
                     LOD / Culling
                            ↓
                     Lighting / AO
                            ↓
                       Final Scene
```

---

# 3. 数据源策略

## 3.1 DEM

优先：

- Copernicus DEM GLO-30
- 备用：SRTM / HydroSHEDS 派生 DEM

要求：

- 真实覆盖贵州
- 保留原始数据
- 记录来源、下载日期、版本
- 预处理后生成运行时数据

---

## 3.2 河流与水系

优先：

- HydroSHEDS
- HydroRIVERS
- HydroLAKES
- OSM 局部补充

分为：

```text
Primary River
Secondary River
Minor River
Stream
```

主河流必须优先保证真实空间关系。

重点水系包括：

- 乌江
- 赤水河
- 北盘江
- 南盘江
- 清水江
- 主要支流及湖泊

---

## 3.3 城市、道路、建筑

优先使用贵州区域 OSM 数据。

数据处理：

```text
OSM
 ↓
Osmium / GDAL
 ↓
roads
buildings
places
water
landuse
 ↓
Guizhou Clip
 ↓
Simplify
 ↓
LOD
```

---

# 4. 数据目录

```text
guizhou-3d/
│
├── app/
│   ├── index.html
│   ├── main.ts
│   ├── scene/
│   ├── terrain/
│   ├── water/
│   ├── forest/
│   ├── cities/
│   ├── roads/
│   ├── labels/
│   ├── shaders/
│   └── utils/
│
├── data/
│   ├── raw/
│   │   ├── dem/
│   │   ├── rivers/
│   │   ├── lakes/
│   │   ├── admin/
│   │   └── osm/
│   │
│   ├── processed/
│   │   ├── terrain/
│   │   ├── hydro/
│   │   ├── cities/
│   │   ├── roads/
│   │   └── vegetation/
│   │
│   └── runtime/
│       ├── terrain/
│       ├── rivers/
│       ├── cities/
│       └── forests/
│
├── scripts/
│   ├── download/
│   ├── dem/
│   ├── hydro/
│   ├── osm/
│   ├── terrain/
│   └── build/
│
├── public/
├── dist/
│
└── docs/
    ├── DATA_SOURCES.md
    ├── ARCHITECTURE.md
    ├── PERFORMANCE.md
    └── CHANGELOG.md
```

---

# 5. 数据预处理

Agent 不允许直接把原始 GIS 数据扔进 Three.js。

必须：

```text
Raw
 ↓
Validate
 ↓
Clip
 ↓
Reproject
 ↓
Simplify
 ↓
Compress
 ↓
Tile
 ↓
Runtime
```

---

# 6. 坐标系统

原始 GIS 数据可保持：

```text
EPSG:4326
```

但 Three.js 世界坐标不能直接使用经纬度。

统一：

```text
longitude → X
latitude  → Z
elevation → Y
```

实际渲染使用局部投影坐标：

```javascript
X = projectedX - originX
Z = projectedY - originY
Y = elevation * verticalScale
```

---

# 7. 贵州边界裁剪

流程：

```text
Guizhou Province Polygon
        ↓
DEM
        ↓
Clip by Guizhou boundary
        ↓
Mask outside
        ↓
Edge Fade
        ↓
Terrain Base
```

边缘不要直接形成生硬垂直切断。

---

# 8. Terrain Mesh

不要直接创建超大单体 Mesh。

采用：

```text
Tile Terrain
```

例如：

```text
16 × 16 tiles
```

每 Tile：

```text
128 × 128
```

或：

```text
256 × 256
```

具体参数由性能测试决定。

---

# 9. Terrain LOD

建议：

```text
LOD0 = 全省
LOD1 = 大区域
LOD2 = 中区域
LOD3 = 近距离
```

例如：

```text
LOD0: 64×64
LOD1: 128×128
LOD2: 256×256
LOD3: 512×512
```

实际参数由 Agent 根据 GPU benchmark 自动调整。

---

# 10. 高程夸张

禁止简单：

```javascript
height *= 3;
```

建议：

```javascript
normalizedHeight = normalize(height);

visualHeight =
    Math.pow(normalizedHeight, heightCurve)
    * verticalScale;
```

初始参数：

```text
heightCurve = 1.15
verticalScale = 2.8
```

要求：

- 保持山脉空间关系
- 保持真实高低顺序
- 不改变城市位置
- 不改变河流方向
- 只增强垂直视觉比例

---

# 11. 峡谷增强

结合：

```text
坡度
+
河流距离
+
局部高程差
```

进行视觉增强。

禁止：

- 把所有陡坡变成峡谷
- 手工修改真实主河道
- 随机制造大型峡谷

---

# 12. 地貌视觉分区

允许进行视觉参数分区，但不能修改真实地理结构：

```text
黔北
黔西
黔中
黔南
黔东南
```

可以调整：

- vertical exaggeration
- material
- vegetation density
- rock exposure

---

# 13. Terrain Shader

至少使用：

```text
Elevation
Slope
Aspect
Noise
AO
Hillshade
```

建议：

```text
terrainColor =
    elevationColor
    *
    slopeColor
    *
    noise
    *
    ambientOcclusion
```

---

# 14. 地形颜色

建议：

```text
低海拔 → 黄绿色
中海拔 → 深绿色
高海拔 → 灰绿色
陡峭岩壁 → 灰褐色
裸岩 → 灰白色
河谷 → 深绿色
```

禁止整块贵州使用单一绿色。

---

# 15. Hillshade

生成：

```text
hillshade
```

初始太阳参数：

```text
azimuth = 315°
altitude = 45°
```

与地形材质融合，增强山脊、峡谷和坡面的立体感。

---

# 16. 森林系统

必须优先使用：

```text
THREE.InstancedMesh
```

森林结构：

```text
ForestTile
 ├── TreeTypeA
 ├── TreeTypeB
 ├── TreeTypeC
 └── Shrub
```

每个实例只存：

```text
position
rotation
scale
```

---

# 17. 森林密度

根据：

```text
landcover
+
elevation
+
slope
+
river distance
```

计算：

```javascript
density =
    landcoverWeight
    *
    slopeWeight
    *
    elevationWeight;
```

---

# 18. 森林遮罩

建立：

```text
cityMask
roadMask
riverMask
```

避免树木出现在：

- 城市中心
- 主要道路
- 河道
- 建筑物内部

---

# 19. 城市系统

分级：

```text
Tier 1
省会 / 主要城市

Tier 2
地级市 / 州府

Tier 3
县城

Tier 4
普通乡镇
```

主要城市包括：

- 贵阳
- 遵义
- 六盘水
- 安顺
- 毕节
- 铜仁
- 凯里
- 都匀
- 兴义

---

# 20. 城市模型

Tier 1：

```text
真实道路
+
建筑 footprint
+
建筑高度估计
```

Tier 2：

```text
建筑群
+
主要道路
```

Tier 3：

```text
城市 footprint
+
低模建筑
```

Tier 4：

```text
小型建筑 cluster
```

不追求每栋建筑的高精度。

---

# 21. 城市贴地

所有建筑：

```javascript
buildingY =
    sampleTerrain(buildingX, buildingZ);
```

所有道路：

```javascript
roadY =
    sampleTerrain(roadX, roadZ);
```

禁止漂浮。

---

# 22. 河流贴地

```javascript
for (const point of river) {
    point.y =
        terrain.getHeight(point.x, point.z)
        + riverOffset;
}
```

同时考虑：

- 河岸
- 水面
- 桥梁
- 河谷

---

# 23. 河流等级

一级河流：

- 宽
- 深
- 明显

二级河流：

- 中等

三级河流：

- 细线

小溪：

- 近距离显示

河流宽度不得全部统一。

---

# 24. 湖泊

流程：

```text
Lake polygon
 ↓
Terrain interaction
 ↓
Water surface
 ↓
Shoreline
```

水面不得漂浮在山坡上。

---

# 25. 城市标签

默认只显示主要城市。

县级城市：

```text
靠近镜头才显示
```

标签必须 LOD。

---

# 26. 行政边界

默认：

```text
省界：明显
市州界：非常淡
县界：默认关闭
```

近距离再显示县界。

---

# 27. 道路

默认只显示：

- 高速
- 国道
- 主要省道
- 主要城市道路

禁止默认显示所有 OSM 道路。

---

# 28. 实体沙盘底座

建议：

```text
Terrain
 ↓
Vertical Wall
 ↓
Base
```

底座厚度：

```text
terrainHeight * 0.15 ~ 0.25
```

形成实体地形模型效果。

---

# 29. 光照

建议：

```text
HemisphereLight
+
DirectionalLight
+
Ambient Occlusion
```

方向光用于表现：

- 山谷阴影
- 山脊高光
- 地形起伏

---

# 30. 雾

使用轻量：

```text
FogExp2
```

目的：

增强远山空间层次，而不是遮挡地形。

---

# 31. 相机

```text
PerspectiveCamera
FOV = 40
```

默认：

```text
第三视角
35°~50° 俯视
```

支持：

- 旋转
- 缩放
- 平移

默认不显示控制 UI。

---

# 32. 性能目标

目标设备：

```text
Mac mini M4 16GB
Chrome / Edge
```

目标：

```text
全省 ≥ 50 FPS
正常观察 ≥ 60 FPS
近距离 ≥ 45 FPS
```

---

# 33. 性能预算

目标：

```text
Draw Calls < 300
理想 < 150
```

必须使用：

- InstancedMesh
- Frustum Culling
- Distance Culling
- LOD
- Geometry Merge
- Texture Atlas

禁止：

- 每棵树一个 Mesh
- 每栋房子一个 Mesh
- 每条河单独高开销 Mesh

---

# 34. 运行时数据格式

不要直接加载：

- GeoTIFF
- OSM PBF
- Shapefile

预处理为：

```text
terrain.bin
terrain.meta.json

rivers.bin
rivers.meta.json

cities.json

roads.bin

forest.bin
```

---

# 35. 工程技术栈

建议：

```text
Node.js
TypeScript
Three.js
Vite
GDAL
Python
GeoPandas
Rasterio
Shapely
PyProj
Osmium
```

---

# 36. 工程命令

必须支持：

```bash
npm install
npm run dev
npm run build
npm run preprocess
npm run validate-data
npm run benchmark
npm run build-single
```

---

# 37. 自动化数据流水线

执行：

```bash
npm run preprocess
```

自动完成：

```text
1. 检查 DEM
2. 检查贵州边界
3. 裁剪 DEM
4. 重采样
5. 生成 hillshade
6. 生成 slope
7. 处理河流
8. 处理湖泊
9. 处理 OSM
10. 提取城市
11. 提取道路
12. 生成 terrain tiles
13. 生成 runtime data
```

---

# 38. 数据完整性检查

执行：

```bash
npm run validate-data
```

必须检查：

```text
✓ 贵州边界
✓ DEM 覆盖
✓ DEM 无 NoData
✓ 河流坐标
✓ 城市坐标
✓ 河流与地形关系
✓ 城市是否位于贵州
✓ 道路是否位于贵州
✓ Tile 是否完整
```

---

# 39. 自动测试报告

示例：

```text
DATA VALIDATION
────────────────────

DEM
✓ Coverage
✓ Resolution
✓ NoData
✓ Range

RIVERS
✓ Primary
✓ Secondary
✓ Geometry

CITIES
✓ Major cities
✓ County settlements

TERRAIN
✓ Tile integrity
✓ Height range

RESULT
PASS
```

---

# 40. 视觉验收

每次重大修改必须生成截图：

```text
01-overview.png
02-north.png
03-west.png
04-center.png
05-south.png
06-city.png
07-river.png
08-closeup.png
```

检查：

### Overview
- 贵州轮廓
- 山势
- 整体高度
- 河流
- 城市分布

### Close-up
- 山体
- 岩石
- 森林
- 河流
- 城市

---

# 41. 核心视觉验收标准

### A
从远处看，能明显看出贵州是山地省份。

### B
从侧面看，高程差明显。

### C
从上方看，贵州轮廓正确。

### D
河流不能漂浮。

### E
城市不能漂浮。

### F
森林不能呈规则网格。

---

# 42. 开发阶段

严格按照：

```text
Phase 0
工程初始化

↓

Phase 1
DEM

↓

Phase 2
Terrain Shader

↓

Phase 3
River

↓

Phase 4
City

↓

Phase 5
Forest

↓

Phase 6
Road

↓

Phase 7
LOD

↓

Phase 8
Lighting

↓

Phase 9
Optimization

↓

Phase 10
Single HTML

↓

Phase 11
Final QA
```

---

# 43. Phase 0

完成：

- Three.js
- TypeScript
- Vite
- Python GIS
- 目录结构

验收：

```bash
npm run dev
```

能看到空场景。

---

# 44. Phase 1：真实贵州 Terrain

只做：

```text
DEM
+
贵州边界
+
Terrain
+
Camera
```

暂不加入：

- 城市
- 河流
- 森林
- 道路

目标：

> 一眼看出真实贵州山势。

---

# 45. Phase 2：地形视觉

加入：

```text
Height color
Slope
Hillshade
AO
```

调整：

```text
vertical exaggeration
```

目标：

> 山势明显，但不能变成尖峰。

---

# 46. Phase 3：水系

加入：

- 乌江
- 赤水河
- 北盘江
- 南盘江
- 清水江
- 主要支流

然后逐级加入次级河流。

---

# 47. Phase 4：城市

顺序：

```text
主要城市
 ↓
县城
 ↓
乡镇
```

---

# 48. Phase 5：森林

顺序：

```text
大面积森林块
 ↓
Instanced trees
 ↓
Shrub
 ↓
Rock
 ↓
Grass
```

---

# 49. Phase 6：道路

顺序：

```text
高速
 ↓
国道
 ↓
主要省道
 ↓
城市道路
```

---

# 50. Phase 7：LOD

加入：

```text
Terrain LOD
Forest LOD
City LOD
River LOD
Label LOD
Road LOD
```

---

# 51. Phase 8：真实感

加入：

```text
Sun
AO
Fog
Shadow
Rock
Terrain Noise
```

---

# 52. Phase 9：性能

记录：

```text
FPS
Draw Calls
Triangles
Textures
GPU memory
CPU frame time
```

---

# 53. 性能报告

示例：

```text
Guizhou Sandbox Benchmark
────────────────────────

Resolution:
2560 × 1440

FPS:
61

Draw Calls:
124

Triangles:
2.8M

Terrain Tiles:
36

Trees:
218K instances

Buildings:
32K instances

Memory:
xxx MB
```

---

# 54. Phase 10：单文件

最终：

```text
dist/
└── guizhou-terrain.html
```

同时提供：

```text
Standalone Build
```

以及：

```text
Data External Build
```

如果全部数据内嵌导致文件过大，应采用外部压缩运行时资源。

---

# 55. Debug 模式

默认：

```text
UI = OFF
```

通过：

```text
?debug=1
```

显示：

```text
FPS
Draw Calls
Triangles
LOD
Tile
Terrain Height
```

---

# 56. URL 调试参数

支持：

```text
?v3
?terrain=1
?water=1
?forest=1
?city=1
?debug=1
?exaggeration=3
```

视角：

```text
?view=overview
?view=north
?view=west
?view=central
?view=river
?view=city
```

---

# 57. V2 → V3 迁移

如果已有 V2 项目：

不要重写整个项目。

建议：

```text
现有 V2
   │
   ├── 保留 Camera
   ├── 保留 Labels
   ├── 保留 City logic
   ├── 保留 Boundary logic
   │
   ↓
新增 Terrain Engine
   ↓
新增 Hydro Engine
   ↓
新增 Forest Engine
   ↓
新增 LOD Engine
```

使用 Git：

```text
main
│
├── v2-stable
│
└── v3-terrain
```

---

# 58. 最终系统结构

```text
GuizhouSandbox
│
├── TerrainEngine
├── HydroEngine
├── ForestEngine
├── CityEngine
├── RoadEngine
├── BoundaryEngine
├── LabelEngine
├── CameraController
├── LODEngine
├── MaterialEngine
├── PerformanceMonitor
└── DebugEngine
```

---

# 59. Agent 执行纪律

1. 不允许一次修改大量模块后直接宣称完成。
2. 每个 Phase 完成后必须运行测试。
3. 每个 Phase 必须生成截图。
4. 每个 Phase 必须说明新增内容。
5. 修改已有 V2 功能前必须先阅读现有代码。
6. 不得删除现有有效功能。
7. 不得用 placeholder 冒充真实 GIS 数据。
8. 不得随机生成真实地理对象。
9. 数据源必须记录在 DATA_SOURCES.md。
10. 每次数据更新必须记录日期和来源。
11. 所有地理坐标必须统一 CRS。
12. 所有地形对象必须通过 TerrainSampler 获取高度。
13. 城市、道路、河流不得漂浮。
14. 森林必须使用 InstancedMesh 或等价实例化方案。
15. 必须使用 LOD 和 Frustum Culling。
16. 不允许为了追求细节无限增加三角形。
17. 如果性能下降，优先优化几何和实例，而不是降低真实数据质量。
18. 不允许为了“视觉好看”修改真实河流和城市空间关系。
19. 每次重大修改必须执行 benchmark。
20. 如果无法达到目标，必须明确报告瓶颈，而不是隐藏问题。

---

# 60. 完成标准

只有同时满足：

```text
数据正确
+
地形真实
+
视觉完成
+
性能达标
+
单文件可构建
+
Debug 可用
+
数据来源完整
```

才能宣布：

```text
V3.0 COMPLETE
```

---

# 61. 建议第一轮 Agent 任务

第一轮不要一次性实现全部系统。

只执行：

```text
Phase 0
+
Phase 1
+
Phase 2
```

即：

```text
真实 DEM
 ↓
贵州边界
 ↓
Terrain
 ↓
高度夸张
 ↓
Hillshade
 ↓
Terrain Shader
 ↓
Three.js
 ↓
可旋转缩放
```

先把“贵州这块山”做正确。

然后依次加入：

```text
河流
 ↓
城市
 ↓
森林
 ↓
道路
 ↓
LOD
 ↓
性能
 ↓
Single HTML
```

---

# 62. 最终视觉目标

最终打开页面：

- 远景：贵州整体山地格局
- 中景：山脉、峡谷、河流、盆地、城市
- 近景：森林、岩壁、河岸、道路、低模城市
- 极近景：地形连续，无穿模、无漂浮

最终效果应接近：

> “真实 DEM 数据驱动的博物馆级贵州实体地形沙盘”

而不是：

> “普通 GIS 地图”或“游戏地图”。

---

# 63. 数据来源文档要求

必须建立：

```text
docs/DATA_SOURCES.md
```

记录：

- 数据名称
- 数据类型
- 来源网站
- 下载日期
- 数据版本
- 空间分辨率
- CRS
- License
- 预处理方式
- 最终使用范围

建议数据源：

1. Copernicus DEM GLO-30
2. HydroSHEDS / HydroRIVERS / HydroLAKES
3. OpenStreetMap
4. Geofabrik 贵州区域数据
5. 贵州行政区边界数据

---

# 64. 最终开发理念

整个项目必须坚持：

```text
真实地理数据
      ↓
科学数据处理
      ↓
合理垂直夸张
      ↓
程序化视觉增强
      ↓
Three.js 高性能渲染
      ↓
LOD
      ↓
博物馆级数字沙盘
```

核心不是“做得多复杂”，而是：

> **真实地形决定骨架，程序化视觉决定质感，LOD 决定性能。**
