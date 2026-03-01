#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const geom = require('./export-route-geometry');

function percentile(values, p) {
	if (!values.length) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * p)));
	return sorted[idx];
}

function parseArgs() {
	const args = process.argv.slice(2);
	const out = {
		dir: path.resolve('pathfinder/exports/adt-objs'),
		outReport: path.resolve('pathfinder/exports/placement-regression-report.json'),
		margin: 2,
		sampleVerts: 700,
		// game coords: north, west, height
		from: [326.71, -4704.19, 16.08],
		to: [-618.48, -4251.93, 38.73],
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--dir' && args[i + 1]) out.dir = path.resolve(args[++i]);
		else if (args[i] === '--out' && args[i + 1]) out.outReport = path.resolve(args[++i]);
		else if (args[i] === '--margin' && args[i + 1]) out.margin = Number(args[++i]) || 2;
		else if (args[i] === '--sample-verts' && args[i + 1]) out.sampleVerts = Number(args[++i]) || 700;
	}
	return out;
}

function buildTileIdSet(opts) {
	const ids = geom.getTileIdsForRoute(opts.from[0], opts.from[1], opts.to[0], opts.to[1], opts.margin);
	return { tileIdSet: ids, tileIds: Array.from(ids).sort() };
}

function getPlacementsForModelPath(placementsByModel, dirNorm, fp) {
	const relPath = path.relative(dirNorm, fp).replace(/\\/g, '/');
	const relKeyBasename = path.basename(fp);
	const relPathObj = relPath.replace(/\.phys\.obj$/i, '.obj');
	const relKeyObjBasename = relKeyBasename.replace(/\.phys\.obj$/i, '.obj');
	return (
		placementsByModel.get(relPath) ||
		placementsByModel.get(relPathObj) ||
		placementsByModel.get(relKeyBasename) ||
		placementsByModel.get(relKeyObjBasename) ||
		[]
	);
}

