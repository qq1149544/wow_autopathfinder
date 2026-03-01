/**
 * WMO geometry extraction for pathfinding.
 * Loads collision polygons from WMO groups and rasterizes them into the terrain grid.
 * Uses MOPY flags: 0x08 = collision (walkable surface).
 * Only includes upward-facing triangles (normal.y > 0.3) for floors/bridges.
 */
const ADTLoader = require('../wow.export-min/src/js/3D/loaders/ADTLoader');
const WMOLoader = require('../wow.export-min/src/js/3D/loaders/WMOLoader');

const MAP_SIZE = 64;
const MOPY_COLLISION = 0x08;
const MOPY_DETAIL = 0x04;   // Detail-only, often no collision; we skip if ONLY this is set
const MIN_NORMAL_Y = 0.2;   // Minimum upward component for floor-like surfaces (incl. ramps)

/**
 * MODF placement transform per wowdev ADT.
 * Full: Rx(r2-90)*Rz(-r0)*Ry(r1-270)*Translate*Ry(90)*Rx(90).
 * WoW world: X=north, Y=west, Z=up. We return vertices as (west, up, north).
 */
const TILE_SIZE_WMO = 533.333333333;
const MAX_SIZE = 32 * TILE_SIZE_WMO;
const DEG = Math.PI / 180;

function buildPlacementMatrix(position, rotation, scale = 1) {
	// wowdev MODF: posx = 32*TILE - position[0], posy = position[1], posz = 32*TILE - position[2]
	// Full pipeline: Rx(r2-90)*Rz(-r0)*Ry(r1-270)*Translate*Ry(90)*Rx(90)*vertex
	// Ry(90)*Rx(90) maps file (x,y,z) -> (z,x,y) => North=file_z, West=file_y, Up=file_x
	const posx = MAX_SIZE - position[0]; // North
	const posy = position[1];
	const posz = MAX_SIZE - position[2]; // West
	const [r0, r1, r2] = rotation;
	const s = (scale !== undefined && typeof scale === 'number') ? scale : 1;

	// WMOLoader (file0, file1, -file2). Identity: (north, west, up) = (x, y, z) + (posx, posz, posy).
	let m00 = 1, m01 = 0, m02 = 0;
	let m10 = 0, m11 = 1, m12 = 0;
	let m20 = 0, m21 = 0, m22 = 1;

	const rx = (r2 - 90) * DEG, ry = (r1 - 270) * DEG, rz = -r0 * DEG;
	const cx = Math.cos(rx), sx = Math.sin(rx);
	const cy = Math.cos(ry), sy = Math.sin(ry);
	const cz = Math.cos(rz), sz = Math.sin(rz);
	const r00 = cy * cz, r01 = cy * sz, r02 = -sy;
	const r10 = sx * sy * cz - cx * sz, r11 = sx * sy * sz + cx * cz, r12 = sx * cy;
	const r20 = cx * sy * cz + sx * sz, r21 = cx * sy * sz - sx * cz, r22 = cx * cy;

	const isZeroRotation = (r0 === 0 && r1 === 0 && r2 === 0);
	let b00, b01, b02, b10, b11, b12, b20, b21, b22, tx, ty, tz;
	if (isZeroRotation) {
		b00 = m00; b01 = m01; b02 = m02;
		b10 = m10; b11 = m11; b12 = m12;
		b20 = m20; b21 = m21; b22 = m22;
		tx = posx; ty = posz; tz = posy;
	} else {
		// 3x3 = R_place * R_axis, translation = R_place * (posx, posz, posy)
		b00 = r00 * m00 + r01 * m10 + r02 * m20;
		b01 = r00 * m01 + r01 * m11 + r02 * m21;
		b02 = r00 * m02 + r01 * m12 + r02 * m22;
		b10 = r10 * m00 + r11 * m10 + r12 * m20;
		b11 = r10 * m01 + r11 * m11 + r12 * m21;
		b12 = r10 * m02 + r11 * m12 + r12 * m22;
		b20 = r20 * m00 + r21 * m10 + r22 * m20;
		b21 = r20 * m01 + r21 * m11 + r22 * m21;
		b22 = r20 * m02 + r21 * m12 + r22 * m22;
		tx = r00 * posx + r01 * posz + r02 * posy;
		ty = r10 * posx + r11 * posz + r12 * posy;
		tz = r20 * posx + r21 * posz + r22 * posy;
	}

	return [
		b00 * s, b10 * s, b20 * s, 0,
		b01 * s, b11 * s, b21 * s, 0,
		b02 * s, b12 * s, b22 * s, 0,
		tx * s, ty * s, tz * s, 1
	];
}

