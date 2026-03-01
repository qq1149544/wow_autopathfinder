# 路线规划全流程说明

本文档描述从「地图 + 两个坐标」到「最终规划路线输出」的完整执行过程与代码逻辑。

---

## 1. 输入

- **地图**：通过几何文件间接指定。当前支持：
  - **Kalimdor**（或其它地图名，由几何导出时决定）。
- **两个坐标**：起点、终点，**游戏坐标系**：
  - `x` = 北（North）
  - `y` = 西（West）
  - `z` = 高度（Height）

**入口**：`run-kalimdor-route.js`  
- 参数：`--from 北 西 高`、`--to 北 西 高`（可选，有默认值）。  
- 可选：`--use-casc`（使用 CASC 导出的几何）、`--use-wowexport`（使用 wow.export OBJ 合并几何）。

---

## 2. 几何来源与准备（两条路径）

路线规划依赖**已导出的 Recast 几何**（顶点 + 三角形索引，坐标系见下）。几何可来自两条路径之一。

### 2.1 路径 A：CASC 自写导出（推荐，含地形 + WMO）

1. **脚本**：`scripts/export-recast-geometry-casc.js`
2. **输入**：地图名（如 `Kalimdor`）、起终点（北、西、高）、margin（默认 800）。
3. **过程**：
   - 根据起终点计算 bbox：  
     `minWest/maxWest = 起终点西 ± margin`，`minNorth/maxNorth = 起终点北 ± margin`。
   - 打开 WoW 客户端 CASC（config.json 的 `wowClientPath` 或 wow.export 配置）。
   - 调用 `buildRecastGeometry(casc, mapName, bbox, options)`（`export-recast-geometry.js`）：
     - **地形**：用 `TerrainLoader` 按 bbox 计算 tile 索引（`blockWest/North = floor(32 - axis/TILE_SIZE)`，`tileIndex = blockWest*64+blockNorth`），加载对应 ADT，对每个 MCNK chunk 用 `chunkToTriangles` + `getTileWorldOrigin` 得到世界坐标 (west, height, north) 的三角形。
     - **WMO**：对 bbox 内每个 tile 调用 `loadObjADT` 取 MODF 放置，对每个放置调用 `loadWmoWalkableTriangles`（MOPY 碰撞三角 + 放置变换 + tile 原点），顶点同样为 (west, height, north)。
   - 输出：`exports/recast-geometry-kalimdor-from-casc.json`（`positions`、`indices`、bbox、`terrainTriCount`、`wmoTriCount` 等）。
4. **使用**：寻路时加 `--use-casc`，则 `GEOMETRY_PATH = recast-geometry-kalimdor-from-casc.json`。

### 2.2 路径 B：wow.export OBJ 合并

1. **可选脚本**：
   - `scripts/export-route-geometry.js`：按起终点从 wow.export 导出目录合并相关 OBJ + CSV → `recast-geometry-route.json`。
   - 或 `scripts/obj-to-recast-geometry.js`：整图 OBJ 合并 → `recast-geometry-kalimdor-from-obj.json`。
2. **使用**：不传 `--use-casc` 时，若存在 `recast-geometry-route.json` 则用它，否则用 `recast-geometry-kalimdor-from-obj.json`；`--use-wowexport` 则强制用后者。

**当前主流程**：若使用 CASC 管线，则几何完全由**自写导出**（路径 A）生成，不依赖 wow.export 导出的 OBJ。

---

## 3. 几何加载与建网（NavMesh）

**执行位置**：`run-kalimdor-route.js` → `buildNavMesh(...)`（`navmesh-route-service.js`）。

### 3.1 加载几何

- 使用 `geometryPath`（由上一步确定的几何文件路径）和 `useGeometryFile: true`。
- 从 JSON 读取 `positions`、`indices`。
- 计算几何边界 `lastGeometryBounds`（minX/maxX = west，minZ/maxZ = north），供寻路时限制查询范围。

### 3.2 是否裁剪

- **路线模式**下默认 **不裁剪**（`skipRouteCrop === true`）。
- 原因：裁剪会移除外侧三角形，可能裁掉绕行障碍，导致本应折弯的路线变成直线；要求 100% 精度故不裁。
- 仅在显式传入 `skipRouteCrop: false` 时才会调用 `cropGeometryToBbox`。

### 3.3 建网参数（路线模式）

- **稳定 profile（默认）**：`run-kalimdor-route.js` 默认固定关键参数，避免环境变量污染导致结果漂移：
  - `routeCellSize = 1`
  - `routeWalkableSlopeAngleDegrees = 35`
  - `walkableRadiusWorld = 1.0`
  - `walkableClimbWorld = 2.2`
  - `forceTiledNavMesh = true`
- **允许覆盖（显式开启）**：仅当 `ALLOW_NAV_ENV_OVERRIDE=1` 时，才会读取 `ROUTE_CELL_SIZE`、`ROUTE_SLOPE_DEG`、`WALKABLE_RADIUS_WORLD`、`WALKABLE_CLIMB_WORLD`、`FORCE_TILED_NAVMESH`。
- **其它**：`fullPathFidelity: true`、`subdivideMaxSegment: 30` 等。

### 3.4 建网执行

- 优先使用 **navcat**（路线模式默认 `forceTiledNavMesh=true`，即 `generateTiledNavMesh`），输入 `positions`、`indices`，坐标系 (x,y,z)=(west, height, north)。
- 失败则回退到 **recast-navigation**（WASM）`generateSoloNavMesh`。
- 成功后保存 NavMesh 实例与 `pathOptions`（含 `rejectStraightPath`、`subdivideMaxSegment` 等），供寻路使用。

---

