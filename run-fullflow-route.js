#!/usr/bin/env node
/**
 * 全流程：自实现 ADT 导出 → 路线几何 → NavMesh 寻路 → 输出 route.json
 * 1) export-adt-obj.js：从 CASC 导出 adt_<tz>_<tx>.obj 到 exports/adt-objs
 * 2) export-route-geometry.js：合并 OBJ 为 recast-geometry-route.json
 * 3) run-kalimdor-route.js：建网 + 寻路，写入 route.json
 *
 * 用法: node pathfinder/run-fullflow-route.js [--from 北 西 高] [--to 北 西 高] [--terrain-only]
 * 默认起终点与 run-kalimdor-route.js 一致。
 * [--terrain-only] 仅用地形 OBJ 合并与寻路，不加载 WMO/M2 碰撞，用于先验证地形路线。
 */
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

const pathfinderDir = __dirname;
const exportsDir = path.join(pathfinderDir, 'exports');
const adtObjsDir = path.join(exportsDir, 'adt-objs');
const geometryRoutePath = path.join(exportsDir, 'recast-geometry-route.json');

const DEFAULT_FROM = [326.71, -4704.19, 16.08];
const DEFAULT_TO = [-618.48, -4251.93, 38.73];

function parseArgs() {
	const args = process.argv.slice(2);
	let from = DEFAULT_FROM.slice();
	let to = DEFAULT_TO.slice();
	let terrainOnly = false;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--from' && args[i + 3]) {
			from = [parseFloat(args[i + 1]), parseFloat(args[i + 2]), parseFloat(args[i + 3])];
			i += 3;
		} else if (args[i] === '--to' && args[i + 3]) {
			to = [parseFloat(args[i + 1]), parseFloat(args[i + 2]), parseFloat(args[i + 3])];
			i += 3;
		} else if (args[i] === '--terrain-only') {
			terrainOnly = true;
		}
	}
	return { from, to, terrainOnly };
}

function run(cmd, args, opts = {}) {
	const r = spawnSync(cmd, args, {
		stdio: 'inherit',
		cwd: path.join(pathfinderDir, '..'),
		...opts
	});
	return r.status;
}

function main() {
	const { from, to, terrainOnly } = parseArgs();
	const [fromNorth, fromWest, fromZ] = from;
	const [toNorth, toWest, toZ] = to;

	// 清空 adt-objs，避免混入上次导出的瓦片导致几何 bbox 错误
	if (fs.existsSync(adtObjsDir)) {
		for (const name of fs.readdirSync(adtObjsDir)) {
			fs.unlinkSync(path.join(adtObjsDir, name));
		}
	}

	console.log('\n=== 1/3 导出 ADT → OBJ (自实现) ===');
	if (run('node', [
		path.join(pathfinderDir, 'scripts', 'export-adt-obj.js'),
		'--map', 'kalimdor',
		'--from', String(fromNorth), String(fromWest), String(fromZ),
		'--to', String(toNorth), String(toWest), String(toZ),
		'--out-dir', adtObjsDir,
		'--margin', '2'
	]) !== 0) process.exit(1);

	const step2Label = terrainOnly
		? '=== 2/3 合并 OBJ → 路线几何 JSON (仅地形) ==='
		: '=== 2/3 合并 OBJ → 路线几何 JSON (地形 + 放置 CSV + WMO/M2 碰撞) ===';
	console.log('\n' + step2Label);
	const step2Args = [
		path.join(pathfinderDir, 'scripts', 'export-route-geometry.js'),
		'--dir', adtObjsDir,
		'--from', String(fromNorth), String(fromWest), String(fromZ),
		'--to', String(toNorth), String(toWest), String(toZ),
		'--out', geometryRoutePath,
		'--margin', '2'
	];
	if (terrainOnly) step2Args.push('--terrain-only');
	if (run('node', step2Args) !== 0) process.exit(1);

	console.log('\n=== 3/3 NavMesh 寻路 → route.json ===');
	const step3 = run('node', [
		path.join(pathfinderDir, 'run-kalimdor-route.js'),
		'--from', String(fromNorth), String(fromWest), String(fromZ),
		'--to', String(toNorth), String(toWest), String(toZ)
	]);
	if (step3 !== 0) process.exit(step3);

	console.log('\n全流程完成，路线已写入 pathfinder/route.json');
}

main();
