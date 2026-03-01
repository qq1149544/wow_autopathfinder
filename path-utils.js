/**
 * Path planning utilities for navmesh routes.
 * Used to enforce "不允许回退直线" (no backtracking along the same straight line).
 *
 * 禁止卡点：仅移除「同一直线回退」与「朝起点方向倒退」的点；不做任何会切角、穿墙的简化，
 * 不删除窄道、转角处的必要路径点。
 *
 * References:
 * - TrinityCore/recastnavigation (Detour findStraightPath / string pulling)
 * - AmeisenNavigation (straight path, smooth path)
 * - recast-navigation-js (computePath = findPath + findStraightPath)
 */

/** @typedef {{ x: number, y: number, z: number }} Vec3 */

/**
 * Squared distance between two points (any shape with x,y,z).
 * @param {Vec3} a
 * @param {Vec3} b
 * @returns {number}
 */
function distSq(a, b) {
	const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
	return dx * dx + dy * dy + dz * dz;
}

/**
 * Dot product of vectors (b - a) and (c - b).
 * @param {Vec3} a
 * @param {Vec3} b
 * @param {Vec3} c
 * @returns {number}
 */
function dotSegments(a, b, c) {
	const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
	const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
	return v1x * v2x + v1y * v2y + v1z * v2z;
}

/**
 * Squared magnitude of cross product of (b-a) and (c-b).
 * Zero when collinear.
 * @param {Vec3} a
 * @param {Vec3} b
 * @param {Vec3} c
 * @returns {number}
 */
function crossSegmentsSq(a, b, c) {
	const v1x = b.x - a.x, v1y = b.y - a.y, v1z = b.z - a.z;
	const v2x = c.x - b.x, v2y = c.y - b.y, v2z = c.z - b.z;
	const cx = v1y * v2z - v1z * v2y;
	const cy = v1z * v2x - v1x * v2z;
	const cz = v1x * v2y - v1y * v2x;
	return cx * cx + cy * cy + cz * cz;
}

/**
 * Remove path points that cause backtracking along the same straight line.
 * If we have A -> B -> C and the segment B->C goes back toward A on the same line,
 * B is removed so the path becomes A -> C (no straight-line backtrack).
 *
 * @param {Array<Vec3>} path - Array of { x, y, z } waypoints (game or recast coords).
 * @param {Object} [opts]
 * @param {number} [opts.collinearEps=1e-6] - Max squared cross product (relative to len^4) to consider segments collinear.
 * @param {number} [opts.oppositeEps=-1e-6] - Dot product below this (negative) to consider direction reversed.
 * @returns {Array<Vec3>} New path with no straight-line backtrack (may be same array if no change).
 */
function removeBacktrackSegments(path, opts = {}) {
	if (!path || path.length <= 2) return path ? [...path] : [];

	const collinearEps = opts.collinearEps ?? 1e-6;
	const oppositeEps = opts.oppositeEps ?? -1e-6;

	const result = [path[0]];
	let last = 0;

	for (let i = 1; i < path.length - 1; i++) {
		const A = result[last];
		const B = path[i];
		const C = path[i + 1];

		const dot = dotSegments(A, B, C);
		const crossSq = crossSegmentsSq(A, B, C);
		const len1Sq = distSq(A, B);
		const len2Sq = distSq(B, C);

		// Collinear: cross product squared small relative to (|v1||v2|)^2
		const refSq = len1Sq * len2Sq;
		const isCollinear = refSq <= 0 || crossSq <= collinearEps * Math.max(refSq, 1);
		// Backtrack: opposite direction
		const isBacktrack = dot < oppositeEps;

		if (isCollinear && isBacktrack) {
			// Skip B: we're going A->B then B->C with C back toward A on same line
			continue;
		}
		result.push(B);
		last++;
	}

	result.push(path[path.length - 1]);
	return result;
}

/**
 * Ensure path has monotonically non-decreasing progress toward goal (by projection on start->end).
 * Removes any point that goes "backward" toward start. Complements removeBacktrackSegments
 * for cases where the path zigzags and then comes back along a different line.
 *
 * @param {Array<Vec3>} path - Array of { x, y, z } waypoints.
 * @returns {Array<Vec3>} Path with no backward progress (start and end always kept).
 */
