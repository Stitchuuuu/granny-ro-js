#!/usr/bin/env node
/**
 * test-js.mjs — JS-only content-addressed parity check.
 *
 * Walks `tests/fixtures/source/`, hashes each .gr2, looks up the sha
 * in the manifest, JS-decompresses, and compares each output sha
 * element-by-element (sections[idx], textures[texIdx/imgIdx/mipIdx],
 * meshes[idx], skeletons[idx], animations[idx], materials[idx]).
 *
 * NO wine, NO DLL, NO data.grf needed. This is the JS port contract
 * gate for the `1.0.0` release.
 *
 * Exit codes :
 *   0  all known fixtures pass per-element sha compare
 *   1  one or more known fixtures have mismatches
 *   2  no fixtures found, or manifest load error
 *
 * Flags :
 *   --source   <dir>   .gr2 source directory (default tests/fixtures/source/)
 *   --manifest <path>  manifest path (default tests/fixtures/content-manifest.json)
 *   --quiet            only show failures (otherwise per-fixture summary)
 *   --json             machine-readable JSON output instead of human text
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { walkSourceDir } from './lib/discover-gr2.mjs';
import { buildEntry } from './lib/js-bake.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

// ANSI colors — honor NO_COLOR + only emit on TTY (CI logs stay plain).
const isTTY = process.stderr.isTTY && !process.env.NO_COLOR;
const ansi = (code) => (s) => isTTY ? `\x1b[${code}m${s}\x1b[0m` : s;
const bold    = ansi('1');
const dim     = ansi('2');
const red     = ansi('31');
const green   = ansi('32');
const yellow  = ansi('33');
const cyan    = ansi('36');

const SYM_OK   = isTTY ? '✓' : 'OK';
const SYM_FAIL = isTTY ? '✗' : 'FAIL';
const SYM_SKIP = isTTY ? '?' : '?';
const TAG = bold(cyan('[test-js]'));

const DEFAULTS = {
    source: resolve(PKG_ROOT, 'tests/fixtures/source'),
    manifest: resolve(PKG_ROOT, 'tests/fixtures/content-manifest.json'),
    quiet: false,
    json: false,
};

function parseArgs(argv) {
    const out = { ...DEFAULTS };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--source') out.source = resolve(argv[++i]);
        else if (arg === '--manifest') out.manifest = resolve(argv[++i]);
        else if (arg === '--quiet') out.quiet = true;
        else if (arg === '--json') out.json = true;
        else throw new Error(`unknown arg : ${arg}`);
    }
    return out;
}

function log(opts, ...args) {
    if (opts.json) return;
    if (!opts.quiet) process.stderr.write(TAG + ' ' + args.join(' ') + '\n');
}

function logForce(...args) {
    process.stderr.write(TAG + ' ' + args.join(' ') + '\n');
}

/**
 * Compare two arrays of `{ idx, sha256, ... }` records element-by-element
 * by their identity key. Returns { match, total, mismatches }.
 */
function compareCategory(category, expected, actual, identityKeys, shaKey = 'sha256') {
    const mismatches = [];
    const total = expected.length;
    if (actual.length !== expected.length) {
        mismatches.push({
            kind: 'count',
            category,
            expectedCount: expected.length,
            actualCount: actual.length,
        });
    }
    for (const exp of expected) {
        const expId = identityKeys.map((k) => exp[k]).join('/');
        const act = actual.find((a) => identityKeys.every((k) => a[k] === exp[k]));
        if (!act) {
            mismatches.push({ kind: 'missing', category, id: expId });
            continue;
        }
        if (act[shaKey] !== exp[shaKey]) {
            mismatches.push({
                kind: 'sha-mismatch',
                category,
                id: expId,
                expected: exp[shaKey],
                actual: act[shaKey],
            });
        }
    }
    return { match: mismatches.length === 0, total, mismatches };
}

function compareEntry(expected, actual) {
    const results = {
        sections:   compareCategory('sections',   expected.sections,   actual.sections,   ['idx']),
        textures:   compareCategory('textures',   expected.textures,   actual.textures,   ['texIdx', 'imgIdx', 'mipIdx'], 'rgbaSha256'),
        meshes:     compareCategory('meshes',     expected.meshes,     actual.meshes,     ['idx']),
        skeletons:  compareCategory('skeletons',  expected.skeletons,  actual.skeletons,  ['idx']),
        animations: compareCategory('animations', expected.animations, actual.animations, ['idx']),
        materials:  compareCategory('materials',  expected.materials,  actual.materials,  ['idx']),
    };
    const allMatch = Object.values(results).every((r) => r.match);
    return { match: allMatch, byCategory: results };
}

