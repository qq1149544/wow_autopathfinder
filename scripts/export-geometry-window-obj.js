#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function exportWindowObj(geom, centerNorth, centerWest, radius, outPath) {
	const pos = geom.positions || [];
	const idx = geom.indices || [];
	const keep = new Uint8Array(Math.floor(idx.length / 3));
	let kept = 0;
	for (let t = 0; t < idx.length; t += 3) {
		let hit = false;
		for (let k = 0; k < 3; k++) {
			const vi = idx[t + k] * 3;
			const west = pos[vi];
			const north = pos[vi + 2];
			if (Math.hypot(north - centerNorth, west - centerWest) <= radius) {
				hit = true;
				break;
			}
		}
		if (hit) {
			keep[t / 3] = 1;
			kept++;
		}
	}
	const map = new Int32Array(Math.floor(pos.length / 3)).fill(-1);
	const outPos = [];
	const outIdx = [];
	let n = 0;
	for (let t = 0; t < idx.length; t += 3) {
		if (!keep[t / 3]) continue;
		for (let k = 0; k < 3; k++) {
			const old = idx[t + k];
			if (map[old] === -1) {
				map[old] = n++;
				outPos.push(pos[old * 3], pos[old * 3 + 1], pos[old * 3 + 2]);
			}
			outIdx.push(map[old]);
		}
	}
	let s = '';
	for (let i = 0; i < outPos.length; i += 3) s += `v ${outPos[i]} ${outPos[i + 1]} ${outPos[i + 2]}\n`;
	for (let i = 0; i < outIdx.length; i += 3) s += `f ${outIdx[i] + 1} ${outIdx[i + 1] + 1} ${outIdx[i + 2] + 1}\n`;
	fs.writeFileSync(outPath, s, 'utf8');
	return { outPath, verts: outPos.length / 3, tris: outIdx.length / 3, keptInputTris: kept };
}

function main() {
	const geomPath = path.resolve(process.argv[2] || 'pathfinder/exports/recast-geometry-route.json');
	const radius = Number(process.argv[3] || 80);
	const outDir = path.resolve('pathfinder/exports');
	const g = JSON.parse(fs.readFileSync(geomPath, 'utf8'));

	const points = [
		{ name: 'fence', north: 243.67999267578125, west: -4706.08984375 },
		{ name: 'fallen_tree', north: -341.55999755859375, west: -4727.93994140625 },
	];
	const result = [];
	for (const p of points) {
		const outPath = path.join(outDir, `debug-window-${p.name}.obj`);
		result.push({
			name: p.name,
			center: p,
			radius,
			...exportWindowObj(g, p.north, p.west, radius, outPath),
		});
	}
	console.log(JSON.stringify({ geomPath, result }, null, 2));
}

main();

