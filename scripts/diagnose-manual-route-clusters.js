const fs = require('fs');
const path = require('path');
const svc = require('../navmesh-route-service');

const ROUTE_POINTS = [
	[-618.52, -4251.67, 38.72],
	[-591.29, -4441.07, 41.58],
	[-571.05, -4487.40, 42.57],
	[-585.14, -4532.30, 41.33],
	[-548.90, -4566.72, 41.33],
	[-559.03, -4579.41, 41.33],
	[-592.56, -4573.30, 41.13],
	[-609.43, -4613.31, 40.82],
	[-601.91, -4695.75, 37.07],
	[-525.06, -4751.06, 33.04],
	[-367.44, -4811.22, 32.39],
	[-204.90, -4784.38, 23.98],
	[-50.66, -4753.05, 21.05],
	[155.02, -4733.07, 15.33],
	[243.95, -4735.75, 10.10],
	[280.72, -4748.21, 9.59],
	[327.99, -4713.02, 13.96],
	[327.64, -4703.63, 16.27],
];

function parseArgs() {
	const args = process.argv.slice(2);
	const out = {
		geometryPath: path.resolve('pathfinder/exports/recast-geometry-route.json'),
		outPath: path.resolve('pathfinder/exports/manual-route-cluster-report.json'),
		routeCellSize: 0.5,
		mode: 'quick',
		fineNavMesh: true,
		useRouteBbox: true,
		routeMargin: 200,
		forceTiled: false,
		forceSolo: false,
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--geometry' && args[i + 1]) out.geometryPath = path.resolve(args[++i]);
		else if (args[i] === '--out' && args[i + 1]) out.outPath = path.resolve(args[++i]);
		else if (args[i] === '--route-cell-size' && args[i + 1]) out.routeCellSize = Number(args[++i]) || 0.5;
		else if (args[i] === '--mode' && args[i + 1]) out.mode = String(args[++i]).toLowerCase();
		else if (args[i] === '--no-fine') out.fineNavMesh = false;
		else if (args[i] === '--no-route-bbox') out.useRouteBbox = false;
		else if (args[i] === '--route-margin' && args[i + 1]) out.routeMargin = Number(args[++i]) || 200;
		else if (args[i] === '--force-tiled') out.forceTiled = true;
		else if (args[i] === '--force-solo') out.forceSolo = true;
	}
	return out;
}

function ufCreate(n) {
	const p = Array.from({ length: n }, (_, i) => i);
	const r = Array.from({ length: n }, () => 0);
	const find = (x) => (p[x] === x ? x : (p[x] = find(p[x])));
	const union = (a, b) => {
		let ra = find(a), rb = find(b);
		if (ra === rb) return;
		if (r[ra] < r[rb]) [ra, rb] = [rb, ra];
		p[rb] = ra;
		if (r[ra] === r[rb]) r[ra]++;
	};
	return { find, union };
}

