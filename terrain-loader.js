/**
 * WoW terrain loader - builds a heightmap from ADT files for pathfinding.
 * Uses wow.export-min's ADT/WDT loaders and CASC.
 */
const path = require('path');
const ADTLoader = require('../wow.export-min/src/js/3D/loaders/ADTLoader');
const WDTLoader = require('../wow.export-min/src/js/3D/loaders/WDTLoader');

// WoW map constants (matches wow.export-min)
const MAP_SIZE = 64;
const TILE_SIZE = (51200 / 3) / 32;
const CHUNK_SIZE = TILE_SIZE / 16;
const UNIT_SIZE = CHUNK_SIZE / 8;
const UNIT_SIZE_HALF = UNIT_SIZE / 2;

/**
 * Convert vertex index to (row, col) in the 17x9/8 MCNK layout.
 * 145 vertices: rows 0,2,4..16 have 9 cols; rows 1,3,5..15 have 8 cols.
 */
function vertexToRowCol(idx) {
	let row = 0;
	let col = 0;
	let n = idx;
	for (let r = 0; r < 17; r++) {
		const count = (r % 2) === 0 ? 9 : 8;
		if (n < count) {
			row = r;
			col = n;
			break;
		}
		n -= count;
	}
	return { row, col };
}

/**
 * Get world position (x, z, y) for a vertex in a chunk.
 * WoW: x = chunkY - col*UNIT_SIZE [- UNIT_SIZE_HALF if short row]
 *      z = chunkX - row*UNIT_SIZE_HALF
 *      y = chunkZ + vertexHeight
 */
function vertexToWorld(chunk, idx) {
	const { row, col } = vertexToRowCol(idx);
	const isShort = !!(row % 2);
	let wx = chunk.position[1] - (col * UNIT_SIZE);
	if (isShort) wx -= UNIT_SIZE_HALF;
	const wz = chunk.position[0] - (row * UNIT_SIZE_HALF);
	const wy = (chunk.vertices && chunk.vertices[idx] !== undefined)
		? chunk.vertices[idx] + chunk.position[2]
		: chunk.position[2];
	return { x: wx, y: wy, z: wz };
}

/**
 * TerrainLoader - loads ADT tiles and builds a heightmap for pathfinding.
 */
class TerrainLoader {
	constructor(casc, mapName) {
		this.casc = casc;
		this.mapName = mapName;
		this.prefix = `world/maps/${mapName}/${mapName}`;
		this.wdt = null;
		this.tiles = new Map();
		this.heightmap = null;
		this.bounds = null;
	}

	async init() {
		const wdtPath = this.prefix + '.wdt';
		const wdtPathLower = `world/maps/${this.mapName.toLowerCase()}/${this.mapName.toLowerCase()}.wdt`;
		let wdtFile;
		try {
			wdtFile = await this.casc.getFileByName(wdtPath, false, true);
		} catch (e) {
			try {
				wdtFile = await this.casc.getFileByName(wdtPathLower, false, true);
			} catch (e2) {
				throw new Error('WDT not found: ' + wdtPath + ' or ' + wdtPathLower);
			}
		}
		this.wdt = new WDTLoader(wdtFile);
		this.wdt.load();
		return this;
	}

	/**
	 * Get tile index from world coordinates (x, z).
	 * WoW: 64x64 tiles, TILE_SIZE=533.33. Uses same formula for both axes.
	 */
	getTileIndexFromWorld(worldX, worldZ) {
		const MAP_HALF = 32;
		const tx = Math.floor(MAP_HALF - worldX / TILE_SIZE);
		const tz = Math.floor(MAP_HALF - worldZ / TILE_SIZE);
		if (tx < 0 || tx >= MAP_SIZE || tz < 0 || tz >= MAP_SIZE) return -1;
		return tz * MAP_SIZE + tx;
	}

