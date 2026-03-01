/**
 * Export Recast input geometry (positions + indices) from current game resources.
 * Uses TerrainLoader (ADT MCNK) + WMO walkable triangles. Coordinate system: (x,y,z) = (west, up, north).
 * Output can be passed to recast-navigation generateSoloNavMesh() for navmesh build.
 *
 * Usage:
 *   node export-recast-geometry.js [--map <name>] [--min-west <n>] [--min-north <n>] [--max-west <n>] [--max-north <n>] [--out <path>] [--terrain-subsample <n>]
 * Default: map=Azeroth, bbox around Stormwind, writes exports/recast-geometry.json
 * --terrain-subsample 2|4 reduces terrain resolution (fewer verts/tris) for large regions.
 */
const path = require('path');
const fs = require('fs');
const { TerrainLoader, vertexToWorld, TILE_SIZE } = require('./terrain-loader');
const wmoPathfinder = require('./wmo-pathfinder');

const MAP_SIZE = 64;

/** Row/col to MCNK vertex index (145 vertices: 9+8+9+8... per row). */
function rowColToVertexIndex(row, col) {
	const countPerRow = (row % 2) === 0 ? 9 : 8;
	if (col < 0 || col >= countPerRow) return -1;
	let start = 0;
	for (let r = 0; r < row; r++) start += (r % 2) === 0 ? 9 : 8;
	return start + col;
}

/**
 * Build terrain triangles for one chunk. vertexToWorld returns {x: west, y: up, z: north} in tile-relative space.
 * Caller must add tileOrigin to get world (west, height, north).
 * When subsample > 1, only vertices at every Nth row/col are included.
 */
function chunkToTriangles(chunk, tileOrigin, subsample = 1) {
	const fullPositions = [];
	for (let idx = 0; idx < 145; idx++) {
		const w = vertexToWorld(chunk, idx);
		fullPositions.push(w.x, w.y, w.z);
	}
	const step = Math.max(1, subsample | 0);
	const positions = [];
	const indices = [];
	const key = (r, c) => r * 16 + c;
	const used = new Map(); // logical (row,col) -> new vertex index
	for (let row = 0; row <= 16; row += step) {
		const maxCol = (row % 2) === 0 ? 9 : 8;
		for (let col = 0; col < maxCol; col += step) {
			const idx = rowColToVertexIndex(row, col);
			if (idx < 0) continue;
			used.set(key(row, col), positions.length / 3);
			positions.push(fullPositions[idx * 3], fullPositions[idx * 3 + 1], fullPositions[idx * 3 + 2]);
		}
	}
	for (let row = 0; row < 16; row += step) {
		for (let col = 0; col < 8; col += step) {
			const c1 = Math.min(col + step, (row % 2) === 0 ? 9 : 8);
			const r1 = Math.min(row + step, 16);
			const i00 = used.get(key(row, col));
			const i01 = used.get(key(row, c1));
			const i10 = used.get(key(r1, col));
			const i11 = used.get(key(r1, c1));
			if (i00 == null || i01 == null || i10 == null || i11 == null) continue;
			indices.push(i00, i01, i10, i01, i11, i10);
		}
	}
	return { positions, indices };
}

/**
 * Build Recast geometry for a world bbox: terrain + WMO walkable triangles.
 */
