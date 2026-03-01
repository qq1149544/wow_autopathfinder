#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const TILE_SIZE = (51200 / 3) / 32;
const MAP_HALF = 32;

function parseObj(filePath) {
	const text = fs.readFileSync(filePath, 'utf8');
	const positions = [];
	const indices = [];
	for (const line of text.split(/\r?\n/)) {
		const p = line.trim().split(/\s+/);
		if (p[0] === 'v' && p.length >= 4) positions.push(Number(p[1]), Number(p[2]), Number(p[3]));
		else if (p[0] === 'f' && p.length >= 4) indices.push(Number(p[1].split('/')[0]) - 1, Number(p[2].split('/')[0]) - 1, Number(p[3].split('/')[0]) - 1);
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
					if (line[i] === '"') {
						s += '"';
						i++;
					} else break;
				} else s += line[i++];
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
	const lines = content.split(/\r?\n/).filter((x) => x.trim());
	if (lines.length === 0) return [];
	const headers = parseCSVLine(lines[0]);
	const out = [];
	for (let i = 1; i < lines.length; i++) {
		const vals = parseCSVLine(lines[i]);
		const row = {};
		headers.forEach((h, j) => (row[h] = vals[j] || ''));
		out.push(row);
	}
	return out;
}

function eulerZXYToQuat(x, y, z) {
	const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
	const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
	const cz = Math.cos(z / 2), sz = Math.sin(z / 2);
	return [sx * cy * cz - cx * sy * sz, cx * sy * cz + sx * cy * sz, cx * cy * sz - sx * sy * cz, cx * cy * cz + sx * sy * sz];
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

function toWorld(row) {
	const x = Number(row.PositionX || 0);
	const y = Number(row.PositionY || 0);
	const z = Number(row.PositionZ || 0);
	return { west: MAP_HALF * TILE_SIZE - x, north: MAP_HALF * TILE_SIZE - z, height: y };
}

function transform(positions, row) {
	const w = toWorld(row);
	const q = eulerZXYToQuat((Number(row.RotationX || 0) * Math.PI) / 180, (Number(row.RotationY || 0) * Math.PI) / 180, (Number(row.RotationZ || 0) * Math.PI) / 180);
	const scale = Number(row.ScaleFactor || 1) || 1;
	const out = [];
	for (let i = 0; i < positions.length; i += 3) {
		const v = quatRotate(positions[i] * scale, positions[i + 1] * scale, positions[i + 2] * scale, q);
		out.push(v[0] + w.west, v[1] + w.height, v[2] + w.north);
	}
	return out;
}

function exportOne(name, targetNorth, targetWest, radius) {
	const dir = path.resolve('pathfinder/exports/adt-objs');
	const csvFiles = fs.readdirSync(dir).filter((f) => /ModelPlacementInformation\.csv$/i.test(f));
	const allRows = [];
	for (const csv of csvFiles) {
		for (const row of parseCSV(fs.readFileSync(path.join(dir, csv), 'utf8'))) {
			if (!row.ModelFile) continue;
			const w = toWorld(row);
			const d2 = (w.north - targetNorth) ** 2 + (w.west - targetWest) ** 2;
			if (Math.sqrt(d2) <= radius) allRows.push({ ...row, __csv: csv, __north: w.north, __west: w.west });
		}
	}
	let positions = [];
	let indices = [];
	let vo = 0;
	for (const row of allRows) {
		const modelPath = path.resolve(dir, row.ModelFile);
		const usePhys = process.argv.includes('--use-phys-model');
		const physPath = modelPath.replace(/\.obj$/i, '.phys.obj');
		const usePath = (usePhys && fs.existsSync(physPath)) ? physPath : modelPath;
		if (!fs.existsSync(usePath)) continue;
		const obj = parseObj(usePath);
		const tpos = transform(obj.positions, row);
		positions = positions.concat(tpos);
		for (let i = 0; i < obj.indices.length; i++) indices.push(obj.indices[i] + vo);
		vo += obj.positions.length / 3;
	}
	const out = path.resolve(`pathfinder/exports/debug-nearby-models-${name}.obj`);
	let s = '';
	for (let i = 0; i < positions.length; i += 3) s += `v ${positions[i]} ${positions[i + 1]} ${positions[i + 2]}\n`;
	for (let i = 0; i < indices.length; i += 3) s += `f ${indices[i] + 1} ${indices[i + 1] + 1} ${indices[i + 2] + 1}\n`;
	fs.writeFileSync(out, s, 'utf8');
	return { out, rows: allRows.length, verts: positions.length / 3, tris: indices.length / 3 };
}

function main() {
	const radius = Number(process.argv[2] || 70);
	const fence = exportOne('fence', 243.67999267578125, -4706.08984375, radius);
	const tree = exportOne('fallen_tree', -341.55999755859375, -4727.93994140625, radius);
	console.log(JSON.stringify({ radius, fence, fallen_tree: tree }, null, 2));
}

main();

