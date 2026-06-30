#!/usr/bin/env node
/**
 * verify-rebake.mjs — element-by-element sha diff between a freshly-baked
 * per-target manifest and the committed content manifest.
 *
 * The rebake driver writes :
 *     tests/fixtures/rebake-fresh/<target>/manifest.json
 *
 * This script loads it + the committed manifest and reports per-fixture
 * per-element divergences. Exits non-zero on any mismatch.
 *
 * Flags :
 *   --target   <name>  rebake-fresh subdirectory (container|macos-host|windows-host)
 *   --manifest <path>  committed manifest path (default tests/fixtures/content-manifest.json)
 *   --json             machine-readable JSON output
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');

/**
 * Parse CLI args. Returns `{ target, manifest, json }`.
 *
 * @param {string[]} argv argv array including node + script
 * @returns {{ target: string, manifest: string, json: boolean }}
 */
function parseArgs(argv) {
    const out = {
        target: null,
        manifest: resolve(PKG_ROOT, 'tests/fixtures/content-manifest.json'),
        json: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--target') out.target = argv[++i];
        else if (arg === '--manifest') out.manifest = resolve(argv[++i]);
        else if (arg === '--json') out.json = true;
        else throw new Error(`unknown arg : ${arg}`);
    }
    if (!out.target) {
        throw new Error('verify-rebake : --target required');
    }
    return out;
}

/**
 * Compare two manifest entries category-by-category. Returns
 * `{ match, mismatches }` ; `mismatches` is a flat array of
 * `{ category, id, expected, actual, kind }` records.
 *
 * @param {object} expected entry from the committed manifest
 * @param {object} actual entry from the freshly-baked manifest
 */
function compareEntry(expected, actual) {
    const mismatches = [];
    const compare = (category, expArr, actArr, idKeys, shaKey) => {
        for (const exp of expArr) {
            const id = idKeys.map((k) => exp[k]).join('/');
            const act = actArr.find((a) => idKeys.every((k) => a[k] === exp[k]));
            if (!act) {
                mismatches.push({ category, id, kind: 'missing-in-rebake' });
                continue;
            }
            if (act[shaKey] !== exp[shaKey]) {
                mismatches.push({
                    category, id, kind: 'sha-mismatch',
                    expected: exp[shaKey], actual: act[shaKey],
                });
            }
        }
    };
    compare('sections',   expected.sections   ?? [], actual.sections   ?? [], ['idx'], 'sha256');
    compare('textures',   expected.textures   ?? [], actual.textures   ?? [], ['texIdx', 'imgIdx', 'mipIdx'], 'rgbaSha256');
    compare('meshes',     expected.meshes     ?? [], actual.meshes     ?? [], ['idx'], 'sha256');
    compare('skeletons',  expected.skeletons  ?? [], actual.skeletons  ?? [], ['idx'], 'sha256');
    compare('animations', expected.animations ?? [], actual.animations ?? [], ['idx'], 'sha256');
    compare('materials',  expected.materials  ?? [], actual.materials  ?? [], ['idx'], 'sha256');
    return { match: mismatches.length === 0, mismatches };
}

function main() {
    const opts = parseArgs(process.argv);
    const rebakePath = resolve(PKG_ROOT, 'tests/fixtures/rebake-fresh', opts.target, 'manifest.json');

    if (!existsSync(rebakePath)) {
        const msg = `rebake artifact not found at ${rebakePath}. ` +
                    `Run \`npm run rebake:${opts.target}\` first.`;
        if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
            console.error('[verify-rebake]', msg);
        }
        process.exit(2);
    }
    if (!existsSync(opts.manifest)) {
        const msg = `committed manifest not found at ${opts.manifest}.`;
        if (opts.json) {
            console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
        } else {
            console.error('[verify-rebake]', msg);
        }
        process.exit(2);
    }

    const committed = JSON.parse(readFileSync(opts.manifest, 'utf-8'));
    const fresh = JSON.parse(readFileSync(rebakePath, 'utf-8'));

    const reports = [];
    let passed = 0;
    let failed = 0;
    let unknown = 0;
    for (const sha of Object.keys(committed.fixtures)) {
        const expected = committed.fixtures[sha];
        const actual = fresh.fixtures[sha];
        if (!actual) {
            unknown++;
            reports.push({ sha256: sha, filenameHint: expected.filenameHint, status: 'unknown-in-rebake' });
            continue;
        }
        const cmp = compareEntry(expected, actual);
        if (cmp.match) {
            passed++;
            reports.push({ sha256: sha, filenameHint: expected.filenameHint, status: 'pass' });
        } else {
            failed++;
            reports.push({
                sha256: sha,
                filenameHint: expected.filenameHint,
                status: 'fail',
                mismatches: cmp.mismatches,
            });
        }
    }

    const summary = {
        ok: failed === 0,
        target: opts.target,
        committedManifest: opts.manifest,
        rebakeManifest: rebakePath,
        totals: {
            committedFixtures: Object.keys(committed.fixtures).length,
            rebakeFixtures: Object.keys(fresh.fixtures).length,
            passed,
            failed,
            unknown,
        },
        reports,
    };

    if (opts.json) {
        console.log(JSON.stringify(summary, null, 2));
    } else {
        console.log(
            `target=${opts.target} : ${passed} pass, ${failed} fail, ` +
            `${unknown} unknown`
        );
        for (const r of reports) {
            if (r.status === 'pass') continue;
            console.log(`  ${r.status === 'fail' ? '✗' : '?'} ${r.filenameHint} (${r.sha256.slice(0, 8)})`);
            if (r.mismatches) {
                for (const m of r.mismatches) {
                    console.log(`     ${m.category}[${m.id}] : ${m.kind}` +
                        (m.expected ? ` expected=${m.expected.slice(0, 8)} actual=${m.actual.slice(0, 8)}` : ''));
                }
            }
        }
    }
    process.exit(failed === 0 ? 0 : 1);
}

main();
