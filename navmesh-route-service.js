/**
 * Navmesh-based route planning service.
 * Builds a Recast navmesh from exported geometry (or on-the-fly) and exposes findPath via API.
 * Coordinates: game (north, west, height) <-> pathfinder/Recast (x=west, y=height, z=north).
 *
 * 不允许回退直线: path 失败时不会回退为起终点直线，仅返回 null/[]；路径后处理会移除直线回退段。
 *
 * Usage:
 *   node navmesh-route-service.js                    # build navmesh from exports/recast-geometry.json, then start HTTP server
 *   node navmesh-route-service.js --no-server        # build only, no HTTP
 *   node navmesh-route-service.js --port 3920       # custom port
 * GET /path?map=azeroth&fromN=&fromW=&fromH=&toN=&toW=&toH=  -> JSON path
 * POST /path  body: { map, from: {x,y,z}, to: {x,y,z} }  (x=north, y=west, z=height)
 */
const path = require('path');
const fs = require('fs');
const http = require('http');
const { isPathEffectivelyStraight2D } = require('./path-utils');

let recastInit = null;
let navMeshQuery = null;
let currentGeometryPath = null;
/** 'navcat' | 'recast' - 当前使用的后端 */
let navMeshBackend = null;
/** 寻路后处理选项（由 buildNavMesh 的 options 写入）：fullPathFidelity、subdivideMaxSegment、avoidCollisions */
let pathOptions = { fullPathFidelity: false, subdivideMaxSegment: 0, avoidCollisions: false };
/** navcat 的 NavMesh 实例（当 backend === 'navcat' 时使用） */
let navMeshNavcat = null;
/** navcat ESM 模块缓存（buildNavMesh 成功时写入，findPathNavMesh 使用） */
let navcatModule = null;
/** 最近一次从几何文件加载的 bbox（recast 坐标：minWest, minNorth, maxWest, maxNorth），用于将查询点限制在 tile 范围内 */
let lastGeometryBounds = null;
/** navcat 构建时使用的世界坐标偏移（仅 XZ），用于降低大坐标精度误差 */
let navWorldOffset = { x: 0, z: 0 };

/** Game (north, west, height) -> Recast (x=west, y=height, z=north) */
function gameToRecast(north, west, height) {
	return { x: west, y: height ?? 0, z: north };
}

/** Recast (x,y,z) -> Game (north, west, height) */
function recastToGame(x, y, z) {
	return { x: z, y: x, z: y };
}

/**
 * 将几何裁剪到 XZ 矩形内（保留与 bbox 相交的三角形）。
 * 原意：缩小建网范围以用更小 cellSize，但裁剪会移除外侧三角形；若绕行障碍在起终点轴对齐框外会被裁掉，导致本应折弯的路线变成直线。
 * 路线模式要求 100% 精度、不丢障碍，因此默认不裁剪（skipRouteCrop）；此处保留供非路线场景或显式 opt-in 使用。
 * @param {Float32Array|number[]} positions [x,y,z,...] = west, height, north
 * @param {Uint32Array|number[]} indices 三角形索引
 * @param {{ minWest: number, maxWest: number, minNorth: number, maxNorth: number }} bbox 扩展后的路线范围
 * @returns {{ positions: Float32Array, indices: Uint32Array, vertexCount: number, triCount: number }}
 */
function cropGeometryToBbox(positions, indices, bbox) {
	const { minWest, maxWest, minNorth, maxNorth } = bbox;
	const numTris = indices.length / 3;
	const keepTri = new Uint8Array(numTris);
	for (let t = 0; t < numTris; t++) {
		let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
		for (let i = 0; i < 3; i++) {
			const idx = indices[t * 3 + i] * 3;
			const x = positions[idx];
			const z = positions[idx + 2];
			minX = Math.min(minX, x); maxX = Math.max(maxX, x);
			minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
		}
		if (maxX >= minWest && minX <= maxWest && maxZ >= minNorth && minZ <= maxNorth) {
			keepTri[t] = 1;
		}
	}
	const oldToNew = new Int32Array(positions.length / 3).fill(-1);
	let newVertexCount = 0;
	const newPositions = [];
	const newIndices = [];
	for (let t = 0; t < numTris; t++) {
		if (!keepTri[t]) continue;
		for (let i = 0; i < 3; i++) {
			const oldIdx = indices[t * 3 + i];
			if (oldToNew[oldIdx] === -1) {
				oldToNew[oldIdx] = newVertexCount++;
				newPositions.push(positions[oldIdx * 3], positions[oldIdx * 3 + 1], positions[oldIdx * 3 + 2]);
			}
			newIndices.push(oldToNew[oldIdx]);
		}
	}
	return {
		positions: new Float32Array(newPositions),
		indices: new Uint32Array(newIndices),
		vertexCount: newVertexCount,
		triCount: newIndices.length / 3,
	};
}

/**
 * 当路径点高度与起终点请求高度偏差过大时，用起终点高度线性插值替代（几何/导出异常时的启发式修正）
 * @param {Array<{x,y,z}>} path 游戏坐标路径
 * @param {{x,y,z}} startGame 起点（游戏）
 * @param {{x,y,z}} endGame 终点（游戏）
 * @param {number} maxDeviation 与起终点高度都超过此值则视为异常并插值
 */
