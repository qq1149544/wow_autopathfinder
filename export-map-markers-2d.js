#!/usr/bin/env node
/**
 * 在 2D 小地图上标记起点、终点坐标并输出 PNG。
 * 支持 --margin：在起终点覆盖的瓦片基础上外扩 N 圈，与 export-adt-obj 定位区域一致。
 *
 * 用法:
 *   node export-map-markers-2d.js --map Kalimdor --from 326.71 -4704.19 16.08 --to -618.48 -4251.93 38.73 [--margin 2] [--out exports/kalimdor-markers.png]
 * 坐标为游戏格式: x=北, y=西, z=高（z 可选）
 */
const path = require('path');
const fs = require('fs');

const TILE_SIZE = (51200 / 3) / 32;
const MAP_HALF = 32;

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
	for (const p of [
		'D:\\战网\\World of Warcraft\\_classic_titan_',
		'C:\\Program Files (x86)\\World of Warcraft\\_classic_titan_',
	]) {
		if (fs.existsSync(p) && fs.existsSync(path.join(p, '.build.info'))) return p;
	}
	return null;
}

/** 游戏 (x=北, y=西) → 内部 west, north */
function gameToInner(north, west) {
	return { west, north };
}

/** 世界 (west, north) → 瓦片索引 */
function worldToTile(west, north) {
	const tx = Math.floor(MAP_HALF - west / TILE_SIZE);
	const tz = Math.floor(MAP_HALF - north / TILE_SIZE);
	return { tx, tz };
}

/** 瓦片内世界坐标 → 纹理 UV [0,1]，flip-u 与游戏小地图一致 */
function worldToTileUV(west, north, tx, tz) {
	const MAP_OFFSET = 51200 / 3;
	const westMin = MAP_OFFSET - (tx + 1) * TILE_SIZE;
	const westMax = MAP_OFFSET - tx * TILE_SIZE;
	const northMin = MAP_OFFSET - (tz + 1) * TILE_SIZE;
	const northMax = MAP_OFFSET - tz * TILE_SIZE;
	let u = Math.max(0, Math.min(1, (west - westMin) / (westMax - westMin)));
	const v = Math.max(0, Math.min(1, (northMax - north) / (northMax - northMin)));
	u = 1 - u;
	return { u, v };
}

/** 在像素数组上画实心圆 (RGBA) */
function drawCircle(pixels, width, height, cx, cy, radius, r, g, b) {
	const x0 = Math.max(0, Math.floor(cx - radius));
	const x1 = Math.min(width - 1, Math.floor(cx + radius));
	const y0 = Math.max(0, Math.floor(cy - radius));
	const y1 = Math.min(height - 1, Math.floor(cy + radius));
	const r2 = radius * radius;
	for (let y = y0; y <= y1; y++) {
		for (let x = x0; x <= x1; x++) {
			const dx = x - cx, dy = y - cy;
			if (dx * dx + dy * dy <= r2) {
				const idx = (y * width + x) * 4;
				pixels[idx] = r;
				pixels[idx + 1] = g;
				pixels[idx + 2] = b;
				pixels[idx + 3] = 255;
			}
		}
	}
}

/** 在像素数组上画线段 (RGBA)，线宽约 1～2 像素 */
function drawLine(pixels, width, height, x0, y0, x1, y1, r, g, b) {
	const steps = Math.max(1, Math.ceil(Math.hypot(x1 - x0, y1 - y0)));
	for (let i = 0; i <= steps; i++) {
		const t = i / steps;
		const x = x0 + (x1 - x0) * t;
		const y = y0 + (y1 - y0) * t;
		const px = Math.round(x);
		const py = Math.round(y);
		if (px >= 0 && px < width && py >= 0 && py < height) {
			const idx = (py * width + px) * 4;
			pixels[idx] = r;
			pixels[idx + 1] = g;
			pixels[idx + 2] = b;
			pixels[idx + 3] = 255;
		}
	}
}

function parseArgs() {
	const args = process.argv.slice(2);
	const opts = {
		map: 'Kalimdor',
		from: [326.71, -4704.19, 16.08],
		to: [-618.48, -4251.93, 38.73],
		out: null,
		margin: 2,
	};
	for (let i = 0; i < args.length; i++) {
		if (args[i] === '--map' && args[i + 1]) {
			opts.map = args[++i];
		} else if (args[i] === '--from' && args[i + 1] != null && args[i + 2] != null) {
			opts.from = [parseFloat(args[i + 1]), parseFloat(args[i + 2]), null];
			if (args[i + 3] != null && !args[i + 3].startsWith('--') && Number.isFinite(parseFloat(args[i + 3]))) {
				opts.from[2] = parseFloat(args[i + 3]);
				i++;
			}
			i += 2;
		} else if (args[i] === '--to' && args[i + 1] != null && args[i + 2] != null) {
			opts.to = [parseFloat(args[i + 1]), parseFloat(args[i + 2]), null];
			if (args[i + 3] != null && !args[i + 3].startsWith('--') && Number.isFinite(parseFloat(args[i + 3]))) {
				opts.to[2] = parseFloat(args[i + 3]);
				i++;
			}
			i += 2;
		} else if (args[i] === '--out' && args[i + 1]) {
			opts.out = path.resolve(args[++i]);
		} else if (args[i] === '--margin' && args[i + 1]) {
			opts.margin = parseInt(args[++i], 10);
			if (!Number.isFinite(opts.margin) || opts.margin < 0) opts.margin = 2;
		}
	}
	return opts;
}

