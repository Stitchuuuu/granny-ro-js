#!/usr/bin/env node
/**
 * grf-inspect.mjs — GRF file table reader (v0x200 "Master of Magic" and
 * v0x300 "Event Horizon"). Parses the file table using node built-ins
 * (fs + zlib).
 *
 * Partial reads : opens the GRF and reads only header + file table, so
 * multi-GB files work fine (Node fs.readFileSync would OOM).
 *
 * Usage :
 *   node grf-inspect.mjs <path/to/data.grf> [options]
 *
 * Options :
 *   --filter <regex>     Filter filenames by JS regex (case-insensitive)
 *   --ext <ext1,ext2>    Filter by file extension(s) — e.g. --ext str,spr,wav
 *   --json               Output JSON array instead of human-readable
 *   --count              Just print the total file count + filtered count
 *   --extract <file>     Extract one file by exact filename to ./<basename>.
 *                        Only unencrypted entries (type === 0x01).
 *                        Encrypted (DES) entries are not supported.
 *   --extract-all <dir>  Bulk-extract all entries (respecting --filter / --ext)
 *                        into <dir>, preserving the GRF directory tree.
 *                        Decrypts DES-encrypted entries (header / mixed).
 *                        Idempotent : skips entries whose output file already
 *                        exists unless --force is set.
 *   --force              With --extract-all, overwrite existing files.
 *   --report             With --extract-all, print a one-line counters summary.
 *
 * Korean filenames :
 *   Both v0x200 and v0x300 GRFs in the wild store filenames as raw
 *   EUC-KR bytes (despite GameFile.js comment about UTF-8 for v0x300).
 *   The bytes are read as latin1 — Korean appears as Mojibake (¼¼ÀÌÁö
 *   = 세이지) but ASCII substrings (data\sprite\…\windhit) stay searchable.
 *   For Korean filters, pass the EUC-KR bytes as JS-string escapes :
 *     --filter '\xBC\xBC\xC0\xCC\xC1\xF6'   # 세이지 (Sage)
 *
 * Examples :
 *   node grf-inspect.mjs ~/cyro-data.grf --count
 *   node grf-inspect.mjs ~/cyro-data.grf --filter 'windhit' --ext str
 *   node grf-inspect.mjs ~/data.grf --extract 'data\texture\effect\windhit1.str'
 */

import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { argv, exit, stdout } from 'node:process'

// ── DES decryption ───────────────────────────────────────────────────
// Algorithm + tables ported from rathena's common/des.c (GPLv3 compatible
// open-source codebase). Pure JS, no native crypto.
const DES_mask  = new Uint8Array([0x80, 0x40, 0x20, 0x10, 0x08, 0x04, 0x02, 0x01])
const DES_tmp   = new Uint8Array(8)
const DES_tmp2  = new Uint8Array(8)
const DES_clean = new Uint8Array(8)