	/**
	 * Load a single ADT tile by index.
	 */
	async loadTile(tileIndex) {
		if (this.tiles.has(tileIndex)) return this.tiles.get(tileIndex);

		const tiles = this.wdt.tiles;
		if (!tiles || !tiles[tileIndex]) {
			return null;
		}

		const entries = this.wdt.entries;
		if (!entries || !entries[tileIndex] || !entries[tileIndex].rootADT) {
			return null;
		}

		const tileX = tileIndex % MAP_SIZE;
		const tileY = Math.floor(tileIndex / MAP_SIZE);
		const tilePath = `${this.prefix}_${tileY}_${tileX}.adt`;

		let rootFile;
		const tilePathLower = `world/maps/${this.mapName.toLowerCase()}/${this.mapName.toLowerCase()}_${tileY}_${tileX}.adt`;
		try {
			if (entries[tileIndex].rootADT > 0) {
				rootFile = await this.casc.getFile(entries[tileIndex].rootADT, false, true);
			} else {
				throw new Error('No rootADT');
			}
		} catch (e) {
			try {
				rootFile = await this.casc.getFileByName(tilePath, false, true);
			} catch (e2) {
				try {
					rootFile = await this.casc.getFileByName(tilePathLower, false, true);
				} catch (e3) {
					return null;
				}
			}
		}

		const rootAdt = new ADTLoader(rootFile);
		rootAdt.loadRoot();
		this.tiles.set(tileIndex, rootAdt);
		return rootAdt;
	}

