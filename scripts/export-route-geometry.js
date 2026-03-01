#!/usr/bin/env node
/**
 * 按路线起点/终点从 wow.export 导出目录中只加载相关地形块 + 外圈，并合并 WMO/M2 的 CSV 放置，生成寻路几何。
 * 与 wow.export 瓦片命名一致：tileID = tileY_tileX（如 31_40），世界坐标 (west,north) -> tx=floor(32-west/TILE_SIZE), tz=floor(32-north/TILE_SIZE)。
 *
 * 用法:
 *   node pathfinder/scripts/export-route-geometry.js --dir "..." --from 北 西 高 --to 北 西 高 [--out ...] [--margin 2] [--terrain-only]
 * [--terrain-only] 仅合并地形 OBJ，不加载放置 CSV 与 WMO/M2，用于先验证地形能否规划路线。
 * 地形 OBJ 顶点与 wow.export 一致：来自 MCNK chunk.position + 顶点偏移，已是世界坐标 (west, height, north)，不再加 tileOrigin。
 * [--wow-export] 兼容保留。地形 OBJ 自实现与 wow.export 均已 (west, height, north)，合并时统一不交换轴。
 */
const path = require('path');
const fs = require('fs');

const MAP_SIZE = 64;
const MAP_HALF = 32;
const TILE_SIZE = (51200 / 3) / 32;
let writeRegionMapSvg = null;
try {
	({ writeRegionMapSvg } = require('./export-region-map-svg'));
} catch (_) {
	writeRegionMapSvg = null;
}

/** 世界坐标 (west, north) -> 瓦片 (tileX, tileY)，与 terrain-loader / wow.export 一致 */
function worldToTile(west, north) {
	const tx = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - west / TILE_SIZE)));
	const tz = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - north / TILE_SIZE)));
	return { tx, tz };
}

/** 起点、终点（游戏坐标：北,西,高）+ margin 圈数 -> 瓦片 ID 集合（tileY_tileX） */
function getTileIdsForRoute(fromNorth, fromWest, toNorth, toWest, margin = 2) {
	const minWest = Math.min(fromWest, toWest);
	const maxWest = Math.max(fromWest, toWest);
	const minNorth = Math.min(fromNorth, toNorth);
	const maxNorth = Math.max(fromNorth, toNorth);
	const t0 = worldToTile(maxWest, maxNorth);
	const t1 = worldToTile(minWest, minNorth);
	const txMin = Math.min(t0.tx, t1.tx);
	const txMax = Math.max(t0.tx, t1.tx);
	const tzMin = Math.min(t0.tz, t1.tz);
	const tzMax = Math.max(t0.tz, t1.tz);
	const txLo = Math.max(0, txMin - margin);
	const txHi = Math.min(MAP_SIZE - 1, txMax + margin);
	const tzLo = Math.max(0, tzMin - margin);
	const tzHi = Math.min(MAP_SIZE - 1, tzMax + margin);
	const ids = new Set();
	for (let tz = tzLo; tz <= tzHi; tz++) {
		for (let tx = txLo; tx <= txHi; tx++) {
			ids.add(tz + '_' + tx);
		}
	}
	return ids;
}

/** 解析 OBJ */
function parseObjFile(filePath) {
	const text = fs.readFileSync(filePath, 'utf8');
	const positions = [];
	const indices = [];
	const lines = text.split(/\r?\n/);
	for (const line of lines) {
		const parts = line.trim().split(/\s+/);
		if (parts.length < 4) continue;
		if (parts[0] === 'v') {
			positions.push(parseFloat(parts[1]), parseFloat(parts[2]), parseFloat(parts[3]));
		} else if (parts[0] === 'f') {
			for (let i = 1; i <= 3; i++) {
				const idx = parseInt(parts[i].split('/')[0], 10);
				indices.push(idx - 1);
			}
		}
	}
	return { positions, indices };
}

function parseCSVLine(line) {
	const out = [];
	let i = 0;
	while (i < line.length) {
		if (line[i] === '"') {
			let s = '';
			i++;
			while (i < line.length) {
				if (line[i] === '"') {
					i++;
					if (line[i] === '"') { s += '"'; i++; }
					else break;
				} else { s += line[i]; i++; }
			}
			out.push(s);
		} else {
			let s = '';
			while (i < line.length && line[i] !== ';') s += line[i++];
			out.push(s.trim());
			if (line[i] === ';') i++;
		}
	}
	return out;
}

function parseCSV(content) {
	const lines = content.split(/\r?\n/).filter(l => l.trim());
	if (lines.length === 0) return { headers: [], rows: [] };
	const headers = parseCSVLine(lines[0]);
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const values = parseCSVLine(lines[i]);
		const row = {};
		headers.forEach((h, j) => { row[h] = values[j] !== undefined ? values[j] : ''; });
		rows.push(row);
	}
	return { headers, rows };
}

/** 仅从给定的 CSV 文件列表加载放置，按 ModelFile 聚合；dirNorm 为导出根目录。
 * CSV 与 wow.export-main 一致为 raw 的 PositionX/Y/Z（ADT 坐标），此处转为世界坐标 (west, height, north) 再写入 placement。 */