/**
 * Tile 西北角 (west, north)。与 loadTile 文件命名一致：prefix_<tileY>_<tileX>.adt，tileIndex = tileY*64+tileX。
 * tx = tileIndex%64 = tileX (west 方向)，tz = floor(tileIndex/64) = tileY (north 方向)。
 * 瓦片 (tz,tx) 覆盖 north=[MAP_OFFSET-(tz+1)*T, MAP_OFFSET-tz*T), west=[MAP_OFFSET-(tx+1)*T, MAP_OFFSET-tx*T)。
 */
const MAP_OFFSET_WMO = 32 * TILE_SIZE_WMO;

function getTileWorldOrigin(tileIndex) {
	const tx = tileIndex % MAP_SIZE;       // tileX (west block)
	const tz = Math.floor(tileIndex / MAP_SIZE); // tileY (north block)
	const west = MAP_OFFSET_WMO - (tx + 1) * TILE_SIZE_WMO;
	const north = MAP_OFFSET_WMO - (tz + 1) * TILE_SIZE_WMO;
	return { west, north };
}

/**
 * Transform vertex by 4x4 column-major matrix.
 * Matrix rows 0,1,2 have translation posx, posy, posz. posy=height.
 * WoW: X=north, Y=west, Z=up. We need up<-posy so up gets row1.
 */
function transformVertex(m, x, y, z) {
	const north = m[0] * x + m[4] * y + m[8] * z + m[12];
	const west = m[1] * x + m[5] * y + m[9] * z + m[13];
	const up = m[2] * x + m[6] * y + m[10] * z + m[14];
	// 必须 [West, Up, North]，与 getHeightAt(innerX=West, innerZ=North) 及 barycentricHeight(px=v[0], pz=v[2]) 一致
	return [west, up, north];
}

/**
 * WDT MAID uses (row,col) = (y,x) with index = y*64+x.
 * Terrain loader uses (blockX,blockZ) with tileIndex = blockX*64+blockZ (col*64+row).
 * So for terrain tileIndex T: col=floor(T/64), row=T%64 → MAID idx = row*64+col.
 */
function terrainTileToMaidIndex(tileIndex) {
	const col = Math.floor(tileIndex / MAP_SIZE);
	const row = tileIndex % MAP_SIZE;
	return row * MAP_SIZE + col;
}

/** 是否为指定的 WMO 根文件名（排除 stormwind_XXX 等 group 文件） */
function isPreferredWmoRoot(wmoName, preferredRoots) {
	if (!preferredRoots || preferredRoots.length === 0) return true;
	const name = String(wmoName || '').replace(/\\/g, '/').toLowerCase();
	const base = name.split('/').pop() || name;
	return preferredRoots.some(r => base === r.toLowerCase());
}

/**
 * Load WDT-level world WMO placement (e.g. Stormwind city).
 */
async function loadWdtWorldWmo(casc, wdt, mapName) {
	if (!wdt || !wdt.worldModel || !wdt.worldModelPlacement) return [];
	const p = wdt.worldModelPlacement;
	const placement = {
		position: p.position,
		rotation: p.rotation,
		lowerBounds: p.lowerExtents,
		upperBounds: p.upperExtents,
		scale: p.scale ?? 1024,
		wmoName: wdt.worldModel
	};
	return [placement];
}