async function main() {
	const opts = parseArgs();
	const buildOpts = {
		geometryPath: opts.geometryPath,
		useGeometryFile: true,
		fineNavMesh: opts.fineNavMesh,
		skipRouteCrop: true,
		routeCellSize: opts.routeCellSize,
		forceTiledNavMesh: opts.forceTiled,
		forceSoloNavMesh: opts.forceSolo,
		avoidCollisions: true,
		routeWalkableSlopeAngleDegrees: 35,
		walkableRadiusWorld: 1.0,
		walkableClimbWorld: 2.2,
	};
	if (opts.useRouteBbox) {
		buildOpts.routeBbox = {
			minNorth: -618.52,
			maxNorth: 327.64,
			minWest: -4703.63,
			maxWest: -4251.67,
			margin: opts.routeMargin,
		};
	}
	await svc.buildNavMesh(buildOpts);

	const nav = svc.getNavMeshNavcat();
	const navcat = svc.getNavcatModule();
	const off = svc.getNavWorldOffset();
	const filter = navcat.ANY_QUERY_FILTER || navcat.DEFAULT_QUERY_FILTER;
	const COMPLETE = (navcat.FindPathResultFlags && navcat.FindPathResultFlags.COMPLETE_PATH) || 2;
	const extentsList = [[300, 500, 300], [500, 500, 500], [1000, 1000, 1000], [2000, 2000, 2000], [3000, 3000, 3000]];

	const g2r = (p) => [p[1] - off.x, p[2], p[0] - off.z];

	// Reuse service strategy: query all polys, then nearest by closest-point.
	const tileIds = Object.keys(nav.tiles || {});
	let fullBounds = null;
	if (tileIds.length > 0) {
		let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
		for (const id of tileIds) {
			const t = nav.tiles[id];
			if (!t || !t.bounds) continue;
			minX = Math.min(minX, t.bounds[0]); minY = Math.min(minY, t.bounds[1]); minZ = Math.min(minZ, t.bounds[2]);
			maxX = Math.max(maxX, t.bounds[3]); maxY = Math.max(maxY, t.bounds[4]); maxZ = Math.max(maxZ, t.bounds[5]);
		}
		if (Number.isFinite(minX)) fullBounds = [minX, minY, minZ, maxX, maxY, maxZ];
	}
	let polys = fullBounds ? navcat.queryPolygons(nav, fullBounds, filter) : [];
	if ((!polys || polys.length === 0) && tileIds.length === 1 && nav.tiles[tileIds[0]]?.polyNodes && nav.nodes) {
		polys = [];
		const tile = nav.tiles[tileIds[0]];
		for (const nodeIndex of tile.polyNodes) {
			const node = nav.nodes[nodeIndex];
			if (node?.ref) polys.push(node.ref);
		}
	}

	const cpResult = navcat.createGetClosestPointOnPolyResult();
	function nearestRef(point) {
		let best = null;
		for (const ref of polys) {
			navcat.getClosestPointOnPoly(cpResult, nav, ref, point);
			if (!cpResult.success || !cpResult.position) continue;
			const pos = cpResult.position;
			const px = Array.isArray(pos) ? pos[0] : pos.x;
			const py = Array.isArray(pos) ? pos[1] : pos.y;
			const pz = Array.isArray(pos) ? pos[2] : pos.z;
			const xzSq = (px - point[0]) ** 2 + (pz - point[2]) ** 2;
			if (!best || xzSq < best.xzDistSq) best = { ref, position: [px, py, pz], xzDistSq: xzSq };
		}
		return best;
	}

	function isComplete(a, b) {
		for (const ext of extentsList) {
			const r = navcat.findPath(nav, a, b, ext, filter);
			if (r && r.success && r.path && r.path.length > 1 && ((r.flags & COMPLETE) === COMPLETE)) {
				return { ok: true, flags: r.flags, extents: ext };
			}
		}
		const rLast = navcat.findPath(nav, a, b, extentsList[extentsList.length - 1], filter);
		return { ok: false, flags: rLast?.flags ?? null, extents: extentsList[extentsList.length - 1] };
	}

	const points = ROUTE_POINTS.map((p, i) => {
		const r = g2r(p);
		const near = nearestRef(r);
		return {
			index: i + 1,
			game: { north: p[0], west: p[1], height: p[2] },
			recast: { x: r[0], y: r[1], z: r[2] },
			nearestRef: near?.ref ?? null,
			nearestXZDist: near ? Math.sqrt(near.xzDistSq) : null,
		};
	});

	const n = points.length;
	const uf = ufCreate(n);
	const adjacent = [];
	for (let i = 0; i < n - 1; i++) {
		const a = points[i].recast;
		const b = points[i + 1].recast;
		const r1 = isComplete([a.x, a.y, a.z], [b.x, b.y, b.z]);
		const r2 = isComplete([b.x, b.y, b.z], [a.x, a.y, a.z]);
		const ok = r1.ok && r2.ok;
		if (ok) uf.union(i, i + 1);
		adjacent.push({
			segment: `${i + 1}->${i + 2}`,
			ok,
			flags: [r1.flags, r2.flags],
		});
	}

	const startReach = [];
	const s = points[0].recast;
	for (let i = 0; i < n; i++) {
		const t = points[i].recast;
		const r1 = isComplete([s.x, s.y, s.z], [t.x, t.y, t.z]);
		const r2 = isComplete([t.x, t.y, t.z], [s.x, s.y, s.z]);
		startReach.push({
			index: i + 1,
			ok: r1.ok && r2.ok,
			flags: [r1.flags, r2.flags],
		});
	}

	const compMap = new Map();
	for (let i = 0; i < n; i++) {
		const root = uf.find(i);
		if (!compMap.has(root)) compMap.set(root, []);
		compMap.get(root).push(i + 1);
	}
	const components = [...compMap.values()].sort((a, b) => b.length - a.length);

	let firstBrokenAdjacent = null;
	for (let i = 0; i < adjacent.length; i++) {
		if (!adjacent[i].ok) {
			firstBrokenAdjacent = {
				segment: `${i + 1}->${i + 2}`,
				aRef: points[i].nearestRef,
				bRef: points[i + 1].nearestRef,
				aNearestXZDist: points[i].nearestXZDist,
				bNearestXZDist: points[i + 1].nearestXZDist,
				flags: adjacent[i].flags,
			};
			break;
		}
	}

	const out = {
		geometry: opts.geometryPath,
		routeCellSize: opts.routeCellSize,
		mode: opts.mode,
		backend: svc.getNavMeshBackend(),
		tileCount: Object.keys((svc.getNavMeshNavcat() && svc.getNavMeshNavcat().tiles) || {}).length,
		fineNavMesh: opts.fineNavMesh,
		useRouteBbox: opts.useRouteBbox,
		forceTiled: opts.forceTiled,
		forceSolo: opts.forceSolo,
		offset: off,
		pointCount: n,
		components,
		firstBrokenAdjacent,
		points,
		adjacent,
		startReach,
	};
	fs.writeFileSync(opts.outPath, JSON.stringify(out, null, 2), 'utf8');
	console.log('wrote', opts.outPath);
	console.log(JSON.stringify({
		geometry: out.geometry,
		components: out.components,
		firstBrokenAdjacent: out.firstBrokenAdjacent,
	}, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

