# ARCHITECTURE(系统结构,方案 §58)

## 数据流水线(方案 §37)

```
raw 下载(scripts/download/*.mjs)
  DEM:    AWS terrarium z10 ×440 瓦片
  边界:   DataV 520000 / 520000_full / 9×{adcode}_full
  卫星:   Esri World Imagery z12 ×5304 瓦片(V3.9.0 新增)
  OSM:    Overpass(7 查询,rivers/streams/water/woods/places/roads/buildings-guiyang)
      ↓
预处理(scripts/process/*.mjs,npm run preprocess)
  dem.mjs         瓦片解码 → 3072×2654 Uint16 高程栅格 + 省掩膜(硬/软边缘/5.6km 缓冲带)+ 去坏点
  satellite.mjs   卫星瓦片按行拼接(符号链接 + image2 demuxer)→ 6× area 降采样 → 3328×2901 JPEG(≈204m/px)
  admin.mjs       省/市州/县界简化(Albers 投影)→ boundary.json
  hydro.mjs       河流裁剪分级(乌江/北盘江等一级命名匹配)、湖泊/水库环提取 → rivers.json / lakes.json
  valley.mjs      沿河真实水位剖面(平滑 + 保序回归)→ riverbed.bin;河谷下切量表 → valley.bin
  ao.mjs          真实 DEM 天空可见度分析(8 方位地平线扫描,大尺度平滑高程)→ ao.bin(1/2 分辨率)
  cities.mjs      OSM 居民点 + DataV 县中心 → T1–T4 城市表
  roads.mjs       高速/国道/省道裁剪简化 → roads.json
  vegetation.mjs  OSM 林地栅格化 + 高程/坡度/水系/城市约束 → forest.bin;河流水色烙印 rivertint.bin
  buildings.mjs   贵阳真实 footprint → 有向包围盒实例
      ↓
运行时(public/runtime/*,npm run validate-data 校验)
      ↓
Three.js 引擎(app/*)
```

## 运行时引擎