/**
 * Load obj ADT and return MODF entries (world model placements).
 * @param {object} casc - CASC instance
 * @param {object} wdt - WDTLoader with entries
 * @param {string} mapName - Map directory name
 * @param {number} tileIndex - bz*64+bx; MAID index = tileIndex
 */
/**
 * WDT MAID: entries[(y * 64) + x]. Our tileIndex = bz*64+bx → use tileIndex as MAID index so we load the correct tile's obj (e.g. 3102 = azeroth_48_30).
 */
async function loadObjADT(casc, wdt, mapName, tileIndex) {
	const prefix = `world/maps/${mapName}/${mapName}`;
	const prefixLower = `world/maps/${mapName.toLowerCase()}/${mapName.toLowerCase()}`;
	const tileX = tileIndex % MAP_SIZE;
	const tileY = Math.floor(tileIndex / MAP_SIZE);
	const allPlacements = [];
	const entries = wdt?.entries;
	const maidIdx = entries ? tileIndex : tileIndex;
	for (const suffix of ['obj0', 'obj1']) {
		const adtKey = suffix === 'obj0' ? 'obj0ADT' : 'obj1ADT';
		let data = null;
		if (entries) {
			const entry = entries[maidIdx];
			const fileId = entry?.[adtKey];
			if (fileId && fileId > 0) {
				try {
					data = await casc.getFile(fileId, false, true);
				} catch (e) {}
			}
		}
		if (!data) {
			for (const [ty, tx] of [[tileY, tileX], [tileX, tileY]]) {
				try {
					data = await casc.getFileByName(`${prefix}_${ty}_${tx}_${suffix}.adt`, false, true);
					break;
				} catch (e) {
					try {
						data = await casc.getFileByName(`${prefixLower}_${ty}_${tx}_${suffix}.adt`, false, true);
						break;
					} catch (e2) {}
				}
			}
		}
		if (!data) continue;
		const adt = new ADTLoader(data);
		adt.loadObj();
		if (adt.worldModels) {
			const listfile = require('../wow.export-min/src/js/casc/listfile');
			for (const wm of adt.worldModels) {
				let wmoName = null;
				if (adt.wmoNames && adt.wmoOffsets) {
					const nameOfs = adt.wmoOffsets[wm.mwidEntry];
					wmoName = nameOfs != null ? (adt.wmoNames[nameOfs] || '') : '';
				}
				if (!wmoName && (wm.flags & 0x8)) {
					wmoName = wm.mwidEntry;
				}
				if (!wmoName && adt.worldModels.length === 1) {
					wmoName = wm.mwidEntry;
				}
				// Resolve file ID to path for filtering (e.g. 107243 -> stormwind.wmo)
				if (typeof wmoName === 'number') {
					const resolved = listfile.getByID && listfile.getByID(wmoName);
					if (resolved) wmoName = resolved;
				}
				if (wmoName) allPlacements.push({ ...wm, wmoName });
			}
		}
	}
	return allPlacements;
}

/**
 * Load WMO root and all groups, extract walkable triangles.
 * @param {number|null} tileIndex - ADT tile index (bx*64+bz). If null (WDT world WMO), no tile offset applied.
 * Returns array of { vertices, normals } in world space for each placement.
 */
