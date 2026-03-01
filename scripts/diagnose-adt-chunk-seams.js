const fs = require('fs');
const path = require('path');

function parseObjVerts(filePath) {
	const txt = fs.readFileSync(filePath, 'utf8');
	const verts = [];
	for (const line of txt.split(/\r?\n/)) {
		if (!line.startsWith('v ')) continue;
		const p = line.trim().split(/\s+/);
		if (p.length < 4) continue;
		verts.push([Number(p[1]), Number(p[2]), Number(p[3])]); // west, height, north
	}
	return verts;
}

function percentile(sorted, p) {
	if (!sorted.length) return 0;
	const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor(sorted.length * p)));
	return sorted[idx];
}

function stat(values) {
	if (!values.length) return { count: 0, max: 0, p95: 0, avg: 0 };
	const sorted = [...values].sort((a, b) => a - b);
	const sum = sorted.reduce((a, b) => a + b, 0);
	return {
		count: sorted.length,
		max: sorted[sorted.length - 1],
		p95: percentile(sorted, 0.95),
		avg: sum / sorted.length,
	};
}

function nearestByU(sortedPoints, u) {
	if (!sortedPoints.length) return null;
	let lo = 0, hi = sortedPoints.length - 1;
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (sortedPoints[mid].u < u) lo = mid + 1;
		else hi = mid;
	}
	let best = sortedPoints[lo];
	if (lo > 0 && Math.abs(sortedPoints[lo - 1].u - u) < Math.abs(best.u - u)) best = sortedPoints[lo - 1];
	return best;
}

function compareChunk(aPts, bPts) {
	if (!aPts.length || !bPts.length) {
		return {
			samplesA: aPts.length,
			samplesB: bPts.length,
			matched: 0,
			uGap: { count: 0, max: 0, p95: 0, avg: 0 },
			heightGap: { count: 0, max: 0, p95: 0, avg: 0 },
		};
	}
	const bSorted = [...bPts].sort((x, y) => x.u - y.u);
	const dU = [];
	const dH = [];
	for (const p of aPts) {
		const q = nearestByU(bSorted, p.u);
		if (!q) continue;
		dU.push(Math.abs(p.u - q.u));
		dH.push(Math.abs(p.h - q.h));
	}
	return {
		samplesA: aPts.length,
		samplesB: bPts.length,
		matched: dU.length,
		uGap: stat(dU),
		heightGap: stat(dH),
	};
}

function clamp(v, lo, hi) {
	return Math.max(lo, Math.min(hi, v));
}

function collectSeamChunkPoints(tile, seamValue, dir, epsilon, uMinOverride = null, uMaxOverride = null) {
	const points = Array.from({ length: 16 }, () => []);
	const minU = Number.isFinite(uMinOverride) ? uMinOverride : (dir === 'east' ? tile.bounds.minN : tile.bounds.minW);
	const maxU = Number.isFinite(uMaxOverride) ? uMaxOverride : (dir === 'east' ? tile.bounds.maxN : tile.bounds.maxW);
	const span = (maxU - minU) / 16;
	if (!Number.isFinite(span) || span <= 0) return points;
	for (const [w, h, n] of tile.verts) {
		const onSeam = dir === 'east' ? Math.abs(w - seamValue) <= epsilon : Math.abs(n - seamValue) <= epsilon;
		if (!onSeam) continue;
		const u = dir === 'east' ? n : w;
		const idx = clamp(Math.floor((u - minU) / span), 0, 15);
		points[idx].push({ u, h });
	}
	return points;
}