## 4. 起终点高度吸附（可选）

- 当几何为路线几何（CASC 或 `recast-geometry-route.json`）时，对起点、终点做**高度吸附**：
  - `getHeightAtFromGeometry(geometryPath, west, north)` 在几何三角形中做重心插值，得到该 (west, north) 的地表高度。
  - 若得到有效高度则替换起/终点的 `z`，避免因高度偏差导致后续 `findNearestPoly` 失败。

---

## 5. 寻路执行（findPathNavMesh）

**调用**：`findPathNavMesh(startUse, endUse)`，起终点为游戏坐标 `{ x, y, z }` = (北, 西, 高)。

### 5.1 坐标转换

- 游戏 → Recast：`[west, height, north] = [a.y, a.z, a.x]`。
- 若存在 `lastGeometryBounds`，将起终点在 (west, north) 上裁到 bbox 内，避免查询越界。

### 5.2 navcat 分支（当前主路径）

1. **找 poly**：用 `queryPolygons` 取全 mesh 多边形（单 tile 时用几何 bbox 构造查询范围），再用 `getClosestPointOnPoly` 在起终点附近找最近 poly（XZ 距离平方 &lt; 1000²），得到起点/终点 poly ref 与吸附位置。
2. **寻路**：`findNodePath(navMesh, startRef, endRef, startPos, endPos)` 得到 poly 序列，再 `findStraightPath(startPos, endPos, nodePath)` 得到路径点序列（Recast 坐标）。
3. **转回游戏坐标**：每个点 `recastToGame(x,y,z)` → `{ x: z, y: x, z: y }` = (北, 西, 高)。
4. **首尾替换**：路径首尾点强制设为用户请求的起终点（保证地图标记一致）。
5. **后处理**（见下）。

### 5.3 后处理（所有分支共用）

- **correctPathHeights**：仅当某点高度与起终点高度偏差均 &gt; 2000 时，用起终点高度线性插值替代（异常修正）。
- **sanitizePathNoBacktrack**：在 `fullPathFidelity` 下移除共线回退段，保留折弯。
- **subdividePath**：按 `subdivideMaxSegment`（如 30）对长线段插点，得到更密的路径点。
- **直线检测**：若路径在水平面 2D 共线（`isPathEffectivelyStraight2D`），打警告「寻路结果为水平直线…」，但仍返回路径（不返回 null），便于排查几何/坡度/体素问题。

---

## 6. 输出

1. **route.json**  
   - 路径点数组，每点 `{ x, y, z }`（北, 西, 高）。  
   - 写入 `pathfinder/route.json`。

2. **控制台**  
   - 路径点数量与逐点坐标；若发生直线则输出上述警告。

3. **可选：2D 路线图**  
   - 调用 `exportRegionMapPng`（`export-map-markers-2d.js`）：根据起终点与 `routePoints` 确定瓦片范围，从 WoW 客户端读取小地图纹理，将起点、终点、路线点用 `worldToCompositePx(west, north)` 标在图上，输出 `exports/map-markers-2d-route.png`。  
   - 若缺少客户端小地图资源会捕获异常并只打警告，不中断流程。

---

## 7. 坐标约定小结

| 空间       | 含义 | 使用处 |
|------------|------|--------|
| **游戏**   | x=北, y=西, z=高 | 用户输入、route.json、API、2D 导出 |
| **几何/Recast** | positions[i,i+1,i+2] = west, height, north | 几何文件、建网、寻路内部、getHeightAtFromGeometry |
| **转换**   | game→recast: (x,y,z)=(west, height, north)；recast→game: (北,西,高)=(z,x,y) | navmesh-route-service `gameToRecast` / `recastToGame` |

---

## 8. 流程简图（CASC 管线）

```
地图(Kalimdor) + 起点(北,西,高) + 终点(北,西,高)
        │
        ▼
[ 几何是否已存在？ ]
        │
  否 ───┼─── 运行 export-recast-geometry-casc.js
        │     (CASC → bbox → TerrainLoader + WMO → recast-geometry-kalimdor-from-casc.json)
        │
  是 ───┘
        │
        ▼
run-kalimdor-route.js --use-casc
        │
        ├─ 选定 GEOMETRY_PATH = recast-geometry-kalimdor-from-casc.json
        ├─ routeBbox = 起终点 ± 280
        ├─ buildNavMesh(geometryPath, routeBbox, skipRouteCrop=true, routeWalkableSlopeAngleDegrees=35, …)
        │     └─ 加载 positions/indices → 不裁剪 → navcat generateSoloNavMesh → 保存 NavMesh
        ├─ 起终点高度吸附（getHeightAtFromGeometry）
        ├─ findPathNavMesh(start, end)
        │     └─ gameToRecast → queryPolygons + getClosestPointOnPoly → findNodePath → findStraightPath
        │     └─ recastToGame → 首尾替换 → correctPathHeights → sanitize → subdivide → 直线警告(若共线)
        ├─ 写入 pathfinder/route.json
        └─ 可选：exportRegionMapPng → exports/map-markers-2d-route.png
```

---

## 9. 相关文件索引

| 阶段     | 文件 |
|----------|------|
| 入口     | `run-kalimdor-route.js` |
| 几何导出 | `scripts/export-recast-geometry-casc.js`、`export-recast-geometry.js`、`terrain-loader.js`、`wmo-pathfinder.js` |
| 建网与寻路 | `navmesh-route-service.js`、`path-utils.js` |
| 2D 导出 | `export-map-markers-2d.js` |
| 输出     | `route.json`、`exports/map-markers-2d-route.png` |

以上即为从接收地图与两坐标到最终规划路线输出的全流程代码逻辑与执行过程。