async function loadWmoWalkableTriangles(casc, wmoName, placement, bounds, tileIndex = null) {
	const { position, rotation, lowerBounds, upperBounds } = placement;
	// Calculate hypothesized coords
	// const max = 32 * 533.333333333;
	// const hNorth = max - position[2];
	// const hWest = max - position[0];
	// console.log(`[DEBUG] WMO ${wmoName} pos: [${position}] HypNorth: ${hNorth} HypWest: ${hWest}`);

	const tileOffset = (tileIndex != null) ? getTileWorldOrigin(tileIndex) : { west: 0, north: 0 };
	const scale = (placement.scale !== undefined ? placement.scale : 1024) / 1024;

	let wmoData;
	if (typeof wmoName === 'number') {
		try {
			wmoData = await casc.getFile(wmoName, false, true);
		} catch (e) {
			return [];
		}
	} else {
		const wmoPath = String(wmoName).replace(/\\/g, '/');
		const wmoPathLower = wmoPath.toLowerCase();
		try {
			wmoData = await casc.getFileByName(wmoPath, false, true);
		} catch (e) {
			try {
				wmoData = await casc.getFileByName(wmoPathLower, false, true);
			} catch (e2) {
				try {
					const listfile = require('../wow.export-min/src/js/casc/listfile');
					const fid = listfile.getByFilename(wmoPath) || listfile.getByFilename(wmoPathLower);
					if (fid) wmoData = await casc.getFile(fid, false, true);
				} catch (e3) {
					return [];
				}
			}
		}
	}
	if (!wmoData) return [];

		const wmo = new WMOLoader(wmoData, wmoName);
		await wmo.load();
		if (!wmo.groups) return [];

	const mat = buildPlacementMatrix(position, rotation, scale);
	const triangles = [];

	for (let gi = 0; gi < wmo.groupCount; gi++) {
		let group = wmo.groups[gi];
		if (!group) {
			try {
				group = await wmo.getGroup(gi);
			} catch (e) {
				continue;
			}
		}
		if (!group.vertices || !group.indices || !group.materialInfo) continue;
		
		const verts = group.vertices;
		const normals = group.normals || [];
		const indices = group.indices;
		const materialInfo = group.materialInfo;

		for (let ti = 0; ti < indices.length; ti += 3) {
			const i0 = indices[ti], i1 = indices[ti + 1], i2 = indices[ti + 2];
			const polyIdx = ti / 3;
			const matInfo = materialInfo[polyIdx];
			if (!matInfo) continue;
			// if (matInfo.flags & MOPY_DETAIL) continue;
			if (!(matInfo.flags & MOPY_COLLISION)) continue;

			// WMOLoader: verts = [file0, -file2, file1]. Pass as (x,y,z) to transform.
			const v0 = [verts[i0 * 3], verts[i0 * 3 + 1], verts[i0 * 3 + 2]];
			const v1 = [verts[i1 * 3], verts[i1 * 3 + 1], verts[i1 * 3 + 2]];
			const v2 = [verts[i2 * 3], verts[i2 * 3 + 1], verts[i2 * 3 + 2]];

			// Normal - only include upward-facing (floor-like) surfaces
			let ny = 0.33;
			if (normals && normals.length >= (i2 + 1) * 3) {
				const n0 = [normals[i0 * 3], normals[i0 * 3 + 1], normals[i0 * 3 + 2]];
				const n1 = [normals[i1 * 3], normals[i1 * 3 + 1], normals[i1 * 3 + 2]];
				const n2 = [normals[i2 * 3], normals[i2 * 3 + 1], normals[i2 * 3 + 2]];
				ny = (n0[1] + n1[1] + n2[1]) / 3;
			}
			// if (ny < MIN_NORMAL_Y) continue;
			
			let w0 = transformVertex(mat, v0[0], v0[1], v0[2]);
			let w1 = transformVertex(mat, v1[0], v1[1], v1[2]);
			let w2 = transformVertex(mat, v2[0], v2[1], v2[2]);
			// Apply tile world origin offset (west, north) so triangles are in game coordinates
			if (tileOffset.west !== 0 || tileOffset.north !== 0) {
				w0 = [w0[0] + tileOffset.west, w0[1], w0[2] + tileOffset.north];
				w1 = [w1[0] + tileOffset.west, w1[1], w1[2] + tileOffset.north];
				w2 = [w2[0] + tileOffset.west, w2[1], w2[2] + tileOffset.north];
			}
			triangles.push({ v0: w0, v1: w1, v2: w2 });
		}
	}
	return triangles;
}

