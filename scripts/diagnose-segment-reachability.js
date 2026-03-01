const path = require('path');
const svc = require('../navmesh-route-service');

function parseArgs() {
	const args = process.argv.slice(2);
	const out = {
		geometryPath: path.resolve('pathfinder/exports/recast-geometry-route.json'),
		from: [-525.06, -4751.06, 33.04], // game north, west, height
		to: [-367.44, -4811.22, 32.39],
		routeCellSize: 0.5,
		fineNavMesh: true,
		useRouteBbox: true,
		routeMargin: 600,
		forceTiled: false,
		forceSolo: false,
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--geometry' && args[i + 1]) out.geometryPath = path.resolve(args[++i]);
		else if (args[i] === '--from' && args[i + 3]) out.from = [Number(args[++i]), Number(args[++i]), Number(args[++i])];
		else if (args[i] === '--to' && args[i + 3]) out.to = [Number(args[++i]), Number(args[++i]), Number(args[++i])];
		else if (args[i] === '--route-cell-size' && args[i + 1]) out.routeCellSize = Number(args[++i]) || 0.5;
		else if (args[i] === '--no-fine') out.fineNavMesh = false;
		else if (args[i] === '--no-route-bbox') out.useRouteBbox = false;
		else if (args[i] === '--route-margin' && args[i + 1]) out.routeMargin = Number(args[++i]) || 600;
		else if (args[i] === '--force-tiled') out.forceTiled = true;
		else if (args[i] === '--force-solo') out.forceSolo = true;
	}
	return out;
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
			minNorth: Math.min(opts.from[0], opts.to[0]),
			maxNorth: Math.max(opts.from[0], opts.to[0]),
			minWest: Math.min(opts.from[1], opts.to[1]),
			maxWest: Math.max(opts.from[1], opts.to[1]),
			margin: opts.routeMargin,
		};
	}
	await svc.buildNavMesh(buildOpts);

	const nav = svc.getNavMeshNavcat();
	const navcat = svc.getNavcatModule();
	const off = svc.getNavWorldOffset();
	const filter = navcat.ANY_QUERY_FILTER || navcat.DEFAULT_QUERY_FILTER;
	const COMPLETE = (navcat.FindPathResultFlags && navcat.FindPathResultFlags.COMPLETE_PATH) || 2;

	const g2r = (p) => [p[1] - off.x, p[2], p[0] - off.z];
	const a = g2r(opts.from);
	const b = g2r(opts.to);
	const extentsList = [[300, 500, 300], [500, 500, 500], [1000, 1000, 1000], [2000, 2000, 2000], [3000, 3000, 3000]];

	let summary = null;
	for (const ext of extentsList) {
		const r1 = navcat.findPath(nav, a, b, ext, filter);
		const r2 = navcat.findPath(nav, b, a, ext, filter);
		const ok1 = !!(r1 && r1.success && r1.path && r1.path.length > 1 && ((r1.flags & COMPLETE) === COMPLETE));
		const ok2 = !!(r2 && r2.success && r2.path && r2.path.length > 1 && ((r2.flags & COMPLETE) === COMPLETE));
		summary = {
			extents: ext,
			forward: { ok: ok1, flags: r1?.flags ?? null, pathLen: r1?.path?.length ?? 0 },
			backward: { ok: ok2, flags: r2?.flags ?? null, pathLen: r2?.path?.length ?? 0 },
		};
		if (ok1 && ok2) break;
	}

	console.log(JSON.stringify({
		geometry: opts.geometryPath,
		from: opts.from,
		to: opts.to,
		backend: svc.getNavMeshBackend(),
		tileCount: Object.keys((svc.getNavMeshNavcat() && svc.getNavMeshNavcat().tiles) || {}).length,
		offset: off,
		routeCellSize: opts.routeCellSize,
		fineNavMesh: opts.fineNavMesh,
		useRouteBbox: opts.useRouteBbox,
		forceTiled: opts.forceTiled,
		forceSolo: opts.forceSolo,
		result: summary,
	}, null, 2));
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});