	/**
	 * Build a heightmap grid for the bounding box of start and end.
	 * gridResolution: cells per chunk (e.g. 4 = 4x4 grid per MCNK)
	 */
	async buildHeightmap(startX, startZ, endX, endZ, gridResolution = 4, options = {}) {
		const minX = Math.min(startX, endX);
		const maxX = Math.max(startX, endX);
		const minZ = Math.min(startZ, endZ);
		const maxZ = Math.max(startZ, endZ);

		const padding = TILE_SIZE * 0.5;
		const loadMinX = minX - padding;
		const loadMaxX = maxX + padding;
		const loadMinZ = minZ - padding;
		const loadMaxZ = maxZ + padding;

		// WoW WDT: first index = 32 - z/533 (row), second = 32 - x/533 (col). chunk.position[1]=X, [0]=Z.
		const MAP_HALF = 32;
		const blockForXMin = Math.max(0, Math.floor(MAP_HALF - loadMaxX / TILE_SIZE));
		const blockForXMax = Math.min(63, Math.floor(MAP_HALF - loadMinX / TILE_SIZE));
		const blockForZMin = Math.max(0, Math.floor(MAP_HALF - loadMaxZ / TILE_SIZE));
		const blockForZMax = Math.min(63, Math.floor(MAP_HALF - loadMinZ / TILE_SIZE));

		const tileIndices = new Set();
		// loadTile: tileY=tileIndex/64, tileX=tileIndex%64 → prefix_<tileY>_<tileX>.adt (row=North, col=West)
		for (let bz = blockForZMin; bz <= blockForZMax; bz++) {
			for (let bx = blockForXMin; bx <= blockForXMax; bx++) {
				tileIndices.add(bz * MAP_SIZE + bx);
			}
		}
		// 暴风城：bounds 在 west≈-9000..-7000、north≈-9000..-7000 时，必须包含 stormwind.wmo 所在瓦片
		const mapLower = String(this.mapName || '').toLowerCase();
		if (mapLower === 'azeroth' && loadMinX > -9500 && loadMaxX < -6500 && loadMinZ > -9500 && loadMaxZ < -6500) {
			for (let bz = 48; bz <= 49; bz++) tileIndices.add(bz * MAP_SIZE + 30);
		}

		for (const idx of tileIndices) {
			await this.loadTile(idx);
		}

		const cellsPerChunk = gridResolution;
		const cellSize = CHUNK_SIZE / cellsPerChunk;
		const gridMinX = Math.floor(loadMinX / cellSize) * cellSize;
		const gridMinZ = Math.floor(loadMinZ / cellSize) * cellSize;
		const gridWidth = Math.ceil((loadMaxX - loadMinX) / cellSize) + 2;
		const gridHeight = Math.ceil((loadMaxZ - loadMinZ) / cellSize) + 2;

		const heights = new Float32Array(gridWidth * gridHeight);
		const walkable = new Uint8Array(gridWidth * gridHeight);
		heights.fill(-999999);
		walkable.fill(0);

		const wmoPathfinder = require('./wmo-pathfinder');
		for (const [tileIdx, rootAdt] of this.tiles) {
			if (!rootAdt || !rootAdt.chunks) continue;
			const tileOrigin = wmoPathfinder.getTileWorldOrigin(tileIdx);
			for (let ci = 0; ci < rootAdt.chunks.length; ci++) {
				const chunk = rootAdt.chunks[ci];
				if (!chunk || !chunk.vertices) continue;

				for (let vi = 0; vi < 145; vi++) {
					const w = vertexToWorld(chunk, vi);
					const wx = w.x + tileOrigin.west;
					const wz = w.z + tileOrigin.north;
					const gx = Math.floor((wx - gridMinX) / cellSize);
					const gz = Math.floor((wz - gridMinZ) / cellSize);
					if (gx < 0 || gx >= gridWidth || gz < 0 || gz >= gridHeight) continue;

					const idx = gz * gridWidth + gx;
					if (w.y > heights[idx]) {
						heights[idx] = w.y;
						walkable[idx] = 1;
					}
				}
			}
		}

		// Rasterize WMO collision geometry (bridges, plazas, streets)
		if (options.wmo !== false) {
			const wmoPathfinder = require('./wmo-pathfinder');
			const bounds = { minX: loadMinX, maxX: loadMaxX, minZ: loadMinZ, maxZ: loadMaxZ };
			const preferredRoots = options.preferredWmoRoots || [];
			let wmoPlacementCount = 0;
			// WDT-level world WMO (e.g. Stormwind city)
			const wdtPlacements = await wmoPathfinder.loadWdtWorldWmo(this.casc, this.wdt, this.mapName);
			for (const placement of wdtPlacements) {
				if (!wmoPathfinder.isPreferredWmoRoot(placement.wmoName, preferredRoots)) continue;
				wmoPlacementCount++;
				const triangles = await wmoPathfinder.loadWmoWalkableTriangles(
					this.casc, placement.wmoName, placement, bounds, null
				);
				wmoPathfinder.rasterizeWmoTriangles(
					triangles, heights, walkable,
					gridWidth, gridHeight, gridMinX, gridMinZ, cellSize
				);
			}
			for (const tileIdx of tileIndices) {
				const placements = await wmoPathfinder.loadObjADT(this.casc, this.wdt, this.mapName, tileIdx);
				for (const placement of placements) {
					if (!wmoPathfinder.isPreferredWmoRoot(placement.wmoName, preferredRoots)) continue;
					wmoPlacementCount++;
					const triangles = await wmoPathfinder.loadWmoWalkableTriangles(
						this.casc, placement.wmoName, placement, bounds, tileIdx
					);
					wmoPathfinder.rasterizeWmoTriangles(
						triangles, heights, walkable,
						gridWidth, gridHeight, gridMinX, gridMinZ, cellSize
					);
				}
			}
			if (options.debugWmo && preferredRoots.length > 0) {
				console.log('[terrain] WMO placements used (stormwind.wmo/stormwindharbor.wmo):', wmoPlacementCount);
			}
		}

		// Rasterize liquid (MH2O) as unwalkable
		if (options.liquid !== false) {
			for (const [tileIdx, rootAdt] of this.tiles) {
				if (!rootAdt.liquidChunks || !rootAdt.chunks) continue;
				const tileOrigin = wmoPathfinder.getTileWorldOrigin(tileIdx);
				for (let ci = 0; ci < rootAdt.liquidChunks.length; ci++) {
					const liqChunk = rootAdt.liquidChunks[ci];
					const terrainChunk = rootAdt.chunks[ci];
					if (!liqChunk || !liqChunk.instances || !terrainChunk || !terrainChunk.position) continue;
					const pos = terrainChunk.position; // [Z, X, Y] WoW
					for (const inst of liqChunk.instances) {
						if (!inst || !inst.bitmap) continue;
						const w = inst.width || 8;
						const h = inst.height || 8;
						const xOff = inst.xOffset || 0;
						const yOff = inst.yOffset || 0;
						const totalBits = w * h;
						for (let i = 0; i < totalBits; i++) {
							const byteIdx = i >>> 3;
							if (byteIdx >= inst.bitmap.length) break;
							if (!((inst.bitmap[byteIdx] >>> (i & 7)) & 1)) continue;
							const ix = i % w;
							const iy = (i / w) | 0;
							const worldWest = tileOrigin.west + pos[1] - (xOff + ix + 0.5) * UNIT_SIZE;
							const worldNorth = tileOrigin.north + pos[0] - (yOff + iy + 0.5) * UNIT_SIZE;
							const gx = Math.floor((worldWest - gridMinX) / cellSize);
							const gz = Math.floor((worldNorth - gridMinZ) / cellSize);
							if (gx >= 0 && gx < gridWidth && gz >= 0 && gz < gridHeight) {
								const idx = gz * gridWidth + gx;
								walkable[idx] = 0;
							}
						}
					}
				}
			}
		}

		// Fill only small gaps (no vertex/WMO sampled) - 2 passes to avoid creating walkable paths through walls.
		// Requires 4+ neighbors so we only fill single-cell holes, not propagate through buildings.
		for (let pass = 0; pass < 2; pass++) {
			for (let gz = 0; gz < gridHeight; gz++) {
				for (let gx = 0; gx < gridWidth; gx++) {
					const idx = gz * gridWidth + gx;
					if (heights[idx] > -999999) continue;

					let sum = 0;
					let count = 0;
					for (let dz = -1; dz <= 1; dz++) {
						for (let dx = -1; dx <= 1; dx++) {
							if (dx === 0 && dz === 0) continue;
							const nx = gx + dx;
							const nz = gz + dz;
							if (nx < 0 || nx >= gridWidth || nz < 0 || nz >= gridHeight) continue;
							const nidx = nz * gridWidth + nx;
							if (heights[nidx] > -999999) {
								sum += heights[nidx];
								count++;
							}
						}
					}
					// Only fill when 4+ neighbors - single-cell gaps in terrain, not walls between streets
					if (count >= 4) {
						heights[idx] = sum / count;
						walkable[idx] = 1;
					}
				}
			}
		}

		this.heightmap = {
			heights,
			walkable,
			gridWidth,
			gridHeight,
			cellSize,
			gridMinX,
			gridMinZ
		};
		this.bounds = { minX: gridMinX, maxX: gridMinX + gridWidth * cellSize, minZ: gridMinZ, maxZ: gridMinZ + gridHeight * cellSize };
		return this.heightmap;
	}