/**
 * Rasterize WMO triangles into heightmap grid.
 * For each grid cell, if a triangle covers it, set height to interpolated Y and walkable=1.
 */
function rasterizeWmoTriangles(triangles, heights, walkable, gridWidth, gridHeight, gridMinX, gridMinZ, cellSize) {
	for (const tri of triangles) {
		const { v0, v1, v2 } = tri;
		const minX = Math.min(v0[0], v1[0], v2[0]);
		const maxX = Math.max(v0[0], v1[0], v2[0]);
		const minZ = Math.min(v0[2], v1[2], v2[2]);
		const maxZ = Math.max(v0[2], v1[2], v2[2]);
		const gx0 = Math.max(0, Math.floor((minX - gridMinX) / cellSize));
		const gx1 = Math.min(gridWidth - 1, Math.floor((maxX - gridMinX) / cellSize));
		const gz0 = Math.max(0, Math.floor((minZ - gridMinZ) / cellSize));
		const gz1 = Math.min(gridHeight - 1, Math.floor((maxZ - gridMinZ) / cellSize));

		for (let gz = gz0; gz <= gz1; gz++) {
			for (let gx = gx0; gx <= gx1; gx++) {
				const cx = gridMinX + (gx + 0.5) * cellSize;
				const cz = gridMinZ + (gz + 0.5) * cellSize;
				const h = barycentricHeight(v0, v1, v2, cx, cz);
				if (h === null) continue;
				const idx = gz * gridWidth + gx;
				if (h > heights[idx]) {
					heights[idx] = h;
					walkable[idx] = 1;
				}
			}
		}
	}
}

/**
 * Compute height at (px, pz) via barycentric interpolation if point is inside triangle.
 * Returns null if outside.
 * WoW 世界坐标为连续浮点（单位：码），无“像素网格”；放宽边缘容差可减少因浮点或贴边导致的缝隙未命中。
 */
const BARYCENTRIC_EPS = 0.01; // 重心坐标容差：允许略在边外仍算命中（原 -0.001 过严易落在“缝隙”）

function barycentricHeight(v0, v1, v2, px, pz) {
	const x0 = v0[0], z0 = v0[2];
	const x1 = v1[0], z1 = v1[2];
	const x2 = v2[0], z2 = v2[2];
	const denom = (z1 - z2) * (x0 - x2) + (x2 - x1) * (z0 - z2);
	if (Math.abs(denom) < 1e-9) return null;
	const w0 = ((z1 - z2) * (px - x2) + (x2 - x1) * (pz - z2)) / denom;
	const w1 = ((z2 - z0) * (px - x2) + (x0 - x2) * (pz - z2)) / denom;
	const w2 = 1 - w0 - w1;
	if (w0 < -BARYCENTRIC_EPS || w1 < -BARYCENTRIC_EPS || w2 < -BARYCENTRIC_EPS) return null;
	const y = w0 * v0[1] + w1 * v1[1] + w2 * v2[1];
	return y;
}

/**
 * 在 WMO 三角形列表中查询点 (px, pz) 的高度。
 * 若点在某个三角形内，返回该三角形插值得到的高度（角色站立的 WMO 地板 Z）。
 * 返回最高者（若多个三角形覆盖该点，取最高地板）。
 */
function queryWmoHeightAt(triangles, px, pz, refY = null) {
	let bestY = -Infinity;
    let minDiff = Infinity;
	let found = false;
	
	// console.log(`[DEBUG] queryWmoHeightAt: West ${px}, North ${pz} (User input North/West transformed)`);
	for (const tri of triangles) {
		const h = barycentricHeight(tri.v0, tri.v1, tri.v2, px, pz);
		if (h != null) {
            // console.log(`[DEBUG] Hit triangle! h=${h}`);
            if (refY !== null) {
                // Select closest to refY
                const diff = Math.abs(h - refY);
                if (diff < minDiff) {
                    minDiff = diff;
                    bestY = h;
                    found = true;
                }
            } else {
                // Default: Select highest
                if (h > bestY) {
                    bestY = h;
                    found = true;
                }
            }
		}
	}
	return found ? bestY : null;
}

