#!/usr/bin/env node
/**
 * bake-textures.mjs — bake canonical RGBA8888 pixel data for every
 * texture / image / MIP in the iRO ver12 model fixtures, via the
 * `_GrannyDecompressIGCTexture@12` Wine shim.
 *
 * Output layout (under <BAKED>) :
 *   <fixture-stem>/tex<I>-img<J>-mip<K>.rgba   raw RGBA8888 (W * H * 4 bytes)
 *
 * Manifest entries (written to <MANIFEST>) gain a `textures` field, one
 * record per baked MIP :
 *   {
 *     fixture,        # parent .gr2 name (e.g. "treasurebox_2.gr2")
 *     name,           # texture's FromFileName (e.g. "C:\\Treasure chest.TIF")
 *     tex_idx, img_idx, mip_idx,
 *     width, height,
 *     encoding,       # 1 = Raw, 3 = IGC ; 2 (S3TC) skipped with note
 *     alpha,          # inferred from texture.Layout.BytesPerPixel
 *     pixel_bytes,    # bytes consumed from the .gr2 ("Pixels" array length)
 *     rgba_path,      # path to the baked .rgba file (relative to BAKED)
 *     rgba_sha256     # hex sha256 of the baked RGBA bytes
 *   }
 *
 * Two encoding branches :
 *   - **Encoding = 1 (Raw)** : the on-disk Pixels bytes are already 32bpp
 *     BGRA (per [IGC-FORMAT.md § 6](../../iRO_ver12.0-full-client-data/RE/granny2/IGC-FORMAT.md)).
 *     Swizzle to RGBA in JS, no shim call.
 *   - **Encoding = 3 (IGC)** : write the Pixels bytes to a tempfile, invoke
 *     `wine gr2_igc_export.exe <tmp.bin> <W> <H> <alpha> <out.rgba>`,
 *     read back the result. Per [IGC-FORMAT.md § 4 + § 7](../../iRO_ver12.0-full-client-data/RE/granny2/IGC-FORMAT.md)
 *     for the algorithm.
 *
 * Usage :
 *   node scripts/bake-textures.mjs [--source <dir>] [--output <dir>] [--manifest <path>] [--no-wine]
 *
 * Defaults :
 *   --source    tests/fixtures/source
 *   --output    tests/fixtures/baked/textures
 *   --manifest  tests/fixtures/manifest.json
 *
 * With `--no-wine`, the IGC bake is skipped — only the Raw path (the
 * 16×16 emblem) lands. Useful for unit-testing the driver shape without
 * running Wine.
 *
 * The shim binary is found via `GR2_IGC_EXPORT_EXE` env (Docker
 * convention, mirrors the existing `GR2_DECOMPRESS_EXE`) or falls back
 * to `/shim/gr2_igc_export.exe` (Dockerfile install location).
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
    existsSync, mkdirSync, readdirSync, readFileSync, statSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseGR2File } from '../src/GrannyFile.js';
import {
    loadGR2, parseTypeTree, parseObject, readReferenceArrayObjects,
} from '../src/GrannyTypeTree.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, '..');
const DEFAULTS = {
    source: resolve(PKG_ROOT, 'tests/fixtures/source'),
    output: resolve(PKG_ROOT, 'tests/fixtures/baked/textures'),
    manifest: resolve(PKG_ROOT, 'tests/fixtures/manifest.json'),
    shim: process.env.GR2_IGC_EXPORT_EXE ?? '/shim/gr2_igc_export.exe',
};

const ENCODING_RAW = 1;
const ENCODING_S3TC = 2;
const ENCODING_IGC = 3;

function parseArgs(argv) {
    const out = { ...DEFAULTS, noWine: false };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--source') out.source = resolve(argv[++i]);
        else if (arg === '--output') out.output = resolve(argv[++i]);
        else if (arg === '--manifest') out.manifest = resolve(argv[++i]);
        else if (arg === '--shim') out.shim = resolve(argv[++i]);
        else if (arg === '--no-wine') out.noWine = true;
        else throw new Error(`unknown arg : ${arg}`);
    }
    return out;
}

function sha256Hex(buf) {
    return createHash('sha256').update(buf).digest('hex');
}

function ensureDir(path) {
    if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function log(...args) {
    process.stderr.write('[bake-textures] ' + args.join(' ') + '\n');
}

// --- type-tree walk : textures + images + mip levels -------------------

/**
 * Walk a loaded .gr2 → return one record per (texture, image, mip).
 * Each record carries Width, Height, Encoding, Alpha + the raw Pixels
 * bytes ready for encoding-dispatch. Doesn't decode anything ; that's
 * the bake-driver's job.
 */