	/**
	 * 加载指定区域内的 WMO 可行走三角形（用于直接点查询，获取 WMO 地板高度）。
	 * @returns {Promise<Array<{v0,v1,v2}>|null>}
	 */
	async loadWmoTrianglesForArea(minX, minZ, maxX, maxZ, options = {}) {
		await this.init();
		const MAP_HALF = 32;
		const blockForXMin = Math.max(0, Math.floor(MAP_HALF - maxX / TILE_SIZE));
		const blockForXMax = Math.min(63, Math.floor(MAP_HALF - minX / TILE_SIZE));
		const blockForZMin = Math.max(0, Math.floor(MAP_HALF - maxZ / TILE_SIZE));
		const blockForZMax = Math.min(63, Math.floor(MAP_HALF - minZ / TILE_SIZE));
		// loadTile(i): tileX=i%64, tileY=floor(i/64) → prefix_<tileY>_<tileX>.adt；块 (bx,bz) 对应 azeroth_<bz>_<bx>.adt → tileIndex = bz*64+bx
		const tileIndices = new Set();
		for (let bz = blockForZMin; bz <= blockForZMax; bz++) {
			for (let bx = blockForXMin; bx <= blockForXMax; bx++) {
				tileIndices.add(bz * 64 + bx);
			}
		}
		// 暴风城：同上约定，stormwind 在 (bx=30, bz=48..49) → tileIndex = bz*64+30
		const mapLower = String(this.mapName || '').toLowerCase();
		if (mapLower === 'azeroth' && minX > -9500 && maxX < -6500 && minZ > -9500 && maxZ < -6500) {
			for (let bz = 48; bz <= 49; bz++) tileIndices.add(bz * 64 + 30);
		}
		const wmoPathfinder = require('./wmo-pathfinder');
		const bounds = { minX, maxX, minZ, maxZ };
		const preferredRoots = options.preferredWmoRoots || [];
		const allTriangles = [];

		// WDT-level world WMO (e.g. Stormwind city for Azeroth) — Azeroth WDT has no MWMO/MODF; stormwind comes from ADT obj
		const wdtPlacements = await wmoPathfinder.loadWdtWorldWmo(this.casc, this.wdt, this.mapName);
		for (const p of wdtPlacements) {
			if (!wmoPathfinder.isPreferredWmoRoot(p.wmoName, preferredRoots)) continue;
			const tris = await wmoPathfinder.loadWmoWalkableTriangles(this.casc, p.wmoName, p, bounds, null);
			allTriangles.push(...tris);
		}

		for (const tileIdx of tileIndices) {
			await this.loadTile(tileIdx);
			const placements = await wmoPathfinder.loadObjADT(this.casc, this.wdt, this.mapName, tileIdx);
			let tileTriCount = 0;
			for (const p of placements) {
				if (!wmoPathfinder.isPreferredWmoRoot(p.wmoName, preferredRoots)) continue;
				const tris = await wmoPathfinder.loadWmoWalkableTriangles(this.casc, p.wmoName, p, bounds, tileIdx);
				tileTriCount += tris.length;
				allTriangles.push(...tris);
			}
			if (options.loadWmoDebug && minX > -9500 && maxX < -6500 && placements.length > 0) {
				const stormwind = placements.filter(p => String(p.wmoName || '').toLowerCase().includes('stormwind'));
				console.warn(`[loadWmo] tile ${tileIdx} (${tileIdx % 64},${(tileIdx / 64) | 0}) placements=${placements.length} stormwind=${stormwind.length} triangles=${tileTriCount}`);
			}
		}
		return allTriangles;
	}