function loadPlacementsFromCSVFiles(csvPathList, dirNorm, options = {}) {
	const includeWmo = options.includeWmo !== false;
	const includeM2 = options.includeM2 !== false;
	const byModel = new Map();
	const seenPlacementKeys = new Set();
	for (const csvPath of csvPathList) {
		const content = fs.readFileSync(csvPath, 'utf8');
		const { headers, rows } = parseCSV(content);
		if (headers.indexOf('ModelFile') < 0) continue;
		const csvDir = path.dirname(csvPath);
		for (const row of rows) {
			const modelFile = row['ModelFile'];
			if (!modelFile) continue;
			const type = String(row['Type'] || '').toLowerCase();
			if (type === 'wmo' && !includeWmo) continue;
			if (type === 'm2' && !includeM2) continue;
			// ADT 的 obj0/obj1 可能重复写入同一放置实例；按 Type+FileDataID+ModelId 全局去重。
			// 若缺失 ID，则退化到文件名+位姿近似键去重。
			const fid = String(row['FileDataID'] || '');
			const mid = String(row['ModelId'] || '');
			let dedupeKey = '';
			if (fid && mid) {
				dedupeKey = `${type}|${fid}|${mid}`;
			} else {
				const pxK = Number.isFinite(parseFloat(row['PositionX'])) ? parseFloat(row['PositionX']).toFixed(4) : 'nan';
				const pyK = Number.isFinite(parseFloat(row['PositionY'])) ? parseFloat(row['PositionY']).toFixed(4) : 'nan';
				const pzK = Number.isFinite(parseFloat(row['PositionZ'])) ? parseFloat(row['PositionZ']).toFixed(4) : 'nan';
				const rxK = Number.isFinite(parseFloat(row['RotationX'])) ? parseFloat(row['RotationX']).toFixed(3) : 'nan';
				const ryK = Number.isFinite(parseFloat(row['RotationY'])) ? parseFloat(row['RotationY']).toFixed(3) : 'nan';
				const rzK = Number.isFinite(parseFloat(row['RotationZ'])) ? parseFloat(row['RotationZ']).toFixed(3) : 'nan';
				const scK = Number.isFinite(parseFloat(row['ScaleFactor'])) ? parseFloat(row['ScaleFactor']).toFixed(4) : 'nan';
				dedupeKey = `${type}|${modelFile}|${pxK}|${pyK}|${pzK}|${rxK}|${ryK}|${rzK}|${scK}`;
			}
			if (seenPlacementKeys.has(dedupeKey)) continue;
			seenPlacementKeys.add(dedupeKey);
			const absModel = path.resolve(csvDir, modelFile);
			const rel = path.relative(dirNorm, absModel).replace(/\\/g, '/');
			const key = rel.startsWith('..') ? path.basename(modelFile) : rel;
			const pxRaw = parseFloat(row['PositionX']); const pyRaw = parseFloat(row['PositionY']); const pzRaw = parseFloat(row['PositionZ']);
			// wow.export / export-adt-obj CSV 为 ADT/world 坐标：转世界坐标 west = MAP_HALF*TILE - X, north = MAP_HALF*TILE - Z, height = Y
			// 之前将 X/Z 反了，会把放置整体错位并导致路线窗口内实例数为 0。
			const px = isNaN(pxRaw) ? 0 : (MAP_HALF * TILE_SIZE - pxRaw);
			const py = isNaN(pyRaw) ? 0 : pyRaw;
			const pz = isNaN(pzRaw) ? 0 : (MAP_HALF * TILE_SIZE - pzRaw);
			const rx = parseFloat(row['RotationX']); const ry = parseFloat(row['RotationY']); const rz = parseFloat(row['RotationZ']);
			const rw = parseFloat(row['RotationW'] || '0');
			const scale = parseFloat(row['ScaleFactor']);
			const lbx = parseFloat(row['LowerBoundX']); const lby = parseFloat(row['LowerBoundY']); const lbz = parseFloat(row['LowerBoundZ']);
			const ubx = parseFloat(row['UpperBoundX']); const uby = parseFloat(row['UpperBoundY']); const ubz = parseFloat(row['UpperBoundZ']);
			const placement = {
				px, py, pz,
				rx: isNaN(rx) ? 0 : rx, ry: isNaN(ry) ? 0 : ry, rz: isNaN(rz) ? 0 : rz, rw: isNaN(rw) ? 0 : rw,
				scale: isNaN(scale) || scale <= 0 ? 1 : scale,
				type: String(row['Type'] || '').toLowerCase(),
				modelFile: String(modelFile),
			};
			if (Number.isFinite(lbx) && Number.isFinite(lby) && Number.isFinite(lbz) && Number.isFinite(ubx) && Number.isFinite(uby) && Number.isFinite(ubz)) {
				// ADT raw bounds (north, west, up) -> world (west, up, north)
				placement.boundsWorld = {
					minX: MAP_HALF * TILE_SIZE - ubx,
					maxX: MAP_HALF * TILE_SIZE - lbx,
					minY: lby,
					maxY: uby,
					minZ: MAP_HALF * TILE_SIZE - ubz,
					maxZ: MAP_HALF * TILE_SIZE - lbz,
				};
			}
			if (!byModel.has(key)) byModel.set(key, []);
			byModel.get(key).push(placement);
		}
	}
	return byModel;
}

function eulerZXYToQuat(x, y, z) {
	const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
	const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
	const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
	return [
		sx * cy * cz - cx * sy * sz,
		cx * sy * cz + sx * cy * sz,
		cx * cy * sz - sx * sy * cz,
		cx * cy * cz + sx * sy * sz,
	];
}