function main() {
	const dir = path.resolve('pathfinder/exports/adt-objs');
	const files = fs.readdirSync(dir).filter((f) => /^adt_\d+_\d+\.obj$/i.test(f));
	const tiles = new Map();

	for (const f of files) {
		const m = f.match(/^adt_(\d+)_(\d+)\.obj$/i);
		if (!m) continue;
		const tz = Number(m[1]);
		const tx = Number(m[2]);
		const verts = parseObjVerts(path.join(dir, f));
		let minW = Infinity, maxW = -Infinity, minN = Infinity, maxN = -Infinity;
		for (const [w, , n] of verts) {
			if (w < minW) minW = w;
			if (w > maxW) maxW = w;
			if (n < minN) minN = n;
			if (n > maxN) maxN = n;
		}
		tiles.set(`${tz}_${tx}`, { tz, tx, name: f, verts, bounds: { minW, maxW, minN, maxN } });
	}

	const seamChunkRows = [];
	for (const tile of tiles.values()) {
		const eastKey = `${tile.tz}_${tile.tx + 1}`;
		const southKey = `${tile.tz + 1}_${tile.tx}`;

		if (tiles.has(eastKey)) {
			const east = tiles.get(eastKey);
			const opt1 = Math.abs(tile.bounds.maxW - east.bounds.minW); // A.max <-> B.min
			const opt2 = Math.abs(tile.bounds.minW - east.bounds.maxW); // A.min <-> B.max
			const use1 = opt1 <= opt2;
			const aEdge = use1 ? tile.bounds.maxW : tile.bounds.minW;
			const bEdge = use1 ? east.bounds.minW : east.bounds.maxW;
			const seamW = (aEdge + bEdge) * 0.5;
			const eps = Math.max(0.01, Math.abs(aEdge - bEdge) * 4 + 0.01);
			const uMin = Math.max(tile.bounds.minN, east.bounds.minN);
			const uMax = Math.min(tile.bounds.maxN, east.bounds.maxN);
			const aChunks = collectSeamChunkPoints(tile, seamW, 'east', eps, uMin, uMax);
			const bChunks = collectSeamChunkPoints(east, seamW, 'east', eps, uMin, uMax);
			for (let i = 0; i < 16; i++) {
				seamChunkRows.push({
					seam: `${tile.tz}_${tile.tx}->${east.tz}_${east.tx}`,
					direction: 'east-west',
					edgePair: use1 ? 'A.maxW<->B.minW' : 'A.minW<->B.maxW',
					chunkIndex: i,
					...compareChunk(aChunks[i], bChunks[i]),
				});
			}
		}

		if (tiles.has(southKey)) {
			const south = tiles.get(southKey);
			const opt1 = Math.abs(tile.bounds.maxN - south.bounds.minN); // A.max <-> B.min
			const opt2 = Math.abs(tile.bounds.minN - south.bounds.maxN); // A.min <-> B.max
			const use1 = opt1 <= opt2;
			const aEdge = use1 ? tile.bounds.maxN : tile.bounds.minN;
			const bEdge = use1 ? south.bounds.minN : south.bounds.maxN;
			const seamN = (aEdge + bEdge) * 0.5;
			const eps = Math.max(0.01, Math.abs(aEdge - bEdge) * 4 + 0.01);
			const uMin = Math.max(tile.bounds.minW, south.bounds.minW);
			const uMax = Math.min(tile.bounds.maxW, south.bounds.maxW);
			const aChunks = collectSeamChunkPoints(tile, seamN, 'south', eps, uMin, uMax);
			const bChunks = collectSeamChunkPoints(south, seamN, 'south', eps, uMin, uMax);
			for (let i = 0; i < 16; i++) {
				seamChunkRows.push({
					seam: `${tile.tz}_${tile.tx}->${south.tz}_${south.tx}`,
					direction: 'north-south',
					edgePair: use1 ? 'A.maxN<->B.minN' : 'A.minN<->B.maxN',
					chunkIndex: i,
					...compareChunk(aChunks[i], bChunks[i]),
				});
			}
		}
	}

	const valid = seamChunkRows.filter((r) => r.matched > 0);
	const sortedWorst = [...valid]
		.sort((a, b) => b.heightGap.max - a.heightGap.max || b.uGap.max - a.uGap.max)
		.slice(0, 120);
	const emptyPairs = seamChunkRows.filter((r) => r.samplesA === 0 || r.samplesB === 0);

	const out = {
		tileCount: tiles.size,
		seamChunkCount: seamChunkRows.length,
		validSeamChunkCount: valid.length,
		emptyChunkSideCount: emptyPairs.length,
		summary: {
			heightGap: stat(valid.map((r) => r.heightGap.max)),
			uGap: stat(valid.map((r) => r.uGap.max)),
		},
		worstChunks: sortedWorst,
		emptyChunkSidesPreview: emptyPairs.slice(0, 80),
	};

	const outPath = path.resolve('pathfinder/exports/adt-chunk-seam-report.json');
	fs.writeFileSync(outPath, JSON.stringify(out, null, 2), 'utf8');
	console.log('wrote', outPath);
	console.log(JSON.stringify({
		tileCount: out.tileCount,
		seamChunkCount: out.seamChunkCount,
		validSeamChunkCount: out.validSeamChunkCount,
		emptyChunkSideCount: out.emptyChunkSideCount,
		heightGap: out.summary.heightGap,
		uGap: out.summary.uGap,
		topWorst: out.worstChunks.slice(0, 10).map((r) => ({
			seam: r.seam,
			dir: r.direction,
			chunk: r.chunkIndex,
			heightMax: r.heightGap.max,
			uMax: r.uGap.max,
			matched: r.matched,
		})),
	}, null, 2));
}

main();
