// Helper : parse the C-shim's baked output. Layout mirrors the input
// header up through the section array (see iRO_ver12.../shim/gr2_decompress.c).
// The shim writes every section with compression=0 + data_size == expanded_size,
// so we can slice each section's bytes back out from data_offset/data_size.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

/**
 * @param {string} bakedPath
 * @returns {Array<{index:number, decompressed_size:number, sha256:string, bytes:Uint8Array}>}
 */
export function parseBakedSections(bakedPath) {
    const data = readFileSync(bakedPath);
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const sectionArrayOffset = 0x20 + view.getUint32(0x2C, true);
    const sectionCount = view.getUint32(0x30, true);
    const out = [];
    for (let i = 0; i < sectionCount; i++) {
        const off = sectionArrayOffset + i * 44;
        const compression  = view.getUint32(off + 0,  true);
        const dataOffset   = view.getUint32(off + 4,  true);
        const dataSize     = view.getUint32(off + 8,  true);
        const expandedSize = view.getUint32(off + 12, true);
        if (compression !== 0) {
            throw new Error(
                `baked section ${i} of ${bakedPath} has compression=${compression}, expected 0`
            );
        }
        if (dataSize !== expandedSize) {
            throw new Error(
                `baked section ${i} of ${bakedPath} has data_size=${dataSize} ` +
                `!= expanded_size=${expandedSize}`
            );
        }
        const bytes = data.subarray(dataOffset, dataOffset + dataSize);
        out.push({ index: i, decompressed_size: dataSize, sha256: sha256(bytes), bytes });
    }
    return out;
}
