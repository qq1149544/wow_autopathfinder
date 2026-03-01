#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function main() {
	const args = process.argv.slice(2);
	const inPath = path.resolve(args[0] || 'pathfinder/exports/recast-geometry-route.json');
	const outPath = path.resolve(args[1] || 'pathfinder/exports/current-route-merged-preview.obj');
	const g = JSON.parse(fs.readFileSync(inPath, 'utf8'));
	const pos = Array.isArray(g.positions) ? g.positions : [];
	const idx = Array.isArray(g.indices) ? g.indices : [];
	let out = '';
	for (let i = 0; i < pos.length; i += 3) {
		out += 'v ' + pos[i] + ' ' + pos[i + 1] + ' ' + pos[i + 2] + '\n';
	}
	for (let i = 0; i < idx.length; i += 3) {
		out += 'f ' + (idx[i] + 1) + ' ' + (idx[i + 1] + 1) + ' ' + (idx[i + 2] + 1) + '\n';
	}
	fs.writeFileSync(outPath, out, 'utf8');
	console.log(JSON.stringify({ inPath, outPath, verts: pos.length / 3, tris: idx.length / 3 }, null, 2));
}

main();