function fmtCategoryResult(category, r) {
    if (r.total === 0) return dim(`${category} 0`);
    if (r.match) {
        return `${category} ${r.total}/${r.total} ${green(SYM_OK)}`;
    }
    const bad = r.mismatches.filter((m) =>
        m.kind === 'sha-mismatch' || m.kind === 'missing'
    ).length;
    return `${category} ${red(`${r.total - bad}/${r.total}`)} ${red(SYM_FAIL)}`;
}

function main() {
    const opts = parseArgs(process.argv);

    if (!existsSync(opts.manifest)) {
        const msg = `manifest not found at ${opts.manifest}. Run \`npm run regenerate-manifest\` to create it.`;
        if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
            console.error('[test-js] ERROR :', msg);
        }
        process.exit(2);
    }

    const manifest = JSON.parse(readFileSync(opts.manifest, 'utf-8'));
    log(opts, 'loaded manifest', opts.manifest,
        '(' + Object.keys(manifest.fixtures).length + ' pinned fixtures)');

    const fixtures = walkSourceDir(opts.source);
    if (fixtures.length === 0) {
        const msg = `no .gr2 found under ${opts.source}.`;
        if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
            console.error('[test-js] ERROR :', msg);
        }
        process.exit(2);
    }
    log(opts, 'walking', fixtures.length, '.gr2 files from', opts.source);

    const results = [];
    let matched = 0;
    let unknown = 0;
    let passed = 0;
    let failed = 0;

    for (const fixture of fixtures) {
        const expected = manifest.fixtures[fixture.sha256];
        if (!expected) {
            unknown++;
            results.push({
                fixture: fixture.name,
                sha256: fixture.sha256,
                status: 'unknown',
            });
            log(opts, ' ', yellow(SYM_SKIP), fixture.name,
                dim(fixture.sha256.slice(0, 8)),
                dim('(not in manifest)'));
            continue;
        }
        matched++;
        let actual;
        try {
            actual = buildEntry(fixture);
        } catch (err) {
            failed++;
            results.push({
                fixture: fixture.name,
                sha256: fixture.sha256,
                status: 'extract-fail',
                error: err.message,
            });
            log(opts, ' ', red(SYM_FAIL), bold(fixture.name),
                red('— extract failed :'), err.message);
            continue;
        }
        const cmp = compareEntry(expected, actual);
        const result = {
            fixture: fixture.name,
            sha256: fixture.sha256,
            status: cmp.match ? 'pass' : 'fail',
            categories: Object.fromEntries(
                Object.entries(cmp.byCategory).map(([k, v]) => [k, {
                    total: v.total,
                    mismatches: v.mismatches,
                }])
            ),
        };
        results.push(result);
        if (cmp.match) {
            passed++;
            const cats = Object.entries(cmp.byCategory)
                .map(([k, v]) => fmtCategoryResult(k, v))
                .filter((s) => !s.endsWith(' 0'))
                .join(', ');
            log(opts, ' ', green(SYM_OK), fixture.name, dim('—'), cats);
        } else {
            failed++;
            const cats = Object.entries(cmp.byCategory)
                .map(([k, v]) => fmtCategoryResult(k, v))
                .join(', ');
            log(opts, ' ', red(SYM_FAIL), bold(fixture.name), dim('—'), cats);
            if (!opts.quiet) {
                for (const cat of Object.values(cmp.byCategory)) {
                    for (const m of cat.mismatches) {
                        process.stderr.write('     ' + red(JSON.stringify(m)) + '\n');
                    }
                }
            }
        }
    }

    const summary = {
        ok: failed === 0,
        manifest: opts.manifest,
        source: opts.source,
        totals: {
            discovered: fixtures.length,
            matched,
            unknown,
            passed,
            failed,
        },
        results,
    };

    if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        // Final summary line always shown (even with --quiet).
        const passSeg = failed === 0
            ? green(`${passed}/${matched} pass`)
            : `${passed}/${matched} pass`;
        const failSeg = failed === 0
            ? dim(`${failed} fail`)
            : red(bold(`${failed} fail`));
        const skipSeg = unknown === 0
            ? dim(`${unknown} unknown`)
            : yellow(`${unknown} unknown`);
        const head = failed === 0 ? green(SYM_OK) : red(SYM_FAIL);
        logForce(`${head} summary : ${passSeg}, ${failSeg}, ${skipSeg} ${dim('(not in manifest)')}`);
    }
    process.exitCode = failed === 0 ? 0 : 1;
}

main();
