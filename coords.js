/**
 * 统一坐标转换，供 export-map-region、export-wmo-markers-glb、pathfinder 共用。
 *
 * 约定（与 cli gameCoordsToPathfinder 一致）：
 * - 游戏/UnitPosition: (x, y, z) = (north, west, 高度)
 * - 世界/terrain: (west, north, up) = (x, z, y) 其中 x=west, z=north
 * - glTF Y-up: [north, up, west] = [gameX, height, gameY]
 *
 * 若游戏使用 Y=东（如部分 API）：west = -gameY
 */
const TILE_SIZE = (51200 / 3) / 32;
const MAP_OFFSET = 32 * TILE_SIZE;

/**
 * 游戏坐标 (x,y) → 世界 (north, west)。
 * @param {{x:number, y:number}} pt - 游戏 x=north, y=west（默认）
 * @param {boolean} yIsEast - 若 true，则 west=-y（Y 表示东）
 * @param {number} [offsetWest=0] - 世界 west 偏移（子地图坐标校正，如暴风城约 -9058）
 * @param {number} [offsetNorth=0] - 世界 north 偏移
 */
function gameToWorld(pt, yIsEast = false, offsetWest = 0, offsetNorth = 0) {
	return {
		north: pt.x + offsetNorth,
		west: (yIsEast ? -pt.y : pt.y) + offsetWest
	};
}

/**
 * 原始高度 → 游戏 z 坐标。
 * 当 ADT/WMO 高度与游戏 UnitPosition 存在固定偏差时使用。
 * @param {number} rawHeight - 从 terrain/WMO 查询得到的原始高度
 * @param {number} [offsetHeight=0] - 偏移量（如暴风城地形 ~59 vs 游戏 ~106，可设 +47）
 */
function rawHeightToGameZ(rawHeight, offsetHeight = 0) {
	if (rawHeight == null || !Number.isFinite(rawHeight)) return rawHeight;
	return rawHeight + offsetHeight;
}

/**
 * 世界 (west, north) → 瓦片 (tx, tz)。与 export-map-region worldToTile 一致。
 */
function worldToTile(west, north) {
	const tx = Math.floor(32 - west / TILE_SIZE);
	const tz = Math.floor(32 - north / TILE_SIZE);
	return { tx, tz };
}

/**
 * 世界坐标 → 瓦片内 UV [0,1]。纹理 row0=北(顶)，col0=西(左)。
 */
function worldToTileUV(west, north, tx, tz) {
	const westMin = MAP_OFFSET - (tx + 1) * TILE_SIZE;
	const westMax = MAP_OFFSET - tx * TILE_SIZE;
	const northMin = MAP_OFFSET - (tz + 1) * TILE_SIZE;
	const northMax = MAP_OFFSET - tz * TILE_SIZE;
	const u = Math.max(0, Math.min(1, (west - westMin) / (westMax - westMin)));
	const v = Math.max(0, Math.min(1, (northMax - north) / (northMax - northMin)));
	return { u, v };
}

/**
 * 世界 (west, north, up) → glTF 位置 [north, up, west]。
 */
function worldToGlTF(west, up, north) {
	return [north, up, west];
}

module.exports = {
	TILE_SIZE,
	MAP_OFFSET,
	gameToWorld,
	rawHeightToGameZ,
	worldToTile,
	worldToTileUV,
	worldToGlTF
};