const IP_TABLE = new Uint8Array([
	58, 50, 42, 34, 26, 18, 10, 2, 60, 52, 44, 36, 28, 20, 12, 4, 62, 54, 46, 38, 30, 22, 14, 6, 64, 56, 48, 40, 32, 24,
	16, 8, 57, 49, 41, 33, 25, 17, 9, 1, 59, 51, 43, 35, 27, 19, 11, 3, 61, 53, 45, 37, 29, 21, 13, 5, 63, 55, 47, 39,
	31, 23, 15, 7
])
function initialPermutation(src, index) {
	for (let i = 0; i < 64; ++i) {
		const j = IP_TABLE[i] - 1
		if (src[index + ((j >> 3) & 7)] & DES_mask[j & 7]) {
			DES_tmp[(i >> 3) & 7] |= DES_mask[i & 7]
		}
	}
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

const FP_TABLE = new Uint8Array([
	40, 8, 48, 16, 56, 24, 64, 32, 39, 7, 47, 15, 55, 23, 63, 31, 38, 6, 46, 14, 54, 22, 62, 30, 37, 5, 45, 13, 53, 21,
	61, 29, 36, 4, 44, 12, 52, 20, 60, 28, 35, 3, 43, 11, 51, 19, 59, 27, 34, 2, 42, 10, 50, 18, 58, 26, 33, 1, 41, 9,
	49, 17, 57, 25
])
function finalPermutation(src, index) {
	for (let i = 0; i < 64; ++i) {
		const j = FP_TABLE[i] - 1
		if (src[index + ((j >> 3) & 7)] & DES_mask[j & 7]) {
			DES_tmp[(i >> 3) & 7] |= DES_mask[i & 7]
		}
	}
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

const TP_TABLE = new Uint8Array([
	16, 7, 20, 21, 29, 12, 28, 17, 1, 15, 23, 26, 5, 18, 31, 10, 2, 8, 24, 14, 32, 27, 3, 9, 19, 13, 30, 6, 22, 11, 4,
	25
])
function transposition(src, index) {
	for (let i = 0; i < 32; ++i) {
		const j = TP_TABLE[i] - 1
		if (src[index + (j >> 3)] & DES_mask[j & 7]) {
			DES_tmp[(i >> 3) + 4] |= DES_mask[i & 7]
		}
	}
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

function expansion(src, index) {
	DES_tmp[0] = ((src[index + 7] << 5) | (src[index + 4] >> 3)) & 0x3f
	DES_tmp[1] = ((src[index + 4] << 1) | (src[index + 5] >> 7)) & 0x3f
	DES_tmp[2] = ((src[index + 4] << 5) | (src[index + 5] >> 3)) & 0x3f
	DES_tmp[3] = ((src[index + 5] << 1) | (src[index + 6] >> 7)) & 0x3f
	DES_tmp[4] = ((src[index + 5] << 5) | (src[index + 6] >> 3)) & 0x3f
	DES_tmp[5] = ((src[index + 6] << 1) | (src[index + 7] >> 7)) & 0x3f
	DES_tmp[6] = ((src[index + 6] << 5) | (src[index + 7] >> 3)) & 0x3f
	DES_tmp[7] = ((src[index + 7] << 1) | (src[index + 4] >> 7)) & 0x3f
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

const SBOX_TABLE = [
	new Uint8Array([
		0xef, 0x03, 0x41, 0xfd, 0xd8, 0x74, 0x1e, 0x47, 0x26, 0xef, 0xfb, 0x22, 0xb3, 0xd8, 0x84, 0x1e, 0x39, 0xac,
		0xa7, 0x60, 0x62, 0xc1, 0xcd, 0xba, 0x5c, 0x96, 0x90, 0x59, 0x05, 0x3b, 0x7a, 0x85, 0x40, 0xfd, 0x1e, 0xc8,
		0xe7, 0x8a, 0x8b, 0x21, 0xda, 0x43, 0x64, 0x9f, 0x2d, 0x14, 0xb1, 0x72, 0xf5, 0x5b, 0xc8, 0xb6, 0x9c, 0x37,
		0x76, 0xec, 0x39, 0xa0, 0xa3, 0x05, 0x52, 0x6e, 0x0f, 0xd9
	]),
	new Uint8Array([
		0xa7, 0xdd, 0x0d, 0x78, 0x9e, 0x0b, 0xe3, 0x95, 0x60, 0x36, 0x36, 0x4f, 0xf9, 0x60, 0x5a, 0xa3, 0x11, 0x24,
		0xd2, 0x87, 0xc8, 0x52, 0x75, 0xec, 0xbb, 0xc1, 0x4c, 0xba, 0x24, 0xfe, 0x8f, 0x19, 0xda, 0x13, 0x66, 0xaf,
		0x49, 0xd0, 0x90, 0x06, 0x8c, 0x6a, 0xfb, 0x91, 0x37, 0x8d, 0x0d, 0x78, 0xbf, 0x49, 0x11, 0xf4, 0x23, 0xe5,
		0xce, 0x3b, 0x55, 0xbc, 0xa2, 0x57, 0xe8, 0x22, 0x74, 0xce
	]),
	new Uint8Array([
		0x2c, 0xea, 0xc1, 0xbf, 0x4a, 0x24, 0x1f, 0xc2, 0x79, 0x47, 0xa2, 0x7c, 0xb6, 0xd9, 0x68, 0x15, 0x80, 0x56,
		0x5d, 0x01, 0x33, 0xfd, 0xf4, 0xae, 0xde, 0x30, 0x07, 0x9b, 0xe5, 0x83, 0x9b, 0x68, 0x49, 0xb4, 0x2e, 0x83,
		0x1f, 0xc2, 0xb5, 0x7c, 0xa2, 0x19, 0xd8, 0xe5, 0x7c, 0x2f, 0x83, 0xda, 0xf7, 0x6b, 0x90, 0xfe, 0xc4, 0x01,
		0x5a, 0x97, 0x61, 0xa6, 0x3d, 0x40, 0x0b, 0x58, 0xe6, 0x3d
	]),
	new Uint8Array([
		0x4d, 0xd1, 0xb2, 0x0f, 0x28, 0xbd, 0xe4, 0x78, 0xf6, 0x4a, 0x0f, 0x93, 0x8b, 0x17, 0xd1, 0xa4, 0x3a, 0xec,
		0xc9, 0x35, 0x93, 0x56, 0x7e, 0xcb, 0x55, 0x20, 0xa0, 0xfe, 0x6c, 0x89, 0x17, 0x62, 0x17, 0x62, 0x4b, 0xb1,
		0xb4, 0xde, 0xd1, 0x87, 0xc9, 0x14, 0x3c, 0x4a, 0x7e, 0xa8, 0xe2, 0x7d, 0xa0, 0x9f, 0xf6, 0x5c, 0x6a, 0x09,
		0x8d, 0xf0, 0x0f, 0xe3, 0x53, 0x25, 0x95, 0x36, 0x28, 0xcb
	])
]
function substitutionBox(src, index) {
	for (let i = 0; i < 4; ++i) {
		DES_tmp[i] =
			(SBOX_TABLE[i][src[i * 2 + 0 + index]] & 0xf0) |
			(SBOX_TABLE[i][src[i * 2 + 1 + index]] & 0x0f)
	}
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

function roundFunction(src, index) {
	for (let i = 0; i < 8; i++) { DES_tmp2[i] = src[index + i] }
	expansion(DES_tmp2, 0)
	substitutionBox(DES_tmp2, 0)
	transposition(DES_tmp2, 0)
	src[index + 0] ^= DES_tmp2[4]
	src[index + 1] ^= DES_tmp2[5]
	src[index + 2] ^= DES_tmp2[6]
	src[index + 3] ^= DES_tmp2[7]
}

function decryptBlock(src, index) {
	initialPermutation(src, index)
	roundFunction(src, index)
	finalPermutation(src, index)
}

const SHUFFLE_TABLE = (function init_substitution() {
	const out = new Uint8Array(256)
	const list = [0x00, 0x2b, 0x6c, 0x80, 0x01, 0x68, 0x48, 0x77, 0x60, 0xff, 0xb9, 0xc0, 0xfe, 0xeb]
	for (let i = 0; i < 256; ++i) { out[i] = i }
	for (let i = 0, count = list.length; i < count; i += 2) {
		out[list[i + 0]] = list[i + 1]
		out[list[i + 1]] = list[i + 0]
	}
	return out
})()
function shuffleDec(src, index) {
	DES_tmp[0] = src[index + 3]
	DES_tmp[1] = src[index + 4]
	DES_tmp[2] = src[index + 6]
	DES_tmp[3] = src[index + 0]
	DES_tmp[4] = src[index + 1]
	DES_tmp[5] = src[index + 2]
	DES_tmp[6] = src[index + 5]
	DES_tmp[7] = SHUFFLE_TABLE[src[index + 7]]
	src.set(DES_tmp, index)
	DES_tmp.set(DES_clean)
}

function decodeFull(buf, len, entry_len) {
	const nblocks = len >> 3
	const digits = entry_len.toString().length
	const cycle = digits < 3 ? 3 : digits < 5 ? digits + 1 : digits < 7 ? digits + 9 : digits + 15
	let i, j
	for (i = 0; i < 20 && i < nblocks; ++i) { decryptBlock(buf, i * 8) }
	for (i = 20, j = 0; i < nblocks; ++i) {
		if (i % cycle === 0) { decryptBlock(buf, i * 8); continue }
		if (j === 7) { shuffleDec(buf, i * 8); j = 0 }
		j++
	}
}

function decodeHeader(buf, len) {
	const nblocks = len >> 3
	for (let i = 0; i < 20 && i < nblocks; ++i) { decryptBlock(buf, i * 8) }
}

// Dispatch — mirrors GameFile.js:246-285
const SKIP_EXTENSIONS = /\.(gnd|gat|act|str)$/i
function decodeEntry(buf, type, lengthAligned, packSize, filename) {
	if (type & 0x02) {
		if (SKIP_EXTENSIONS.test(filename)) decodeHeader(buf, lengthAligned)
		else                                decodeFull(buf, lengthAligned, packSize)
		return 'mixed'
	}
	if (type & 0x04) {
		decodeHeader(buf, lengthAligned)
		return 'header'
	}
	return 'plain'
}

// ── CLI parsing ──────────────────────────────────────────────────────
function parseArgs(args) {
	const out = { _: [], opts: {} }
	for (let i = 0; i < args.length; i++) {
		const a = args[i]
		if (a.startsWith('--')) { out.opts[a.slice(2)] = args[i + 1] && !args[i + 1].startsWith('--') ? args[++i] : true }
		else { out._.push(a) }
	}
	return out
}

const { _: positional, opts } = parseArgs(argv.slice(2))
if (!positional.length) {
	console.error('usage: node grf-inspect.mjs <path/to/data.grf> [--filter <regex>] [--ext str,spr,...] [--json] [--count] [--extract <filename>] [--extract-all <dir>] [--force] [--report]')
	exit(1)
}
const grfPath = positional[0]
if (!fs.existsSync(grfPath)) {
	console.error('GRF file not found :', grfPath)
	exit(1)
}

// ── GRF parse ────────────────────────────────────────────────────────
// Header layout (46 bytes) :
//   signature[15] (null-terminated) + key[15] + then version-specific fields.
//   v0x200 : file_table_offset(u32) + skip(u32) + filecount(u32) + version(u32)
//   v0x300 : file_table_offset(u64) + filecount(u32) + version(u32)
const fd = fs.openSync(grfPath, 'r')
const header = Buffer.alloc(46)
fs.readSync(fd, header, 0, 46, 0)

const signature = header.slice(0, 15).toString('latin1').split('\0')[0]
const isV3 = signature === 'Event Horizon'
const isV2 = signature === 'Master of Magic'
if (!isV2 && !isV3) {
	console.error('invalid GRF signature :', JSON.stringify(signature))
	fs.closeSync(fd)
	exit(1)
}

let file_table_offset, filecount, version, tableExtraSkip, entryTrailSize
if (isV3) {
	// v0x300 : pack_offset(u64) at offset 30, filecount(u32) at 38, version(u32) at 42.
	file_table_offset = Number(header.readBigUInt64LE(30))
	filecount         = header.readUInt32LE(38)
	version           = header.readUInt32LE(42)
	tableExtraSkip    = 4   // v0x300 has 4 unknown bytes before the table header
	entryTrailSize    = 21  // pack_size(4) + length_aligned(4) + real_size(4) + type(1) + offset(8)
} else {
	file_table_offset = header.readUInt32LE(30)
	const skip        = header.readUInt32LE(34)
	const raw         = header.readUInt32LE(38)
	version           = header.readUInt32LE(42)
	filecount         = raw - skip - 7
	tableExtraSkip    = 0
	entryTrailSize    = 17  // offset is u32 in v0x200
}
console.error(`[grf] sig="${signature}" version=0x${version.toString(16)} files=${filecount}`)

if (version !== 0x200 && version !== 0x300) {
	console.error('only GRF version 0x200 and 0x300 supported (this one is 0x' + version.toString(16) + ')')
	fs.closeSync(fd)
	exit(1)
}

// File table : pack_size(u32) + real_size(u32) + zlib-deflated payload
const tableStartAbs = 46 + file_table_offset + tableExtraSkip
const tableHeader = Buffer.alloc(8)
fs.readSync(fd, tableHeader, 0, 8, tableStartAbs)
const pack_size = tableHeader.readUInt32LE(0)
const real_size = tableHeader.readUInt32LE(4)
const tableComp = Buffer.alloc(pack_size)
fs.readSync(fd, tableComp, 0, pack_size, tableStartAbs + 8)

const tableInflate = zlib.inflateSync(tableComp)
if (tableInflate.length !== real_size) {
	console.error(`warn: inflate size mismatch (got ${tableInflate.length}, expected ${real_size})`)
}

// Iterate entries.
// Filename : null-terminated, read as latin1 (preserves EUC-KR bytes as
//            codepoints 0x80-0xFF — ASCII substrings stay searchable).
// Trail (v0x200) : pack_size(u32) + length_aligned(u32) + real_size(u32) + type(u8) + offset(u32)
// Trail (v0x300) : same but offset is u64.
const entries = []
let off = 0
while (off < tableInflate.length) {
	const nul = tableInflate.indexOf(0, off)
	if (nul === -1 || nul + 1 + entryTrailSize > tableInflate.length) { break }
	const name = tableInflate.slice(off, nul).toString('latin1')
	const tail = tableInflate.slice(nul + 1, nul + 1 + entryTrailSize)
	const entry = {
		name,
		pack_size:      tail.readUInt32LE(0),
		length_aligned: tail.readUInt32LE(4),
		real_size:      tail.readUInt32LE(8),
		type:           tail.readUInt8(12),
		offset:         isV3 ? Number(tail.readBigUInt64LE(13)) : tail.readUInt32LE(13),
	}
	entries.push(entry)
	off = nul + 1 + entryTrailSize
}
console.error(`[grf] parsed ${entries.length} entries from table (${tableInflate.length} bytes uncompressed)`)

// ── Filter ───────────────────────────────────────────────────────────
let filtered = entries
if (opts.filter) {
	const re = new RegExp(opts.filter, 'i')
	filtered = filtered.filter(e => re.test(e.name))
}
if (opts.ext) {
	const exts = String(opts.ext).toLowerCase().split(',').map(s => s.trim())
	const re = new RegExp('\\.(' + exts.join('|') + ')$', 'i')
	filtered = filtered.filter(e => re.test(e.name))
}

if (opts.count) {
	console.log(`total=${entries.length} filtered=${filtered.length}`)
	fs.closeSync(fd)
	exit(0)
}

if (opts.extract) {
	const target = filtered.find(e => e.name === opts.extract) || entries.find(e => e.name === opts.extract)
	if (!target) { console.error('extract: filename not found exactly :', opts.extract); fs.closeSync(fd); exit(1) }
	// Refuse encrypted entries — DES decryption (GameFileDecrypt) not ported here.
	if (target.type !== 0x01) {
		console.error(`extract: entry "${target.name}" has type=0x${target.type.toString(16)} (encrypted). DES decryption not supported.`)
		fs.closeSync(fd)
		exit(1)
	}
	const compressed = Buffer.alloc(target.length_aligned)
	fs.readSync(fd, compressed, 0, target.length_aligned, 46 + target.offset)
	let data
	try { data = zlib.inflateSync(compressed.slice(0, target.pack_size)) }
	catch (e) { console.error('extract: inflate failed —', e.message); fs.closeSync(fd); exit(1) }
	if (data.length !== target.real_size) {
		console.error(`extract warn: size mismatch (got ${data.length}, expected ${target.real_size})`)
	}
	const outName = target.name.split(/[\\/]/).pop()
	fs.writeFileSync(outName, data)
	console.error(`[grf] wrote ${outName} (${data.length} bytes, type=${target.type})`)
	fs.closeSync(fd)
	exit(0)
}

if (opts['extract-all']) {
	const targetDir = String(opts['extract-all'])
	const force = !!opts.force
	const report = !!opts.report
	fs.mkdirSync(targetDir, { recursive: true })

	let extracted = 0, skipped = 0, failed = 0
	let unencrypted = 0, decryptedHeader = 0, decryptedMixed = 0
	const total = filtered.length

	for (let i = 0; i < total; i++) {
		const target = filtered[i]
		if ((i + 1) % 1000 === 0) {
			console.error(`[extract-all] ${i + 1} / ${total} · last=${target.name}`)
		}

		// Skip directories and empty payloads.
		if (!(target.type & 0x01) || target.length_aligned === 0) { skipped++; continue }

		// Path safety — reject traversal segments.
		const normalised = target.name.replace(/\\/g, '/')
		if (normalised.split('/').some(seg => seg === '..')) {
			console.error(`[extract-all] WARN path traversal rejected : ${target.name}`)
			failed++
			continue
		}

		const outPath = path.join(targetDir, normalised)
		if (!force && fs.existsSync(outPath)) { skipped++; continue }

		const buf = Buffer.alloc(target.length_aligned)
		fs.readSync(fd, buf, 0, target.length_aligned, 46 + target.offset)

		const mode = decodeEntry(buf, target.type, target.length_aligned, target.pack_size, target.name)
		if (mode === 'mixed')       decryptedMixed++
		else if (mode === 'header') decryptedHeader++
		else                        unencrypted++

		let data
		try { data = zlib.inflateSync(buf.slice(0, target.pack_size)) }
		catch (e) {
			console.error(`[extract-all] WARN inflate failed for ${target.name} (type=0x${target.type.toString(16)}) : ${e.message}`)
			failed++
			continue
		}
		if (data.length !== target.real_size) {
			console.error(`[extract-all] WARN size mismatch for ${target.name} : got ${data.length}, expected ${target.real_size}`)
		}

		try {
			fs.mkdirSync(path.dirname(outPath), { recursive: true })
			fs.writeFileSync(outPath, data)
			extracted++
		} catch (e) {
			console.error(`[extract-all] WARN write failed for ${outPath} : ${e.message}`)
			failed++
		}
	}

	fs.closeSync(fd)
	console.error(`[extract-all] done · extracted=${extracted} skipped=${skipped} failed=${failed}`)
	if (report) {
		console.log(`total=${total} decrypted-header=${decryptedHeader} decrypted-mixed=${decryptedMixed} unencrypted=${unencrypted} extracted=${extracted} skipped=${skipped} failed=${failed}`)
	}
	exit(failed === 0 ? 0 : 2)
}

fs.closeSync(fd)

// ── Output ───────────────────────────────────────────────────────────
if (opts.json) {
	stdout.write(JSON.stringify(filtered.map(e => ({ name: e.name, size: e.real_size, type: e.type })), null, 2) + '\n')
} else {
	// Human-readable : grouped by extension, sorted
	const by_ext = {}
	for (const e of filtered) {
		const m = e.name.match(/\.(\w+)$/)
		const ext = (m ? m[1] : 'noext').toLowerCase()
		;(by_ext[ext] ||= []).push(e)
	}
	for (const ext of Object.keys(by_ext).sort()) {
		console.log(`\n=== .${ext} (${by_ext[ext].length}) ===`)
		for (const e of by_ext[ext].sort((a, b) => a.name.localeCompare(b.name))) {
			console.log(`  ${e.name}  [${e.real_size}B type=${e.type}]`)
		}
	}
	console.log(`\n[summary] ${filtered.length} / ${entries.length} entries`)
}