async function buildRecastGeometry(casc, mapName, bbox, options = {}) {
	const { minWest, minNorth, maxWest, maxNorth } = bbox;
	const terrain = new TerrainLoader(casc, mapName);
	await terrain.init();

	const MAP_HALF = 32;
	const blockForWestMin = Math.max(0, Math.floor(MAP_HALF - maxWest / TILE_SIZE));
	const blockForWestMax = Math.min(63, Math.floor(MAP_HALF - minWest / TILE_SIZE));
	const blockForNorthMin = Math.max(0, Math.floor(MAP_HALF - maxNorth / TILE_SIZE));
	const blockForNorthMax = Math.min(63, Math.floor(MAP_HALF - minNorth / TILE_SIZE));
	const tileIndices = new Set();
	// WoW: block = floor(32 - axis/533.33). ADT file is MapName_tileY_tileX with tileY=west block, tileX=north block.
	// So tileIndex = blockWest*64 + blockNorth so that loadTile uses tileY=floor(tileIdx/64), tileX=tileIdx%64.
	for (let bz = blockForNorthMin; bz <= blockForNorthMax; bz++) {
		for (let bx = blockForWestMin; bx <= blockForWestMax; bx++) {
			tileIndices.add(bx * MAP_SIZE + bz);
		}
	}
	const mapLower = String(mapName || '').toLowerCase();
	if (mapLower === 'azeroth' && minWest > -9500 && maxWest < -6500 && minNorth > -9500 && maxNorth < -6500) {
		for (let bz = 48; bz <= 49; bz++) tileIndices.add(30 * MAP_SIZE + bz);
	}

	const allPositions = [];
	const allIndices = [];
	let vertexOffset = 0;
	let terrainTriCount = 0;

	for (const tileIdx of tileIndices) {
		await terrain.loadTile(tileIdx);
	}
	const preferredRoots = options.preferredWmoRoots || [];

	for (const [tileIdx, rootAdt] of terrain.tiles) {
		if (!rootAdt || !rootAdt.chunks) continue;
		const tileOrigin = wmoPathfinder.getTileWorldOrigin(tileIdx);
		const subsample = options.terrainSubsample || 1;
		for (let ci = 0; ci < rootAdt.chunks.length; ci++) {
			const chunk = rootAdt.chunks[ci];
			if (!chunk || !chunk.vertices) continue;
			const { positions: pos, indices: ind } = chunkToTriangles(chunk, tileOrigin, subsample);
			for (let i = 0; i < ind.length; i++) allIndices.push(ind[i] + vertexOffset);
			for (let i = 0; i < pos.length; i += 3) {
				allPositions.push(pos[i] + tileOrigin.west, pos[i + 1], pos[i + 2] + tileOrigin.north);
			}
			vertexOffset += pos.length / 3;
			terrainTriCount += ind.length / 3;
		}
	}

	const bounds = { minX: minWest, maxX: maxWest, minZ: minNorth, maxZ: maxNorth };
	let wmoTriCount = 0;
	const wdtPlacements = await wmoPathfinder.loadWdtWorldWmo(casc, terrain.wdt, mapName);
	for (const p of wdtPlacements) {
		if (!wmoPathfinder.isPreferredWmoRoot(p.wmoName, preferredRoots)) continue;
		const tris = await wmoPathfinder.loadWmoWalkableTriangles(casc, p.wmoName, p, bounds, null);
		wmoTriCount += tris.length;
		for (const t of tris) {
			allPositions.push(t.v0[0], t.v0[1], t.v0[2], t.v1[0], t.v1[1], t.v1[2], t.v2[0], t.v2[1], t.v2[2]);
			allIndices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
			vertexOffset += 3;
		}
	}
	for (const tileIdx of tileIndices) {
		const placements = await wmoPathfinder.loadObjADT(casc, terrain.wdt, mapName, tileIdx);
		for (const p of placements) {
			if (!wmoPathfinder.isPreferredWmoRoot(p.wmoName, preferredRoots)) continue;
			const tris = await wmoPathfinder.loadWmoWalkableTriangles(casc, p.wmoName, p, bounds, tileIdx);
			wmoTriCount += tris.length;
			for (const t of tris) {
				allPositions.push(t.v0[0], t.v0[1], t.v0[2], t.v1[0], t.v1[1], t.v1[2], t.v2[0], t.v2[1], t.v2[2]);
				allIndices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
				vertexOffset += 3;
			}
		}
	}

	return { positions: allPositions, indices: allIndices, terrainTriCount, wmoTriCount };
}

