#!/usr/bin/env node
/**
 * dump-baked-texture-png.mjs — convert a baked .rgba file (raw
 * RGBA8888, W*H*4 bytes) into a PNG for visual eye-test.
 *
 * No new dependencies — uses Node's built-in `zlib.deflateSync` for
 * the IDAT chunk and a hand-rolled PNG header per the spec
 * (https://www.w3.org/TR/PNG-Chunks/).
 *
 * Usage :
 *   node scripts/dump-baked-texture-png.mjs <baked.rgba> <W> <H> <out.png>
 *
 * Throwaway eye-test tool — not part of the public granny-ro-js
 * surface, lives in scripts/ next to the bake driver.
 */

import { deflateSync } from 'node:zlib';
import { readFileSync, writeFileSync } from 'node:fs';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {
            c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        }
        t[n] = c >>> 0;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) {
        c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    }
    return (c ^ 0xffffffff) >>> 0;
}

function writeChunk(typeStr, data) {
    const type = Buffer.from(typeStr, 'ascii');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const crcInput = Buffer.concat([type, data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(crcInput), 0);
    return Buffer.concat([len, type, data, crc]);
}

function buildPNG(width, height, rgbaBytes) {
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr.writeUInt8(8, 8);    // bit depth
    ihdr.writeUInt8(6, 9);    // color type = truecolor + alpha (RGBA)
    ihdr.writeUInt8(0, 10);   // compression = deflate
    ihdr.writeUInt8(0, 11);   // filter = none/default
    ihdr.writeUInt8(0, 12);   // interlace = none

    // Filter byte 0 (None) prepended to each scanline.
    const stride = width * 4;
    const raw = Buffer.alloc(height * (stride + 1));
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0;
        rgbaBytes.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const idat = deflateSync(raw);

    return Buffer.concat([
        PNG_SIGNATURE,
        writeChunk('IHDR', ihdr),
        writeChunk('IDAT', idat),
        writeChunk('IEND', Buffer.alloc(0)),
    ]);
}

function main() {
    if (process.argv.length !== 6) {
        process.stderr.write('usage: dump-baked-texture-png.mjs <in.rgba> <W> <H> <out.png>\n');
        process.exit(2);
    }
    const [, , inPath, wStr, hStr, outPath] = process.argv;
    const width = parseInt(wStr, 10);
    const height = parseInt(hStr, 10);
    const rgba = readFileSync(inPath);
    if (rgba.length !== width * height * 4) {
        process.stderr.write(
            `ERROR: ${inPath} has ${rgba.length} bytes, expected ${width * height * 4} ` +
            `(${width}×${height} RGBA)\n`,
        );
        process.exit(3);
    }
    const png = buildPNG(width, height, rgba);
    writeFileSync(outPath, png);
    process.stderr.write(`wrote ${png.length} bytes -> ${outPath}\n`);
}

main();
