# ARCHITECTURE(系统结构,方案 §58)

## 数据流水线(方案 §37)

```
raw 下载(scripts/download/*.mjs)
  DEM:    AWS terrarium z10 ×440 瓦片
  边界:   DataV 520000 / 520000_full / 9×{adcode}_full
  OSM:    Overpass(7 查询,rivers/streams/water/woods/places/roads/buildings-guiyang)
      ↓
预处理(scripts/process/*.mjs,npm run preprocess)
  dem.mjs         瓦片解码 → 3072×2654 Uint16 高程栅格 + 省掩膜(硬/软边缘/5.6km 缓冲带)+ 去坏点
  admin.mjs       省/市州/县界简化(Albers 投影)→ boundary.json
  hydro.mjs       河流裁剪分级(乌江/北盘江等一级命名匹配)、湖泊/水库环提取 → rivers.json / lakes.json
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
| TerrainEngine | app/terrain/TerrainEngine.ts | 6×6 瓦片、四级 LOD(步长 1/2/4/16 + 块平均防混叠)、掩膜裁剪、高程分层色 × 林地色 × 河谷烙印 × Hillshade(az315/alt45)× 噪声、裙边 |
| TerrainSampler | app/utils/sampler.ts | 高程双线性、平滑栅格(2×高斯)、表面高度(边缘下沉)、meshHeightAt(与渲染网格逐级一致的贴地) |
| HydroEngine | app/water/HydroEngine.ts | 河流三级合并条带(真实米制宽度,LOD 分级重建贴地)、湖泊 earcut + 顶点钳制 |
| RoadEngine | app/roads/RoadEngine.ts | 高速/省道 2 合并条带,meshHeightAt 贴地 |
| CityEngine | app/cities/CityEngine.ts | 贵阳真实 footprint 实例 + 程序化街区块(陡坡剔除) |
| ForestEngine | app/forest/ForestEngine.ts | 4 类树 InstancedMesh ~4.4 万,远景隐藏(地形着色替代) |
| BoundaryEngine | app/scene/BoundaryEngine.ts | 省界条带(明显)/市州县 LineSegments(淡,县界近距显示) |
| BaseEngine | app/scene/BaseEngine.ts | 裙墙(层状岩色)+ 基座外沿 + 深色地面(方案 §28) |
| LabelEngine | app/labels/LabelEngine.ts | HTML 标签,T1/T2 常显,T3<15u,T4<5.5u,上限 90 个 |
| DebugEngine | app/scene/DebugEngine.ts | ?debug=1 HUD(FPS/DrawCalls/Triangles/LOD) |
| SceneSetup | app/scene/SceneSetup.ts | 渲染器(ACES)/FOV40/OrbitControls/半球+方向光/FogExp2/渐变天穹 |

## 坐标系统(方案 §6)

- 原始数据 EPSG:4326
- 局部平面:Albers 等积圆锥(lon0 106.5°E,lat0 26.8°N,双纬线 25.5°/28.5°,球体 R=6378137)
- 世界:X=东,Z=-北,Y=pow(norm(elev),1.15)×verticalScale(默认 10u,?exaggeration 调节);全省宽 150u(≈3.9km/u)

## 构建

- `npm run dev` — 开发(Vite,public/runtime 外置数据)
- `npm run build` — 预处理 + 产物到 dist/web(数据外置)
- `npm run build-single` — 全部内联+base64 → dist/guizhou-terrain.html(单文件,离线可用)