function main() {
	const opts = parseArgs();
	if (!fs.existsSync(opts.dir)) {
		console.error('[placement-regression] adt-objs dir not found:', opts.dir);
		process.exit(1);
	}

	const { tileIdSet, tileIds } = buildTileIdSet(opts);
	const { terrainObjs, csvFiles } = geom.collectTileFiles(opts.dir, tileIdSet);
	const placementsByModel = geom.loadPlacementsFromCSVFiles(csvFiles, path.resolve(opts.dir), { includeWmo: true, includeM2: true });
	const modelPaths = geom.collectModelPathsFromCSVs(csvFiles, path.resolve(opts.dir), { includeWmo: true, includeM2: true, usePhysModel: false, physOnly: false });

	const parseCache = new Map();
	const getObj = (fp) => {
		if (!parseCache.has(fp)) parseCache.set(fp, geom.parseObjFile(fp));
		return parseCache.get(fp);
	};

	const report = {
		config: {
			dir: opts.dir,
			margin: opts.margin,
			sampleVerts: opts.sampleVerts,
			from: opts.from,
			to: opts.to,
		},
		coverage: {
			routeTiles: tileIds.length,
			terrainObjCount: terrainObjs.length,
			csvCount: csvFiles.length,
			modelFileCount: modelPaths.length,
		},
		wmoBoundsFit: {},
		m2VisualPhysConsistency: {},
		anchorChecks: {},
		failures: [],
	};

	// 1) WMO bounds fit regression
	const wmoScores = [];
	let wmoChecked = 0;
	for (const fp of modelPaths) {
		const placements = getPlacementsForModelPath(placementsByModel, path.resolve(opts.dir), fp);
		if (!placements.length) continue;
		const model = getObj(fp);
		if (!model.positions || model.positions.length < 9) continue;
		for (const pl of placements) {
			if (pl.type !== 'wmo' || !pl.boundsWorld) continue;
			const sampled = geom.samplePositions(model.positions, opts.sampleVerts);
			const tpos = geom.transformPositions(sampled, pl, fp, null);
			const b = geom.boundsFromPositions(tpos);
			const s = geom.scoreBoundsFit(b, pl.boundsWorld);
			wmoScores.push(s);
			wmoChecked++;
		}
	}
	report.wmoBoundsFit = {
		checked: wmoChecked,
		p50: percentile(wmoScores, 0.5),
		p90: percentile(wmoScores, 0.9),
		p95: percentile(wmoScores, 0.95),
		max: wmoScores.length ? Math.max(...wmoScores) : null,
	};

	// 2) M2 visual/phys consistency regression
	const m2Scores = [];
	let m2Checked = 0;
	for (const fp of modelPaths) {
		if (!/\.obj$/i.test(fp) || /\.phys\.obj$/i.test(fp)) continue;
		const phys = fp.replace(/\.obj$/i, '.phys.obj');
		if (!fs.existsSync(phys)) continue;
		const placements = getPlacementsForModelPath(placementsByModel, path.resolve(opts.dir), fp);
		if (!placements.length) continue;
		const visObj = getObj(fp);
		const physObj = getObj(phys);
		if (visObj.positions.length < 9 || physObj.positions.length < 9) continue;
		const visSample = geom.samplePositions(visObj.positions, opts.sampleVerts);
		const physSample = geom.samplePositions(physObj.positions, opts.sampleVerts);
		for (const pl of placements) {
			if (pl.type !== 'm2') continue;
			const visTrans = geom.transformPositions(visSample, pl, fp, null);
			const physTrans = geom.transformPositions(physSample, pl, phys, visObj.positions);
			const vb = geom.boundsFromPositions(visTrans);
			const pb = geom.boundsFromPositions(physTrans);
			const score = geom.scoreBoundsFit(pb, vb);
			m2Scores.push(score);
			m2Checked++;
		}
	}
	report.m2VisualPhysConsistency = {
		checked: m2Checked,
		p50: percentile(m2Scores, 0.5),
		p90: percentile(m2Scores, 0.9),
		p95: percentile(m2Scores, 0.95),
		max: m2Scores.length ? Math.max(...m2Scores) : null,
	};

	// 3) Anchor checks (historical bug points)
	const anchors = [
		{ name: 'fence', north: 243.67999267578125, west: -4706.08984375, height: 15.84000015258789, radius2d: 8 },
		{ name: 'fallen_tree', north: -341.55999755859375, west: -4727.93994140625, height: 37.150001525878906, radius2d: 8 },
	];
	const allPlacements = [];
	for (const arr of placementsByModel.values()) {
		for (const pl of arr) allPlacements.push(pl);
	}
	for (const a of anchors) {
		let best = null;
		for (const pl of allPlacements) {
			const d2 = (pl.pz - a.north) ** 2 + (pl.px - a.west) ** 2;
			const d2d = Math.sqrt(d2);
			if (!best || d2d < best.dist2d) {
				best = {
					type: pl.type,
					modelFile: pl.modelFile,
					dist2d: d2d,
					dist3d: Math.hypot(pl.pz - a.north, pl.px - a.west, pl.py - a.height),
				};
			}
		}
		report.anchorChecks[a.name] = { target: a, nearest: best, pass: !!(best && best.dist2d <= a.radius2d) };
	}

	// Rule-based gates (conservative)
	if (report.coverage.terrainObjCount < report.coverage.routeTiles) {
		report.failures.push('terrain_obj_coverage_incomplete');
	}
	if (report.coverage.csvCount < report.coverage.routeTiles - 2) {
		report.failures.push('placement_csv_coverage_too_low');
	}
	if ((report.wmoBoundsFit.p95 ?? Infinity) > 120) {
		report.failures.push('wmo_bounds_fit_p95_too_high');
	}
	if ((report.m2VisualPhysConsistency.p95 ?? Infinity) > 180) {
		report.failures.push('m2_visual_phys_consistency_p95_too_high');
	}
	for (const [name, r] of Object.entries(report.anchorChecks)) {
		if (!r.pass) report.failures.push(`anchor_${name}_not_matched`);
	}

	fs.writeFileSync(opts.outReport, JSON.stringify(report, null, 2), 'utf8');
	console.log('[placement-regression] wrote:', opts.outReport);
	console.log(JSON.stringify({
		coverage: report.coverage,
		wmoBoundsFit: report.wmoBoundsFit,
		m2VisualPhysConsistency: report.m2VisualPhysConsistency,
		failures: report.failures,
	}, null, 2));

	if (report.failures.length > 0) process.exit(2);
}

main();

