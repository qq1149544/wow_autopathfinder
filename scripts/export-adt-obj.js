#!/usr/bin/env node
/**
 * 自实现 ADT 导出：地形 OBJ + WMO/M2 OBJ + 放置 CSV。
 * 严格照抄 wow.export-main (https://github.com/Kruithne/wow.export) 的 ADTExporter 导出逻辑：
 * - 地形：chunk 顺序 chunkIndex=(x*16)+y，position[0]=north,[1]=west,[2]=height；
 *   vx=position[1]-col*UNIT_SIZE, vy=vertices[idx]+position[2], vz=position[0]-row*UNIT_SIZE_HALF（即 west, height, north）；
 *   WDT 瓦片索引与 wow.export 一致：wdtTileIndex = tx*64+tz（tileY_tileX 对应 tileY=tx, tileX=tz）；
 *   三角形用与 ADTExporter 相同的 holes 循环与索引 (indOfs+j, indOfs±8, indOfs±9)。
 * - 文件名：与 wow.export 一致 adt_<tileY>_<tileX>.obj / adt_<tileY>_<tileX>_ModelPlacementInformation.csv（tileID = tileY_tileX）。
 * - 地形顶点：必须与 wow.export 导出的 OBJ 逐顶点一致（v 行 = west, height, north），不得加 tile 偏移；MCNK position 已是世界坐标。
 * - CSV：与 wow.export 一致写 raw 的 position[0],[1],[2] 与 rotation、scale/1024（不写世界坐标）。
 *
 * 数据源与缓存：
 * - 默认使用项目内缓存：<项目>/wow.export-min/cache/casc（不依赖 wow.export 安装版）。
 * - wow.export 安装版缓存位于 %LOCALAPPDATA%\wow.export\User Data\Default\casc；若需与安装版导出结果对比，可设置环境变量 WOW_EXPORT_MIN_USE_APPDATA=1 后运行以共用该缓存。
 *
 * 用法:
 *   node pathfinder/scripts/export-adt-obj.js --map kalimdor --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73 [--out-dir pathfinder/exports/adt-objs] [--margin 2]
 * 坐标: --from/--to 为 北 西 高（游戏 x=北, y=西, z=高）
 */
const path = require('path');
const fs = require('fs');

const MAP_SIZE = 64;
const MAP_HALF = 32;
const TILE_SIZE = (51200 / 3) / 32;
const CHUNK_SIZE = TILE_SIZE / 16;
const UNIT_SIZE = CHUNK_SIZE / 8;
const UNIT_SIZE_HALF = UNIT_SIZE / 2;
/** MODF/MDDF 转世界坐标：与 wmo-pathfinder buildPlacementMatrix 一致，32*TILE */
const MAX_SIZE_MODF = 32 * TILE_SIZE;

const { TerrainLoader } = require('../terrain-loader');
const wmoPathfinder = require('../wmo-pathfinder');
const { exportRegionMapPng } = require('../export-map-markers-2d');

/** 世界坐标 (北,西) 与 margin 圈数 → 瓦片 ID 集合 (tz_tx)；与 export-route-geometry / loadTile 一致：tx=west, tz=north → tileID=tz_tx */
function getTileIdsForRoute(fromNorth, fromWest, toNorth, toWest, margin = 2) {
	const minWest = Math.min(fromWest, toWest);
	const maxWest = Math.max(fromWest, toWest);
	const minNorth = Math.min(fromNorth, toNorth);
	const maxNorth = Math.max(fromNorth, toNorth);
	const txMin = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - maxWest / TILE_SIZE)));
	const txMax = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - minWest / TILE_SIZE)));
	const tzMin = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - maxNorth / TILE_SIZE)));
	const tzMax = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(MAP_HALF - minNorth / TILE_SIZE)));
	const txLo = Math.max(0, txMin - margin);
	const txHi = Math.min(MAP_SIZE - 1, txMax + margin);
	const tzLo = Math.max(0, tzMin - margin);
	const tzHi = Math.min(MAP_SIZE - 1, tzMax + margin);
	const ids = new Set();
	for (let tz = tzLo; tz <= tzHi; tz++) {
		for (let tx = txLo; tx <= txHi; tx++) {
			ids.add(tz + '_' + tx);
		}
	}
	return ids;
}