function extractRawTextures(loaded) {
    const file = loaded.file;
    const rootTypeTree = parseTypeTree(loaded, file.header.root_type);
    const root = parseObject(loaded, rootTypeTree, file.header.root_object, { maxArrayRefs: 256 });
    const texField = root.Textures;
    if (!texField || !texField.reference_type) return [];

    const textureType = texField.reference_type;
    const textureRefs = texField.element_refs ?? [];
    if (textureRefs.length === 0) return [];

    const texMembers = parseTypeTree(loaded, [textureType.section, textureType.offset]);
    const records = [];

    for (let ti = 0; ti < textureRefs.length; ti++) {
        const texRef = textureRefs[ti];
        if (!texRef) continue;
        const texFields = parseObject(loaded, texMembers, [texRef.section, texRef.offset], { maxArrayRefs: 64 });
        const width = texFields.Width?.value ?? 0;
        const height = texFields.Height?.value ?? 0;
        const encoding = texFields.Encoding?.value ?? 0;
        const subFormat = texFields.SubFormat?.value ?? 0;
        const fromFileName = texFields.FromFileName?.value ?? '';
        const alpha = readAlphaFromLayout(loaded, texMembers, texFields, texRef);

        const imagesField = texFields.Images;
        const imageType = imagesField?.reference_type ?? null;
        const images = imageType ? readReferenceArrayObjects(
            loaded,
            imagesField.target ?? null,
            imagesField.count ?? 0,
            imageType,
            { maxCount: 8 },
        ) : [];

        for (let ii = 0; ii < images.length; ii++) {
            const imgFields = images[ii].fields;
            const mipsField = imgFields.MIPLevels;
            const mipType = mipsField?.reference_type ?? null;
            const mips = mipType ? readReferenceArrayObjects(
                loaded,
                mipsField.target ?? null,
                mipsField.count ?? 0,
                mipType,
                { maxCount: 32 },
            ) : [];

            for (let mi = 0; mi < mips.length; mi++) {
                const mipFields = mips[mi].fields;
                const pixelField = mipFields.Pixels ?? mipFields.PixelBytes;
                const pixelCount = pixelField?.count ?? 0;
                const pixelTarget = pixelField?.target ?? null;
                let pixelBytes = null;
                if (pixelTarget && pixelCount > 0) {
                    const section = loaded.sectionsOriginal[pixelTarget.section];
                    if (section
                        && pixelTarget.offset >= 0
                        && pixelTarget.offset + pixelCount <= section.length) {
                        pixelBytes = section.subarray(pixelTarget.offset, pixelTarget.offset + pixelCount);
                    }
                }
                records.push({
                    texIdx: ti,
                    imgIdx: ii,
                    mipIdx: mi,
                    width,
                    height,
                    encoding,
                    subFormat,
                    alpha,
                    fromFileName,
                    pixelBytes,
                    pixelCount,
                });
            }
        }
    }
    return records;
}

/**
 * Infer Alpha (0 / 1) from the Texture's inline Layout struct. The
 * Layout's BytesPerPixel field is the first 4 bytes ; 4 = RGBA → alpha,
 * 3 = RGB → no alpha. Falls back to 1 (assume alpha) if unreadable —
 * IGC fixtures in iRO all set BinkEncodeAlpha so the default matches
 * the corpus.
 */
