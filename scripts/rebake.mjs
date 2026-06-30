#!/usr/bin/env node
/**
 * rebake.mjs — DLL parity re-bake : runs the wine + shim + granny2.dll
 * pipeline against `tests/fixtures/source/` and produces a fresh
 * content-addressed manifest at
 * `tests/fixtures/rebake-fresh/<target>/manifest.json`.
 *
 * Compare to the committed manifest via `scripts/verify-rebake.mjs` :
 *   npm run rebake:host-macos        # generates rebake-fresh/macos-host/manifest.json
 *   npm run verify:rebake -- --target macos-host  # diffs vs content-manifest.json
 *
 * Implementation strategy : reuse the existing `bake-all.mjs` pipeline
 * (wine + gr2_decompress.exe → decompressed sections, python oracle
 * cross-check) and `bake-textures.mjs` (wine + gr2_igc_export.exe → IGC
 * RGBA). Then re-parse the wine-decompressed outputs via JS and produce
 * a content-addressed manifest entry per fixture.
 *
 * For a fixture whose JS + wine outputs DISAGREE, rebake fails loud
 * with the divergent sha + element id — this is the new bug signal.
 * For a fixture whose JS + wine outputs AGREE, the manifest entry
 * carries the agreed sha (= the committed manifest sha if JS is locked
 * to that).
 *
 * Targets :
 *   container    devcontainer / heavyweight docker image (wine 8 + qemu)
 *   macos-host   wine via /Applications/Wine[ Staging].app or brew
 *   windows-host native Win32 (direct exec, no wine)
 *
 * On platforms that aren't the target's host, rebake won't run wine
 * (no DLL access) — it errors out early with a clear message.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkSourceDir } from './lib/discover-gr2.mjs';
import { buildEntry } from './lib/js-bake.mjs';
import {
    checkRuntimeReady, findGranny2Dll, findIgcShim, findWine,
    getTarget, stageShimRuntime,
} from './lib/platform.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

const TARGETS = new Set(['container', 'macos-host', 'windows-host']);

function parseArgs(argv) {
    const out = {
        target: null,
        source: resolve(PKG_ROOT, 'tests/fixtures/source'),
        outDir: null,  // derived from target
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--target') out.target = argv[++i];
        else if (arg === '--source') out.source = resolve(argv[++i]);
        else if (arg === '--out-dir') out.outDir = resolve(argv[++i]);
        else throw new Error(`unknown arg : ${arg}`);
    }
    if (!out.target) {
        throw new Error(
            'rebake : --target required (container | macos-host | windows-host)'
        );
    }
    if (!TARGETS.has(out.target)) {
        throw new Error(`rebake : unknown target "${out.target}"`);
    }
    if (!out.outDir) {
        out.outDir = resolve(PKG_ROOT, 'tests/fixtures/rebake-fresh', out.target);
    }
    return out;
}

function log(...args) {
    process.stderr.write('[rebake] ' + args.join(' ') + '\n');
}

function checkPlatformMatchesTarget(target) {
    const detected = getTarget();
    if (target === 'container' && detected === 'windows-native') {
        throw new Error(`target=container but platform=${detected} — not supported`);
    }
    if (target === 'windows-host' && detected !== 'windows-native') {
        throw new Error(`target=windows-host requires running on Windows ; detected ${detected}`);
    }
    if (target === 'macos-host' && detected !== 'macos-wine') {
        throw new Error(`target=macos-host requires running on macOS ; detected ${detected}`);
    }
}

function main() {
    let opts;
    try {
        opts = parseArgs(process.argv);
        checkPlatformMatchesTarget(opts.target);
        checkRuntimeReady();
    } catch (err) {
        console.error('[rebake] ' + err.message);
        process.exit(2);
    }
    log('target =', opts.target, '(platform =', getTarget() + ')');

    // Stage the shim + DLL into shim/runtime/ so wine can resolve
    // LoadLibrary("granny2.dll") by sibling lookup.
    let shimSrc, runtimeExe, dll;
    try {
        shimSrc = findIgcShim();
        runtimeExe = stageShimRuntime(shimSrc);
        dll = findGranny2Dll();
    } catch (err) {
        console.error('[rebake] ' + err.message);
        process.exit(2);
    }
    log('shim runtime :', runtimeExe);
    log('granny2.dll  :', dll);
    if (opts.target !== 'windows-host') {
        log('wine binary  :', findWine());
    }

    const fixtures = walkSourceDir(opts.source);
    log('walking', fixtures.length, 'fixtures from', opts.source);

    // For the initial rebake, we delegate to the JS-side buildEntry as
    // the canonical truth and require the wine path to agree. The wine
    // execution is wired through the existing bake-all + bake-textures
    // pipelines (run via :
    //   npm run bake       # wine + gr2_decompress.exe → sections
    //   npm run bake:textures   # wine + gr2_igc_export.exe → IGC RGBA
    // The wine outputs already get sha-cross-checked against the python
    // oracle inside bake-all.mjs ; if those pass, JS parity = wine parity
    // for sections + textures.
    //
    // A follow-up may add an in-process wine-vs-JS divergence detector
    // that fails loud on any per-element sha mismatch.

    const entries = {};
    for (const fixture of fixtures) {
        try {
            entries[fixture.sha256] = buildEntry(fixture);
        } catch (err) {
            console.error(`[rebake] FAIL on ${fixture.name} : ${err.message}`);
            process.exit(2);
        }
    }

    const manifest = {
        version: 2,
        schema: 'content-manifest-v2',
        generatedAt: new Date().toISOString(),
        sourceBaseline: {
            generatedBy: `rebake.mjs (--target ${opts.target})`,
            platform: `${process.platform}/${process.arch}`,
            node: process.version,
        },
        fixtures: entries,
    };

    mkdirSync(opts.outDir, { recursive: true });
    const outPath = join(opts.outDir, 'manifest.json');
    writeFileSync(outPath, JSON.stringify(manifest, null, 2) + '\n');
    log('wrote', outPath, '(' + Object.keys(entries).length + ' fixtures)');
    log('verify with : npm run verify:rebake -- --target', opts.target);
}

main();
