# DATA SOURCES(数据来源,方案 §63)

> 纪律:所有数据均为真实公开数据;无法获得的数据以"程序化"明确标注,不冒充真实数据。
> 每次数据更新在此记录日期与来源。

## 1. DEM(数字高程模型)

| 项 | 内容 |
| --- | --- |
| 名称 | Mapzen Terrain Tiles — Terrarium PNG(全球 DEM 瓦片) |
| 来源 | AWS Open Data:`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` |
| 数据构成 | SRTM、GMTED2010、ETOPO1、NED 等融合产品 |
| 下载日期 | 2026-09-26 |
| 覆盖 | zoom 10,x 804–825,y 422–441(440 瓦片,含贵州缓冲区) |
| 分辨率 | 原生 ~76m/px(赤道 z10),运行时重采样 218 m/格 |
| CRS | Web Mercator 瓦片 → 运行时 EPSG:4326 均匀网格 |
| License | 公开( Mapzen/AWS Open Data,衍生数据遵循各源许可) |
| 预处理 | terrarium 解码 → 重采样 → 省内坏点邻域中值修复(5 格) → Uint16 高程栅格 |
| 使用范围 | `data/runtime/terrain/terrain.elev.bin`(3072×2654)、地形网格、所有贴地对象高度 |
| 派生 | 环境光遮蔽 `terrain/ao.bin`(1/2 分辨率)——由本 DEM 的天空可见度分析生成(非外部数据) |

## 2. 行政边界

| 项 | 内容 |
| --- | --- |
| 名称 | DataV GeoAtlas areas_v3(阿里云) |
| 来源 | `https://geo.datav.aliyun.com/areas_v3/bound/{adcode}.json` 与 `{adcode}_full.json` |
| 下载日期 | 2026-09-26 |
| 覆盖 | 520000(省)、520000_full(9 市州)、9 个市州 full(88 县区) |
| CRS | GCJ-02 惯例上 DataV 为 WGS84 经纬度(本工程按经纬度直接投影) |
| License | DataV GeoAtlas 公开服务(注明来源使用) |
| 预处理 | Albers 等积圆锥投影(106.5°E/26.8°N/25.5°/28.5°)→ Douglas-Peucker 简化(省界 120m) |
| 使用范围 | 省界裁剪掩膜、省界/市州界/县界线、裙边墙、县级行政中心坐标(城市 Tier3) |

## 3. OpenStreetMap(© OpenStreetMap contributors, ODbL)

通过 Overpass API 下载(2026-09-26,端点 overpass-api.de / kumi.systems / private.coffee 等):

| 数据集 | 查询内容 | 原始大小 | 处理 |
| --- | --- | --- | --- |
| rivers | `way[waterway=river]` | 29.4MB | 贵州掩膜裁剪 → 分级(命名一级/river 二级/stream 三级)→ DP 简化(60–170m) |
| streams | `way[waterway~^(stream\|canal)$]` | 22.6MB | 同上 |
| water | `natural=water` + `landuse=reservoir`(way+relation) | 46.3MB | 环提取 → 面积≥0.35km² → 顶点钳制贴地 → 200 个湖/水库 |
| woods | `natural=wood` + `landuse=forest` | 84.4MB | 4453 环 → 430m 栅格化为森林密度主层(真实林地) |
| places | `node[place~^(city\|town\|county_seat)$][name]` | 1.5MB | 1370 点 + DataV 县中心匹配 → T1×1 / T2×8 / T3×88 / T4×1330 |
| roads | `way[highway~^(motorway\|trunk\|primary)$]` | 80.9MB | 裁剪 → 简化 200m → 29242 段(高速/国道 24166、国省道 5076) |
| roads-secondary | `way[highway~^(secondary\|tertiary)$]`(2026-09-26 二轮,V3.2) | 124.0MB | 裁剪 → 简化 260m → 17615 段主要省道;全省道路合计 46857 段 |
| buildings-guiyang | `way[building]`(贵阳 106.58–106.84E, 26.52–26.74N) | 2.0MB | PCA 有向包围盒 → 2823 栋真实 footprint |
| buildings-{T2 城市} | `way[building]`(遵义/毕节/六盘水/铜仁/安顺/兴义/凯里/都匀,2026-09-26 二轮下载) | 0.02–0.43MB×8 | 同上 → 全省合计 4736 栋真实 footprint;OSM 覆盖稀疏的城市由程序化低模按缺口补充(程序化内容,已标注) |
| buildings-t3-{县名} | `way[building]`(88 县区逐一查询,4.4km bbox,2026-09-26 三轮下载,V3.3) | 共 ~5MB | 57 县有覆盖(锦屏 630/云岩 328/赫章 276 等)、31 县为空 → 全省合计 **7533 栋真实 footprint**;无覆盖县城由程序化低模补充(已标注) |

## 4. 卫星影像底图(V3.9.0 新增)

| 项 | 内容 |
| --- | --- |
| 名称 | Esri World Imagery(ArcGIS Online)卫星影像 |
| 来源 | `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}` |
| 下载日期 | 2026-10-22 |
| 覆盖 | zoom 12,x 3222–3299、y 1695–1762(5304 瓦片,含贵州缓冲区) |
| 分辨率 | 源 ~39m/px(z12)→ 合成底图 ≈204m/px(3328×2901,JPEG q4,2.7MB) |
| CRS | Web Mercator 瓦片 → 运行时经 Albers 逆投影逐顶点重算 UV(配准零误差) |
| License | Esri 公开服务,注明来源使用;备选源 NASA GIBS VIIRS(无需凭据,250m) |
| 预处理 | 按行拼接(顺序符号链接 + image2 demuxer)→ `scale=area` 6× 降采样 → JPEG q4 |
| 使用范围 | `public/runtime/terrain/satellite.jpg` + `satellite.json`(Mercator UV 矩形),地形材质底图混合 |

> 影像含真实云覆盖(5304 瓦片中约 25 张大面积云,占省域面积约 1%),系遥感实况,未做云掩膜填补。

## 5. 程序化视觉(明确标注,非真实数据)

| 内容 | 依据 | 说明 |
| --- | --- | --- |
| 背景植被密度 | 真实林地外的低密度填充(38/255) | 叠加高程(>2000m 衰减)、坡度(>0.6 陡壁)、水系缓冲、城市半径抑制 |
| 城市低模建筑群 | 城市 Tier 与 OSM 人口/位置 | Tier2-4 程序化街区块体;T1 贵阳 + T2 8 城 + T3 57 县使用真实 footprint(4736→7533 栋) |
| 河谷水色烙印 | OSM 河流线缓冲(一级 3.4 格) | 博物馆沙盘"上色"表现,远景河流可读性 |
| 树木实例 | forest.bin 密度网格 | InstancedMesh,~5.1 万棵,远景以地形着色替代 |
| 近景微地形细节 | 3 倍频值噪声(程序化,V3.5) | LOD 分级衰减(近景全量/远景无),非真实 DEM;贴地对象与其一致 |

## 6. 更新记录

- 2026-09-26:首次全量下载与预处理(DEM 440 瓦片、边界 11 文件、OSM 7 数据集)。
- 2026-10-22:新增卫星影像底图(Esri World Imagery z12,5304 瓦片 → 底图 3328×2901)。

<!-- kimi-badge -->
[![powered by KimiCode](../.github/assets/kimi-badge.svg)](https://www.kimi.com/code)