function quatNormalize(q) {
	const len = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]);
	if (len < 1e-10) return [0, 0, 0, 1];
	return [q[0] / len, q[1] / len, q[2] / len, q[3] / len];
}

function quatRotate(vx, vy, vz, q) {
	const x = q[0], y = q[1], z = q[2], w = q[3];
	const ix = w * vx + y * vz - z * vy;
	const iy = w * vy + z * vx - x * vz;
	const iz = w * vz + x * vy - y * vx;
	const iw = -x * vx - y * vy - z * vz;
	return [
		ix * w + iw * -x + iy * -z - iz * -y,
		iy * w + iw * -y + iz * -x - ix * -z,
		iz * w + iw * -z + ix * -y - iy * -x,
	];
}

function quatMul(a, b) {
	return [
		a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
		a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
		a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
		a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
	];
}

function quatToMat3(q) {
	const x = q[0], y = q[1], z = q[2], w = q[3];
	const xx = x * x, yy = y * y, zz = z * z;
	const xy = x * y, xz = x * z, yz = y * z;
	const wx = w * x, wy = w * y, wz = w * z;
	return [
		[1 - 2 * (yy + zz), 2 * (xy - wz), 2 * (xz + wy)],
		[2 * (xy + wz), 1 - 2 * (xx + zz), 2 * (yz - wx)],
		[2 * (xz - wy), 2 * (yz + wx), 1 - 2 * (xx + yy)],
	];
}

function mat3Mul(a, b) {
	return [
		[
			a[0][0] * b[0][0] + a[0][1] * b[1][0] + a[0][2] * b[2][0],
			a[0][0] * b[0][1] + a[0][1] * b[1][1] + a[0][2] * b[2][1],
			a[0][0] * b[0][2] + a[0][1] * b[1][2] + a[0][2] * b[2][2],
		],
		[
			a[1][0] * b[0][0] + a[1][1] * b[1][0] + a[1][2] * b[2][0],
			a[1][0] * b[0][1] + a[1][1] * b[1][1] + a[1][2] * b[2][1],
			a[1][0] * b[0][2] + a[1][1] * b[1][2] + a[1][2] * b[2][2],
		],
		[
			a[2][0] * b[0][0] + a[2][1] * b[1][0] + a[2][2] * b[2][0],
			a[2][0] * b[0][1] + a[2][1] * b[1][1] + a[2][2] * b[2][1],
			a[2][0] * b[0][2] + a[2][1] * b[1][2] + a[2][2] * b[2][2],
		],
	];
}

function mat3MulVec(m, v) {
	return [
		m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
		m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
		m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
	];
}

function mat3FromEulerXYZ(ax, ay, az) {
	const cx = Math.cos(ax), sx = Math.sin(ax);
	const cy = Math.cos(ay), sy = Math.sin(ay);
	const cz = Math.cos(az), sz = Math.sin(az);
	return [
		[cy * cz, -cy * sz, sy],
		[sx * sy * cz + cx * sz, -sx * sy * sz + cx * cz, -sx * cy],
		[-cx * sy * cz + sx * sz, cx * sy * sz + sx * cz, cx * cy],
	];
}

function mat3MulRowVec(v, m) {
	return [
		v[0] * m[0][0] + v[1] * m[1][0] + v[2] * m[2][0],
		v[0] * m[0][1] + v[1] * m[1][1] + v[2] * m[2][1],
		v[0] * m[0][2] + v[1] * m[1][2] + v[2] * m[2][2],
	];
}

function axisAngleQuat(axis, angle) {
	const s = Math.sin(angle / 2);
	const c = Math.cos(angle / 2);
	if (axis === 'x') return [s, 0, 0, c];
	if (axis === 'y') return [0, s, 0, c];
	return [0, 0, s, c];
}

function quatFromEulerOrder(rx, ry, rz, order) {
	const angleByAxis = { x: rx, y: ry, z: rz };
	let q = [0, 0, 0, 1];
	for (const axis of order) {
		q = quatMul(q, axisAngleQuat(axis, angleByAxis[axis]));
	}
	return quatNormalize(q);
}

function boundsFromPositions(positions) {
	let minX = Infinity, minY = Infinity, minZ = Infinity;
	let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
	for (let i = 0; i < positions.length; i += 3) {
		const x = positions[i], y = positions[i + 1], z = positions[i + 2];
		minX = Math.min(minX, x); minY = Math.min(minY, y); minZ = Math.min(minZ, z);
		maxX = Math.max(maxX, x); maxY = Math.max(maxY, y); maxZ = Math.max(maxZ, z);
	}
	return { minX, minY, minZ, maxX, maxY, maxZ };
}

const IDENTITY_LOCAL_MAP = [
	[0, 1], // x <- +x
	[1, 1], // y <- +y
	[2, 1], // z <- +z
];
const WMO_DEFAULT_LOCAL_MAP = [
	[2, 1],  // x <- +z
	[1, 1],  // y <- +y
	[0, -1], // z <- -x
];

function applyLocalMap(lx, ly, lz, localMap) {
	const src = [lx, ly, lz];
	return [
		src[localMap[0][0]] * localMap[0][1],
		src[localMap[1][0]] * localMap[1][1],
		src[localMap[2][0]] * localMap[2][1],
	];
}

