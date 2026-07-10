# S3.19 full-load profile — hot-spot evidence across both codecs

CPU profile of the **true consumer flow** (not Oodle0-only) : the 6 model
fixtures through `parseTextured` (parse + **IGC texture decode**) and the
15 anim packs through `parseAnimated`. This is the ranking that orders
the S3.19b optimization tracks — the S4 profile (in
[`../before/`](../before/) / [`../after/`](../after/)) only ever saw
Oodle0.

## How to reproduce

```
cd <granny-ro-js repo root>
node --prof scripts/perf-profile.mjs full 10
node --prof-process isolate-*.log > docs/perf-profile/full-load/cpu.txt
rm isolate-*.log
```

- `scripts/perf-profile.mjs full` — the full-load driver (`parseTextured`
  / `parseAnimated`), 10 iterations × 21 fixtures, ~4.8 s wall.
- Total samples : **2520 ticks**. JS 47.0% (74.0% nonlib), C++ 16.5%,
  GC 3.4%, shared libs 36.5% (mostly the `--prof` writer + node runtime,
  not the codec — see the C++-entry-points caveat below).
- Toolchain : Node v24.18.0 aarch64, devcontainer Apple Silicon.

## Top-15 JS functions (ticks)

| # | Ticks | % total | Function | Codec | Source |
|--:|------:|--------:|----------|-------|--------|
|  1 | 293 | 11.6% | `decompress`      | Oodle0 | [`GrannyOodle0.js:404`](../../../src/GrannyOodle0.js#L404) |
|  2 | 224 |  8.9% | `remove`          | Oodle0 | [`GrannyOodle0.js:281`](../../../src/GrannyOodle0.js#L281) |
|  3 | 157 |  6.2% | `iDWTcol`         | IGC    | [`GrannyTextureIGC.js:1127`](../../../src/GrannyTextureIGC.js#L1127) |
|  4 | 117 |  4.6% | `arithDecompress` | IGC    | [`GrannyTextureIGC.js:767`](../../../src/GrannyTextureIGC.js#L767) |
|  5 |  88 |  3.5% | `iDWTrow`         | IGC    | [`GrannyTextureIGC.js:866`](../../../src/GrannyTextureIGC.js#L866) |
|  6 |  84 |  3.3% | `decodeHigh1`     | IGC    | [`GrannyTextureIGC.js:1640`](../../../src/GrannyTextureIGC.js#L1640) |
|  7 |  64 |  2.5% | `arithRenorm`     | IGC    | [`GrannyTextureIGC.js:128`](../../../src/GrannyTextureIGC.js#L128) |
|  8 |  35 |  1.4% | `decodeBlock`     | Oodle0 | [`GrannyOodle0.js:670`](../../../src/GrannyOodle0.js#L670) |
|  9 |  26 |  1.0% | `yuvToRGB`        | IGC    | [`GrannyTextureIGC.js:2082`](../../../src/GrannyTextureIGC.js#L2082) |
| 10 |   9 |  0.4% | `fillRect`        | IGC    | [`GrannyTextureIGC.js:1515`](../../../src/GrannyTextureIGC.js#L1515) |
| 11 |   9 |  0.4% | `bitReverse`      | Oodle0 | [`GrannyOodle0.js:175`](../../../src/GrannyOodle0.js#L175) |
| 12 |   6 |  0.2% | `u32lePadded`     | Oodle0 | [`GrannyOodle0.js:149`](../../../src/GrannyOodle0.js#L149) |
| 13 |   5 |  0.2% | `get`             | Oodle0 | [`GrannyOodle0.js:201`](../../../src/GrannyOodle0.js#L201) |
| 14 |   4 |  0.2% | `readPointerFixups` | parse | [`GrannyTypeTree.js:294`](../../../src/GrannyTypeTree.js#L294) |
| 15 |   3 |  0.1% | `arithUpdate`     | IGC    | [`GrannyTextureIGC.js:459`](../../../src/GrannyTextureIGC.js#L459) |

**C++ entry points caveat** : the arith decoder's per-symbol `BigInt`
math shows up as native allocation, not JS ticks — `__libc_malloc`
(1.7%), `__libc_calloc` (0.8%), `operator new` (0.8%) in the C++-entry
table are largely BigInt boxes. Add them to the IGC arith cost. The
`__write` (2.2%) + `__lll_lock*` ticks are the `--prof` log writer, not
the codec — discount them when reading the shared-libs bucket.

## Ranked S3.19b candidates

Oodle0 (`decompress` + `remove`, ~20.5% combined) still tops the list —
but it was already optimized in S4 (1.4× ; diminishing returns). The
**untouched surface is IGC**, and it splits into two independent tracks:

| Rank | Track | Ticks (approx) | Rationale |
|-----:|-------|---------------:|-----------|
| 1 | **IGC inverse wavelet** — `iDWTcol` + `iDWTrow` | **~9.7%** (245 ticks) | Single biggest *new* cost, bigger than the arith decode. `iDWTcol` (column pass) alone beats `arithDecompress`. Never optimized. Cache-unfriendly column striding + per-element float work — prime target. |
| 2 | **IGC arith decode + BigInt allocation** — `arithDecompress` + `decodeHigh1` + `arithRenorm` + `arithUpdate` | **~10.5% JS + the malloc/calloc/new above** | The BigInt-heavy per-symbol path the session brief called out. The win is likely *removing BigInt* (64-bit range math in two 32-bit halves) to kill both the JS ticks and the native allocation. |
| 3 | `yuvToRGB` + `fillRect` | ~1.4% | YUV→RGBA + MIP fill. Small ; SIMD-ish batch or typed-array tightening only if #1/#2 land and it surfaces. |
| — | Oodle0 `decompress`/`remove` | ~20.5% | Already S4-optimized. Revisit only if IGC tracks exhaust and anim-pack load still dominates a real scene. |

The bench ([`../../perf-baseline.md`](../../perf-baseline.md#s319-full-load-baseline-2026-07-10))
agrees : texture (IGC) decode is **85% of model-load time**, and iDWT +
arith are the whole of that 85%. Start 3.19b on the inverse wavelet.
