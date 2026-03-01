#!/usr/bin/env node
/**
 * 使用已导出的 Kalimdor 几何规划路线。
 * 用法: node run-kalimdor-route.js [--from 北 西 高] [--to 北 西 高]
 * 禁止任何形式的回退路线：仅规划用户给出的起终点路线，失败则直接报错退出。
 */
const path = require('path');
const fs = require('fs');
const { buildNavMesh, findPathNavMesh, getHeightAtFromGeometry } = require('./navmesh-route-service');

const GEOMETRY_ROUTE = path.join(__dirname, 'exports', 'recast-geometry-route.json');
const GEOMETRY_PATH = GEOMETRY_ROUTE;

// 默认两点（游戏坐标: x=北, y=西, z=高）；可通过 --from / --to 覆盖
function parseArgs() {
	const args = process.argv.slice(2);
	let start = { x: 326.71, y: -4704.19, z: 16.08 };
	let end = { x: -618.48, y: -4251.93, z: 38.73 };
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--from' && args[i + 1] != null && args[i + 2] != null) {
			start = {
				x: parseFloat(args[i + 1]),
				y: parseFloat(args[i + 2]),
				z: parseFloat(args[i + 3]) || 0
			};
			i += 3;
		} else if (args[i] === '--to' && args[i + 1] != null && args[i + 2] != null) {
			end = {
				x: parseFloat(args[i + 1]),
				y: parseFloat(args[i + 2]),
				z: parseFloat(args[i + 3]) || 0
			};
			i += 3;
		}
	}
	return { start, end };
}

const { start: USER_START, end: USER_END } = parseArgs();

// 路线走廊 bbox（游戏坐标 x=北 y=西）供精细 NavMesh 裁剪；OBJ 几何量大，margin 稍小以控制裁剪后三角数、加快建网
function routeBboxFromEndpoints(start, end, margin = 280) {
	return {
		minNorth: Math.min(start.x, end.x) - margin,
		maxNorth: Math.max(start.x, end.x) + margin,
		minWest:  Math.min(start.y, end.y) - margin,
		maxWest:  Math.max(start.y, end.y) + margin,
	};
}