function transformPositionsWithQuat(positions, placement, quat, localMap = IDENTITY_LOCAL_MAP) {
	const { px, py, pz, scale } = placement;
	const out = [];
	for (let i = 0; i < positions.length; i += 3) {
		let lx = positions[i] * scale;
		let ly = positions[i + 1] * scale;
		let lz = positions[i + 2] * scale;
		[lx, ly, lz] = applyLocalMap(lx, ly, lz, localMap);
		const v = quatRotate(lx, ly, lz, quat);
		out.push(v[0] + px, v[1] + py, v[2] + pz);
	}
	return out;
}

function scoreBoundsFit(boundsA, boundsB) {
	const caX = (boundsA.minX + boundsA.maxX) * 0.5;
	const caY = (boundsA.minY + boundsA.maxY) * 0.5;
	const caZ = (boundsA.minZ + boundsA.maxZ) * 0.5;
	const cbX = (boundsB.minX + boundsB.maxX) * 0.5;
	const cbY = (boundsB.minY + boundsB.maxY) * 0.5;
	const cbZ = (boundsB.minZ + boundsB.maxZ) * 0.5;
	const centerErr = Math.hypot(caX - cbX, caY - cbY, caZ - cbZ);
	const saX = boundsA.maxX - boundsA.minX, saY = boundsA.maxY - boundsA.minY, saZ = boundsA.maxZ - boundsA.minZ;
	const sbX = boundsB.maxX - boundsB.minX, sbY = boundsB.maxY - boundsB.minY, sbZ = boundsB.maxZ - boundsB.minZ;
	const sizeErr = Math.abs(saX - sbX) + Math.abs(saY - sbY) + Math.abs(saZ - sbZ);
	return centerErr + sizeErr * 0.2;
}

function samplePositions(positions, maxVerts = 600) {
	const total = Math.floor(positions.length / 3);
	if (total <= maxVerts) return positions;
	const step = Math.max(1, Math.floor(total / maxVerts));
	const out = [];
	for (let i = 0; i < total; i += step) {
		out.push(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]);
	}
	return out;
}

const wmoQuatChoiceCache = new Map();
const physLocalMapCache = new Map();

function getDefaultLocalMapForPlacement(placement) {
	return placement.type === 'wmo' ? WMO_DEFAULT_LOCAL_MAP : IDENTITY_LOCAL_MAP;
}

function resolvePlacementQuat(positions, placement, fallbackOrder = 'zxy') {
	const { rx, ry, rz, rw, scale } = placement;
	const DEG2RAD = Math.PI / 180;
	if (Math.abs(rw) >= 1e-6) return quatNormalize([rx, ry, rz, rw]);
	if (placement.type === 'wmo' && placement.boundsWorld) {
		const cacheKey = `${placement.modelFile}|${rx.toFixed(3)}|${ry.toFixed(3)}|${rz.toFixed(3)}|${scale.toFixed(4)}`;
		let quat = wmoQuatChoiceCache.get(cacheKey);
		if (quat) return quat;
		const sample = samplePositions(positions, 700);
		const orders = ['zxy', 'zyx', 'yxz', 'yzx', 'xyz', 'xzy'];
		const candidates = [];
		for (const order of orders) {
			candidates.push(quatFromEulerOrder(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, order));
			// TrinityCore-like mapping: rotation(y, x, z) with ZYX
			candidates.push(quatFromEulerOrder(ry * DEG2RAD, rx * DEG2RAD, rz * DEG2RAD, order));
		}
		let bestQuat = candidates[0];
		let bestScore = Infinity;
		for (const q of candidates) {
			const testPos = transformPositionsWithQuat(sample, placement, q, WMO_DEFAULT_LOCAL_MAP);
			const s = scoreBoundsFit(boundsFromPositions(testPos), placement.boundsWorld);
			if (s < bestScore) {
				bestScore = s;
				bestQuat = q;
			}
		}
		quat = bestQuat;
		wmoQuatChoiceCache.set(cacheKey, quat);
		return quat;
	}
	if (fallbackOrder === 'zxy') return eulerZXYToQuat(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD);
	return quatFromEulerOrder(rx * DEG2RAD, ry * DEG2RAD, rz * DEG2RAD, fallbackOrder);
}

function generateRightHandedLocalMaps() {
	const perms = [
		[0, 1, 2], [0, 2, 1], [1, 0, 2],
		[1, 2, 0], [2, 0, 1], [2, 1, 0],
	];
	const signs = [-1, 1];
	const maps = [];
	for (const p of perms) {
		for (const sx of signs) for (const sy of signs) for (const sz of signs) {
			const m = [
				[sx, 0, 0],
				[0, sy, 0],
				[0, 0, sz],
			];
			const pm = [
				[m[0][p[0]], m[0][p[1]], m[0][p[2]]],
				[m[1][p[0]], m[1][p[1]], m[1][p[2]]],
				[m[2][p[0]], m[2][p[1]], m[2][p[2]]],
			];
			const det =
				pm[0][0] * (pm[1][1] * pm[2][2] - pm[1][2] * pm[2][1]) -
				pm[0][1] * (pm[1][0] * pm[2][2] - pm[1][2] * pm[2][0]) +
				pm[0][2] * (pm[1][0] * pm[2][1] - pm[1][1] * pm[2][0]);
			if (det < 0.5) continue; // keep right-handed orientation transforms
			maps.push([
				[p[0], sx],
				[p[1], sy],
				[p[2], sz],
			]);
		}
	}
	return maps;
}