| 引擎 | 文件 | 职责 |
| --- | --- | --- |
| TerrainEngine | app/terrain/TerrainEngine.ts | 6×6 瓦片、四级 LOD(步长 1/2/4/16 + 块平均防混叠)、掩膜裁剪、高程分层色 × 林地色 × 河谷烙印 × 坡度着色(明暗交由实时光照,V3.9 起不再烘焙静态 hillshade)、卫星底图混合、裙边 |
| SatelliteOverlay | app/terrain/satellite.ts | 卫星底图材质注入:顶点着色器做 Albers 逆投影 → Mercator UV;降饱和 + 亮度增益 + 暗部提亮;按相机距离衰减权重 |
| TerrainSampler | app/utils/sampler.ts | 高程双线性、平滑栅格(2×高斯)、表面高度(边缘下沉)、meshHeightAt(与渲染网格逐级一致的贴地) |
| HydroEngine | app/water/HydroEngine.ts | 河流**分段水平水面**(每段严格水平,段间白色跌水面衔接;水位取自离线真实高程序列 riverbed.bin)、湖泊 earcut + 顶点钳制 |
| 环境光遮蔽 | app/terrain/TerrainEngine.ts | 顶点属性 `ao` → `aomap_fragment` 处乘算;遮蔽来自真实 DEM 天空可见度(离线),无后处理 pass、零运行时开销 |
| 河谷下切 | app/utils/sampler.ts + app/terrain/TerrainEngine.ts | 按 valley.bin(逐格下切米数)在 visualY 之前削减高程 → 沟底削平到真实水位,水平水面得以躺在沟中;LOD 变粗时按同窗口块平均随之抹平 |
| RoadEngine | app/roads/RoadEngine.ts | 高速/国省道/主要省道 3 合并条带,meshHeightAt 贴地 |
| CityEngine | app/cities/CityEngine.ts | 全省 7533 栋真实 footprint 实例 + 程序化街区块(陡坡剔除) |
| ForestEngine | app/forest/ForestEngine.ts | 4 类树 InstancedMesh(上限 15 万),远景隐藏(地形着色替代) |
| BoundaryEngine | app/scene/BoundaryEngine.ts | 省界条带(明显)/市州县 LineSegments(淡,县界近距显示) |
| BaseEngine | app/scene/BaseEngine.ts | 裙墙(层状岩色)+ 基座外沿 + 深色地面(方案 §28) |
| LabelEngine | app/labels/LabelEngine.ts | HTML 标签,T1/T2 常显,T3<15u,T4<5.5u,上限 90 个 |
| DebugEngine | app/scene/DebugEngine.ts | ?debug=1 HUD(FPS/DrawCalls/Triangles/LOD) |
| SceneSetup | app/scene/SceneSetup.ts | 渲染器(ACES)/FOV40/OrbitControls/半球+方向光/FogExp2/**Preetham 大气天空**(`three/addons/objects/Sky.js`)/PMREM 环境贴图 |
| SunPosition | app/scene/sun.ts | NOAA 天文年历 → 太阳高度角/方位角 → 场景方向向量;按高度角插值光照与大气参数 |

## 卫星底图配准(V3.9.0)

底图存为 **Web Mercator 网格**,运行时逐顶点反算 UV:

```
顶点世界坐标 → Albers 投影平面(米) → Albers 逆投影 → 经纬度 → Web Mercator UV → 底图纹理
```

因为从**实际几何位置**反算(而非按格元索引),底图与渲染出的地形严格贴合,配准零误差
(`scripts/validate-satellite.mjs` 实测:反投影纬度误差 0.00km、经度 0.006°;湖库周边水像元
提升 9.9×、河网 4.9×,全省基线 0.18%)。

底图为全省尺度(≈204m/px),近景放大后会糊,故按相机距离衰减权重(近景 0.22 → 远景 1.0)。

## 真实太阳与大气(V3.10.0)

太阳位置由 NOAA 天文年历算出(黄经 → 赤纬 → 时角 → 高度角/方位角),场景坐标为
`X=东、Z=−北、Y=上`,方位角自北顺时针。实测与天文参考吻合(贵州 2026-10-22 正午太阳高度
51.8°,理论 52.2°)。

太阳高度角驱动一整套光照与大气参数(方向光颜色/强度、半球光、雾色雾浓度、曝光、
Preetham 的 turbidity/rayleigh),使清晨—正午—黄昏—夜间连续变化。

天空用 `three/addons/objects/Sky.js`(Preetham 模型,零新增依赖),盒子跟随相机;
PMREM 环境贴图由同参数的独立实例生成(线性渲染,保持物理亮度供水面反射)。
因 Preetham 输出为物理亮度而场景曝光按地形调至 1.0,显示天空另加独立增益 0.28,
近地平线再做去饱和蓝移(`horizonBlue`)。

实时阴影默认开启,阴影相机范围按视距分四档(9 / 22 / 45 / 90 世界单位)自适应。

## 坐标系统(方案 §6)

- 原始数据 EPSG:4326
- 局部平面:Albers 等积圆锥(lon0 106.5°E,lat0 26.8°N,双纬线 25.5°/28.5°,球体 R=6378137)
- 世界:X=东,Z=-北,Y=pow(norm(elev),1.15)×verticalScale(默认 10u,?exaggeration 调节);全省宽 150u(≈4.57km/u)

## 构建

- `npm run dev` — 开发(Vite,public/runtime 外置数据)
- `npm run download` — 拉取原始数据(DEM/边界/卫星/OSM;卫星为 `npm run download sat`)
- `npm run build` — 预处理 + 产物到 dist/web(数据外置)
- `npm run build-single` — 全部内联+base64 → dist/guizhou-terrain.html(单文件,离线可用)

<!-- kimi-badge -->
[![powered by KimiCode](../.github/assets/kimi-badge.svg)](https://www.kimi.com/code)