function getHeightAtFromGeometry(geometryPath, west, north) {
	if (!geometryPath || !fs.existsSync(geometryPath)) return null;
	const data = JSON.parse(fs.readFileSync(geometryPath, 'utf8'));
	const positions = data.positions;
	const indices = data.indices;
	if (!positions || !indices || positions.length < 9) return null;
	let bestH = null;
	let bestDist = Infinity;
	for (let t = 0; t < indices.length / 3; t++) {
		const i0 = indices[t * 3] * 3, i1 = indices[t * 3 + 1] * 3, i2 = indices[t * 3 + 2] * 3;
		const ax = positions[i0], ay = positions[i0 + 1], az = positions[i0 + 2];
		const bx = positions[i1], by = positions[i1 + 1], bz = positions[i1 + 2];
		const cx = positions[i2], cy = positions[i2 + 1], cz = positions[i2 + 2];
		const denom = (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
		if (Math.abs(denom) < 1e-12) continue;
		const u = ((west - ax) * (cz - az) - (north - az) * (cx - ax)) / denom;
		const v = ((north - az) * (bx - ax) - (west - ax) * (bz - az)) / denom;
		if (u >= -1e-6 && v >= -1e-6 && u + v <= 1 + 1e-6) {
			const h = ay + u * (by - ay) + v * (cy - ay);
			const dx = (ax + u * (bx - ax) + v * (cx - ax)) - west;
			const dz = (az + u * (bz - az) + v * (cz - az)) - north;
			const distSq = dx * dx + dz * dz;
			if (distSq < bestDist) {
				bestDist = distSq;
				bestH = h;
			}
		}
	}
	return bestH;
}

/**
 * 仅当路径点高度与起终点偏差极大时（几何异常），用起终点高度线性插值替代；避免覆盖正常路径高度，保证 100% 精度。
 * @param {Array<{x,y,z}>} path 游戏坐标路径（原地修改）
 * @param {{x,y,z}} startGame 起点
 * @param {{x,y,z}} endGame 终点
 * @param {number} maxDeviation 与起终点高度都超过此值才视为异常并插值（默认 2000，仅修正明显错误）
 */
function correctPathHeights(path, startGame, endGame, maxDeviation = 2000) {
	if (!path || path.length < 2) return path;
	const sz = startGame.z;
	const ez = endGame.z;
	for (let i = 0; i < path.length; i++) {
		const p = path[i];
		const devStart = Math.abs(p.z - sz);
		const devEnd = Math.abs(p.z - ez);
		if (devStart > maxDeviation && devEnd > maxDeviation) {
			const t = path.length > 1 ? i / (path.length - 1) : 0;
			p.z = sz + t * (ez - sz);
		}
	}
	return path;
}

/** 将路径中过长的线段按 maxSegmentLength（游戏单位）细分，得到多段折线供客户端逐段跟随 */
function subdividePath(path, maxSegmentLength = 80) {
	if (!path || path.length < 2 || maxSegmentLength <= 0) return path;
	const out = [];
	for (let i = 0; i < path.length - 1; i++) {
		const p0 = path[i];
		const p1 = path[i + 1];
		out.push(p0);
		const dx = p1.x - p0.x, dy = p1.y - p0.y, dz = p1.z - p0.z;
		const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
		if (len > maxSegmentLength) {
			const n = Math.ceil(len / maxSegmentLength);
			for (let k = 1; k < n; k++) {
				const t = k / n;
				out.push({
					x: p0.x + t * dx,
					y: p0.y + t * dy,
					z: p0.z + t * dz,
				});
			}
		}
	}
	out.push(path[path.length - 1]);
	return out;
}

/** 预生成 MMAP：从文件加载 NavMesh（recast-navigation 格式），参考 TrinityCore/AmeisenNavigation 的 MMAP 用法。 */
async function loadNavMeshFromMmap(mmapPath) {
	const absPath = path.isAbsolute(mmapPath) ? mmapPath : path.join(__dirname, mmapPath);
	if (!fs.existsSync(absPath)) return null;
	const { init, importNavMesh, NavMeshQuery } = require('recast-navigation');
	if (!recastInit) {
		await init();
		recastInit = true;
	}
	const buf = fs.readFileSync(absPath);
	const data = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
	const { navMesh } = importNavMesh(data);
	const QUERY_HALF_EXTENTS = { x: 1000, y: 1000, z: 1000 };
	const query = new NavMeshQuery(navMesh, { defaultQueryHalfExtents: QUERY_HALF_EXTENTS });
	return query;
}

/**
 * Build navmesh from geometry file or from CASC. Returns NavMeshQuery or null.
 * 若提供 options.mmapPath 且文件存在，则优先从预生成 MMAP 加载（不再从几何构建）。
 */
async function buildNavMesh(options = {}) {
	// 预生成 MMAP：优先从文件加载（参考 TrinityCore / AmeisenNavigation）
	if (options.mmapPath) {
		const mmapPath = path.isAbsolute(options.mmapPath) ? options.mmapPath : path.join(__dirname, options.mmapPath);
		if (fs.existsSync(mmapPath)) {
			try {
				const query = await loadNavMeshFromMmap(mmapPath);
				if (query) {
					navMeshQuery = query;
					navMeshBackend = 'recast';
					navMeshNavcat = null;
					navcatModule = null;
					currentGeometryPath = null;
					console.log('[navmesh] Loaded pre-generated MMAP:', mmapPath);
					return query;
				}
			} catch (e) {
				if (process.env.DEBUG_NAVMESH) console.warn('[navmesh] MMAP load failed:', e.message);
			}
		}
	}

	const geometryPath = options.geometryPath || path.join(__dirname, 'exports', 'recast-geometry.json');
	let positions, indices;
	// 显式指定几何文件时（如 CLI --geometry）优先使用，保证覆盖该区域的 NavMesh 能精确寻路
	if (options.useGeometryFile && geometryPath && fs.existsSync(geometryPath)) {
		const data = JSON.parse(fs.readFileSync(geometryPath, 'utf8'));
		positions = data.positions;
		indices = data.indices;
		currentGeometryPath = geometryPath;
		if (positions && positions.length >= 3) {
			let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
			for (let i = 0; i < positions.length; i += 3) {
				minX = Math.min(minX, positions[i]);
				maxX = Math.max(maxX, positions[i]);
				minZ = Math.min(minZ, positions[i + 2]);
				maxZ = Math.max(maxZ, positions[i + 2]);
			}
			lastGeometryBounds = { minX, maxX, minZ, maxZ };
		} else {
			lastGeometryBounds = null;
		}
	} else if (options.casc && options.mapName && options.bbox) {
		const { buildRecastGeometry } = require('./export-recast-geometry');
		const geom = await buildRecastGeometry(options.casc, options.mapName, options.bbox, options);
		positions = geom.positions;
		indices = geom.indices;
		currentGeometryPath = null;
		if (typeof process !== 'undefined' && process.env.DEBUG_NAVMESH) {
			let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
			for (let i = 0; i < positions.length; i += 3) {
				minX = Math.min(minX, positions[i]); maxX = Math.max(maxX, positions[i]);
				minY = Math.min(minY, positions[i+1]); maxY = Math.max(maxY, positions[i+1]);
				minZ = Math.min(minZ, positions[i+2]); maxZ = Math.max(maxZ, positions[i+2]);
			}
			console.warn('[navmesh] CASC+bbox geometry:', (positions.length / 3) | 0, 'verts', (indices.length / 3) | 0, 'tris', 'bounds', { minX, maxX, minZ, maxZ });
		}
	} else if (fs.existsSync(geometryPath)) {
		const data = JSON.parse(fs.readFileSync(geometryPath, 'utf8'));
		positions = data.positions;
		indices = data.indices;
		currentGeometryPath = geometryPath;
	} else {
		console.error('[navmesh] No geometry: provide casc+mapName+bbox for route, or ensure', geometryPath, 'exists for server.');
		return null;
	}
	if (!positions || !indices || positions.length < 9 || indices.length < 3) {
		console.error('[navmesh] Invalid geometry (no triangles).');
		return null;
	}
	// 细 mesh + 路线 bbox：裁剪几何到走廊内再建网，可用更小 cellSize 得到更多 poly
	let buildPositions = positions instanceof Float32Array ? positions : new Float32Array(positions);
	let buildIndices = indices instanceof Uint32Array ? indices : new Uint32Array(indices);
	// 细 mesh + 路线 bbox：裁剪几何到走廊内再建网，可用更小 cellSize 得到更多 poly（精度对齐模型坐标）
		const routeBbox = options.routeBbox || (options.bbox && typeof options.bbox.minWest === 'number' && typeof options.bbox.maxWest === 'number' && typeof options.bbox.minNorth === 'number' && typeof options.bbox.maxNorth === 'number'
		? { minWest: options.bbox.minWest, maxWest: options.bbox.maxWest, minNorth: options.bbox.minNorth, maxNorth: options.bbox.maxNorth }
		: null);
	const wantFine = !!options.fineNavMesh || process.env.FINE_NAVMESH === '1' || process.env.FINE_NAVMESH === 'true' ||
		(!!options.useGeometryFile && !!routeBbox); // 几何文件 + 路线 bbox 时默认精细建网以匹配模型精度
	pathOptions.fullPathFidelity = !!options.fullPathFidelity;
	pathOptions.subdivideMaxSegment = typeof options.subdivideMaxSegment === 'number' ? options.subdivideMaxSegment : (options.fullPathFidelity || options.avoidCollisions ? 30 : 0);
	pathOptions.avoidCollisions = !!options.avoidCollisions;
	pathOptions.preferDirectFindPath = !!options.forceTiledNavMesh;
	// 路线模式：为 100% 精度、不裁掉绕行障碍，默认不裁剪几何；仅当调用方显式 skipRouteCrop=false 时才裁剪
	if (wantFine && routeBbox && typeof routeBbox.minWest === 'number' && typeof routeBbox.maxWest === 'number' && typeof routeBbox.minNorth === 'number' && typeof routeBbox.maxNorth === 'number' && options.skipRouteCrop === false) {
		// 显式要求裁剪时：扩大 margin 保留走廊两侧，但轴对齐框外的障碍仍可能被裁掉
		const margin = typeof routeBbox.margin === 'number' ? routeBbox.margin : 800;
		const cropBox = {
			minWest: Math.min(routeBbox.minWest, routeBbox.maxWest) - margin,
			maxWest: Math.max(routeBbox.minWest, routeBbox.maxWest) + margin,
			minNorth: Math.min(routeBbox.minNorth, routeBbox.maxNorth) - margin,
			maxNorth: Math.max(routeBbox.minNorth, routeBbox.maxNorth) + margin,
		};
		const cropped = cropGeometryToBbox(buildPositions, buildIndices, cropBox);
		if (cropped.triCount >= 3) {
			buildPositions = cropped.positions;
			buildIndices = cropped.indices;
			if (typeof process !== 'undefined') {
				console.log('[navmesh] Cropped geometry for fine navmesh:', cropped.vertexCount, 'verts', cropped.triCount, 'tris');
			}
		} else if (typeof process !== 'undefined' && cropped.triCount === 0) {
			console.warn('[navmesh] Crop to route bbox produced 0 tris; geometry may not cover route corridor (check tile/chunk coords for this map).');
		}
	}
	// 优先使用 navcat（纯 JS，支持 Solo/Tiled，无 WASM 断言）
	// 若仅从几何文件构建且未强制 navcat，则先尝试 recast 以规避 navcat 大世界坐标下 queryPolygons 的 tile 查找问题
	const preferRecastForGeometry = !!options.useGeometryFile && !!options.preferRecastForGeometry;
	navMeshNavcat = null;
	navMeshBackend = null;
	if (!preferRecastForGeometry) try {
		const navcat = await import('navcat');
		const blocks = await import('navcat/blocks');
		let pos = buildPositions;
		const idx = buildIndices;
		const numTris = idx.length / 3;
		// 将几何平移到局部坐标系，降低 navcat 在大世界坐标下的量化/精度问题。
		let minBX = Infinity, maxBX = -Infinity, minBZ = Infinity, maxBZ = -Infinity;
		for (let i = 0; i < pos.length; i += 3) {
			minBX = Math.min(minBX, pos[i]);
			maxBX = Math.max(maxBX, pos[i]);
			minBZ = Math.min(minBZ, pos[i + 2]);
			maxBZ = Math.max(maxBZ, pos[i + 2]);
		}
		const offsetX = Number.isFinite(minBX) && Number.isFinite(maxBX) ? (minBX + maxBX) * 0.5 : 0;
		const offsetZ = Number.isFinite(minBZ) && Number.isFinite(maxBZ) ? (minBZ + maxBZ) * 0.5 : 0;
		if (Math.abs(offsetX) > 1e-9 || Math.abs(offsetZ) > 1e-9) {
			const shifted = new Float32Array(pos.length);
			for (let i = 0; i < pos.length; i += 3) {
				shifted[i] = pos[i] - offsetX;
				shifted[i + 1] = pos[i + 1];
				shifted[i + 2] = pos[i + 2] - offsetZ;
			}
			pos = shifted;
		}
		navWorldOffset = { x: offsetX, z: offsetZ };
		// 路线模式（routeBbox）：优先正确性，强制细粒度 cellSize 以保留障碍物、得到折弯路径；不因三角数大而放大 cellSize
		// 三角数极大时（>1.2M）建网会 OOM，故自动用 2；若需折线可缩小几何 bbox 后使用 0.5/1
		const usedCropped = (buildIndices.length !== (indices instanceof Uint32Array ? indices.length : indices.length));
		let cellSize;
		if (wantFine && routeBbox) {
			// 路线寻路：固定 0.5 保证障碍物不被体素抹平；三角数极大(>60万)时用 1，>120万时用 2 避免 OOM
			const defaultRouteCellSize = numTris > 1200000 ? 2 : (numTris > 600000 ? 1 : 0.5);
			cellSize = (typeof options.routeCellSize === 'number' && options.routeCellSize > 0) ? options.routeCellSize : defaultRouteCellSize;
		} else {
			cellSize = (wantFine && usedCropped && numTris < 30000) ? 0.5 : (numTris > 100000 ? 4 : numTris > 50000 ? 2 : 1);
			if (wantFine && usedCropped && cellSize > 1) {
				if (numTris <= 150000) cellSize = 1;
				else if (numTris <= 400000) cellSize = Math.min(cellSize, 2);
			}
		}
		if (typeof process !== 'undefined' && (numTris > 100000 || (wantFine && routeBbox))) {
			console.log('[navmesh] Building NavMesh (navcat),', numTris, 'tris, cellSize', cellSize, (routeBbox ? '(route precision)' : '') + '...');
		}
		const cellHeight = (cellSize <= 0.5) ? 0.3 : 0.5;
		const walkableRadiusWorld = (pathOptions.avoidCollisions || options.useGeometryFile) ? (options.walkableRadiusWorld ?? 1.0) : (options.walkableRadiusWorld ?? 0.6);
		const walkableHeightWorld = (typeof options.walkableHeightWorld === 'number' && options.walkableHeightWorld > 0) ? options.walkableHeightWorld : 2.0;
		const walkableClimbWorld = (typeof options.walkableClimbWorld === 'number') ? options.walkableClimbWorld : 0.5;
		const walkableRadiusVoxels = Math.max(1, Math.ceil(walkableRadiusWorld / cellSize));
		const walkableClimbVoxels = Math.max(1, Math.ceil(walkableClimbWorld / cellHeight));
		const walkableHeightVoxels = Math.ceil(walkableHeightWorld / cellHeight);
		// 路线模式可收紧坡度：山体等陡坡视为不可行走，迫使绕行；默认 35°（小于 45° 可避免“直线翻山”）
		const walkableSlopeDegrees = (wantFine && routeBbox && typeof options.routeWalkableSlopeAngleDegrees === 'number')
			? options.routeWalkableSlopeAngleDegrees
			: 45;
		const input = { positions: pos, indices: idx };
		let result = null;
		const minRegionArea = (wantFine && routeBbox) ? 0 : (wantFine ? 2 : 8);
		const mergeRegionArea = (wantFine && routeBbox) ? 0 : (wantFine ? 4 : 20);
		const maxSimplificationError = wantFine ? 0.3 : 1.3;
		const maxEdgeLength = wantFine ? 6 : 24;
		// wantFine 默认强制 Solo；可通过 forceTiledNavMesh 显式覆盖做对照实验
		const forceTiled = !!options.forceTiledNavMesh;
		const forceSolo = !forceTiled && (!!options.forceSoloNavMesh || wantFine);
		if (!forceSolo && numTris > 50000) {
			try {
				const tileSizeWorld = wantFine ? 128 : 64;
				const tileSizeVoxels = Math.ceil(tileSizeWorld / cellSize);
				result = blocks.generateTiledNavMesh(input, {
					cellSize,
					cellHeight,
					tileSizeVoxels,
					tileSizeWorld,
					walkableRadiusVoxels,
					walkableRadiusWorld,
					walkableClimbVoxels,
					walkableClimbWorld,
					walkableHeightVoxels,
					walkableHeightWorld,
					walkableSlopeAngleDegrees: walkableSlopeDegrees,
					borderSize: walkableRadiusVoxels + 3,
					minRegionArea,
					mergeRegionArea,
					maxSimplificationError,
					maxEdgeLength,
					maxVerticesPerPoly: 6,
					detailSampleDistance: cellSize * 6,
					detailSampleMaxError: cellHeight * 1,
				});
			} catch (_) {}
		}
		if (!result) {
			result = blocks.generateSoloNavMesh(input, {
				cellSize,
				cellHeight,
				walkableRadiusVoxels,
				walkableRadiusWorld,
				walkableClimbVoxels,
				walkableClimbWorld,
				walkableHeightVoxels,
				walkableHeightWorld,
				walkableSlopeAngleDegrees: walkableSlopeDegrees,
				borderSize: 0,
				minRegionArea,
				mergeRegionArea,
				maxSimplificationError,
				maxEdgeLength,
				maxVerticesPerPoly: 6,
				detailSampleDistance: cellSize * 6,
				detailSampleMaxError: cellHeight * 1,
			});
		}
		if (result && result.navMesh) {
			navMeshNavcat = result.navMesh;
			navMeshBackend = 'navcat';
			navMeshQuery = null;
			navcatModule = navcat;
			console.log('[navmesh] NavMesh built successfully (navcat).');
			return navMeshNavcat;
		}
	} catch (e) {
		if (process.env.DEBUG_NAVMESH) {
			console.warn('[navmesh] navcat build failed:', e.message);
		}
	}
	// 回退到 recast-navigation-js (WASM)：使用与 navcat 相同的裁剪后几何
	navMeshNavcat = null;
	navMeshBackend = 'recast';
	navcatModule = null;
	navWorldOffset = { x: 0, z: 0 };
	const recastPositions = buildPositions;
	const recastIndices = buildIndices;
	const routeBboxForRecast = options.routeBbox || (options.bbox && typeof options.bbox.minWest === 'number' ? {
		minWest: options.bbox.minWest, maxWest: options.bbox.maxWest, minNorth: options.bbox.minNorth, maxNorth: options.bbox.maxNorth
	} : null);
	// 用裁剪后几何的边界作为 build bounds
	let bounds = options.bounds;
	if (!bounds || !Array.isArray(bounds[0])) {
		let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		for (let i = 0; i < recastPositions.length; i += 3) {
			minX = Math.min(minX, recastPositions[i]); maxX = Math.max(maxX, recastPositions[i]);
			minY = Math.min(minY, recastPositions[i + 1]); maxY = Math.max(maxY, recastPositions[i + 1]);
			minZ = Math.min(minZ, recastPositions[i + 2]); maxZ = Math.max(maxZ, recastPositions[i + 2]);
		}
		bounds = [[minX, minY, minZ], [maxX, maxY, maxZ]];
	}
	const { init } = require('recast-navigation');
	const { generateSoloNavMesh, generateTiledNavMesh } = require('recast-navigation/generators');
	if (!recastInit) {
		await init();
		recastInit = true;
	}
	// 路线模式：更细 cellSize/cellHeight 以保留障碍物；可收紧 agentMaxSlope 使山体不可行走
	const navMeshConfig = {
		cellSize: (wantFine && routeBboxForRecast) ? 0.5 : 0.3,
		cellHeight: (wantFine && routeBboxForRecast) ? 0.3 : 0.2,
		agentHeight: (typeof options.walkableHeightWorld === 'number' && options.walkableHeightWorld > 0) ? options.walkableHeightWorld : 2.0,
		agentRadius: pathOptions.avoidCollisions ? 1.0 : 0.6,
		agentMaxClimb: (typeof options.walkableClimbWorld === 'number') ? options.walkableClimbWorld : 0.9,
		agentMaxSlope: (wantFine && routeBboxForRecast && typeof options.routeWalkableSlopeAngleDegrees === 'number')
			? options.routeWalkableSlopeAngleDegrees : 45,
		regionMinSize: 8,
		regionMergeSize: 20,
		edgeMaxLen: 12,
		edgeMaxError: 1.3,
		vertsPerPoly: 6,
		detailSampleDist: 6,
		detailSampleMaxError: 1,
		...options.recastConfig
	};
	if (options.bounds && Array.isArray(options.bounds[0])) {
		navMeshConfig.bounds = options.bounds;
	} else if (bounds && Array.isArray(bounds[0])) {
		navMeshConfig.bounds = bounds;
	}
	// Tiled 适合大范围几何；路线模式仅用 Solo，使用裁剪后几何
	const numVerts = recastPositions.length / 3;
	const numTrisRecast = recastIndices.length / 3;
	const useTiledFirst = !routeBboxForRecast && (numVerts > 50000 || numTrisRecast > 50000);
	let result;
	if (useTiledFirst) {
		const tiledConfig = {
			...navMeshConfig,
			tileSize: 32,
		};
		result = generateTiledNavMesh(recastPositions, recastIndices, tiledConfig);
	}
	if (!result?.success || !result?.navMesh) {
		result = generateSoloNavMesh(recastPositions, recastIndices, navMeshConfig);
	}
	if (!result.success || !result.navMesh) {
		// 重试：更粗参数以减少多边形数（至少比当前粗）
		const baseCs = navMeshConfig.cellSize || 0.3;
		const coarseConfig = {
			...navMeshConfig,
			cellSize: Math.max(baseCs * 1.5, 2),
			cellHeight: Math.max(navMeshConfig.cellHeight || 0.2, 0.5),
			regionMinSize: 16,
			regionMergeSize: 32,
			edgeMaxLen: 24,
			detailSampleDist: 12,
			detailSampleMaxError: 2,
		};
		result = generateSoloNavMesh(recastPositions, recastIndices, coarseConfig);
	}
	if (!result.success || !result.navMesh) {
		// 再次重试：极粗参数
		const baseCs = navMeshConfig.cellSize || 0.3;
		const veryCoarse = {
			...navMeshConfig,
			cellSize: Math.max(baseCs * 2.5, 4),
			cellHeight: 1,
			regionMinSize: 8,
			regionMergeSize: 16,
			edgeMaxLen: 40,
			detailSampleDist: 0,
			detailSampleMaxError: 0,
		};
		result = generateSoloNavMesh(recastPositions, recastIndices, veryCoarse);
	}
	if (!result.success || !result.navMesh) {
		// 路线模式（有 bbox）最后重试：超粗参数
		if (options.bbox || routeBboxForRecast) {
			const baseCs = navMeshConfig.cellSize || 0.3;
			const ultraCoarse = {
				...navMeshConfig,
				cellSize: Math.max(baseCs * 4, 8),
				cellHeight: 1.5,
				regionMinSize: 4,
				regionMergeSize: 8,
				edgeMaxLen: 60,
				detailSampleDist: 0,
				detailSampleMaxError: 0,
			};
			result = generateSoloNavMesh(recastPositions, recastIndices, ultraCoarse);
		}
	}
	if (!result.success || !result.navMesh) {
		console.log('[navmesh] NavMesh build failed. Try smaller bbox or export geometry to file.');
		if (result.error && typeof process !== 'undefined') {
			console.warn('[navmesh] Last error:', result.error);
		}
		return null;
	}
	const { success, navMesh, error } = result;
	const { NavMeshQuery } = require('recast-navigation');
	// WoW 世界坐标尺度大（数千单位），默认 halfExtents=1 会找不到多边形；使用 1000 码搜索半径
	const QUERY_HALF_EXTENTS = { x: 1000, y: 1000, z: 1000 };
	navMeshQuery = new NavMeshQuery(navMesh, {
		defaultQueryHalfExtents: QUERY_HALF_EXTENTS
	});
	console.log('[navmesh] NavMesh built successfully.');
	return navMeshQuery;
}

/**
 * Find path on navmesh. start/end in game coords: { x: north, y: west, z: height } or (north, west, height).
 * Returns array of { x, y, z } in game coords (north, west, height) or null.
 * WoW 世界坐标尺度大，参考 AmeisenNavigation/TrinityCore 做法：先用较大 halfExtents 确保 findNearestPoly 命中多边形，
 * 若 1000 失败则依次尝试 2000、3000（INVALID_INPUT 通常表示起点或终点未落在查询盒内的多边形上）。
 */
function findPathNavMesh(start, end) {
	const a = Array.isArray(start) ? { x: start[0], y: start[1], z: start[2] } : start;
	const b = Array.isArray(end) ? { x: end[0], y: end[1], z: end[2] } : end;
	if (navMeshBackend === 'navcat' && navMeshNavcat && navcatModule) {
		const startVecWorld = [a.y, a.z, a.x];   // west, height, north
		const endVecWorld = [b.y, b.z, b.x];
		if (lastGeometryBounds) {
			// 仅将超出几何范围的点裁到 bbox 内，避免查询越界；不再内缩 margin，否则会把起点/终点裁到错误位置
			const minX = lastGeometryBounds.minX;
			const maxX = lastGeometryBounds.maxX;
			const minZ = lastGeometryBounds.minZ;
			const maxZ = lastGeometryBounds.maxZ;
			if (minX <= maxX && minZ <= maxZ) {
				startVecWorld[0] = Math.max(minX, Math.min(maxX, startVecWorld[0]));
				startVecWorld[2] = Math.max(minZ, Math.min(maxZ, startVecWorld[2]));
				endVecWorld[0] = Math.max(minX, Math.min(maxX, endVecWorld[0]));
				endVecWorld[2] = Math.max(minZ, Math.min(maxZ, endVecWorld[2]));
			}
		}
		const startVec = [startVecWorld[0] - navWorldOffset.x, startVecWorld[1], startVecWorld[2] - navWorldOffset.z];
		const endVec = [endVecWorld[0] - navWorldOffset.x, endVecWorld[1], endVecWorld[2] - navWorldOffset.z];
		const extentsToTry = lastGeometryBounds
			? [[300, 500, 300], [500, 500, 500], [1000, 1000, 1000], [2000, 2000, 2000], [3000, 3000, 3000]]
			: [[1000, 1000, 1000], [2000, 2000, 2000], [3000, 3000, 3000]];
		// 先吸附到 NavMesh 表面，避免因高度偏差导致 findNearestPoly 失败
		let startUse = startVec;
		let endUse = endVec;
		const filter = navcatModule.ANY_QUERY_FILTER || navcatModule.DEFAULT_QUERY_FILTER;
		const directFindPath = (s, e) => {
			const completeMask = (navcatModule.FindPathResultFlags && navcatModule.FindPathResultFlags.COMPLETE_PATH) ? navcatModule.FindPathResultFlags.COMPLETE_PATH : 2;
			for (const halfExtents of extentsToTry) {
				const r = navcatModule.findPath(navMeshNavcat, s, e, halfExtents, filter);
				if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
					console.warn('[navmesh] direct findPath', halfExtents, 'flags', r?.flags, 'len', r?.path?.length || 0);
				}
				if (r && r.success && r.path && r.path.length > 1 && (r.flags & completeMask) === completeMask) {
					const raw = r.path.map(p => {
						const pos = p.position || p;
						const x = (typeof pos.x === 'number' ? pos.x : pos[0]) + navWorldOffset.x;
						const y = typeof pos.y === 'number' ? pos.y : pos[1];
						const z = (typeof pos.z === 'number' ? pos.z : pos[2]) + navWorldOffset.z;
						return recastToGame(x, y, z);
					});
					if (raw.length >= 2) return raw;
				}
			}
			return null;
		};
		// 单 tile 时 findNearestPoly 常因 BV 树量化漏掉多边形；先用整 tile queryPolygons + getClosestPointOnPoly 得到 ref，再 findNodePath + findStraightPath
		const tileIds = Object.keys(navMeshNavcat.tiles || {});
		let tile0 = null;
		for (const id of tileIds) {
			tile0 = navMeshNavcat.tiles[id];
			if (tile0) break;
		}
		if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
			console.warn('[navmesh] tileIds.length', tileIds.length, 'tile0', !!tile0, 'queryPolygons', !!navcatModule.queryPolygons);
		}
		// tiled 场景优先走原生 findPath，避免候选-直线分支在多 tile 时误丢可达路径。
		if (pathOptions.preferDirectFindPath && tileIds.length > 1) {
			if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
				console.warn('[navmesh] trying direct findPath first for tiled navmesh');
			}
			const direct = directFindPath(startVec, endVec);
			if (direct) return direct;
		}
		if (tile0 && tileIds.length >= 1 && navcatModule.queryPolygons && navcatModule.getClosestPointOnPoly && navcatModule.createGetClosestPointOnPolyResult && navcatModule.findNodePath && navcatModule.findStraightPath) {
			// 多 tile 时合并所有 tile 的 bounds，确保 queryPolygons 能查到全 mesh 的 poly
			let fullBounds;
			if (tileIds.length === 1) {
				// 单 tile 时 queryPolygons 可能因 worldToTilePosition 得到空；用几何 bbox 构造 bounds，Y 放宽
				const g = lastGeometryBounds;
				fullBounds = g && g.minX <= g.maxX && g.minZ <= g.maxZ
					? [g.minX - navWorldOffset.x, -1e10, g.minZ - navWorldOffset.z, g.maxX - navWorldOffset.x, 1e10, g.maxZ - navWorldOffset.z]
					: [tile0.bounds[0], tile0.bounds[1], tile0.bounds[2], tile0.bounds[3], tile0.bounds[4], tile0.bounds[5]];
			} else {
				let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
				for (const id of tileIds) {
					const t = navMeshNavcat.tiles[id];
					if (!t || !t.bounds) continue;
					minX = Math.min(minX, t.bounds[0]); minY = Math.min(minY, t.bounds[1]); minZ = Math.min(minZ, t.bounds[2]);
					maxX = Math.max(maxX, t.bounds[3]); maxY = Math.max(maxY, t.bounds[4]); maxZ = Math.max(maxZ, t.bounds[5]);
				}
				fullBounds = [minX, minY, minZ, maxX, maxY, maxZ];
			}
			let polys = navcatModule.queryPolygons(navMeshNavcat, fullBounds, filter);
			if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
				console.warn('[navmesh] queryPolygons polys.length', polys && polys.length);
			}
			if (polys && polys.length > 0) {
				// 正常路径
			} else if (tileIds.length === 1 && tile0 && tile0.polyNodes && navMeshNavcat.nodes) {
				// 单 tile 时 queryPolygons 可能返回 0（worldToTilePosition/quant 等），直接收集该 tile 所有 poly 的 ref
				polys = [];
				for (let i = 0; i < (tile0.polyNodes.length || 0); i++) {
					const nodeIndex = tile0.polyNodes[i];
					const node = navMeshNavcat.nodes[nodeIndex];
					if (node && node.ref) polys.push(node.ref);
				}
				if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
					console.warn('[navmesh] single-tile fallback tile.polys.length', tile0.polys && tile0.polys.length, 'polyNodes.length', tile0.polyNodes && tile0.polyNodes.length, 'polys.length', polys.length);
				}
			}
			if (polys && polys.length > 0) {
				const cpResult = navcatModule.createGetClosestPointOnPolyResult();
				// 只接受「查询点在 XZ 平面内真正靠近」的 poly，否则会吸附到错误区域导致路线完全错误
				const MAX_XZ_DISTANCE_SQ = 1000 * 1000; // 1000 码：终点可能距最近 poly ~972，需放宽以走通单 tile 分支
				const collectNearestCandidates = (point, limit = 16, excludeRef = null) => {
					const cands = [];
					for (const ref of polys) {
						if (ref === excludeRef) continue;
						navcatModule.getClosestPointOnPoly(cpResult, navMeshNavcat, ref, point);
						if (!cpResult.success) continue;
						const pos = cpResult.position;
						const px = Array.isArray(pos) ? pos[0] : pos.x;
						const py = Array.isArray(pos) ? pos[1] : pos.y;
						const pz = Array.isArray(pos) ? pos[2] : pos.z;
						const dx = px - point[0], dz = pz - point[2];
						const xzDistSq = dx * dx + dz * dz;
						if (xzDistSq > MAX_XZ_DISTANCE_SQ) continue;
						cands.push({ ref, position: [px, py, pz], xzDistSq });
					}
					cands.sort((m, n) => m.xzDistSq - n.xzDistSq);
					return cands.slice(0, Math.max(1, limit));
				};
				// 诊断：无过滤时起点/终点的最小 XZ 距离（DEBUG_NAVMESH=1 时打印）
				if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
					const diagMinXz = (label, pt) => {
						let minXzSq = Infinity;
						let bestPos = null;
						for (const ref of polys) {
							navcatModule.getClosestPointOnPoly(cpResult, navMeshNavcat, ref, pt);
							if (!cpResult.success) continue;
							const pos = cpResult.position;
							const px = Array.isArray(pos) ? pos[0] : pos.x;
							const pz = Array.isArray(pos) ? pos[2] : pos.z;
							const xzSq = (px - pt[0]) ** 2 + (pz - pt[2]) ** 2;
							if (xzSq < minXzSq) {
								minXzSq = xzSq;
								bestPos = [px, pz];
							}
						}
						const d = minXzSq === Infinity ? null : Math.sqrt(minXzSq).toFixed(1);
						console.warn('[navmesh] diag', label, 'minXz=', d, bestPos ? `closestPolyAt=(${bestPos[0].toFixed(0)},${bestPos[1].toFixed(0)})` : '');
					};
					diagMinXz('start', startVec);
					diagMinXz('end', endVec);
				}
				const startCandidates = collectNearestCandidates(startVec, 16);
				const endCandidates = collectNearestCandidates(endVec, 256);
				const startManual = startCandidates[0] || { ref: null, position: null, xzDistSq: Infinity };
				let endManual = endCandidates[0] || { ref: null, position: null, xzDistSq: Infinity };
				// 吸附过远则视为无效：不在此分支返回，交给后续回退或返回 null
				const XZ_ACCEPT_SQ = 1000 * 1000;
				const startXzSq = Number.isFinite(startManual.xzDistSq) ? startManual.xzDistSq : Infinity;
				const endXzSq = Number.isFinite(endManual.xzDistSq) ? endManual.xzDistSq : Infinity;
				const snapValid = startManual.ref && startManual.position && endManual.ref && endManual.position && startXzSq <= XZ_ACCEPT_SQ && endXzSq <= XZ_ACCEPT_SQ;
				if ((process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') && startManual.position && endManual.position) {
					const sameRef = startManual.ref === endManual.ref;
					const distSq = (startManual.position[0] - endManual.position[0]) ** 2 + (startManual.position[1] - endManual.position[1]) ** 2 + (startManual.position[2] - endManual.position[2]) ** 2;
					console.warn('[navmesh] single-tile snap start', startManual.position, 'end', endManual.position, 'sameRef', sameRef, 'distSq', distSq, 'snapValid', snapValid, 'startXzSq', startXzSq, 'endXzSq', endXzSq);
				}
				if (snapValid) {
					const nodePathFlags = navcatModule.FindNodePathResultFlags || {};
					const straightFlags = navcatModule.FindStraightPathResultFlags || {};
					const pointFlags = navcatModule.StraightPathPointFlags || {};
					const completeNodeMask = nodePathFlags.COMPLETE_PATH ?? 2;
					const partialStraightMask = straightFlags.PARTIAL_PATH ?? 4;
					const endPointMask = pointFlags.END ?? 1;
					const MAX_STRAIGHT_POINTS = 2048;
					for (const s of startCandidates) {
						for (const e of endCandidates) {
							const nodePath = navcatModule.findNodePath(navMeshNavcat, s.ref, e.ref, s.position, e.position, filter);
							if (!nodePath || !nodePath.success || !nodePath.path || nodePath.path.length < 1) continue;
							if ((nodePath.flags & completeNodeMask) !== completeNodeMask) continue;
							const straightPath = navcatModule.findStraightPath(navMeshNavcat, s.position, e.position, nodePath.path, MAX_STRAIGHT_POINTS);
							if (!straightPath || !straightPath.success || !straightPath.path || straightPath.path.length < 2) continue;
							if ((straightPath.flags & partialStraightMask) === partialStraightMask) continue;
							const lastPoint = straightPath.path[straightPath.path.length - 1];
							if (!lastPoint || ((lastPoint.flags ?? 0) & endPointMask) !== endPointMask) continue;
							const raw = straightPath.path.map(p => {
								const pos = p.position || p;
								const x = (typeof pos.x === 'number' ? pos.x : pos[0]) + navWorldOffset.x;
								const y = typeof pos.y === 'number' ? pos.y : pos[1];
								const z = (typeof pos.z === 'number' ? pos.z : pos[2]) + navWorldOffset.z;
								return recastToGame(x, y, z);
							});
							if (raw.length >= 2) return raw;
						}
					}
				}
			}
		}
		// 回退：findNearestPoly + findPath
		for (const halfExtents of extentsToTry) {
			const startNearest = navcatModule.findNearestPoly(
				navcatModule.createFindNearestPolyResult(),
				navMeshNavcat, startVec, halfExtents, filter
			);
			const endNearest = navcatModule.findNearestPoly(
				navcatModule.createFindNearestPolyResult(),
				navMeshNavcat, endVec, halfExtents, filter
			);
			if (startNearest.success && startNearest.position) {
				const p = startNearest.position;
				startUse = Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z];
			}
			if (endNearest.success && endNearest.position) {
				const p = endNearest.position;
				endUse = Array.isArray(p) ? [p[0], p[1], p[2]] : [p.x, p.y, p.z];
			}
			if (startNearest.success && endNearest.success) break;
		}
		let result = null;
		for (const halfExtents of extentsToTry) {
			result = navcatModule.findPath(navMeshNavcat, startUse, endUse, halfExtents, filter);
			const completePathMask = (navcatModule.FindPathResultFlags && navcatModule.FindPathResultFlags.COMPLETE_PATH) ? navcatModule.FindPathResultFlags.COMPLETE_PATH : 2;
			if (result && result.success && result.path && result.path.length > 1 && (result.flags & completePathMask) === completePathMask)
				break;
			if ((process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') && result) {
				console.warn('[navmesh] navcat halfExtents', halfExtents, 'findPath flags:', result.flags);
			}
		}
		const completePathMaskFinal = (navcatModule.FindPathResultFlags && navcatModule.FindPathResultFlags.COMPLETE_PATH) ? navcatModule.FindPathResultFlags.COMPLETE_PATH : 2;
		const isComplete = !!(result && (result.flags & completePathMaskFinal) === completePathMaskFinal);
		if (!result || !result.success || !result.path || result.path.length < 2 || !isComplete) {
			const startN = navcatModule.findNearestPoly(
				navcatModule.createFindNearestPolyResult(),
				navMeshNavcat, startUse, [3000, 3000, 3000], filter
			);
			const endN = navcatModule.findNearestPoly(
				navcatModule.createFindNearestPolyResult(),
				navMeshNavcat, endUse, [3000, 3000, 3000], filter
			);
			console.log('[navmesh] navcat findPath failed startNearest:', startN.success, 'endNearest:', endN.success, 'flags:', result?.flags);
			return null;
		}
		const raw = result.path.map(p => {
			const pos = p.position;
			const x = (typeof pos.x === 'number' ? pos.x : pos[0]) + navWorldOffset.x;
			const y = typeof pos.y === 'number' ? pos.y : pos[1];
			const z = (typeof pos.z === 'number' ? pos.z : pos[2]) + navWorldOffset.z;
			return recastToGame(x, y, z);
		});
		if (raw.length < 2) {
			if (typeof process !== 'undefined' && process.env.DEBUG_NAVMESH) {
				console.warn('[navmesh] navcat findPath returned insufficient points:', raw.length);
			}
			return null;
		}
		if (isPathEffectivelyStraight2D(raw, { collinearEps: 1e-4 })) {
			if (typeof process !== 'undefined') {
				console.warn('[navmesh] 警告：算法返回近似直线路径，请检查几何覆盖/体素参数。');
			}
		}
		return raw;
	}
	if (!navMeshQuery) return null;
	const startR = gameToRecast(a.x, a.y, a.z);
	const endR = gameToRecast(b.x, b.y, b.z);
	const halfExtents = { x: 1000, y: 1000, z: 1000 };
	const startSnap = navMeshQuery.findClosestPoint(startR, { halfExtents });
	const endSnap = navMeshQuery.findClosestPoint(endR, { halfExtents });
	const startUse = (startSnap.success && startSnap.point) ? startSnap.point : startR;
	const endUse = (endSnap.success && endSnap.point) ? endSnap.point : endR;
	const { success, path } = navMeshQuery.computePath(startUse, endUse, { halfExtents });
	if (!success || !path || path.length === 0) {
		if (typeof process !== 'undefined' && process.env.DEBUG_NAVMESH) {
			console.warn('[navmesh] findPath failed:', { startSnap: startSnap.success, endSnap: endSnap.success, computeSuccess: success, pathLen: path?.length ?? 0 });
		}
		return null;
	}
	let raw = path.map(p => recastToGame(p.x, p.y, p.z));
	if (isPathEffectivelyStraight2D(raw, { collinearEps: 1e-4 })) {
		if (typeof process !== 'undefined') {
			console.warn('[navmesh] 警告：算法返回近似直线路径，请检查几何覆盖/体素参数。');
		}
	}
	return raw;
}

