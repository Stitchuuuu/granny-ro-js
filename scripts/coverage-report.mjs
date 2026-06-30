#!/usr/bin/env node
/**
 * coverage-report.mjs — content-addressed manifest coverage probe.
 *
 * Walks `tests/fixtures/source/` (always) and optionally a user's
 * `${RO_FOLDER}/data.grf` (when set), hashes each .gr2 found, and
 * reports how many shas match the committed content-manifest.json.
 *
 * Use cases :
 *   - "What % of my iRO client's .gr2s are tested ?"  → run with RO_FOLDER.
 *   - "Are the fixtures I just dropped in source/ pinned in the manifest ?"
 *
 * Output : human table by default ; `--json` for machine-readable.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';

import { sha256Hex, walkSourceDir } from './lib/discover-gr2.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, '..');
const GRF_INSPECT = resolve(__dirname, 'lib/grf-inspect.mjs');
const DEFAULT_SOURCE = resolve(PKG_ROOT, 'tests/fixtures/source');
const DEFAULT_MANIFEST = resolve(PKG_ROOT, 'tests/fixtures/content-manifest.json');

function parseArgs(argv) {
    const out = {
        source: DEFAULT_SOURCE,
        manifest: DEFAULT_MANIFEST,
        grf: null,
        json: false,
    };
    for (let i = 2; i < argv.length; i++) {
        const arg = argv[i];
        if (arg === '--source') out.source = resolve(argv[++i]);
        else if (arg === '--manifest') out.manifest = resolve(argv[++i]);
        else if (arg === '--grf') out.grf = resolve(argv[++i]);
        else if (arg === '--json') out.json = true;
        else throw new Error(`unknown arg : ${arg}`);
    }
    if (!out.grf && process.env.RO_FOLDER) {
        const candidate = join(process.env.RO_FOLDER, 'data.grf');
        if (existsSync(candidate)) out.grf = candidate;
    }
    return out;
}

function tabulate(records, manifest) {
    const pinnedShas = new Set(Object.keys(manifest.fixtures));
    let matched = 0;
    let unknown = 0;
    const matchedRecords = [];
    const unknownRecords = [];
    for (const rec of records) {
        if (pinnedShas.has(rec.sha256)) {
            matched++;
            matchedRecords.push({ name: rec.name, sha256: rec.sha256, source: rec.origin });
        } else {
            unknown++;
            unknownRecords.push({ name: rec.name, sha256: rec.sha256, source: rec.origin });
        }
    }
    return { total: records.length, matched, unknown, matchedRecords, unknownRecords };
}

function walkGrfForGr2(grfPath) {
    // Bulk-extract every .gr2 to a temp dir, hash, drop.
    const out = mkdtempSync(join(tmpdir(), 'gr2-coverage-'));
    try {
        const r = spawnSync(
            'node',
            [GRF_INSPECT, grfPath, '--extract-all', out, '--ext', 'gr2'],
            { stdio: ['ignore', 'inherit', 'inherit'] },
        );
        if (r.status !== 0) {
            console.error(`[coverage] grf-inspect extract failed (exit=${r.status}) on ${grfPath}`);
            return [];
        }
        return walkDirRecursive(out, '.gr2').map((p) => {
            const bytes = readFileSync(p);
            return {
                sha256: sha256Hex(bytes),
                name: p.slice(out.length + 1),
                origin: grfPath,
                sizeBytes: bytes.length,
            };
        });
    } finally {
        rmSync(out, { recursive: true, force: true });
    }
}

function walkDirRecursive(dir, ext) {
    const out = [];
    for (const name of readdirSync(dir)) {
        const full = join(dir, name);
        const st = statSync(full);
        if (st.isDirectory()) {
            out.push(...walkDirRecursive(full, ext));
        } else if (name.toLowerCase().endsWith(ext)) {
            out.push(full);
        }
    }
    return out;
}

function main() {
    const opts = parseArgs(process.argv);
    if (!existsSync(opts.manifest)) {
        console.error('[coverage] manifest not found at', opts.manifest);
        process.exit(2);
    }
    const manifest = JSON.parse(readFileSync(opts.manifest, 'utf-8'));
    const pinnedCount = Object.keys(manifest.fixtures).length;

    const records = [];
    if (existsSync(opts.source)) {
        for (const rec of walkSourceDir(opts.source)) {
            records.push({ ...rec, origin: opts.source });
        }
    }
    if (opts.grf) {
        if (!existsSync(opts.grf)) {
            console.error('[coverage] --grf path not found :', opts.grf);
            process.exit(2);
        }
        records.push(...walkGrfForGr2(opts.grf));
    }

    const report = tabulate(records, manifest);
    const summary = {
        manifest: opts.manifest,
        pinnedFixtureCount: pinnedCount,
        scanned: report.total,
        matched: report.matched,
        unknown: report.unknown,
        coveragePct: report.total === 0 ? 0 :
            Math.round((report.matched / report.total) * 1000) / 10,
    };

    if (opts.json) {
        console.log(JSON.stringify({
            summary,
            matched: report.matchedRecords,
            unknown: report.unknownRecords,
        }, null, 2));
    } else {
        console.log(`Manifest: ${opts.manifest} (${pinnedCount} pinned fixtures)`);
        console.log(`Scanned : ${report.total} .gr2 files`);
        if (opts.source) console.log(`           ↳ source/  ${existsSync(opts.source) ? 'walked' : 'absent'}`);
        if (opts.grf)    console.log(`           ↳ ${opts.grf}`);
        console.log(`Matched : ${report.matched}`);
        console.log(`Unknown : ${report.unknown} ${report.unknown > 0 ? '(run `npm run regenerate-manifest` to add)' : ''}`);
        console.log(`Coverage: ${summary.coveragePct}%`);
    }
}

main();