async function main() {
	if (!fs.existsSync(GEOMETRY_PATH)) {
		console.error('请先导出几何:');
		console.error('  node pathfinder/scripts/export-route-geometry.js --dir "<prepared-obj-dir>" --from 北 西 高 --to 北 西 高');
		process.exit(1);
	}

	console.log('[kalimdor] 使用几何:', GEOMETRY_PATH);
	const routeBbox = routeBboxFromEndpoints(USER_START, USER_END, 0);
	// 路线模式要求不裁掉绕行空间，默认不做 routeBbox 几何裁剪（仅用于精细参数判定）。
	routeBbox.margin = 200;
	const skipRouteCrop = true;
	const strictProfile = !['1', 'true', 'yes'].includes(String(process.env.ALLOW_NAV_ENV_OVERRIDE || '').toLowerCase());
	const parseEnvNumber = (name) => {
		const n = Number(process.env[name] || '');
		return Number.isFinite(n) && n > 0 ? n : undefined;
	};
	const parseEnvBool = (name) => {
		const raw = String(process.env[name] || '').toLowerCase();
		if (!raw) return undefined;
		if (['1', 'true', 'yes'].includes(raw)) return true;
		if (['0', 'false', 'no'].includes(raw)) return false;
		return undefined;
	};
	// 稳定路由 profile：默认固定关键参数，避免环境变量污染导致“同代码不同结果”。
	let routeCellSize = 1;
	let routeWalkableSlopeAngleDegrees = 35;
	let walkableClimbWorld = 2.2;
	let walkableRadiusWorld = 1.0;
	let walkableHeightWorld = 2.0;
	let forceTiledNavMesh = true;
	if (!strictProfile) {
		routeCellSize = parseEnvNumber('ROUTE_CELL_SIZE') ?? routeCellSize;
		routeWalkableSlopeAngleDegrees = parseEnvNumber('ROUTE_SLOPE_DEG') ?? routeWalkableSlopeAngleDegrees;
		walkableClimbWorld = parseEnvNumber('WALKABLE_CLIMB_WORLD') ?? walkableClimbWorld;
		walkableRadiusWorld = parseEnvNumber('WALKABLE_RADIUS_WORLD') ?? walkableRadiusWorld;
		walkableHeightWorld = parseEnvNumber('WALKABLE_HEIGHT_WORLD') ?? walkableHeightWorld;
		forceTiledNavMesh = parseEnvBool('FORCE_TILED_NAVMESH') ?? forceTiledNavMesh;
	}
	if (process.env.DEBUG_NAVMESH === '1' || process.env.DEBUG_NAVMESH === 'true') {
		console.log('[kalimdor] build options', JSON.stringify({
			geometryPath: GEOMETRY_PATH,
			routeBbox,
			skipRouteCrop,
			strictProfile,
			routeCellSize,
			forceTiledNavMesh,
			routeWalkableSlopeAngleDegrees,
			walkableRadiusWorld,
			walkableClimbWorld,
			walkableHeightWorld,
		}, null, 2));
	}
	const ok = await buildNavMesh({
		geometryPath: GEOMETRY_PATH,
		useGeometryFile: true,
		fineNavMesh: true,
		routeBbox,
		skipRouteCrop,
		routeCellSize,
		forceTiledNavMesh,
		avoidCollisions: true,
		routeWalkableSlopeAngleDegrees,
		walkableRadiusWorld,
		walkableClimbWorld,
		walkableHeightWorld,
		fullPathFidelity: true,
		subdivideMaxSegment: 30,
	});
	if (!ok) {
		console.error('[kalimdor] buildNavMesh 失败');
		process.exit(1);
	}

	// 使用路线几何时，将起终点高度吸附到地表，避免 findNearestPoly 因高度偏差失败
	let startUse = { ...USER_START };
	let endUse = { ...USER_END };
	const disableHeightSnap = ['1', 'true', 'yes'].includes(String(process.env.DISABLE_GEOMETRY_HEIGHT_SNAP || '').toLowerCase());
	if (!disableHeightSnap && path.basename(GEOMETRY_PATH) === 'recast-geometry-route.json') {
		const hStart = getHeightAtFromGeometry(GEOMETRY_PATH, USER_START.y, USER_START.x);
		const hEnd = getHeightAtFromGeometry(GEOMETRY_PATH, USER_END.y, USER_END.x);
		if (hStart != null) {
			startUse = { ...USER_START, z: hStart };
			if (Math.abs(hStart - USER_START.z) > 1) console.log('[kalimdor] 起点高度吸附到地表:', USER_START.z.toFixed(2), '->', hStart.toFixed(2));
		}
		if (hEnd != null) {
			endUse = { ...USER_END, z: hEnd };
			if (Math.abs(hEnd - USER_END.z) > 1) console.log('[kalimdor] 终点高度吸附到地表:', USER_END.z.toFixed(2), '->', hEnd.toFixed(2));
		}
	}

	console.log('\n[kalimdor] 规划路线: 起点', startUse, '→ 终点', endUse);
	const points = findPathNavMesh(startUse, endUse);
	if (!points || points.length === 0) {
		console.error('[kalimdor] 寻路失败：未找到路线。');
		console.error('[kalimdor] 请检查几何是否包含起终点及中间障碍物（地形+WMO/M2），且未裁剪掉绕行障碍（skipRouteCrop）。');
		process.exit(1);
	}

	console.log('[kalimdor] 找到路线，共', points.length, '个路径点 (游戏坐标 x=北, y=西, z=高):');
	points.forEach((p, i) => console.log(`  ${i + 1}. x=${p.x.toFixed(2)} y=${p.y.toFixed(2)} z=${p.z.toFixed(2)}`));
	fs.writeFileSync(path.join(__dirname, 'route.json'), JSON.stringify(points, null, 2), 'utf8');
	console.log('\n已写入 pathfinder/route.json');
	console.log('[kalimdor] PNG map rendering interface is excluded in this public release.');
}

main().catch(e => { console.error(e); process.exit(1); });