async function startServer(port = 3919) {
	if (!navMeshQuery && !navMeshNavcat) {
		await buildNavMesh();
		if (!navMeshQuery && !navMeshNavcat) {
			console.error('[navmesh] Cannot start server: no navmesh.');
			process.exit(1);
		}
	}
	const server = http.createServer((req, res) => {
		const url = new URL(req.url || '', 'http://localhost');
		if (url.pathname === '/path' && req.method === 'GET') {
			const fromN = parseFloat(url.searchParams.get('fromN'));
			const fromW = parseFloat(url.searchParams.get('fromW'));
			const fromH = parseFloat(url.searchParams.get('fromH') || '0');
			const toN = parseFloat(url.searchParams.get('toN'));
			const toW = parseFloat(url.searchParams.get('toW'));
			const toH = parseFloat(url.searchParams.get('toH') || '0');
			if (isNaN(fromN) || isNaN(fromW) || isNaN(toN) || isNaN(toW)) {
				res.writeHead(400, { 'Content-Type': 'application/json' });
				res.end(JSON.stringify({ error: 'Missing or invalid fromN, fromW, toN, toW' }));
				return;
			}
			const pathPoints = findPathNavMesh(
				{ x: fromN, y: fromW, z: fromH },
				{ x: toN, y: toW, z: toH }
			);
			res.writeHead(200, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify(pathPoints || []));
			return;
		}
		if (url.pathname === '/path' && req.method === 'POST') {
			let body = '';
			req.on('data', c => { body += c; });
			req.on('end', () => {
				try {
					const j = JSON.parse(body || '{}');
					const from = j.from || {};
					const to = j.to || {};
					const pathPoints = findPathNavMesh(
						[j.fromN ?? from.x, j.fromW ?? from.y, j.fromH ?? from.z],
						[j.toN ?? to.x, j.toW ?? to.y, j.toH ?? to.z]
					);
					res.writeHead(200, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify(pathPoints || []));
				} catch (e) {
					res.writeHead(400, { 'Content-Type': 'application/json' });
					res.end(JSON.stringify({ error: String(e.message) }));
				}
			});
			return;
		}
		res.writeHead(404);
		res.end('Not found. Use GET /path?fromN=&fromW=&fromH=&toN=&toW=&toH= or POST /path with JSON body.');
	});
	server.listen(port, () => {
		console.log('[navmesh] Route service listening on http://localhost:' + port);
		console.log('[navmesh] GET /path?fromN=&fromW=&fromH=&toN=&toW=&toH= (game coords: x=north, y=west, z=height)');
	});
}

async function main() {
	const args = process.argv.slice(2);
	let port = 3919;
	let noServer = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
		else if (args[i] === '--no-server') noServer = true;
	}
	await buildNavMesh();
	if (!navMeshQuery && !navMeshNavcat) process.exit(1);
	if (!noServer) await startServer(port);
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { buildNavMesh, findPathNavMesh, gameToRecast, recastToGame, getHeightAtFromGeometry, startServer, getNavMeshBackend: () => navMeshBackend, getNavMeshNavcat: () => navMeshNavcat, getNavcatModule: () => navcatModule, getNavWorldOffset: () => navWorldOffset };