const PHYS_LOCAL_MAP_CANDIDATES = generateRightHandedLocalMaps();
// M2 exporter local basis (from wow.export M2Loader):
// exported = A * original, where:
// ex = ox
// ey = -oz
// ez = oy
const M2_A_INV = [
	[1, 0, 0],
	[0, 0, 1],
	[0, -1, 0],
];
// ADT/world raw basis -> route geometry basis (west, height, north):
// west = -x(raw), height = y(raw), north = -z(raw) for vectors
const WORLD_BASIS = [
	[-1, 0, 0],
	[0, 1, 0],
	[0, 0, -1],
];

function pickBestPhysLocalMap(physPositions, refObjPositions, placement, modelPath, quat) {
	const cacheKey = `${modelPath}|${placement.type}`;
	const cached = physLocalMapCache.get(cacheKey);
	if (cached) return cached;
	if (!Array.isArray(refObjPositions) || refObjPositions.length < 9) return getDefaultLocalMapForPlacement(placement);
	const refSample = samplePositions(refObjPositions, 700);
	const target = boundsFromPositions(transformPositionsWithQuat(refSample, placement, quat, getDefaultLocalMapForPlacement(placement)));
	const physSample = samplePositions(physPositions, 700);
	let bestMap = getDefaultLocalMapForPlacement(placement);
	let bestScore = Infinity;
	for (const map of PHYS_LOCAL_MAP_CANDIDATES) {
		const cand = boundsFromPositions(transformPositionsWithQuat(physSample, placement, quat, map));
		const s = scoreBoundsFit(cand, target);
		if (s < bestScore) {
			bestScore = s;
			bestMap = map;
		}
	}
	physLocalMapCache.set(cacheKey, bestMap);
	return bestMap;
}

function transformPositions(positions, placement, modelPath, refObjPositions = null) {
	// M2: default to Trinity/mmaps-style transform chain (global rule, no per-model patch).
	// Set M2_TRANSFORM_MODE=basis to fallback to previous basis-chain mode for A/B compare.
	if (placement.type === 'm2') {
		const mode = String(process.env.M2_TRANSFORM_MODE || 'trinity').toLowerCase();
		const { px, py, pz, scale } = placement;
		if (mode !== 'basis') {
			// Trinity mmaps:
			// rotation = fromEulerAnglesXYZ(-rotZ, -rotX, -rotY)
			// v' = v * rotation * scale + pos; mirror x/y; output(y,z,x)
			const ax = (-placement.rz * Math.PI) / 180;
			const ay = (-placement.rx * Math.PI) / 180;
			const az = (-placement.ry * Math.PI) / 180;
			const rot = mat3FromEulerXYZ(ax, ay, az);
			// Solve position so that local origin maps to (px,py,pz) in (west,height,north):
			// output = [ -pos.y, pos.z, -pos.x ] = [px,py,pz]
			const pos = [-pz, -px, py];
			const out = [];
			for (let i = 0; i < positions.length; i += 3) {
				const lx = positions[i] * scale;
				const ly = positions[i + 1] * scale;
				const lz = positions[i + 2] * scale;
				// Convert exported M2 OBJ local basis -> original M2 source basis.
				// wow.export M2 loader writes: E = [x, z, -y], so inverse is:
				// S = [E.x, -E.z, E.y]
				const s = [lx, -lz, ly];
				let v = mat3MulRowVec(s, rot);
				v = [v[0] + pos[0], v[1] + pos[1], v[2] + pos[2]];
				v[0] *= -1;
				v[1] *= -1;
				// output world basis (west,height,north)
				out.push(v[1], v[2], v[0]);
			}
			return out;
		}
		const quatRaw = resolvePlacementQuat(positions, { ...placement, rw: 0 }, 'zyx');
		const rRaw = quatToMat3(quatRaw);
		const rEff = mat3Mul(mat3Mul(WORLD_BASIS, rRaw), M2_A_INV);
		const out = [];
		for (let i = 0; i < positions.length; i += 3) {
			const local = [positions[i] * scale, positions[i + 1] * scale, positions[i + 2] * scale];
			const v = mat3MulVec(rEff, local);
			out.push(v[0] + px, v[1] + py, v[2] + pz);
		}
		return out;
	}
	const quat = resolvePlacementQuat(positions, placement);
	let localMap = getDefaultLocalMapForPlacement(placement);
	if (typeof modelPath === 'string' && /\.phys\.obj$/i.test(modelPath) && Array.isArray(refObjPositions) && refObjPositions.length >= 9) {
		localMap = pickBestPhysLocalMap(positions, refObjPositions, placement, modelPath, quat);
	}
	return transformPositionsWithQuat(positions, placement, quat, localMap);
}