function rowColToVertexIndex(row, col) {
	const countPerRow = (row % 2) === 0 ? 9 : 8;
	if (col < 0 || col >= countPerRow) return -1;
	let start = 0;
	for (let r = 0; r < row; r++) start += (r % 2) === 0 ? 9 : 8;
	return start + col;
}

/**
 * 与 wow.export-main ADTExporter 完全一致的地形网格构建（见 ADTExporter.js 约 328–556 行）：
 * - chunk 顺序：chunkIndex = (x*16)+y，chunk = rootAdt.chunks[chunkIndex]
 * - chunkX=chunk.position[0], chunkY=chunk.position[1], chunkZ=chunk.position[2]
 * - 顶点：vx=chunkY-col*UNIT_SIZE[, -UNIT_SIZE_HALF], vy=chunk.vertices[idx]+chunkZ, vz=chunkX-row*UNIT_SIZE_HALF → OBJ 输出 (vx,vy,vz)=(west, height, north)
 * - MCNK position：文件中为 (north, west, height) 时 position[0]=north, position[1]=west；若为 (west, north, height) 则用 chunkX=position[1], chunkY=position[0] 使 vx=west, vz=north
 * - 三角形：与 ADTExporter 相同的 holes 循环 (j=9..144, xx/yy)，includeHoles=false 时不跳过洞格，索引 (indOfs+j, indOfs±8, indOfs±9) 四三角形
 * - 坐标：与 wow.export 完全一致，直接使用 MCNK chunk.position[0/1/2] 计算顶点，不加任何 tile 偏移；position 在 ADT 中已是世界/地图坐标，导出 OBJ 与 wow.export 逐顶点一致。
 */
function buildTileMesh(rootAdt) {
	const allPositions = [];
	const allNormals = [];
	const allUvs = [];
	const allIndices = [];
	const chunks = rootAdt.chunks || [];
	// 与 wow.export-main 一致：chunkIndex = (x*16)+y
	function getChunkAt(x, y) {
		const chunkIndex = (x * 16) + y;
		return chunks[chunkIndex] || null;
	}
	const firstChunk = getChunkAt(0, 0) || chunks[0] || null;
	// UV：vx=west=position[1], vz=north=position[0]，与 wow.export 一致
	const firstChunkX = firstChunk && firstChunk.position ? firstChunk.position[1] : 0;
	const firstChunkY = firstChunk && firstChunk.position ? firstChunk.position[0] : 0;
	const includeHoles = false; // 与 wow.export mapsIncludeHoles=false 一致，不按洞跳过
	let ofs = 0;

	for (let x = 0, midX = 0; x < 16; x++) {
		for (let y = 0; y < 16; y++) {
			const chunkIndex = (x * 16) + y;
			const chunk = getChunkAt(x, y);
			if (!chunk || !chunk.position) {
				for (let k = 0; k < 145; k++) {
					allPositions.push(0, 0, 0);
					allNormals.push(0, 1, 0);
					allUvs.push(0, 0);
				}
				ofs += 145;
				midX += 145;
				continue;
			}
			// 与 wow.export 一致：同一 WDT 瓦片下 MCNK position 为 (north, west, height)，即 position[0]=north, position[1]=west。
			// 故 vx=chunkY-...=west, vz=chunkX-...=north，输出 (west, height, north)
			const chunkX = chunk.position[0]; // north
			const chunkY = chunk.position[1]; // west
			const chunkZ = chunk.position[2]; // height base
			if (!chunk.vertices || chunk.vertices.length !== 145) {
				throw new Error(`Chunk (${x},${y}) missing MCVT .vertices (length ${chunk.vertices ? chunk.vertices.length : 0}); root ADT must be parsed with MCVT to match wow.export height.`);
			}
			const chunkNormals = chunk.normals;

			for (let row = 0, idx = 0; row < 17; row++) {
				const isShort = !!(row % 2);
				const colCount = isShort ? 8 : 9;
				for (let col = 0; col < colCount; col++) {
					let vx = chunkY - (col * UNIT_SIZE);
					if (isShort) vx -= UNIT_SIZE_HALF;
					const vy = chunk.vertices[idx] + chunkZ;
					const vz = chunkX - (row * UNIT_SIZE_HALF);

					allPositions.push(vx, vy, vz);
					if (chunkNormals && chunkNormals[idx]) {
						const n = chunkNormals[idx];
						allNormals.push(n[0] / 127, n[1] / 127, n[2] / 127);
					} else {
						allNormals.push(0, 1, 0);
					}
					const uRaw = -(vx - firstChunkX) / TILE_SIZE;
					const vRaw = (vz - firstChunkY) / TILE_SIZE;
					allUvs.push(uRaw, vRaw);
					idx++;
					midX++;
				}
			}

			// 与 wow.export-main ADTExporter 完全一致的三角形循环（holes 索引）
			const holesHighRes = chunk.holesHighRes;
			for (let j = 9, xx = 0, yy = 0; j < 145; j++, xx++) {
				if (xx >= 8) {
					xx = 0;
					yy++;
				}
				let isHole = true;
				if (includeHoles === true) {
					if (!(chunk.flags & 0x10000)) {
						const current = Math.trunc(Math.pow(2, Math.floor(xx / 2) + Math.floor(yy / 2) * 4));
						if (!(chunk.holesLowRes & current)) isHole = false;
					} else {
						if (holesHighRes && !((holesHighRes[yy] >> xx) & 1)) isHole = false;
					}
				} else {
					isHole = false;
				}
				if (!isHole) {
					const indOfs = ofs + j;
					allIndices.push(indOfs, indOfs - 9, indOfs + 8);
					allIndices.push(indOfs, indOfs - 8, indOfs - 9);
					allIndices.push(indOfs, indOfs + 9, indOfs - 8);
					allIndices.push(indOfs, indOfs + 8, indOfs + 9);
				}
				if (!((j + 1) % (9 + 8)))
					j += 9;
			}
			ofs = midX;
		}
	}

	return { positions: allPositions, normals: allNormals, uvs: allUvs.length ? allUvs : null, indices: allIndices };
}

