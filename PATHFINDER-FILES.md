# pathfinder 当前保留文件说明（精简版）

目标：仅保留「完整全流程实现 + 关键调试 + 区域 OBJ 模型导出 + 路线 2D 图片导出」。

## 一、完整全流程（核心）

| 文件 | 作用 |
|------|------|
| `run-fullflow-route.js` | 一键全流程入口：`export-adt-obj` → `export-route-geometry` → `run-kalimdor-route` |
| `run-kalimdor-route.js` | 主寻路执行：读取几何、建网、输出 `route.json`、导出路线 2D 图 |
| `navmesh-route-service.js` | NavMesh 构建 + 寻路核心（tiled/solo、findPath、坐标转换） |
| `path-utils.js` | 路径后处理工具（折线清理、插点等） |
| `coords.js` | 坐标转换 |
| `export-map-markers-2d.js` | 路线 2D 图片导出 |

## 二、区域 OBJ 导出与几何生成

| 文件 | 作用 |
|------|------|
| `scripts/export-adt-obj.js` | 从资源导出区域 ADT/WMO/M2 OBJ + 放置 CSV |
| `scripts/export-route-geometry.js` | 将区域 OBJ/CSV 合并为 `recast-geometry-route.json` |
| `export-recast-geometry.js` | Recast 几何构建辅助（服务层依赖） |
| `terrain-loader.js` | 地形 ADT 加载辅助 |
| `wmo-pathfinder.js` | WMO 碰撞/变换辅助 |

## 三、关键调试文件

| 文件 | 作用 |
|------|------|
| `scripts/diagnose-segment-reachability.js` | 分段可达性诊断（如 10->11） |
| `scripts/diagnose-manual-route-clusters.js` | 手工路线点连通簇诊断 |
| `scripts/diagnose-adt-chunk-seams.js` | ADT chunk 拼缝拓扑核查 |
| `scripts/diagnose-nearby-placements.js` | 对指定疑难坐标导出附近放置实例（模型/位姿/距离） |
| `scripts/export-current-route-model-list.js` | 导出当前路线覆盖区域的模型文件清单（含 `.phys.obj`） |
| `scripts/geometry-json-to-obj.js` | 将 `recast-geometry-route.json` 转为可视检查的合并 OBJ |
| `scripts/export-geometry-window-obj.js` | 导出指定坐标窗口的“最终几何输入”OBJ（含地形+模型） |
| `scripts/export-nearby-models-obj.js` | 导出指定坐标窗口的“仅模型”OBJ（便于核验模型朝向） |
| `scripts/run-placement-regression.js` | 自动回归：覆盖率、WMO拟合、M2可视/碰撞一致性、历史卡点锚点校验 |

## 四、文档与配置

| 文件 | 作用 |
|------|------|
| `docs/ROUTE-PLANNING-FULLFLOW.md` | 当前全流程实现说明 |
| `package.json` / `package-lock.json` | 依赖与脚本配置 |

## 五、主要产物（exports）

- `exports/adt-objs/`：区域 OBJ 导出目录（全流程中间产物）
- `exports/recast-geometry-route.json`：路线几何文件
- `exports/map-markers-2d-route.png`：路线 2D 图
- `exports/map-markers-2d.png`：区域 2D 图
- `route.json`：最终路线点
