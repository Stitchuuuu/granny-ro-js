// Unit tests for the public dispatcher.

import { describe, it, expect } from 'vitest';
import { decompressSection, COMPRESSION_NONE, COMPRESSION_OODLE0 } from '../../src/Granny.js';

describe('decompressSection — dispatcher', () => {
    it('returns an empty Uint8Array when expanded_size === 0', () => {
        const result = decompressSection(
            { index: 1, compression: COMPRESSION_OODLE0, expanded_size: 0,
              first_16bit: 0, first_8bit: 0 },
            new Uint8Array([1, 2, 3, 4]),
        );
        expect(result).toBeInstanceOf(Uint8Array);
        expect(result.length).toBe(0);
    });
    it('handles NoCompression by returning the leading expanded_size bytes', () => {
        const compressed = new Uint8Array([0xAA, 0xBB, 0xCC, 0xDD, 0xEE, 0xFF]);
        const result = decompressSection(
            { index: 5, compression: COMPRESSION_NONE, expanded_size: 4,
              first_16bit: 0, first_8bit: 0 },
            compressed,
        );
        expect(Array.from(result)).toEqual([0xAA, 0xBB, 0xCC, 0xDD]);
    });
    it('throws RangeError when NoCompression input is shorter than expanded_size', () => {
        expect(() =>
            decompressSection(
                { index: 5, compression: COMPRESSION_NONE, expanded_size: 100,
                  first_16bit: 0, first_8bit: 0 },
                new Uint8Array(10),
            )
        ).toThrow(/short:/);
    });
    it('throws on unsupported compression types (Oodle1, BitKnit, BitKnit2)', () => {
        for (const comp of [2, 3, 4, 99]) {
            expect(() =>
                decompressSection(
                    { index: 0, compression: comp, expanded_size: 100,
                      first_16bit: 0, first_8bit: 0 },
                    new Uint8Array(100),
                )
            ).toThrow(/unsupported compression/);
        }
    });
});