function readAlphaFromLayout(loaded, texMembers, texFields, texRef) {
    try {
        const layoutField = texFields.Layout;
        if (!layoutField || layoutField.type !== 'inline') return 1;
        let layoutMember = null;
        for (let i = 0; i < texMembers.length; i++) {
            if (texMembers[i].name === 'Layout') {
                layoutMember = texMembers[i];
                break;
            }
        }
        if (!layoutMember || !layoutMember.referenceType) return 1;
        const refSection = layoutMember.referenceType.section;
        if (!loaded.sectionsOriginal[refSection]) return 1;
        const layoutMembers = parseTypeTree(loaded, [refSection, layoutMember.referenceType.offset]);
        const layoutOffset = layoutField.offset ?? 0;
        const layoutFields = parseObject(loaded, layoutMembers, [texRef.section, texRef.offset + layoutOffset]);
        const bpp = layoutFields.BytesPerPixel?.value;
        return bpp === 3 ? 0 : 1;
    } catch {
        return 1;
    }
}

// --- encoding dispatch -------------------------------------------------

/**
 * Encoding=1 (Raw) — on-disk PixelBytes are 32bpp BGRA per
 * IGC-FORMAT.md § 6. Swizzle to RGBA8888 in place (no shim call).
 */
function bakeRaw(record) {
    const { width, height, pixelBytes } = record;
    const expected = width * height * 4;
    if (!pixelBytes || pixelBytes.length !== expected) {
        throw new Error(`bake-textures: Raw MIP byte count ${pixelBytes?.length} != W*H*4 (${expected}) for ${describe(record)}`);
    }
    const rgba = new Uint8Array(expected);
    for (let i = 0; i < expected; i += 4) {
        rgba[i] = pixelBytes[i + 2];      // R from B-slot
        rgba[i + 1] = pixelBytes[i + 1];  // G unchanged
        rgba[i + 2] = pixelBytes[i];      // B from R-slot
        rgba[i + 3] = pixelBytes[i + 3];  // A unchanged
    }
    return rgba;
}

/**
 * Encoding=3 (IGC) — write the IGC bitstream to a tempfile, invoke
 * the Wine shim, read back the RGBA result. Shim CWD is the directory
 * containing the .exe so `LoadLibrary("granny2.dll")` resolves by
 * sibling lookup ; granny2.dll must live next to the binary.
 */
function bakeIGC(record, shimExe, tmpDir) {
    const { width, height, alpha, pixelBytes } = record;
    if (!pixelBytes) {
        throw new Error(`bake-textures: IGC MIP has no Pixels bytes for ${describe(record)}`);
    }
    const stem = `${describe(record).replace(/[^A-Za-z0-9._-]/g, '_')}`;
    const inBin = join(tmpDir, `${stem}.bin`);
    const outRgba = join(tmpDir, `${stem}.rgba`);
    writeFileSync(inBin, pixelBytes);

    const result = spawnSync(
        'wine',
        [shimExe, inBin, String(width), String(height), String(alpha), outRgba],
        {
            cwd: dirname(shimExe),
            stdio: ['ignore', 'pipe', 'pipe'],
            env: { ...process.env, WINEDEBUG: '-all' },
        },
    );
    if (result.status !== 0) {
        throw new Error(`wine shim failed for ${describe(record)} : ` +
            `exit=${result.status} stderr=${result.stderr?.toString()}`);
    }
    const rgba = readFileSync(outRgba);
    const expected = width * height * 4;
    if (rgba.length !== expected) {
        throw new Error(`shim output ${rgba.length} != W*H*4 (${expected}) for ${describe(record)}`);
    }
    return new Uint8Array(rgba);
}

function describe(record) {
    return `tex${record.texIdx}-img${record.imgIdx}-mip${record.mipIdx}`;
}

// --- driver ------------------------------------------------------------

function fixtureStem(name) {
    return basename(name).replace(/\.gr2$/i, '');
}

