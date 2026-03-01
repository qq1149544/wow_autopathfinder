#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const TILE_SIZE = (51200 / 3) / 32;
const HALF = 32;

function worldToTile(west, north) {
	const tx = Math.max(0, Math.min(63, Math.floor(HALF - west / TILE_SIZE)));
	const tz = Math.max(0, Math.min(63, Math.floor(HALF - north / TILE_SIZE)));
	return { tx, tz };
}

function getRouteTiles(fromNorth, fromWest, toNorth, toWest, margin = 2) {
	const minWest = Math.min(fromWest, toWest);
	const maxWest = Math.max(fromWest, toWest);
	const minNorth = Math.min(fromNorth, toNorth);
	const maxNorth = Math.max(fromNorth, toNorth);
	const t0 = worldToTile(maxWest, maxNorth);
	const t1 = worldToTile(minWest, minNorth);
	const txLo = Math.max(0, Math.min(t0.tx, t1.tx) - margin);
	const txHi = Math.min(63, Math.max(t0.tx, t1.tx) + margin);
	const tzLo = Math.max(0, Math.min(t0.tz, t1.tz) - margin);
	const tzHi = Math.min(63, Math.max(t0.tz, t1.tz) + margin);
	const ids = new Set();
	for (let tz = tzLo; tz <= tzHi; tz++) {
		for (let tx = txLo; tx <= txHi; tx++) ids.add(`${tz}_${tx}`);
	}
	return ids;
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
	if (lines.length === 0) return { headers: [], rows: [] };
	const headers = parseCSVLine(lines[0]);
	const rows = [];
	for (let i = 1; i < lines.length; i++) {
		const values = parseCSVLine(lines[i]);
		const row = {};
		headers.forEach((h, j) => (row[h] = values[j] || ''));
		rows.push(row);
	}
	return { headers, rows };
}

function main() {
	const args = process.argv.slice(2);
	const outPath = path.resolve(args[0] || 'pathfinder/exports/current-route-model-files.txt');
	const adtObjsDir = path.resolve(args[1] || 'pathfinder/exports/adt-objs');
	const from = [326.71, -4704.19, 16.08];
	const to = [-618.48, -4251.93, 38.73];
	const tileSet = getRouteTiles(from[0], from[1], to[0], to[1], 2);

	const csvFiles = fs
		.readdirSync(adtObjsDir)
		.filter((name) => /^adt_\d+_\d+_ModelPlacementInformation\.csv$/i.test(name))
		.map((name) => {
			const id = name.replace(/^adt_/i, '').replace(/_ModelPlacementInformation\.csv$/i, '');
			const rev = id.split('_').reverse().join('_');
			return { id, rev, full: path.join(adtObjsDir, name) };
		})
		.filter((x) => tileSet.has(x.id) || tileSet.has(x.rev))
		.map((x) => x.full);

	const models = new Set();
	for (const csvPath of csvFiles) {
		const content = fs.readFileSync(csvPath, 'utf8');
		const { rows } = parseCSV(content);
		for (const row of rows) {
			const modelFile = row.ModelFile;
			if (!modelFile) continue;
			const abs = path.resolve(path.dirname(csvPath), modelFile);
			if (fs.existsSync(abs)) models.add(abs);
			const phys = abs.replace(/\.obj$/i, '.phys.obj');
			if (fs.existsSync(phys)) models.add(phys);
		}
	}

	const lines = Array.from(models).sort();
	fs.writeFileSync(outPath, lines.join('\n'), 'utf8');
	console.log(JSON.stringify({ outPath, tileCount: tileSet.size, csvCount: csvFiles.length, modelCount: lines.length }, null, 2));
}

main();