/** 在 dir 下递归查找 adt_<tileID>.obj / adt_<tileID>_ModelPlacementInformation.csv；tileID 与 wow.export 一致为 tileY_tileX（即 tz_tx），tx_tz 或 tz_tx 均可匹配 */
function collectTileFiles(dir, tileIdSet) {
	const terrainByTile = new Map();
	const csvByTile = new Map();
	function canonicalTile(rest) {
		if (!/^\d+_\d+$/.test(rest)) return null;
		if (tileIdSet.has(rest)) return { id: rest, exact: true };
		const rev = rest.split('_').reverse().join('_');
		if (tileIdSet.has(rev)) return { id: rev, exact: false };
		return null;
	}
	function scan(d) {
		if (!fs.existsSync(d)) return;
		for (const e of fs.readdirSync(d, { withFileTypes: true })) {
			const full = path.join(d, e.name);
			if (e.isDirectory()) {
				scan(full);
				continue;
			}
			const base = e.name;
			const lower = base.toLowerCase();
			if (lower.endsWith('.obj') && lower.startsWith('adt_')) {
				const rest = base.slice(4, -4);
				const hit = canonicalTile(rest);
				if (!hit) continue;
				// 同一 tile 若同时存在正向与反向命名文件，优先保留与 tile 集一致的“正向命名”文件。
				const prev = terrainByTile.get(hit.id);
				if (!prev || (hit.exact && !prev.exact)) {
					terrainByTile.set(hit.id, { path: full, exact: hit.exact });
				}
			} else if (lower.includes('modelplacementinformation') && lower.endsWith('.csv') && lower.startsWith('adt_')) {
				const rest = base.replace(/^adt_/i, '').replace(/_modelplacementinformation\.csv$/i, '');
				const hit = canonicalTile(rest);
				if (!hit) continue;
				const prev = csvByTile.get(hit.id);
				if (!prev || (hit.exact && !prev.exact)) {
					csvByTile.set(hit.id, { path: full, exact: hit.exact });
				}
			}
		}
	}
	scan(dir);
	return {
		terrainObjs: Array.from(terrainByTile.values()).map((x) => x.path),
		csvFiles: Array.from(csvByTile.values()).map((x) => x.path),
	};
}

/** 从 CSV 行中收集所有 ModelFile 的绝对路径（去重） */
function collectModelPathsFromCSVs(csvPathList, dirNorm, options = {}) {
	const physOnly = !!options.physOnly;
	const usePhysModel = !!options.usePhysModel;
	const includeWmo = options.includeWmo !== false;
	const includeM2 = options.includeM2 !== false;
	const absPaths = new Set();
	for (const csvPath of csvPathList) {
		const content = fs.readFileSync(csvPath, 'utf8');
		const { headers, rows } = parseCSV(content);
		const fileIdx = headers.indexOf('ModelFile');
		if (fileIdx < 0) continue;
		const csvDir = path.dirname(csvPath);
		for (const row of rows) {
			const modelFile = row['ModelFile'];
			if (!modelFile) continue;
			const type = String(row['Type'] || '').toLowerCase();
			if (type === 'wmo' && !includeWmo) continue;
			if (type === 'm2' && !includeM2) continue;
			const abs = path.resolve(csvDir, modelFile);
			if (!fs.existsSync(abs)) continue;
			// 默认优先使用可视 OBJ，确保与导出模型摆放/朝向一致；
			// 仅在显式 usePhysModel 或 physOnly 时使用碰撞 OBJ。
			const phys = abs.replace(/\.obj$/i, '.phys.obj');
			if (physOnly && fs.existsSync(phys)) {
				absPaths.add(phys);
			} else if (usePhysModel && fs.existsSync(phys)) {
				absPaths.add(phys);
			} else if (!physOnly) {
				absPaths.add(abs);
			}
		}
	}
	return Array.from(absPaths);
}

