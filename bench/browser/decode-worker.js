// decode-worker.js — off-thread decode axis (like roBrowser decodes in a
// Worker so it never hitches the render loop).
//
// A module worker : imports the SAME single-file build the main-thread axis
// uses, so decode speed is apples-to-apples — the Worker's value isn't a
// faster kernel (same JIT), it's that the main thread stays free during the
// decode (the bench proves that with its frame-gap monitor).
//
// Protocol :
//   main → { type:'init', url }                          → worker imports + ready()
//   worker → { type:'ready' } | { type:'error', error }
//   main → { type:'decode', path, buffer(transfer), warmIters, op }
//   worker → { type:'result', path, bytes, kind, cold, mean, p50, p95, best }
//          | { type:'error', path, error }

let mod = null;

// Nearest-rank stats, identical to bench.js / perf-load.mjs.
function stats(samples) {
    const sorted = [...samples].sort((a, b) => a - b);
    const n = sorted.length;
    const mean = samples.reduce((s, x) => s + x, 0) / n;
    const rank = (p) => sorted[Math.min(n - 1, Math.ceil((p / 100) * n) - 1)];
    return { mean, p50: rank(50), p95: rank(95), best: sorted[0] };
}

// Measured operations — mirror of bench.js OPS (the worker is a separate module,
// like the duplicated stats() above). The `decode` message names the op.
const OPS = {
    parseTextured: {
        run: (m, bytes) => m.parseTextured(bytes),
        ok: (r) => !!r && Array.isArray(r.textures),
        kind: (r) => (r.textures.length > 0 ? 'textured' : '—'),
    },
    load3x: {
        run: (m, bytes) => {
            m.parseTextured(bytes);
            m.parseAnimated(bytes);
            return m.extractModels(m.loadGR2(m.parseGR2File(bytes)));
        },
        ok: (r) => Array.isArray(r),
        kind: (r) => (r.length > 0 ? 'model' : '—'),
    },
    load1x: {
        run: (m, bytes) => m.parseAll(bytes),
        ok: (r) => !!r && Array.isArray(r.textures) && Array.isArray(r.animations) && Array.isArray(r.models),
        kind: (r) => `${r.textures.length}t·${r.animations.length}a·${r.models.length}m`,
    },
};

self.onmessage = async (e) => {
    const msg = e.data;
    try {
        if (msg.type === 'init') {
            mod = await import(msg.url);
            await mod.Granny.ready();
            if (typeof mod.loadTextureCodec === 'function') await mod.loadTextureCodec();
            self.postMessage({ type: 'ready' });
            return;
        }
        if (msg.type === 'decode') {
            const bytes = new Uint8Array(msg.buffer);
            const opDef = OPS[msg.op] ?? OPS.parseTextured;
            const op = () => opDef.run(mod, bytes);
            const t0 = performance.now();
            const res = op();
            const cold = performance.now() - t0;
            if (!opDef.ok(res)) throw new Error('empty/invalid output');
            const warm = [];
            for (let i = 0; i < msg.warmIters; i++) {
                const s = performance.now();
                op();
                warm.push(performance.now() - s);
            }
            self.postMessage({
                type: 'result',
                path: msg.path,
                bytes: bytes.length,
                kind: opDef.kind(res),
                cold,
                ...stats(warm),
            });
            return;
        }
    } catch (err) {
        self.postMessage({ type: 'error', path: msg.path, error: err.message });
    }
};
