#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const TILE_SIZE = (51200 / 3) / 32;
const MAP_HALF = 32;

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
	if (lines.length === 0) return { headers: [], rows: [] };
	const headers = parseCSVLine(lines[0]);
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const values = parseCSVLine(lines[i]);
		const row = {};
		headers.forEach((h, j) => (row[h] = values[j] ?? ''));
		rows.push(row);
	}
	return { headers, rows };
}

function toWorld(row) {
	const x = parseFloat(row.PositionX);
	const y = parseFloat(row.PositionY);
	const z = parseFloat(row.PositionZ);
	const west = MAP_HALF * TILE_SIZE - x;
	const north = MAP_HALF * TILE_SIZE - z;
	return {
		west,
		north,
		height: y,
	};
}

function main() {
	const args = process.argv.slice(2);
	const outDir = path.resolve(args[0] || 'pathfinder/exports/adt-objs');
	const radius = Number(args[1] || 70);
	// game coords: x=north, y=west, z=height
	const targets = [
		{ name: 'fence', north: 243.67999267578125, west: -4706.08984375, height: 15.84000015258789 },
		{ name: 'fallen_tree', north: -341.55999755859375, west: -4727.93994140625, height: 37.150001525878906 },
	];

	const csvFiles = fs.readdirSync(outDir).filter((f) => /^adt_\d+_\d+_ModelPlacementInformation\.csv$/i.test(f));
	const all = [];
	for (const csv of csvFiles) {
		const full = path.join(outDir, csv);
		const { rows } = parseCSV(fs.readFileSync(full, 'utf8'));
		for (const row of rows) {
			if (!row.ModelFile) continue;
			const w = toWorld(row);
			all.push({
				csv,
				type: (row.Type || '').toLowerCase(),
				modelFile: row.ModelFile,
				fileDataID: row.FileDataID || '',
				modelId: row.ModelId || '',
				rotX: Number(row.RotationX || 0),
				rotY: Number(row.RotationY || 0),
				rotZ: Number(row.RotationZ || 0),
				scale: Number(row.ScaleFactor || 1),
				north: w.north,
				west: w.west,
				height: w.height,
			});
		}
	}

	const report = {};
	for (const t of targets) {
		const hits = all
			.map((m) => {
				const d2 = (m.north - t.north) ** 2 + (m.west - t.west) ** 2 + (m.height - t.height) ** 2;
				return { ...m, dist3d: Math.sqrt(d2), dist2d: Math.hypot(m.north - t.north, m.west - t.west) };
			})
			.filter((m) => m.dist2d <= radius)
			.sort((a, b) => a.dist2d - b.dist2d)
			.slice(0, 60);
		report[t.name] = {
			target: t,
			radius,
			count: hits.length,
			items: hits,
		};
	}

	const outPath = path.resolve('pathfinder/exports/nearby-placement-diagnosis.json');
	fs.writeFileSync(outPath, JSON.stringify(report, null, 2), 'utf8');
	console.log(JSON.stringify({ outPath, totalPlacements: all.length }, null, 2));
}

main();