function main() {
	let dir = '';
	let outPath = path.join(__dirname, '..', 'exports', 'recast-geometry-route.json');
	let fromNorth, fromWest, fromZ, toNorth, toWest, toZ;
	let margin = 2;
	let placementMargin = 600;
	let cropMargin = 800;
	let snapXz = 0;
	let physOnly = false;
	let usePhysModel = false;
	let terrainOnly = false;
	let includeWmo = true;
	let includeM2 = true;
	let wowExport = false;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--dir' && args[i + 1]) { dir = path.resolve(args[++i]); continue; }
		if (args[i] === '--out' && args[i + 1]) { outPath = path.resolve(args[++i]); continue; }
		if (args[i] === '--margin' && args[i + 1]) { margin = parseInt(args[++i], 10) || 2; continue; }
		if (args[i] === '--placement-margin' && args[i + 1]) { placementMargin = parseInt(args[++i], 10) || 600; continue; }
		if (args[i] === '--crop-margin' && args[i + 1]) { cropMargin = parseInt(args[++i], 10) || 800; continue; }
		if (args[i] === '--snap-xz' && args[i + 1]) { snapXz = parseFloat(args[++i]) || 0; continue; }
		if (args[i] === '--phys-only') { physOnly = true; continue; }
		if (args[i] === '--use-phys-model') { usePhysModel = true; continue; }
		if (args[i] === '--terrain-only') { terrainOnly = true; continue; }
		if (args[i] === '--no-wmo') { includeWmo = false; continue; }
		if (args[i] === '--no-m2') { includeM2 = false; continue; }
		if (args[i] === '--wow-export') { wowExport = true; continue; }
		if (args[i] === '--from' && args[i + 3]) {
			fromNorth = parseFloat(args[++i]);
			fromWest = parseFloat(args[++i]);
			fromZ = parseFloat(args[++i]);
			continue;
		}
		if (args[i] === '--to' && args[i + 3]) {
			toNorth = parseFloat(args[++i]);
			toWest = parseFloat(args[++i]);
			toZ = parseFloat(args[++i]);
			continue;
		}
	}

	if (!dir || !fs.existsSync(dir)) {
		console.error('用法: node export-route-geometry.js --dir <wow.export导出目录> --from <北> <西> <高> --to <北> <西> <高> [--out 输出.json] [--margin 2] [--placement-margin 600] [--crop-margin 800] [--snap-xz 0] [--use-phys-model|--phys-only] [--no-wmo] [--no-m2]');
		process.exit(1);
	}
	if (fromNorth == null || fromWest == null || toNorth == null || toWest == null) {
		console.error('必须提供 --from 北 西 高 与 --to 北 西 高（游戏坐标）');
		process.exit(1);
	}

	const tileIdSet = getTileIdsForRoute(fromNorth, fromWest, toNorth, toWest, margin);
	const tileIds = [...tileIdSet].sort();
	console.log('[route-geom] 起点 (北,西)', fromNorth.toFixed(1), fromWest.toFixed(1), '终点', toNorth.toFixed(1), toWest.toFixed(1));
	console.log('[route-geom] 瓦片范围 margin=' + margin + ':', tileIds.length, '块', tileIds.slice(0, 10).join(', ') + (tileIds.length > 10 ? '...' : ''));
	// margin=2：在起终点所在 tx/tz 范围基础上，东西北南各加 2 圈；与 export-adt-obj 一致
	if (tileIds.length > 0 && writeRegionMapSvg) {
		const regionSvg = path.join(path.dirname(outPath), 'region-map.svg');
		writeRegionMapSvg(tileIds, fromNorth, fromWest, toNorth, toWest, margin, regionSvg, { mapName: 'route' });
		console.log('[route-geom] 区域 2D 图:', regionSvg);
	}

	const { terrainObjs, csvFiles } = collectTileFiles(dir, tileIdSet);
	console.log('[route-geom] 地形 OBJ:', terrainObjs.length, '个' + (terrainOnly ? ' (仅地形)' : ' | 放置 CSV: ' + csvFiles.length + ' 个'));

	const dirNorm = path.resolve(dir);
	let placementsByModel = new Map();
	let wmoObjPaths = [];
	if (!terrainOnly) {
		placementsByModel = loadPlacementsFromCSVFiles(csvFiles, dirNorm, { includeWmo, includeM2 });
		wmoObjPaths = collectModelPathsFromCSVs(csvFiles, dirNorm, { physOnly, usePhysModel, includeWmo, includeM2 });
		console.log('[route-geom] WMO/M2 模型文件:', wmoObjPaths.length, '个');
	}

	const allPositions = [];
	const allIndices = [];
	let vertexOffset = 0;
	let terrainCount = 0, placedCount = 0, skipped = 0;
	const snapCoord = (v) => (snapXz > 0 ? Math.round(v / snapXz) * snapXz : v);

	for (const fp of terrainObjs) {
		// 地形 OBJ 与 wow.export、自实现 export-adt-obj 一致：均为 (west, height, north)，直接合并不交换。
		const { positions, indices } = parseObjFile(fp);
		if (positions.length < 9 || indices.length < 3) { skipped++; continue; }
		for (let i = 0; i < positions.length; i += 3)
			allPositions.push(snapCoord(positions[i]), positions[i + 1], snapCoord(positions[i + 2]));
		// 自实现 export-adt-obj 输出的地形 OBJ 绕序已是 +Y 朝上；此处保持原绕序，避免误翻转为朝下导致不可行走
		for (let i = 0; i < indices.length; i += 3)
			allIndices.push(indices[i] + vertexOffset, indices[i + 1] + vertexOffset, indices[i + 2] + vertexOffset);
		vertexOffset += positions.length / 3;
		terrainCount++;
	}

	for (const fp of wmoObjPaths) {
		const relPath = path.relative(dirNorm, fp).replace(/\\/g, '/');
		const relKeyBasename = path.basename(fp);
		const relPathObj = relPath.replace(/\.phys\.obj$/i, '.obj');
		const relKeyObjBasename = relKeyBasename.replace(/\.phys\.obj$/i, '.obj');
		const placements =
			placementsByModel.get(relPath) ||
			placementsByModel.get(relPathObj) ||
			placementsByModel.get(relKeyBasename) ||
			placementsByModel.get(relKeyObjBasename);
		if (!placements || placements.length === 0) { skipped++; continue; }
		const { positions, indices } = parseObjFile(fp);
		if (positions.length < 9 || indices.length < 3) { skipped++; continue; }
		let refObjPositions = null;
		if (/\.phys\.obj$/i.test(fp)) {
			const refObjPath = fp.replace(/\.phys\.obj$/i, '.obj');
			if (fs.existsSync(refObjPath)) {
				const refObj = parseObjFile(refObjPath);
				if (refObj.positions && refObj.positions.length >= 9) refObjPositions = refObj.positions;
			}
		}
		const routeWMin = Math.min(fromWest, toWest) - placementMargin;
		const routeWMax = Math.max(fromWest, toWest) + placementMargin;
		const routeNMin = Math.min(fromNorth, toNorth) - placementMargin;
		const routeNMax = Math.max(fromNorth, toNorth) + placementMargin;
		for (const pl of placements) {
			if (pl.px < routeWMin || pl.px > routeWMax || pl.pz < routeNMin || pl.pz > routeNMax) continue;
			const tpos = transformPositions(positions, pl, fp, refObjPositions);
			for (let i = 0; i < tpos.length; i += 3) {
				allPositions.push(snapCoord(tpos[i]), tpos[i + 1], snapCoord(tpos[i + 2]));
			}
			for (let i = 0; i < indices.length; i++) allIndices.push(indices[i] + vertexOffset);
			vertexOffset += positions.length / 3;
			placedCount++;
		}
	}
	// terrainOnly 时上面循环不执行，仅地形几何

	if (allPositions.length < 9 || allIndices.length < 3) {
		console.error('[route-geom] 合并后顶点或三角形过少，请确认导出目录内有所需 adt_<tileID>.obj');
		process.exit(1);
	}

	const routeWestMin = Math.min(fromWest, toWest);
	const routeWestMax = Math.max(fromWest, toWest);
	const routeNorthMin = Math.min(fromNorth, toNorth);
	const routeNorthMax = Math.max(fromNorth, toNorth);
	const cropWestMin = routeWestMin - cropMargin;
	const cropWestMax = routeWestMax + cropMargin;
	const cropNorthMin = routeNorthMin - cropMargin;
	const cropNorthMax = routeNorthMax + cropMargin;
	const keepTri = new Uint8Array(allIndices.length / 3);
	let keptTris = 0;
	for (let t = 0; t < allIndices.length / 3; t++) {
		let minW = Infinity, maxW = -Infinity, minN = Infinity, maxN = -Infinity;
		for (let i = 0; i < 3; i++) {
			const idx = allIndices[t * 3 + i] * 3;
			const w = allPositions[idx], n = allPositions[idx + 2];
			minW = Math.min(minW, w); maxW = Math.max(maxW, w);
			minN = Math.min(minN, n); maxN = Math.max(maxN, n);
		}
		if (maxW >= cropWestMin && minW <= cropWestMax && maxN >= cropNorthMin && minN <= cropNorthMax) {
			keepTri[t] = 1;
			keptTris++;
		}
	}
	const oldToNew = new Int32Array(allPositions.length / 3).fill(-1);
	let newVertexCount = 0;
	const croppedPositions = [];
	const croppedIndices = [];
	for (let t = 0; t < allIndices.length / 3; t++) {
		if (!keepTri[t]) continue;
		for (let i = 0; i < 3; i++) {
			const oldIdx = allIndices[t * 3 + i];
			if (oldToNew[oldIdx] === -1) {
				oldToNew[oldIdx] = newVertexCount++;
				croppedPositions.push(allPositions[oldIdx * 3], allPositions[oldIdx * 3 + 1], allPositions[oldIdx * 3 + 2]);
			}
			croppedIndices.push(oldToNew[oldIdx]);
		}
	}
	if (keptTris >= 3) {
		console.log('[route-geom] 裁剪到路线走廊 (margin=' + cropMargin + '):', newVertexCount, '顶点', keptTris, '三角形');
		for (let i = 0; i < croppedPositions.length; i++) allPositions[i] = croppedPositions[i];
		allPositions.length = croppedPositions.length;
		for (let i = 0; i < croppedIndices.length; i++) allIndices[i] = croppedIndices[i];
		allIndices.length = croppedIndices.length;
	}

	let minWest = Infinity, maxWest = -Infinity, minNorth = Infinity, maxNorth = -Infinity;
	for (let i = 0; i < allPositions.length; i += 3) {
		const x = allPositions[i], z = allPositions[i + 2];
		minWest = Math.min(minWest, x); maxWest = Math.max(maxWest, x);
		minNorth = Math.min(minNorth, z); maxNorth = Math.max(maxNorth, z);
	}

	const outDir = path.dirname(outPath);
	if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

	const data = {
		positions: allPositions,
		indices: allIndices,
		bbox: { minWest, maxWest, minNorth, maxNorth },
		source: 'export-route-geometry (route tiles + margin, WMO/M2 from CSV)',
		sourceDir: dir,
		route: { from: [fromNorth, fromWest, fromZ], to: [toNorth, toWest, toZ], tileIds: tileIds, margin },
	};
	fs.writeFileSync(outPath, JSON.stringify(data, null, 2));

	console.log('[route-geom] 已写入:', outPath);
	console.log('  顶点:', allPositions.length / 3, '三角形:', allIndices.length / 3);
	console.log('  地形 OBJ:', terrainCount, '| 带放置的实例数:', placedCount, '| 跳过:', skipped);
	console.log('  bbox: west', minWest.toFixed(1), '~', maxWest.toFixed(1), ', north', minNorth.toFixed(1), '~', maxNorth.toFixed(1));
	if (routeWestMin < minWest || routeWestMax > maxWest || routeNorthMin < minNorth || routeNorthMax > maxNorth) {
		console.warn('[route-geom] 警告: bbox 未完全包含路线范围，请检查 tile 坐标或 tileOrigin');
	}
	console.log('  寻路: node pathfinder/run-kalimdor-route.js（将 GEOMETRY 指向此文件）');
}

if (require.main === module) {
	main();
}

module.exports = {
	parseObjFile,
	parseCSV,
	loadPlacementsFromCSVFiles,
	transformPositions,
	collectTileFiles,
	collectModelPathsFromCSVs,
	getTileIdsForRoute,
	boundsFromPositions,
	scoreBoundsFit,
	samplePositions,
};
