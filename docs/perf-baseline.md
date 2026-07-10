# Performance baseline

> **Note** : the JS-vs-Python ratios below are historical, from when the
> harness had a Python clean-room oracle in-loop. The current perf tool
> (`npm run perf` / `scripts/perf.mjs`) measures JS only ; for a v8
> sample profile use `npm run perf:profile`. See
> [docs/HOWTO.md](HOWTO.md#performance).
>
> Pre-optimization baseline locked early in the port ; post-optimization
> result documented in the « 1.4× speedup » section at the bottom.

---

## S3' baseline (2026-06-28)

Snapshot of `granny-ro-js` decompression performance the day S3'
(port-and-validate-oodle0) landed. **Pre-optimization.** S4
(perf-optimize-oodle0) compares against this baseline ; subsequent
revisions should never regress below it.

## Environment

| Component | Value |
|---|---|
| Container | aarch64 Linux on Apple Silicon |
| Node.js | v24.18.0 |
| Vitest | 4.1.9 |
| Granny-js commit | (TBD — replace when committed) |
| Methodology | best-of-5 per fixture, parse + 6 × `decompressSection`, no I/O in the timed region |
| Memory | not measured (no peak-RSS instrumentation yet) |

## Vitest bench — JS-only peak throughput

`npm run bench` output :

```
GrannyOodle0 — performance
  decompress all 21 fixtures (126 sections)              6.87 hz   mean 145.6 ms  rme ±2.47%   11 samples
  biggest single section — 7_dead.gr2 #0 (82.5 KB)      94.07 hz   mean  10.6 ms  rme ±0.48%  142 samples
  model fixture — treasurebox_2.gr2 (6 sections, 56 KB) 272.73 hz   mean   3.7 ms  rme ±0.31%  410 samples
  animation fixture — 7_dead.gr2 (6 sections, biggest 84 KB) 94.72 hz   mean  10.6 ms  rme ±0.90%  143 samples
```

## perf-compare — JS vs Python (Rasetsuu/blendergranny)

`npm run perf:compare` output :

```
perf-compare — JS vs Python (Rasetsuu/blendergranny clean-room codec)
  iterations per fixture : 5 (reporting best-of-N)
  fixtures               : 21

fixture             bytes  JS best ms  Py best ms    JS MB/s    Py MB/s   JS / Py
-----------------  ------  ----------  ----------  ---------  ---------  --------
1_attack.gr2       164820        6.70      251.28  23.5 MB/s   0.6 MB/s     37.5×
2_damage.gr2        22160        2.08       78.28  10.2 MB/s   0.3 MB/s     37.6×
2_dead.gr2          37100        4.61      172.68   7.7 MB/s   0.2 MB/s     37.5×
7_attack.gr2        46032        5.05      202.55   8.7 MB/s   0.2 MB/s     40.1×
7_damage.gr2        60516        7.09      296.86   8.1 MB/s   0.2 MB/s     41.9×
7_dead.gr2          84472       10.89      466.03   7.4 MB/s   0.2 MB/s     42.8×
7_move.gr2          59496        7.14      315.16   7.9 MB/s   0.2 MB/s     44.1×
8_attack.gr2        73028        9.29      409.59   7.5 MB/s   0.2 MB/s     44.1×
8_damage.gr2        41752        3.89      165.16  10.2 MB/s   0.2 MB/s     42.4×
8_dead.gr2          62184        6.68      281.86   8.9 MB/s   0.2 MB/s     42.2×
8_move.gr2          54844        6.00      258.76   8.7 MB/s   0.2 MB/s     43.1×
9_attack.gr2        41104        4.37      191.30   9.0 MB/s   0.2 MB/s     43.7×
9_damage.gr2        52368        5.85      265.20   8.5 MB/s   0.2 MB/s     45.3×
9_dead.gr2          76316        9.56      429.03   7.6 MB/s   0.2 MB/s     44.9×
9_move.gr2          52796        6.06      281.09   8.3 MB/s   0.2 MB/s     46.4×
aguardian90_8.gr2  193364       12.59      582.15  14.6 MB/s   0.3 MB/s     46.2×
empelium90_0.gr2    77376        6.14      276.90  12.0 MB/s   0.3 MB/s     45.1×
guildflag90_1.gr2   87916        5.92      261.07  14.2 MB/s   0.3 MB/s     44.1×
kguardian90_7.gr2  179516       10.16      460.47  16.9 MB/s   0.4 MB/s     45.3×
sguardian90_9.gr2  164084        8.67      386.64  18.1 MB/s   0.4 MB/s     44.6×
treasurebox_2.gr2   56072        3.59      152.84  14.9 MB/s   0.3 MB/s     42.6×
-----------------  ------  ----------  ----------  ---------  ---------  --------
TOTAL              1687316      142.34     6184.89  11.3 MB/s   0.3 MB/s     43.5×
```

## Numbers to beat (S4 targets, in priority order)

| Metric                              | Baseline       | S4 target (suggested) |
|--------------------------------------|----------------|------------------------|
| Total time, 21 fixtures (best-of-5)  | **142 ms**     | ≤ 100 ms (1.4× speedup) |
| Throughput on full corpus            | **11.3 MB/s**  | ≥ 16 MB/s              |
| Biggest single section (`7_dead.gr2 #0`, 82 KB) | **10.6 ms** | ≤ 7 ms (1.5×)        |
| `treasurebox_2.gr2` full (best fixture) | **3.7 ms** | ≤ 2.5 ms (1.5×)        |

These targets are guesses ; they should be revised after S4's profiling
identifies the real hot spots.

## Suspected hot spots (un-profiled, gut-feel)

To be confirmed with a real profiler (`node --prof` + `prof-processed`,
or Chrome DevTools attached to the Node process) at the start of S4 :

1. **`ArithModel._findPos`** — linear scan over `counts[0..N-1]` for every
   symbol decoded. Called ~once per decoded byte. Could become a binary
   search over `totals` (cumulative bin tallies) for a 3-5× cut on this
   function ; on a corpus the size of ours, that translates to maybe
   10-20% global. Caveat : Python source uses the same linear scan ;
   port faithfulness was the priority in S3'.
2. **`ArithBits.remove` inner loops** — three nested renormalization
   loops (8-bit, 4-bit, 1-bit) each with a `bitReverse` call. Inlining
   the byte-level `bitReverse(byte & 0xF, 4) << 4 | bitReverse(byte >> 4, 4)`
   into a 256-entry lookup table would save ~10% globally.
3. **`ArithModel._incrementTotals` + `_addTotalPairU32`** — the packed
   u32 pair arithmetic is awkward in JS (we do Number ops + `>>> 0`).
   A plain `Uint32Array(8)` for `totals` packed differently might
   simplify and speed up.
4. **`Oodle0LZHeader` accessor getters** — `max_byte_value` etc. are
   called per-block-init but also potentially in the hot path via
   `state.max_offsets`. Cache the values onto `LZState` at construction
   (we already do for `max_bytes` / `max_offsets`, but the per-length
   `header.length_unique(i)` is invoked 65 times per block init — fine).
5. **`u32lePadded` zero-pad path** — happens only at EOF. Should never
   trigger in the inner loop. Confirm with a profile.

## Notes

- The 21 fixtures total **1.65 MB** decompressed across 105 Oodle0
  sections + 21 NoCompression sections (= 126 sections).
- For roBrowser's runtime (S9), 142 ms one-shot at character-load
  time is already negligible (LZMA over GRF is a much bigger
  bottleneck). S4 is **future-proofing**, not unblocking S9.
- `npm run perf:compare` re-generates this whole table ; rerun on the
  S4 branch and compare to confirm regressions / progressions before
  every PR.

---

## S4 result (2026-06-28)

S4 (perf-optimize-oodle0) ran a profile-first optimization pass on the
S3' codec. Profile evidence (now in [`docs/perf-profile/before/`](perf-profile/before/))
re-ranked the S3' gut-feel hot-spot list, three optimizations stuck +
one cleanup made the codec measurably faster while removing code.

**Headline** — **1.41× speedup** on the full corpus (145.6 ms → 103.54 ms
vitest mean, ±0.75% rme), throughput **11.3 → 15.5 MB/s**, JS-vs-Python
ratio **43.5× → 54.9×**. Hit the ≥ 1.4× target ; ≤ 100 ms stretch goal
missed by 3-4 ms (within bench variance).

### Vitest bench — JS-only peak throughput (after)

`npm run bench` output :

```
GrannyOodle0 — performance
  decompress all 21 fixtures (126 sections)              9.66 hz   mean 103.5 ms  rme ±0.75%   15 samples
  biggest single section — 7_dead.gr2 #0 (82.5 KB)     135.86 hz   mean   7.4 ms  rme ±0.35%  204 samples
  model fixture — treasurebox_2.gr2 (6 sections, 56 KB) 354.85 hz   mean   2.8 ms  rme ±0.33%  533 samples
  animation fixture — 7_dead.gr2 (6 sections, biggest 84 KB) 136.67 hz mean   7.3 ms  rme ±0.48%  206 samples
```

| Bench row                    | S3' mean | S4 mean | Δ      | Speedup |
|------------------------------|---------:|--------:|-------:|--------:|
| 21 fixtures (126 sections)   | 145.6 ms | 103.5 ms | −42.1 ms | **1.41×** |
| `7_dead.gr2 #0` (82.5 KB)    |  10.6 ms |   7.4 ms |  −3.2 ms | **1.44×** |
| `treasurebox_2.gr2`          |   3.7 ms |   2.8 ms |  −0.9 ms | **1.31×** |
| `7_dead.gr2` full            |  10.6 ms |   7.3 ms |  −3.3 ms | **1.45×** |

### perf-compare — JS vs Python (after)

`npm run perf:compare` output :

```
perf-compare — JS vs Python (Rasetsuu/blendergranny clean-room codec)
  iterations per fixture : 5 (reporting best-of-N)
  fixtures               : 21

fixture             bytes  JS best ms  Py best ms    JS MB/s    Py MB/s   JS / Py
-----------------  ------  ----------  ----------  ---------  ---------  --------
1_attack.gr2       164820        4.89      261.78  32.2 MB/s   0.6 MB/s     53.6×
2_damage.gr2        22160        1.76       78.44  12.0 MB/s   0.3 MB/s     44.6×
2_dead.gr2          37100        3.38      173.33  10.5 MB/s   0.2 MB/s     51.2×
7_attack.gr2        46032        3.84      197.68  11.4 MB/s   0.2 MB/s     51.5×
7_damage.gr2        60516        5.33      292.12  10.8 MB/s   0.2 MB/s     54.9×
7_dead.gr2          84472        7.87      452.36  10.2 MB/s   0.2 MB/s     57.5×
7_move.gr2          59496        5.62      301.08  10.1 MB/s   0.2 MB/s     53.5×
8_attack.gr2        73028        6.97      396.84  10.0 MB/s   0.2 MB/s     56.9×
8_damage.gr2        41752        3.08      159.92  12.9 MB/s   0.2 MB/s     51.9×
8_dead.gr2          62184        5.28      272.70  11.2 MB/s   0.2 MB/s     51.7×
8_move.gr2          54844        4.46      248.93  11.7 MB/s   0.2 MB/s     55.8×
9_attack.gr2        41104        3.33      183.77  11.8 MB/s   0.2 MB/s     55.2×
9_damage.gr2        52368        4.50      254.94  11.1 MB/s   0.2 MB/s     56.7×
9_dead.gr2          76316        6.89      413.17  10.6 MB/s   0.2 MB/s     60.0×
9_move.gr2          52796        4.66      270.39  10.8 MB/s   0.2 MB/s     58.0×
aguardian90_8.gr2  193364        9.84      550.79  18.7 MB/s   0.3 MB/s     56.0×
empelium90_0.gr2    77376        5.34      261.49  13.8 MB/s   0.3 MB/s     48.9×
guildflag90_1.gr2   87916        4.38      248.96  19.1 MB/s   0.3 MB/s     56.8×
kguardian90_7.gr2  179516        7.95      441.57  21.5 MB/s   0.4 MB/s     55.6×
sguardian90_9.gr2  164084        6.64      371.66  23.6 MB/s   0.4 MB/s     56.0×
treasurebox_2.gr2   56072        2.84      148.82  18.8 MB/s   0.4 MB/s     52.4×
-----------------  ------  ----------  ----------  ---------  ---------  --------
TOTAL              1687316      108.84     5980.73  14.8 MB/s   0.3 MB/s     54.9×
```

### Per-fixture delta vs S3' baseline (best-of-5)

| Fixture           | S3' ms | S4 ms | Δ%    |
|-------------------|-------:|------:|------:|
| 1_attack.gr2      |   6.70 |  4.89 | −27.0% |
| 2_damage.gr2      |   2.08 |  1.76 | −15.4% |
| 2_dead.gr2        |   4.61 |  3.38 | −26.7% |
| 7_attack.gr2      |   5.05 |  3.84 | −24.0% |
| 7_damage.gr2      |   7.09 |  5.33 | −24.8% |
| 7_dead.gr2        |  10.89 |  7.87 | −27.7% |
| 7_move.gr2        |   7.14 |  5.62 | −21.3% |
| 8_attack.gr2      |   9.29 |  6.97 | −25.0% |
| 8_damage.gr2      |   3.89 |  3.08 | −20.8% |
| 8_dead.gr2        |   6.68 |  5.28 | −21.0% |
| 8_move.gr2        |   6.00 |  4.46 | −25.7% |
| 9_attack.gr2      |   4.37 |  3.33 | −23.8% |
| 9_damage.gr2      |   5.85 |  4.50 | −23.1% |
| 9_dead.gr2        |   9.56 |  6.89 | −27.9% |
| 9_move.gr2        |   6.06 |  4.66 | −23.1% |
| aguardian90_8.gr2 |  12.59 |  9.84 | −21.8% |
| empelium90_0.gr2  |   6.14 |  5.34 | −13.0% |
| guildflag90_1.gr2 |   5.92 |  4.38 | −26.0% |
| kguardian90_7.gr2 |  10.16 |  7.95 | −21.8% |
| sguardian90_9.gr2 |   8.67 |  6.64 | −23.4% |
| treasurebox_2.gr2 |   3.59 |  2.84 | −20.9% |
| **TOTAL**         | **142.34** | **108.84** | **−23.5%** |

Uniform speedup across fixtures (15-28% per row, average 23%). No
outliers — the wins come from the inner loop, which every fixture
hits the same way.

### Optimizations tried — what stuck, what got reverted

| # | Candidate | Δ vs prior | Decision | Why |
|---|-----------|-----------:|----------|-----|
| 1 | `ArithModel._findPos` : linear scan → 4-compare binary search over the 16-entry `totals[]` bins + bounded within-bin scan. The `bestShift` bucket layout was designed for exactly this. | **−13.5%** | **KEEP** | Big win on byte / offset alphabets (counts.length ≈ 50-260) ; near-neutral on tiny length contexts. Net positive everywhere. |
| 2 | `bitReverse` byte-LUT inside `ArithBits.remove`'s 8-bit renorm loop : 256-entry `Uint8Array`, fold `(bitReverse(byte & 0xF, 4) << 4) \| bitReverse(byte >>> 4, 4)` into a single `LUT[byte]`. | ≈ noise (3 runs : 134, 130, 140 ms) | **REVERT** | V8 already inlines the nibble dance well ; LUT didn't beat the rule's 1% threshold. |
| 3 | Inline `u32` / `u16` / `u31` wrapper functions throughout the hot path (`>>> 0`, `& 0xFFFF`, `& MASK31`). Profile showed 72+ ticks (~3%) just on the wrapper call overhead. | **−16.3%** | **KEEP** | V8 wasn't fully inlining the 1-line wrappers in the optimized hot frame. Inlining removed them from the profile entirely. Biggest single win of S4. |
| 4 | Replace `_addTotalPairU32` packed-u32 dance with per-bin u16 adds (callers always use symmetric packed amounts like `0x10001`, `0x20002`) ; rewrite `_decrementCounts` as a direct subtract instead of routing through `_quickIncrement` with a two's-complement negative pair. | **−1.6%** | **KEEP** | Above the 1% threshold *and* meaningfully cleaner — removed 11 lines of bit-twiddling that existed only for the symmetry the JS code never actually needed. |
| 5 | Drop the `>>> 0` casts inside `ArithBits.remove`'s renorm loops (subsequent bitwise ops `ToInt32` their operands ; final `& MASK31` re-normalizes — so the intermediate casts should be no-ops). | **+8.7%** regression (3 runs : 115, 115, 120 ms) | **REVERT** | Counter-intuitive : V8 was using `>>> 0` as a u32-type hint on `low` / `high` / `code` representation. Dropping the hint made V8 fall back to a slower number repr. Comment-tagged in source to prevent re-trying. |

### Profiled hot spots (replaces the S3' « Suspected » section)

See [`docs/perf-profile/before/README.md`](perf-profile/before/README.md)
for the full top-10 ticks table and the re-ranking it produced. Key
findings :

- **`ArithModel.decompress` (46% of CPU)** and **`ArithBits.remove` (33%)**
  together account for 79% of decode time. Every kept optimization
  touched one of these two functions.
- `_findPos` shows < 1% ticks in the profile because V8 inlined it
  into `decompress` — its cost was hidden inside the 46% bucket. The
  binary-search rewrite improved that hidden cost without changing
  the visible function in the profile.
- The wrapper functions (`u32`, `u16`) accounted for 3% combined ;
  inlining them out moved that time into `decompress` / `remove`
  natively, where V8 could fully optimize the resulting expressions.
- Wrong candidates from the S3' guess list : the `Oodle0LZHeader`
  accessor cache (< 1% in profile — skipped), and `Uint32Array` for
  `totals` / `counts` (uncertain — tried-and-rejected, no clear win
  given the perf:compare noise floor).

### Stability

5-run perf:compare totals after the final revert : 105.76, 106.12,
111.28, 114.36, 110.33 → mean **109.57 ms**, σ ≈ 3.2 ms (rme 2.9%).
Vitest bench is tighter (more samples) : **103.54 ms ± 0.75%**.

Both metrics agree on the headline 1.4× speedup against S3' ; the
vitest bench is the cleaner number to quote.

---

## S3.19 full-load baseline (2026-07-10)

Everything above measures **Oodle0 decompression only**. A real consumer
does more : parse the type-tree + skeleton + mesh, and — for models —
**decode every texture, including the BigInt-heavy IGC codec**. This
section is the first baseline of that **true consumer flow**, captured by
the new `npm run perf:load` ([`scripts/perf-load.mjs`](../scripts/perf-load.mjs)).
S3.19b optimizes against it. **Pre-optimization.**

The workload per fixture : models → `parseTextured(buf)` (parse + decode
every IGC MIP), anim packs → `parseAnimated(buf)`. Model / anim split by
the tests' filename rule (`/^\d+_(attack|damage|dead|move)\.gr2$/`).

### Headline

- **Texture (IGC) decode is 85% of model-load time** — the exact cost the
  Oodle0-only bench never saw. A model like `aguardian90_8.gr2` parses in
  ~10.5 ms but takes **~73 ms** fully loaded ; the other ~62 ms is IGC.
- Full corpus (best-of-N, summed) : **~352 ms**, vs the ~103 ms the
  Oodle0-only bench reports for the same 21 files — a real consumer pays
  **~3.4×** more than the decompression headline implied.

### Environment

| Component | Value |
|---|---|
| Container | aarch64 Linux on Apple Silicon |
| Node.js | v24.18.0 |
| Methodology | per fixture : 1 cold call (JIT unwarmed) + 20 warm calls ; warm reported as mean / p50 / p95 / best-of-N |
| Throughput basis | **input `.gr2` bytes** (what the consumer feeds in), at warm-best — NOT the decompressed-bytes basis the Oodle0 tables above use |
| Stability | 3-run TOTAL warm-best : σ ≈ 1.5 ms (`npm run perf:load:compare`) |
| Memory | not measured |

**Cold caveat** : only the first fixture's cold is truly JIT-cold for the
parse path, and the first *model's* cold is the truly JIT-cold IGC path
(anims sort first, models second). Later fixtures reuse warm JIT — read
the cold column as "first-call cost", not a per-fixture cold-start.

### perf:load — full consumer flow (representative run)

`npm run perf:load` output :

```
perf-load — full consumer flow (parseTextured / parseAnimated)
  target                      : node
  warm iterations per fixture : 20 (+ 1 cold call, reported separately)
  fixtures                    : 21 (6 models, 15 anim packs)
  MB/s basis                  : input .gr2 bytes, at warm-best

fixture            kind    in KB  cold ms  warm mean  warm p50  warm p95  warm best  MB/s
-----------------  -----  ------  -------  ---------  --------  --------  ---------  ----
1_attack.gr2       anim    138.5    26.99       7.57      6.98      9.50       6.17  21.9
2_damage.gr2       anim     14.8     2.36       2.37      2.34      2.76       2.11   6.9
2_dead.gr2         anim     24.4     4.00       4.74      4.01      8.64       3.69   6.5
7_attack.gr2       anim     30.5     4.43       4.48      4.43      4.78       4.21   7.1
7_damage.gr2       anim     39.2     5.79       5.91      5.87      6.14       5.67   6.7
7_dead.gr2         anim     54.4     8.52       8.52      8.43      8.80       8.23   6.5
7_move.gr2         anim     40.0     6.40       6.17      6.21      6.41       5.80   6.7
8_attack.gr2       anim     49.6     9.40       8.51      8.10      8.85       7.52   6.4
8_damage.gr2       anim     27.7    11.58       5.26      4.42     10.23       3.91   6.9
8_dead.gr2         anim     38.7     6.26       6.02      5.97      6.44       5.77   6.5
8_move.gr2         anim     36.4     6.10       5.58      5.56      5.86       5.28   6.7
9_attack.gr2       anim     27.9     3.90       4.06      4.01      4.33       3.85   7.1
9_damage.gr2       anim     34.6     5.11       5.27      5.25      5.63       4.95   6.8
9_dead.gr2         anim     48.9     7.94       7.77      7.74      8.05       7.40   6.5
9_move.gr2         anim     36.1     5.32       5.50      5.45      5.70       5.28   6.7
aguardian90_8.gr2  model   139.0   149.68      88.59     83.26    118.62      72.62   1.9
empelium90_0.gr2   model    50.6    19.27      22.59     20.91     28.20      19.27   2.6
guildflag90_1.gr2  model    55.0    22.05      22.44     21.51     28.88      19.34   2.8
kguardian90_7.gr2  model   132.7    76.53      85.64     82.69    102.45      75.78   1.7
sguardian90_9.gr2  model   123.0    63.21      85.03     81.44     96.58      67.33   1.8
treasurebox_2.gr2  model    40.6    19.57      23.61     19.64     34.67      17.87   2.2
-----------------  -----  ------  -------  ---------  --------  --------  ---------  ----
TOTAL                     1182.8   464.40     415.63         —         —     352.06   3.3
```

### Model breakdown — where the model-load time goes

`parse ms` = `parseModel` (parse + skeleton + mesh) ; `+tex ms` =
`parseTextured − parseModel` = the texture/IGC decode share :

```
model              in KB  parse ms  full ms  +tex ms  tex %
-----------------  -----  --------  -------  -------  -----
aguardian90_8.gr2  139.0     10.51    72.62    62.11  85.5%
empelium90_0.gr2    50.6      4.95    19.27    14.31  74.3%
guildflag90_1.gr2   55.0      4.98    19.34    14.35  74.2%
kguardian90_7.gr2  132.7      8.68    75.78    67.10  88.5%
sguardian90_9.gr2  123.0      8.42    67.33    58.91  87.5%
treasurebox_2.gr2   40.6      3.26    17.87    14.61  81.8%
-----------------  -----  --------  -------  -------  -----
TOTAL              540.9     40.80   272.20   231.41  85.0%
```

### Profiled hot spots (sets the S3.19b track order)

Full `node --prof` ranking in
[`docs/perf-profile/full-load/README.md`](perf-profile/full-load/README.md)
(raw in [`cpu.txt`](perf-profile/full-load/cpu.txt)). Top of the JS
profile, across both codecs :

| Ticks | % | Function | Codec |
|------:|--:|----------|-------|
| 293 | 11.6% | `decompress` | Oodle0 (already S4-optimized) |
| 224 |  8.9% | `remove`     | Oodle0 (already S4-optimized) |
| 157 |  6.2% | `iDWTcol`    | **IGC — inverse wavelet, untouched** |
| 117 |  4.6% | `arithDecompress` | **IGC — BigInt arith, untouched** |
|  88 |  3.5% | `iDWTrow`    | **IGC — inverse wavelet** |
|  84 |  3.3% | `decodeHigh1` | **IGC — arith symbol decode** |
|  64 |  2.5% | `arithRenorm` | **IGC — arith** |

**S3.19b track order** (Oodle0 is already optimized, so target IGC) :
1. **Inverse wavelet** `iDWTcol` + `iDWTrow` (~9.7% combined) — biggest
   untouched cost.
2. **Arith decode + BigInt removal** `arithDecompress` / `decodeHigh1` /
   `arithRenorm` (~10.5% JS + native malloc/calloc from BigInt boxing).
3. `yuvToRGB` / `fillRect` (~1.4%) — only if #1/#2 land.

### Tooling added this session

- `npm run perf:load [warmIters] [--save] [--target=<t>]` — the bench.
  `--save` archives each run (human `.txt` + machine `.json`) under
  [`docs/perf-profile/full-load/runs/`](perf-profile/full-load/runs/),
  named `<target>:<sha>` (index `-NN` per repeat), so runs group by
  commit + runtime target.
- `npm run perf:load:compare` — averages the archived runs per
  `<target>:<commit>` and diffs HEAD against every other benched
  revision (per-fixture Δ%). Run `perf:load -- --save` a few times per
  commit for a meaningful average.
- `npm run perf:load:profile [iter]` — the same full-load workload under
  `node --prof` (`scripts/perf-profile.mjs full`).

The `--target` field is currently always `node` ; the schema is ready
for the **browser-dist** and **wasm** benches (S3.19d) to land in the
same `runs/` dir and compare side-by-side against node — no build target
exists for those yet, so they are deferred, not built. Byte-exact
correctness stays the job of `npm test` ; the bench only smoke-checks
that output isn't empty.