	/**
	 * Convert world (x, z) to grid (gx, gz).
	 */
	worldToGrid(x, z) {
		const h = this.heightmap;
		if (!h) return null;
		const gx = Math.floor((x - h.gridMinX) / h.cellSize);
		const gz = Math.floor((z - h.gridMinZ) / h.cellSize);
		return { gx, gz };
	}

	/**
	 * Convert grid (gx, gz) to world (x, z, y).
	 */
	gridToWorld(gx, gz) {
		const h = this.heightmap;
		if (!h) return null;
		const x = h.gridMinX + (gx + 0.5) * h.cellSize;
		const z = h.gridMinZ + (gz + 0.5) * h.cellSize;
		const idx = gz * h.gridWidth + gx;
		const y = (idx >= 0 && idx < h.heights.length && h.heights[idx] > -999999) ? h.heights[idx] : 0;
		return { x, y, z };
	}

	getHeightAtGrid(gx, gz) {
		const h = this.heightmap;
		if (!h) return null;
		const idx = gz * h.gridWidth + gx;
		if (idx < 0 || idx >= h.heights.length) return null;
		return h.heights[idx];
	}

	/**
	 * 根据世界坐标 (x, z) 获取地面高度。需先 buildHeightmap 包含该点。
	 * 内部格式：x=西, z=北。radius 为采样半径（格数），取周围最高值以覆盖 WMO 边缘。
	 */
	getHeightAtWorld(worldX, worldZ, radius = 2) {
		const grid = this.worldToGrid(worldX, worldZ);
		if (!grid) return null;
		let best = null;
		for (let dz = -radius; dz <= radius; dz++) {
			for (let dx = -radius; dx <= radius; dx++) {
				const h = this.getHeightAtGrid(grid.gx + dx, grid.gz + dz);
				if (h != null && h > -999999 && (best == null || h > best)) best = h;
			}
		}
		return best;
	}

	isWalkable(gx, gz) {
		const h = this.heightmap;
		if (!h) return false;
		const idx = gz * h.gridWidth + gx;
		if (idx < 0 || idx >= h.walkable.length) return false;
		return h.walkable[idx] !== 0 && h.heights[idx] > -999999;
	}
}

module.exports = {
	TerrainLoader,
	TILE_SIZE,
	CHUNK_SIZE,
	UNIT_SIZE,
	vertexToWorld,
	vertexToRowCol
};