function removeBackwardProgress(path) {
	if (!path || path.length <= 2) return path ? [...path] : [];

	const start = path[0];
	const end = path[path.length - 1];
	const dx = end.x - start.x, dy = end.y - start.y, dz = end.z - start.z;
	const lenSq = dx * dx + dy * dy + dz * dz;
	if (lenSq < 1e-12) return [...path];

	const result = [path[0]];
	let maxProj = 0;

	for (let i = 1; i < path.length - 1; i++) {
		const p = path[i];
		const px = p.x - start.x, py = p.y - start.y, pz = p.z - start.z;
		const proj = (px * dx + py * dy + pz * dz) / lenSq;
		if (proj >= maxProj - 1e-6) {
			maxProj = Math.max(maxProj, proj);
			result.push(p);
		}
	}
	result.push(path[path.length - 1]);
	return result;
}

/**
 * Apply both: remove straight-line backtrack segments, then remove any backward progress.
 * Use this as the single post-process for navmesh paths to enforce 不允许回退直线.
 * When fullPathFidelity is true, only remove collinear backtrack (no removeBackwardProgress)
 * so the path keeps all corners and does not cut through obstacles.
 *
 * @param {Array<Vec3>} path - Array of { x, y, z } waypoints.
 * @param {Object} [opts] - Options for removeBacktrackSegments; fullPathFidelity: skip removeBackwardProgress.
 * @returns {Array<Vec3>}
 */
function sanitizePathNoBacktrack(path, opts = {}) {
	if (!path || path.length === 0) return path ? [] : [];
	if (path.length <= 2) return [...path];
	let out = removeBacktrackSegments(path, opts);
	if (!opts.fullPathFidelity) out = removeBackwardProgress(out);
	return out;
}

/**
 * 判断路径在水平面 (x,y) 上是否近似为一条直线（所有中间点共线，忽略 z 高度）。
 * 用于禁止将“水平直线”当作有效寻路结果（仅高度变化不算绕障）。
 * @param {Array<Vec3>} path - 路径点数组 (game coords: x=north, y=west, z=height)
 * @param {Object} [opts]
 * @param {number} [opts.collinearEps=1e-6] - 相对 (len^4) 的叉积平方阈值
 * @param {number} [opts.minPoints=3] - 至少需要几个点才做检测
 * @returns {boolean} true 表示水平面为直线，应拒绝
 */
function isPathEffectivelyStraight2D(path, opts = {}) {
	if (!path || path.length < (opts.minPoints ?? 3)) return false;
	const collinearEps = opts.collinearEps ?? 1e-6;
	const a = path[0];
	const b = path[path.length - 1];
	for (let i = 1; i < path.length - 1; i++) {
		const c = path[i];
		// 2D 叉积 (仅 x,y = north, west)，忽略 z
		const v1x = c.x - a.x, v1y = c.y - a.y;
		const v2x = b.x - c.x, v2y = b.y - c.y;
		const cross = v1x * v2y - v1y * v2x;
		const crossSq = cross * cross;
		const len1Sq = v1x * v1x + v1y * v1y;
		const len2Sq = v2x * v2x + v2y * v2y;
		const refSq = len1Sq * len2Sq;
		if (refSq > 0 && crossSq > collinearEps * Math.max(refSq, 1))
			return false;
	}
	return true;
}

/**
 * 判断路径是否近似为一条直线（所有中间点共线）。用于禁止将“直线”当作有效寻路结果。
 * 使用 3D 叉积，高度变化会使结果非共线；若只需水平面直线判定请用 isPathEffectivelyStraight2D。
 * @param {Array<Vec3>} path - 路径点数组 (game coords: x=north, y=west, z=height)
 * @param {Object} [opts]
 * @param {number} [opts.collinearEps=1e-6] - 相对 (len^4) 的叉积平方阈值，低于则视为共线
 * @param {number} [opts.minPoints=3] - 至少需要几个点才做检测（少于则不算直线）
 * @returns {boolean} true 表示路径可视为直线，应拒绝
 */
function isPathEffectivelyStraight(path, opts = {}) {
	if (!path || path.length < (opts.minPoints ?? 3)) return false;
	const collinearEps = opts.collinearEps ?? 1e-6;
	const a = path[0];
	const b = path[path.length - 1];
	for (let i = 1; i < path.length - 1; i++) {
		const c = path[i];
		const crossSq = crossSegmentsSq(a, c, b);
		const len1Sq = distSq(a, c);
		const len2Sq = distSq(c, b);
		const refSq = len1Sq * len2Sq;
		if (refSq > 0 && crossSq > collinearEps * Math.max(refSq, 1))
			return false;
	}
	return true;
}

module.exports = {
	removeBacktrackSegments,
	removeBackwardProgress,
	sanitizePathNoBacktrack,
	isPathEffectivelyStraight,
	isPathEffectivelyStraight2D,
	distSq,
	dotSegments,
	crossSegmentsSq,
};