/**
 * 诊断：在暴风城范围内写出三角形 bbox、查询点、以及若干“地板高度”三角形的顶点，用于核对坐标/变换。
 * 写入 pathfinder/wmo_diagnostic.json（仅在 options.loadWmoDebug 且为暴风城范围时调用）。
 */
function writeWmoDiagnostic(triangles, queryWest, queryNorth, options) {
	if (!options || !options.loadWmoDebug || triangles.length === 0) return;
	const inStormwind = queryWest > 800 && queryWest < 1000 && queryNorth > -9100 && queryNorth < -8900;
	if (!inStormwind) return;
	let minW = Infinity, maxW = -Infinity, minN = Infinity, maxN = -Infinity;
	const floorTris = [];
	let containingTri = null;
	for (const tri of triangles) {
		const w0 = tri.v0[0], n0 = tri.v0[2], h0 = tri.v0[1];
		const w1 = tri.v1[0], n1 = tri.v1[2], h1 = tri.v1[1];
		const w2 = tri.v2[0], n2 = tri.v2[2], h2 = tri.v2[1];
		minW = Math.min(minW, w0, w1, w2); maxW = Math.max(maxW, w0, w1, w2);
		minN = Math.min(minN, n0, n1, n2); maxN = Math.max(maxN, n0, n1, n2);
		const avgH = (h0 + h1 + h2) / 3;
		if (avgH >= 90 && avgH <= 130 && floorTris.length < 5) {
			floorTris.push({ v0: [round(w0,2), round(h0,2), round(n0,2)], v1: [round(w1,2), round(h1,2), round(n1,2)], v2: [round(w2,2), round(h2,2), round(n2,2)] });
		}
		const h = barycentricHeight(tri.v0, tri.v1, tri.v2, queryWest, queryNorth);
		if (h != null && containingTri == null) containingTri = { h, v0: [round(w0,2), round(h0,2), round(n0,2)], v1: [round(w1,2), round(h1,2), round(n1,2)], v2: [round(w2,2), round(h2,2), round(n2,2)] };
	}
	function round(x, d) { return Math.round(x * Math.pow(10, d)) / Math.pow(10, d); }
	const fs = require('fs');
	const path = require('path');
	const out = {
		queryPoint: { west: queryWest, north: queryNorth },
		triangleCount: triangles.length,
		bbox: { minWest: round(minW, 2), maxWest: round(maxW, 2), minNorth: round(minN, 2), maxNorth: round(maxN, 2) },
		queryInBbox: queryWest >= minW && queryWest <= maxW && queryNorth >= minN && queryNorth <= maxN,
		sampleFloorTriangles: floorTris,
		containingTriangle: containingTri
	};
	fs.writeFileSync(path.join(__dirname, 'wmo_diagnostic.json'), JSON.stringify(out, null, 2), 'utf8');
}

function transformNormal(m, x, y, z) {
	const north = m[0] * x + m[4] * y + m[8] * z;
	const west = m[1] * x + m[5] * y + m[9] * z;
	const up = m[2] * x + m[6] * y + m[10] * z;
	return [west, up, north];
}

module.exports = {
	loadObjADT,
	loadWdtWorldWmo,
	loadWmoWalkableTriangles,
	rasterizeWmoTriangles,
	queryWmoHeightAt,
	writeWmoDiagnostic,
	isPreferredWmoRoot,
	buildPlacementMatrix,
	transformVertex,
	transformNormal,
	getTileWorldOrigin,
	MOPY_COLLISION
};