function bakeFixture(fixturePath, baked, options) {
    const buf = readFileSync(fixturePath);
    const file = parseGR2File(buf);
    const loaded = loadGR2(file);
    const records = extractRawTextures(loaded);
    const stem = fixtureStem(fixturePath);
    const fixtureDir = join(baked, stem);
    ensureDir(fixtureDir);

    const tmpRoot = join(tmpdir(), `granny-bake-${process.pid}-${stem}`);
    ensureDir(tmpRoot);

    const out = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        let rgba = null;
        if (record.encoding === ENCODING_RAW) {
            rgba = bakeRaw(record);
        } else if (record.encoding === ENCODING_S3TC) {
            log(`skip S3TC : ${stem}/${describe(record)} (encoding=2 not in iRO corpus)`);
            continue;
        } else if (record.encoding === ENCODING_IGC) {
            if (options.noWine) {
                log(`skip IGC (--no-wine) : ${stem}/${describe(record)}`);
                continue;
            }
            rgba = bakeIGC(record, options.shim, tmpRoot);
        } else {
            log(`skip unknown encoding=${record.encoding} : ${stem}/${describe(record)}`);
            continue;
        }
        const fileName = `${describe(record)}.rgba`;
        const rgbaPath = join(fixtureDir, fileName);
        writeFileSync(rgbaPath, rgba);
        out.push({
            fixture: basename(fixturePath),
            name: record.fromFileName,
            tex_idx: record.texIdx,
            img_idx: record.imgIdx,
            mip_idx: record.mipIdx,
            width: record.width,
            height: record.height,
            encoding: record.encoding,
            alpha: record.alpha,
            pixel_bytes: record.pixelCount,
            rgba_path: `${stem}/${fileName}`,
            rgba_sha256: sha256Hex(rgba),
        });
        log(`baked ${stem}/${fileName} (${rgba.length} bytes, enc=${record.encoding})`);
    }
    return out;
}

function main() {
    const opts = parseArgs(process.argv);
    if (!existsSync(opts.source)) {
        throw new Error(`source dir not found : ${opts.source}`);
    }
    if (!opts.noWine && !existsSync(opts.shim)) {
        throw new Error(`shim binary not found : ${opts.shim} ` +
            `(set GR2_IGC_EXPORT_EXE or pass --shim)`);
    }
    ensureDir(opts.output);

    // Skip animation-only fixtures (they share the granny root schema so
    // the Textures field exists, but the count is 0 — guarded inside the
    // walker via texField.element_refs check, but the filename filter is
    // a faster pre-screen and matches the existing GrannyMesh.test.js
    // convention).
    const ANIMATION_RX = /^\d+_(attack|damage|dead|move)\.gr2$/;
    const fixtures = readdirSync(opts.source)
        .filter((name) => name.toLowerCase().endsWith('.gr2'))
        .filter((name) => !ANIMATION_RX.test(name))
        .sort();
    log(`source=${opts.source} fixtures=${fixtures.length} (animation files filtered out)`);

    const allEntries = [];
    for (const name of fixtures) {
        const path = join(opts.source, name);
        try {
            const entries = bakeFixture(path, opts.output, opts);
            allEntries.push(...entries);
        } catch (err) {
            log(`ERROR ${name} : ${err.message}`);
            throw err;
        }
    }

    // Merge into manifest.json if it exists ; otherwise write a standalone
    // textures.json next to the baked dir.
    if (existsSync(opts.manifest)) {
        const manifest = JSON.parse(readFileSync(opts.manifest, 'utf8'));
        manifest.textures = allEntries;
        writeFileSync(opts.manifest, JSON.stringify(manifest, null, 2) + '\n');
        log(`updated manifest ${opts.manifest} with ${allEntries.length} texture entries`);
    } else {
        const fallback = resolve(opts.output, 'textures.json');
        writeFileSync(fallback, JSON.stringify({ textures: allEntries }, null, 2) + '\n');
        log(`wrote ${fallback} (manifest.json not present)`);
    }
}

main();