function writeObjFile(filePath, positions, indices, normals, uvs) {
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const lines = ['# ADT terrain (west, height, north)'];
	for (let i = 0; i < positions.length; i += 3) {
		lines.push('v ' + positions[i] + ' ' + positions[i + 1] + ' ' + positions[i + 2]);
	}
	if (normals && normals.length === positions.length) {
		for (let i = 0; i < normals.length; i += 3) {
			lines.push('vn ' + normals[i] + ' ' + normals[i + 1] + ' ' + normals[i + 2]);
		}
	}
	if (uvs && uvs.length >= (positions.length / 3) * 2) {
		for (let i = 0; i < uvs.length; i += 2) {
			lines.push('vt ' + uvs[i] + ' ' + uvs[i + 1]);
		}
	}
	const hasNormals = normals && normals.length === positions.length;
	const hasUvs = uvs && uvs.length >= (positions.length / 3) * 2;
	for (let i = 0; i < indices.length; i += 3) {
		const a = indices[i] + 1, b = indices[i + 1] + 1, c = indices[i + 2] + 1;
		if (hasUvs && hasNormals) {
			lines.push('f ' + a + '/' + a + '/' + a + ' ' + b + '/' + b + '/' + b + ' ' + c + '/' + c + '/' + c);
		} else if (hasNormals) {
			lines.push('f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c);
		} else {
			lines.push('f ' + a + ' ' + b + ' ' + c);
		}
	}
	fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

/** 转义 CSV 字段（分号分隔、含引号时双写） */
function escapeCsv(v) {
	if (v == null) return '';
	const s = String(v);
	if (/[;"\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
	return s;
}

const CSV_HEADERS = 'ModelFile;PositionX;PositionY;PositionZ;RotationX;RotationY;RotationZ;RotationW;ScaleFactor;ModelId;Type;FileDataID;DoodadSetIndexes;DoodadSetNames;LowerBoundX;LowerBoundY;LowerBoundZ;UpperBoundX;UpperBoundY;UpperBoundZ';

function writeCsvFile(filePath, rows) {
	if (rows.length === 0) return;
	const dir = path.dirname(filePath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	const lines = [CSV_HEADERS];
	for (const r of rows) {
		lines.push([
			escapeCsv(r.ModelFile),
			escapeCsv(r.PositionX),
			escapeCsv(r.PositionY),
			escapeCsv(r.PositionZ),
			escapeCsv(r.RotationX),
			escapeCsv(r.RotationY),
			escapeCsv(r.RotationZ),
			escapeCsv(r.RotationW),
			escapeCsv(r.ScaleFactor),
			escapeCsv(r.ModelId),
			escapeCsv(r.Type),
			escapeCsv(r.FileDataID),
			escapeCsv(r.DoodadSetIndexes),
			escapeCsv(r.DoodadSetNames),
			escapeCsv(r.LowerBoundX),
			escapeCsv(r.LowerBoundY),
			escapeCsv(r.LowerBoundZ),
			escapeCsv(r.UpperBoundX),
			escapeCsv(r.UpperBoundY),
			escapeCsv(r.UpperBoundZ)
		].join(';'));
	}
	fs.writeFileSync(filePath, lines.join('\n'), 'utf8');
}

/** 加载该瓦片的 obj0/obj1 ADT，合并 worldModels 与 models */
async function loadObjAdtForTile(casc, wdt, mapName, tileIndex) {
	const prefix = `world/maps/${mapName}/${mapName}`;
	const prefixLower = `world/maps/${(mapName || '').toLowerCase()}/${(mapName || '').toLowerCase()}`;
	const tileX = tileIndex % MAP_SIZE;
	const tileY = Math.floor(tileIndex / MAP_SIZE);
	const entries = wdt?.entries;
	const merged = { worldModels: [], models: [], wmoNames: null, wmoOffsets: null, m2Names: null, m2Offsets: null, doodadSets: [] };
	const ADTLoader = require('../../wow.export-min/src/js/3D/loaders/ADTLoader');

	for (const suffix of ['obj0', 'obj1']) {
		const adtKey = suffix === 'obj0' ? 'obj0ADT' : 'obj1ADT';
		let data = null;
		if (entries && entries[tileIndex]) {
			const fileId = entries[tileIndex][adtKey];
			if (fileId && fileId > 0) {
				try {
					data = await casc.getFile(fileId, false, true);
				} catch (e) {}
			}
		}
		if (!data) {
			try {
				data = await casc.getFileByName(`${prefix}_${tileY}_${tileX}_${suffix}.adt`, false, true);
			} catch (e) {
				try {
					data = await casc.getFileByName(`${prefixLower}_${tileY}_${tileX}_${suffix}.adt`, false, true);
				} catch (e2) {}
			}
		}
		if (!data) continue;
		const adt = new ADTLoader(data);
		adt.loadObj();
		if (adt.worldModels && adt.worldModels.length) {
			merged.worldModels.push(...adt.worldModels);
			if (!merged.wmoNames) {
				merged.wmoNames = adt.wmoNames;
				merged.wmoOffsets = adt.wmoOffsets;
			}
			if (adt.doodadSets && adt.doodadSets.length) merged.doodadSets = adt.doodadSets;
		}
		if (adt.models && adt.models.length) {
			merged.models.push(...adt.models);
			if (!merged.m2Names) {
				merged.m2Names = adt.m2Names;
				merged.m2Offsets = adt.m2Offsets;
			}
		}
	}
	return merged;
}

/** 解析 WMO 文件名（mwidEntry → 文件名） */
function getWmoFileName(objAdt, wm) {
	if (objAdt.wmoNames && objAdt.wmoOffsets != null) {
		const ofs = objAdt.wmoOffsets[wm.mwidEntry];
		if (ofs != null && objAdt.wmoNames[ofs]) return objAdt.wmoNames[ofs];
	}
	return null;
}

/** 解析 M2 文件名（mmidEntry → 文件名） */
function getM2FileName(objAdt, model) {
	if (objAdt.m2Names && objAdt.m2Offsets != null) {
		const ofs = objAdt.m2Offsets[model.mmidEntry];
		if (ofs != null && objAdt.m2Names[ofs]) return objAdt.m2Names[ofs];
	}
	return null;
}

function getWoWClientPath() {
	const projectRoot = path.join(__dirname, '..', '..');
	const configPath = path.join(projectRoot, 'config.json');
	let candidate = null;
	if (fs.existsSync(configPath)) {
		try {
			const c = JSON.parse(fs.readFileSync(configPath, 'utf8'));
			if (c.wowClientPath && fs.existsSync(c.wowClientPath)) candidate = c.wowClientPath;
		} catch (e) {}
	}
	if (!candidate) {
		const wowExport = path.join(
			process.env.LOCALAPPDATA || require('os').homedir(),
			'wow.export', 'User Data', 'Default', 'config.json'
		);
		if (fs.existsSync(wowExport)) {
			try {
				const c = JSON.parse(fs.readFileSync(wowExport, 'utf8'));
				if (c.recentLocal && c.recentLocal.length > 0) {
					const t = c.recentLocal.find(i => i.product === 'wow_classic_titan');
					if (t && fs.existsSync(t.path)) candidate = t.path;
					else if (fs.existsSync(c.recentLocal[0].path)) candidate = c.recentLocal[0].path;
				}
			} catch (e) {}
		}
	}
	if (!candidate) {
		const common = [
			'D:\\战网\\World of Warcraft\\_classic_titan_',
			'C:\\Program Files (x86)\\World of Warcraft\\_classic_titan_',
			path.join(process.env.PROGRAMFILES || 'C:\\Program Files', 'World of Warcraft', '_classic_titan_')
		];
		for (const p of common) {
			if (fs.existsSync(p) && fs.existsSync(path.join(p, '.build.info'))) { candidate = p; break; }
		}
	}
	// 强制使用 _classic_titan_：若当前路径是根目录或非 titan，则改用 <根>/_classic_titan_
	if (candidate) {
		const normalized = path.normalize(candidate).replace(/[/\\]+$/, '');
		const classicTitan = path.join(normalized, '_classic_titan_');
		if (!normalized.endsWith('_classic_titan_') && fs.existsSync(classicTitan) && fs.existsSync(path.join(classicTitan, '.build.info'))) {
			candidate = classicTitan;
		} else if (path.basename(normalized) !== '_classic_titan_' && fs.existsSync(path.join(normalized, '_classic_titan_', '.build.info'))) {
			candidate = path.join(normalized, '_classic_titan_');
		}
		return candidate;
	}
	return null;
}

async function main() {
	let mapName = 'kalimdor';
	let outDir = path.join(__dirname, '..', 'exports', 'adt-objs');
	let cascProduct = 'wow_classic_titan';
	let fromNorth, fromWest, fromZ, toNorth, toWest, toZ;
	let margin = 2;
	const args = process.argv.slice(2);
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--map' && args[i + 1]) { mapName = args[i + 1]; i++; continue; }
		if (args[i] === '--out-dir' && args[i + 1]) { outDir = path.resolve(args[++i]); continue; }
		if (args[i] === '--product' && args[i + 1]) { cascProduct = String(args[++i]); continue; }
		if (args[i] === '--margin' && args[i + 1]) { margin = parseInt(args[++i], 10) || 2; continue; }
		if (args[i] === '--from' && args[i + 3]) {
			fromNorth = parseFloat(args[++i]);
			fromWest = parseFloat(args[++i]);
			fromZ = parseFloat(args[++i]);
			continue;
		}
		if (args[i] === '--to' && args[i + 3]) {
			toNorth = parseFloat(args[++i]);
			toWest = parseFloat(args[++i]);
			toZ = parseFloat(args[++i]);
			continue;
		}
	}

	if (fromNorth == null || fromWest == null || toNorth == null || toWest == null) {
		console.error('用法: node export-adt-obj.js --map kalimdor --from <北> <西> <高> --to <北> <西> <高> [--out-dir pathfinder/exports/adt-objs] [--margin 2] [--product wow_classic_titan]');
		process.exit(1);
	}

	const wowPath = getWoWClientPath();
	if (!wowPath) {
		console.error('未找到 WoW 客户端路径，请设置 config.json 的 wowClientPath 或 wow.export 的 recentLocal');
		process.exit(1);
	}

	const tileIdSet = getTileIdsForRoute(fromNorth, fromWest, toNorth, toWest, margin);
	const tileIds = [...tileIdSet].sort();
	console.log('[adt-obj] 起点 (北,西)', fromNorth.toFixed(1), fromWest.toFixed(1), '终点', toNorth.toFixed(1), toWest.toFixed(1));
	console.log('[adt-obj] 瓦片 margin=' + margin + ':', tileIds.length, '块');
	// 明确：margin=2 表示在起终点覆盖的 tx/tz 范围基础上，东西北南各多导 2 圈瓦片
	if (tileIds.length > 0) {
		const tzVals = tileIds.map(id => parseInt(id.split('_')[0], 10));
		const txVals = tileIds.map(id => parseInt(id.split('_')[1], 10));
		const tzMin = Math.min(...tzVals), tzMax = Math.max(...tzVals);
		const txMin = Math.min(...txVals), txMax = Math.max(...txVals);
		const westMin = MAP_HALF * TILE_SIZE - (txMax + 1) * TILE_SIZE;
		const westMax = MAP_HALF * TILE_SIZE - txMin * TILE_SIZE;
		const northMin = MAP_HALF * TILE_SIZE - (tzMax + 1) * TILE_SIZE;
		const northMax = MAP_HALF * TILE_SIZE - tzMin * TILE_SIZE;
		console.log('[adt-obj] 瓦片范围 tx=' + txMin + '..' + txMax + ' tz=' + tzMin + '..' + tzMax + ' → 世界 west ' + westMin.toFixed(0) + '~' + westMax.toFixed(0) + ', north ' + northMin.toFixed(0) + '~' + northMax.toFixed(0));
	}

	const listfile = require('../../wow.export-min/src/js/casc/listfile');
	const CASCLocal = require('../../wow.export-min/src/js/casc/casc-source-local');
	const core = require('../../wow.export-min/src/js/core');
	await listfile.preload();
	const casc = new CASCLocal(wowPath);
	await casc.init();
	// 默认使用 wow_classic_titan；允许通过 --product 指定构建做对照诊断。
	let buildIndex = -1;
	for (let i = 0; i < casc.builds.length; i++) {
		if (casc.builds[i] && casc.builds[i].Product === cascProduct) {
			buildIndex = i;
			break;
		}
	}
	if (buildIndex < 0) {
		const products = casc.builds.map(b => b && b.Product).filter(Boolean);
		console.error('[adt-obj] 未找到构建:', cascProduct, '可用构建:', products.join(', '));
		process.exit(1);
	}
	if (casc.builds[buildIndex]) {
		console.log('[adt-obj] 使用构建:', casc.builds[buildIndex].Product, 'Version:', casc.builds[buildIndex].Version || '');
	}
	await casc.load(buildIndex);
	core.view.casc = casc;
	const regionPng = path.join(outDir, 'region-map.png');
	await exportRegionMapPng({
		mapName,
		fromNorth,
		fromWest,
		toNorth,
		toWest,
		margin,
		outPath: regionPng,
		casc,
	});
	console.log('[adt-obj] 区域 2D 游戏地图:', regionPng);
	if (core.view.config) {
		core.view.config.modelsExportCollision = true;
		core.view.config.overwriteFiles = true;
		core.view.config.modelsExportTextures = false;
		core.view.config.exportM2Meta = false;
		core.view.config.exportM2Bones = false;
	}

	const terrain = new TerrainLoader(casc, mapName);
	await terrain.init();
	const wdt = terrain.wdt;

	const helper = {
		isCancelled: () => false,
		setCurrentTaskName: () => {},
		setCurrentTaskValue: () => {},
		setCurrentTaskMax: () => {}
	};

	const ADTLoader = require('../../wow.export-min/src/js/3D/loaders/ADTLoader');
	const M2Exporter = require('../../wow.export-min/src/js/3D/exporters/M2Exporter');
	const WMOExporter = require('../../wow.export-min/src/js/3D/exporters/WMOExporter');

	const exportedWmo = new Set();
	const exportedM2 = new Set();

	let writtenTerrain = 0;
	let writtenCsv = 0;
	let totalPlacements = 0;

	for (const tileID of tileIds) {
		const [tz, tx] = tileID.split('_').map(Number);
		// 与 wow.export 一致：WDT/MAID 的 entries 索引 = tileY*64+tileX，其中 tileY=tx(西), tileX=tz(北)；
		// 同一瓦片 wow.export 导出为 adt_39_31 时用 tileIndex=2527，故此处用 tx*MAP_SIZE+tz
		const wdtTileIndex = tx * MAP_SIZE + tz;
		const tileIndex = wdtTileIndex;
		// 输出文件名仍为 adt_<tz>_<tx>.obj（与 tileID 一致）
		const adtFileBase = 'adt_' + tz + '_' + tx;

		// 与 wow.export-main 一致：tileID = tileY_tileX，tilePrefix = map_tileY_tileX（用于 obj/tex 子文件）
		const prefix = `world/maps/${mapName}/${mapName}`;
		const tilePrefix = prefix + '_' + tz + '_' + tx;
		// listfile 中 root ADT 文件名与 wow.export 一致：tileY_tileX = (tx, tz)，否则可能取到错误 fileDataID 导致高度错
		const rootTilePrefix = prefix + '_' + tx + '_' + tz;
		const maid = wdt.entries[tileIndex];
		const rootFileDataID = (maid && maid.rootADT > 0) ? maid.rootADT : listfile.getByFilename(rootTilePrefix + '.adt');
		let rootAdt = null;
		if (rootFileDataID && rootFileDataID > 0) {
			try {
				const rootFile = await casc.getFile(rootFileDataID, false, true);
				// 与 wow.export 一致：先完整解码再解析，否则 BLTE 按需解码可能导致 ADT 读到错误偏移
				if (typeof rootFile.processAllBlocks === 'function') {
					rootFile.processAllBlocks();
					rootFile.seek(0);
				}
				rootAdt = new ADTLoader(rootFile);
				rootAdt.loadRoot();
			} catch (e) {
				rootAdt = await terrain.loadTile(tileIndex);
			}
		} else {
			rootAdt = await terrain.loadTile(tileIndex);
		}
		if (rootAdt && rootAdt.chunks) {
			const { positions, normals, uvs, indices } = buildTileMesh(rootAdt);
			if (positions.length >= 9 && indices.length >= 3) {
				writeObjFile(path.join(outDir, adtFileBase + '.obj'), positions, indices, normals, uvs);
				writtenTerrain++;
			}
		}

		const objAdt = await loadObjAdtForTile(casc, wdt, mapName, tileIndex);
		const csvRows = [];

		if (objAdt.worldModels && objAdt.worldModels.length > 0) {
			const setNameCache = new Map();
			for (const wm of objAdt.worldModels) {
				let fileName = getWmoFileName(objAdt, wm);
				let fileDataID = null;
				if (fileName) {
					fileDataID = listfile.getByFilename(fileName);
				}
				if (!fileDataID && (wm.flags & 0x8)) fileDataID = wm.mwidEntry;
				if (typeof wm.mwidEntry === 'number' && !fileName) {
					fileName = listfile.getByID(wm.mwidEntry);
					if (fileName) fileDataID = wm.mwidEntry;
				}
				if (!fileDataID) continue;

				const doodadSet = wm.doodadSet != null ? wm.doodadSet : 0;
				// 使用 fileDataID 作为主键命名，避免 basename 冲突导致模型被覆盖、CSV 引用错模型。
				const objName = 'wmo_' + fileDataID + '_set' + doodadSet + '.obj';
				const cacheKey = fileDataID + '-' + doodadSet;

				if (!exportedWmo.has(cacheKey)) {
					try {
						const data = await casc.getFile(fileDataID, false, true);
						const wmoLoader = new WMOExporter(data, fileDataID);
						await wmoLoader.wmo.load();
						setNameCache.set(fileDataID, wmoLoader.wmo.doodadSets ? wmoLoader.wmo.doodadSets.map(d => d.name) : []);
						const mask = { 0: { checked: true } };
						mask[doodadSet] = { checked: true };
						wmoLoader.setDoodadSetMask(mask);
						await wmoLoader.exportAsOBJ(path.join(outDir, objName), helper);
						exportedWmo.add(cacheKey);
					} catch (e) {
						console.warn('[adt-obj] WMO export skip', fileDataID, e.message);
					}
				}

				const doodadNames = setNameCache.get(fileDataID) || [];
				// 与 wow.export-main 一致：CSV 写 raw 的 position[0],[1],[2]（ADT 坐标），不转世界坐标
				csvRows.push({
					ModelFile: objName,
					PositionX: wm.position[0],
					PositionY: wm.position[1],
					PositionZ: wm.position[2],
					RotationX: wm.rotation[0],
					RotationY: wm.rotation[1],
					RotationZ: wm.rotation[2],
					RotationW: 0,
					ScaleFactor: (wm.scale != null ? wm.scale : 1024) / 1024,
					ModelId: wm.uniqueId,
					Type: 'wmo',
					FileDataID: fileDataID,
					DoodadSetIndexes: String(doodadSet),
					DoodadSetNames: doodadNames[doodadSet] || '',
					LowerBoundX: wm.lowerBounds && wm.lowerBounds[0],
					LowerBoundY: wm.lowerBounds && wm.lowerBounds[1],
					LowerBoundZ: wm.lowerBounds && wm.lowerBounds[2],
					UpperBoundX: wm.upperBounds && wm.upperBounds[0],
					UpperBoundY: wm.upperBounds && wm.upperBounds[1],
					UpperBoundZ: wm.upperBounds && wm.upperBounds[2],
				});
			}
		}

		if (objAdt.models && objAdt.models.length > 0) {
			for (const model of objAdt.models) {
				let fileName = getM2FileName(objAdt, model);
				let fileDataID = model.mmidEntry;
				if (fileName) {
					const fid = listfile.getByFilename(fileName);
					if (fid) fileDataID = fid;
				}
				// 同名 M2 在不同目录下很常见；统一使用 fileDataID 保证唯一且可回溯。
				const objName = 'm2_' + fileDataID + '.obj';

				if (!exportedM2.has(fileDataID)) {
					try {
						const data = await casc.getFile(fileDataID, false, true);
						const m2Export = new M2Exporter(data, undefined, fileDataID);
						await m2Export.exportAsOBJ(path.join(outDir, objName), true, helper);
						exportedM2.add(fileDataID);
					} catch (e) {
						console.warn('[adt-obj] M2 export skip', fileDataID, e.message);
					}
				}

				// 与 wow.export-main 一致：CSV 写 raw 的 position[0],[1],[2]（ADT 坐标）
				csvRows.push({
					ModelFile: objName,
					PositionX: model.position[0],
					PositionY: model.position[1],
					PositionZ: model.position[2],
					RotationX: model.rotation[0],
					RotationY: model.rotation[1],
					RotationZ: model.rotation[2],
					RotationW: 0,
					ScaleFactor: (model.scale != null ? model.scale : 1024) / 1024,
					ModelId: model.uniqueId,
					Type: 'm2',
					FileDataID: fileDataID,
					DoodadSetIndexes: '0',
					DoodadSetNames: '',
					LowerBoundX: '',
					LowerBoundY: '',
					LowerBoundZ: '',
					UpperBoundX: '',
					UpperBoundY: '',
					UpperBoundZ: '',
				});
			}
		}

		if (csvRows.length > 0) {
			writeCsvFile(path.join(outDir, adtFileBase + '_ModelPlacementInformation.csv'), csvRows);
			writtenCsv++;
			totalPlacements += csvRows.length;
		}
	}

	console.log('[adt-obj] 已写出 地形 OBJ:', writtenTerrain, '个 | 放置 CSV:', writtenCsv, '个 | 带放置的实例数:', totalPlacements);
	console.log('[adt-obj] WMO 种类:', exportedWmo.size, '| M2 种类:', exportedM2.size);
	console.log('[adt-obj] 下一步: node pathfinder/scripts/export-route-geometry.js --dir "' + outDir + '" --from ... --to ... --out pathfinder/exports/recast-geometry-route.json');
}

main().catch(e => { console.error(e); process.exit(1); });