async function main() {
	const args = process.argv.slice(2);
	let mapName = 'azeroth';
	let minWest = -9500, minNorth = -9500, maxWest = -6500, maxNorth = -6500;
	let outPath = path.join(__dirname, 'exports', 'recast-geometry.json');
	let terrainSubsample = 1;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--map' && args[i + 1]) { mapName = args[i + 1]; i++; }
		else if (args[i] === '--min-west' && args[i + 1]) { minWest = parseFloat(args[i + 1]); i++; }
		else if (args[i] === '--min-north' && args[i + 1]) { minNorth = parseFloat(args[i + 1]); i++; }
		else if (args[i] === '--max-west' && args[i + 1]) { maxWest = parseFloat(args[i + 1]); i++; }
		else if (args[i] === '--max-north' && args[i + 1]) { maxNorth = parseFloat(args[i + 1]); i++; }
		else if (args[i] === '--out' && args[i + 1]) { outPath = args[i + 1]; i++; }
		else if (args[i] === '--terrain-subsample' && args[i + 1]) { terrainSubsample = parseInt(args[i + 1], 10) || 1; i++; }
	}
	const wowPath = getWoWClientPath();
	if (!wowPath) {
		console.error('WoW client path not found. Set config.json wowClientPath or use exports/recast-geometry.json from a previous run.');
		process.exit(1);
	}
	const listfile = require('../wow.export-min/src/js/casc/listfile');
	const CASCLocal = require('../wow.export-min/src/js/casc/casc-source-local');
	await listfile.preload();
	const casc = new CASCLocal(wowPath);
	await casc.init();
	let buildIndex = 0;
	for (let i = 0; i < casc.builds.length; i++) {
		if (casc.builds[i] && (casc.builds[i].Product === 'wow_classic_titan' || casc.builds[i].Product === 'wow')) {
			buildIndex = i;
			break;
		}
	}
	await casc.load(buildIndex);
	const bbox = { minWest, minNorth, maxWest, maxNorth };
	const mapLower = String(mapName || '').toLowerCase();
	console.log('[recast-geometry] Building geometry for', mapName, bbox, terrainSubsample > 1 ? `(terrainSubsample=${terrainSubsample})` : '');
	const geometry = await buildRecastGeometry(casc, mapName, bbox, {
		preferredWmoRoots: mapLower === 'azeroth' ? ['stormwind.wmo', 'stormwindharbor.wmo'] : [],
		terrainSubsample
	});
	const dir = path.dirname(outPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(outPath, JSON.stringify({
		positions: geometry.positions,
		indices: geometry.indices,
		bbox: { minWest, minNorth, maxWest, maxNorth },
		mapName
	}, null, 2));
	console.log('[recast-geometry] Wrote', outPath, 'vertices', geometry.positions.length / 3, 'triangles', geometry.indices.length / 3);
}

function getWoWClientPath() {
	const projectRoot = path.join(__dirname, '..');
	const configPath = path.join(projectRoot, 'config.json');
	if (fs.existsSync(configPath)) {
		try {
			const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			if (c.wowClientPath && fs.existsSync(c.wowClientPath)) return c.wowClientPath;
		} catch (e) {}
	}
	const wowExport = path.join(
		process.env.LOCALAPPDATA || require('os').homedir(),
		'wow.export', 'User Data', 'Default', 'config.json'
	);
	if (fs.existsSync(wowExport)) {
		try {
			const c = JSON.parse(fs.readFileSync(wowExport, 'utf8'));
			if (c.recentLocal && c.recentLocal.length > 0) {
				const t = c.recentLocal.find(i => i.product === 'wow_classic_titan');
				if (t && fs.existsSync(t.path)) return t.path;
				if (fs.existsSync(c.recentLocal[0].path)) return c.recentLocal[0].path;
			}
		} catch (e) {}
	}
	const common = ['D:\\战网\\World of Warcraft\\_classic_titan_', 'C:\\Program Files (x86)\\World of Warcraft\\_classic_titan_'];
	for (const p of common) {
		if (fs.existsSync(p) && fs.existsSync(path.join(p, '.build.info'))) return p;
	}
	return null;
}

if (require.main === module) main().catch(e => { console.error(e); process.exit(1); });

module.exports = { buildRecastGeometry, chunkToTriangles };