async function exportRegionMapPng(opts) {
	const {
		mapName = 'Kalimdor',
		fromNorth, fromWest, toNorth, toWest,
		margin = 2,
		outPath,
		casc: cascIn,
		routePoints = null,
	} = opts;
	if (outPath == null || fromNorth == null || fromWest == null || toNorth == null || toWest == null) {
		throw new Error('exportRegionMapPng: need outPath, fromNorth, fromWest, toNorth, toWest');
	}
	let casc = cascIn;
	if (!casc) {
		const wowPath = getWoWClientPath();
		if (!wowPath) throw new Error('未找到 WoW 客户端路径');
		const listfile = require('../wow.export-min/src/js/casc/listfile');
		const CASCLocal = require('../wow.export-min/src/js/casc/casc-source-local');
		const core = require('../wow.export-min/src/js/core');
		await listfile.preload();
		casc = new CASCLocal(wowPath);
		await casc.init();
		let buildIndex = 0;
		for (let i = 0; i < casc.builds.length; i++) {
			if (casc.builds[i] && (casc.builds[i].Product === 'wow_classic_titan' || casc.builds[i].Product === 'wow')) {
				buildIndex = i;
				break;
			}
		}
		await casc.load(buildIndex);
		core.view.casc = casc;
	}

	const startInner = gameToInner(fromNorth, fromWest);
	const endInner = gameToInner(toNorth, toWest);
	const tStart = worldToTile(startInner.west, startInner.north);
	const tEnd = worldToTile(endInner.west, endInner.north);
	let minTx = Math.min(tStart.tx, tEnd.tx);
	let maxTx = Math.max(tStart.tx, tEnd.tx);
	let minTz = Math.min(tStart.tz, tEnd.tz);
	let maxTz = Math.max(tStart.tz, tEnd.tz);
	// 若有路线点，扩展瓦片范围以包含整条路径，避免绕行路线只画出起终点直线
	if (routePoints && routePoints.length > 0) {
		for (const p of routePoints) {
			const t = worldToTile(p.y, p.x);
			minTx = Math.min(minTx, t.tx);
			maxTx = Math.max(maxTx, t.tx);
			minTz = Math.min(minTz, t.tz);
			maxTz = Math.max(maxTz, t.tz);
		}
	}
	const marginN = Math.max(0, margin);
	const MAP_SIZE = 64;
	const txLo = Math.max(0, minTx - marginN);
	const txHi = Math.min(MAP_SIZE - 1, maxTx + marginN);
	const tzLo = Math.max(0, minTz - marginN);
	const tzHi = Math.min(MAP_SIZE - 1, maxTz + marginN);

	const mapDir = mapName;
	let tileW = 0, tileH = 0;
	const tilePixels = {};
	const BLPImage = require('../wow.export-min/src/js/casc/blp');

	for (let tz = tzLo; tz <= tzHi; tz++) {
		for (let tx = txLo; tx <= txHi; tx++) {
			const tileStr = `map${String(tx).padStart(2, '0')}_${String(tz).padStart(2, '0')}`;
			const blpPath = `world/minimaps/${mapDir}/${tileStr}.blp`;
			let data;
			try {
				data = await casc.getFileByName(blpPath, false, true);
			} catch (e) {
				try {
					data = await casc.getFileByName(blpPath.replace(mapDir, mapDir.toLowerCase()), false, true);
				} catch (e2) {
					const size = 256;
					const buf = Buffer.alloc(size * size * 4);
					for (let i = 0; i < size * size * 4; i += 4) {
						buf[i] = 64;
						buf[i + 1] = 64;
						buf[i + 2] = 64;
						buf[i + 3] = 255;
					}
					tilePixels[`${tx}_${tz}`] = { pixels: buf, w: size, h: size };
					if (tileW === 0) tileW = size;
					if (tileH === 0) tileH = size;
					continue;
				}
			}
			const blp = new BLPImage(data);
			const pixels = blp.toUInt8Array(0, 0b1111);
			const w = blp.scaledWidth;
			const h = blp.scaledHeight;
			tilePixels[`${tx}_${tz}`] = { pixels: Buffer.from(pixels), w, h };
			if (tileW === 0) tileW = w;
			if (tileH === 0) tileH = h;
		}
	}

	const numCols = txHi - txLo + 1;
	const numRows = tzHi - tzLo + 1;
	const outW = numCols * tileW;
	const outH = numRows * tileH;
	const PNGWriter = require('../wow.export-min/src/js/png-writer');
	const png = new PNGWriter(outW, outH);
	const out = png.getPixelData();
	out.fill(0);

	for (let tz = tzLo; tz <= tzHi; tz++) {
		for (let tx = txLo; tx <= txHi; tx++) {
			const key = `${tx}_${tz}`;
			const tile = tilePixels[key];
			if (!tile) continue;
			const dx = (tx - txLo) * tileW;
			const dy = (tz - tzLo) * tileH;
			const src = tile.pixels;
			const tw = tile.w, th = tile.h;
			for (let y = 0; y < th; y++) {
				for (let x = 0; x < tw; x++) {
					const dstX = dx + x;
					const dstY = dy + y;
					if (dstX >= outW || dstY >= outH) continue;
					const srcIdx = (y * tw + x) * 4;
					const dstIdx = (dstY * outW + dstX) * 4;
					out[dstIdx] = src[srcIdx];
					out[dstIdx + 1] = src[srcIdx + 1];
					out[dstIdx + 2] = src[srcIdx + 2];
					out[dstIdx + 3] = src[srcIdx + 3];
				}
			}
		}
	}

	function worldToCompositePx(west, north) {
		const { tx, tz } = worldToTile(west, north);
		const { u, v } = worldToTileUV(west, north, tx, tz);
		const px = (tx - txLo) * tileW + u * tileW;
		const py = (tz - tzLo) * tileH + v * tileH;
		return { px, py };
	}

	// 起终点标记改小：原 max(8, tile/8)，改为 max(4, tile/12)
	const radius = Math.max(4, Math.min(tileW, tileH) / 12);
	const startPx = worldToCompositePx(startInner.west, startInner.north);
	drawCircle(out, outW, outH, startPx.px, startPx.py, radius, 0, 255, 0);
	drawCircle(out, outW, outH, startPx.px, startPx.py, radius * 0.5, 255, 255, 255);
	const endPx = worldToCompositePx(endInner.west, endInner.north);
	drawCircle(out, outW, outH, endPx.px, endPx.py, radius, 255, 0, 0);
	drawCircle(out, outW, outH, endPx.px, endPx.py, radius * 0.5, 255, 255, 255);

	// 若有路线点：先画折线再画小圆点（红色，半径 2）
	if (routePoints && routePoints.length > 0) {
		const routeRadius = 2;
		for (let i = 0; i < routePoints.length - 1; i++) {
			const a = routePoints[i];
			const b = routePoints[i + 1];
			const pa = worldToCompositePx(a.y, a.x);
			const pb = worldToCompositePx(b.y, b.x);
			drawLine(out, outW, outH, pa.px, pa.py, pb.px, pb.py, 255, 0, 0);
		}
		for (const p of routePoints) {
			const { px, py } = worldToCompositePx(p.y, p.x);
			drawCircle(out, outW, outH, px, py, routeRadius, 255, 0, 0);
		}
	}

	const dir = path.dirname(outPath);
	if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
	await png.write(outPath);
	return { outPath, txLo, txHi, tzLo, tzHi, margin: marginN };
}

async function main() {
	const opts = parseArgs();
	opts.margin = opts.margin != null ? opts.margin : 2;
	const [startNorth, startWest, startZ] = opts.from;
	const [endNorth, endWest, endZ] = opts.to;

	const outPath = opts.out || path.join(__dirname, 'exports', 'map-markers-2d.png');
	const result = await exportRegionMapPng({
		mapName: opts.map,
		fromNorth: startNorth,
		fromWest: startWest,
		toNorth: endNorth,
		toWest: endWest,
		margin: opts.margin,
		outPath,
	});
	const { txLo, txHi, tzLo, tzHi, margin } = result;

	console.log('起点 (游戏 x=北, y=西, z=高):', startNorth.toFixed(2), startWest.toFixed(2), startZ != null ? startZ.toFixed(2) : '-');
	console.log('终点:', endNorth.toFixed(2), endWest.toFixed(2), endZ != null ? endZ.toFixed(2) : '-');
	console.log('地图:', opts.map, '瓦片范围 tx', txLo, '~', txHi, 'tz', tzLo, '~', tzHi, '(margin=' + margin + ')');
	console.log('已导出:', outPath);
}

main().catch(e => {
	console.error(e);
	process.exit(1);
});

module.exports = { exportRegionMapPng };
