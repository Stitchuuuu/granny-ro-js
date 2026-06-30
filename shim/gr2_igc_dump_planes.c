/*
 * gr2_igc_dump_planes — S3.15 debug shim.
 *
 * Combines the existing ARITH trace (S3.13/S3.14) with a NEW second detour at
 * granny2.dll + 0x9700 (= iDWT2D entry) that dumps the input S16 plane buffer
 * on every iDWT2D call. Used to localize the downstream RGBA bug post-S3.14 :
 * trace ARITH layer is byte-exact (3414/3414 calls match) but RGBA still
 * differs from baked golden at 5946/32768 bytes. The bug is in planeDecode
 * (escape paths, varBits, readEscapes) or iDWT2D (lifting kernels) or
 * yuvToRGB (rounding). Comparing the per-iDWT2D-call plane state between
 * DLL (this shim) and JS (instrumented `_decodeIGCTextureWIP`) localizes it.
 *
 * Outputs (next to <out.rgba>) :
 *   <out.rgba>.trace.jsonl   — same arith trace as gr2_igc_export_trace
 *   <out.rgba>.idwt-<N>.bin  — plane buffer at iDWT2D call N (16-bit LE S16)
 *                              filename includes plane index and the 4
 *                              (pitch, width, height) args :
 *                                <out.rgba>.idwt-<N>-w<W>-h<H>-p<PITCH>.bin
 *
 * For kg7-tex0 (64x128 alpha=1) there are 4 iDWT2D calls per plane × 4 planes
 * = 16 dumps total. Each dump is 16384 bytes (= 8192 S16 = 64*128).
 *
 * Build (in container — mingw-w64 cross-compile) :
 *   cd /workspace/granny-ro-js/shim
 *   i686-w64-mingw32-gcc -static -O2 -o gr2_igc_dump_planes.exe gr2_igc_dump_planes.c
 *   ln -sf ../../iRO_ver12.0-full-client-data/RE/granny2/granny2.dll .
 *
 * Run (macOS-host wine staging 11.10 per S3.13 LOG — sole working setup) :
 *   wine ./gr2_igc_dump_planes.exe kg7-tex0.bin 64 128 1 kg7-tex0.rgba
 *
 * SPDX-License-Identifier: MIT
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

#define DETOUR_ARITH_OFFSET 0xE6F0    /* fcn.1000e6f0 — Arith_decompress */
#define DETOUR_IDWT_OFFSET  0x9700    /* fcn.10009700 — iDWT2D dispatcher */

/* Per-target prologue save sizes — each MUST land on an instruction boundary.
 *
 * fcn.1000e6f0 (arith) prologue :
 *   0x1000e6f0  83 ec 08            sub esp, 8                (3 B)
 *   0x1000e6f3  56                  push esi                  (1 B)
 *   0x1000e6f4  8b 74 24 10         mov esi, [esp+0x10]       (4 B)
 *   → 8 bytes, ends cleanly at 0x1000e6f8.
 *
 * fcn.10009700 (iDWT2D) prologue :
 *   0x10009700  83 ec 10            sub esp, 0x10             (3 B)
 *   0x10009703  8b 4c 24 1c         mov ecx, [esp+0x1c]       (4 B)
 *   0x10009707  83 f9 0c            cmp ecx, 0xc              (3 B)
 *   → save 7 bytes (skip the cmp), land at 0x10009707. Saving 8 cuts the cmp
 *     and CPU executes `83 E9 ..` (= `sub ecx, imm8`) from the trampoline's
 *     JMP encoding, corrupting state silently. */
#define DETOUR_ARITH_SAVE  8
#define DETOUR_IDWT_SAVE   7

static FILE   *g_trace_fp = NULL;
static int     g_trace_active = 0;
static size_t  g_trace_calls = 0;
static size_t  g_idwt_calls = 0;

static BYTE   *g_target_arith = NULL;
static BYTE   *g_trampoline_arith = NULL;
static BYTE   *g_target_idwt  = NULL;
static BYTE   *g_trampoline_idwt  = NULL;

static char    g_out_path[1024];
static size_t  g_plane_bytes = 64 * 128 * 2;  /* runtime W*H*2, set from argv */

/* ===== ARITH trace logger (verbatim from gr2_igc_export_trace.c) ===== */

void __stdcall log_arith_state(void *ctx_ptr, void *ab_ptr) {
    if (!g_trace_fp || !g_trace_active || !ctx_ptr) return;
    g_trace_calls++;
    uint16_t *cc = (uint16_t *)ctx_ptr;
    uint32_t *ab = (uint32_t *)ab_ptr;
    uint32_t ab_high = ab_ptr ? ab[4] : 0;
    uint32_t ab_low  = ab_ptr ? ab[5] : 0;
    uint32_t ab_tgt  = ab_ptr ? ab[6] : 0;
    fprintf(g_trace_fp,
        "{\"call\":%zu,\"ctx\":\"%p\",\"cum\":[%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u,%u],"
        "\"sL\":%u,\"bB\":%u,\"sD\":%u,\"bS\":%u,\"uC\":%u,"
        "\"abH\":\"%x\",\"abL\":\"%x\",\"abT\":\"%x\"}\n",
        g_trace_calls, ctx_ptr,
        cc[0], cc[1], cc[2], cc[3], cc[4], cc[5], cc[6], cc[7],
        cc[8], cc[9], cc[10], cc[11], cc[12], cc[13], cc[14], cc[15],
        cc[16], cc[18],
        ((uint8_t *)ctx_ptr)[0x26],
        cc[20], cc[22],
        ab_high, ab_low, ab_tgt
    );
}

__declspec(naked) static void detour_arith_decompress(void) {
    __asm__ __volatile__(
        "pushal\n\t"
        "pushfl\n\t"
        "movl 0x2c(%%esp), %%eax\n\t"   /* ab */
        "pushl %%eax\n\t"
        "movl 0x2c(%%esp), %%eax\n\t"   /* ctx */
        "pushl %%eax\n\t"
        "call _log_arith_state@8\n\t"
        "popfl\n\t"
        "popal\n\t"
        "jmp _g_trampoline_arith_invoke\n\t"
        : : : "memory"
    );
}

__declspec(naked) void g_trampoline_arith_invoke(void) {
    __asm__ __volatile__("jmpl *_g_trampoline_arith\n\t" : : : "memory");
}

/* ===== iDWT2D plane dumper (NEW for S3.15) ===== */

/* iDWT2D signature (per leaked-SDK wavelet.c:1328) :
 *   void iDWT2D(short *plane, int pitch, int width, int height,
 *               unsigned char *rowMask, short *temp);
 *
 * cdecl, 6 args. At entry, esp_caller+4 = plane ; +8 = pitch ; +0xc = width ;
 * +0x10 = height ; +0x14 = rowMask ; +0x18 = temp. After pushal+pushfl the
 * offsets shift by +0x24, so [esp+0x28] = plane, +0x2c = pitch, etc.
 *
 * For kg7-tex0 (64x128) the plane buffer is 64*128 = 8192 S16 elements = 16
 * KB. The width/height args reflect the sub-band being inverted (W/8, W/4,
 * W/2, W for levels 3/2/1/0) — we always dump the FULL plane (16 KB) because
 * the plane[] layout has all 4 sub-bands interleaved at fixed offsets per
 * the IGC format. */

void __stdcall dump_idwt_plane(int16_t *plane, int32_t pitch,
                                int32_t width, int32_t height) {
    if (!g_trace_active || !plane) return;
    g_idwt_calls++;
    /* Set by main() from argv W*H*2 ; default 64*128 for back-compat. */
    size_t plane_bytes = g_plane_bytes;
    char path[1280];
    snprintf(path, sizeof(path), "%s.idwt-%02zu-w%d-h%d-p%d.bin",
             g_out_path, g_idwt_calls, width, height, pitch);
    FILE *fp = fopen(path, "wb");
    if (!fp) {
        fprintf(stderr, "WARN: open '%s': %s\n", path, strerror(errno));
        return;
    }
    fwrite(plane, 1, plane_bytes, fp);
    fclose(fp);
    fprintf(stderr, "IDWT %02zu : plane=%p pitch=%d w=%d h=%d → %s (%zu bytes)\n",
            g_idwt_calls, plane, pitch, width, height, path, plane_bytes);
}

__declspec(naked) static void detour_idwt2d(void) {
    /* iDWT2D cdecl. After pushal+pushfl the 4 first args are at
     * [esp+0x28], [esp+0x2c], [esp+0x30], [esp+0x34]. */
    __asm__ __volatile__(
        "pushal\n\t"
        "pushfl\n\t"
        "movl 0x34(%%esp), %%eax\n\t"   /* height */
        "pushl %%eax\n\t"
        "movl 0x34(%%esp), %%eax\n\t"   /* width  (shifted by 4 from the previous push) */
        "pushl %%eax\n\t"
        "movl 0x34(%%esp), %%eax\n\t"   /* pitch */
        "pushl %%eax\n\t"
        "movl 0x34(%%esp), %%eax\n\t"   /* plane */
        "pushl %%eax\n\t"
        "call _dump_idwt_plane@16\n\t"
        "popfl\n\t"
        "popal\n\t"
        "jmp _g_trampoline_idwt_invoke\n\t"
        : : : "memory"
    );
}

__declspec(naked) void g_trampoline_idwt_invoke(void) {
    __asm__ __volatile__("jmpl *_g_trampoline_idwt\n\t" : : : "memory");
}

/* ===== Detour installation (one per hook) ===== */

static int install_detour(BYTE *target, void *detour, int save_bytes,
                          BYTE **out_trampoline) {
    BYTE *tramp = (BYTE *)VirtualAlloc(NULL, 32, MEM_COMMIT | MEM_RESERVE,
                                       PAGE_EXECUTE_READWRITE);
    if (!tramp) return -2;
    memcpy(tramp, target, save_bytes);
    tramp[save_bytes] = 0xE9;
    int32_t rel_back = (int32_t)((intptr_t)(target + save_bytes) -
                                  (intptr_t)(tramp + save_bytes + 5));
    memcpy(tramp + save_bytes + 1, &rel_back, 4);
    *out_trampoline = tramp;

    DWORD old_prot;
    if (!VirtualProtect(target, 5, PAGE_EXECUTE_READWRITE, &old_prot)) {
        VirtualFree(tramp, 0, MEM_RELEASE);
        return -3;
    }
    target[0] = 0xE9;
    int32_t rel_forward = (int32_t)((intptr_t)detour - (intptr_t)(target + 5));
    memcpy(target + 1, &rel_forward, 4);
    DWORD ignore;
    VirtualProtect(target, 5, old_prot, &ignore);
    return 0;
}

typedef struct GrannyIGCTexture {
    int32_t  Width;
    int32_t  Height;
    int32_t  Alpha;
    int32_t  ImageDataCount;
    void    *ImageData;
} GrannyIGCTexture;

typedef void (__stdcall *GrannyDecompressIGCTextureFn)(
                  GrannyIGCTexture const *Image,
                  int32_t                 DestStride,
                  void                   *Dest);

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr,
                "usage: gr2_igc_dump_planes <in.bin> <W> <H> <alpha 0|1> <out.rgba>\n"
                "  Captures per-call ARITH ctx state to <out.rgba>.trace.jsonl AND\n"
                "  dumps every iDWT2D input plane to <out.rgba>.idwt-NN-wW-hH-pP.bin\n"
                "  (16 KB each for 64x128 ; 4 calls per plane × planeCount).\n");
        return 2;
    }
    char const *in_path  = argv[1];
    int32_t     W        = (int32_t)strtol(argv[2], NULL, 10);
    int32_t     H        = (int32_t)strtol(argv[3], NULL, 10);
    int32_t     alpha    = (int32_t)strtol(argv[4], NULL, 10);
    snprintf(g_out_path, sizeof(g_out_path), "%s", argv[5]);
    g_plane_bytes = (size_t)W * (size_t)H * 2;

    char trace_path[1280];
    snprintf(trace_path, sizeof(trace_path), "%s.trace.jsonl", g_out_path);
    g_trace_fp = fopen(trace_path, "w");
    if (!g_trace_fp) {
        fprintf(stderr, "ERROR: open trace '%s': %s\n", trace_path, strerror(errno));
        return 5;
    }

    FILE *f = fopen(in_path, "rb");
    if (!f) { fprintf(stderr, "ERROR: open '%s': %s\n", in_path, strerror(errno)); return 5; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); rewind(f);
    uint8_t *igc_bytes = (uint8_t *)malloc((size_t)sz);
    fread(igc_bytes, 1, (size_t)sz, f);
    fclose(f);

    HMODULE h = LoadLibraryA("granny2.dll");
    if (!h) { fprintf(stderr, "LoadLibrary failed: %lu\n", GetLastError()); return 3; }

    g_target_arith = (BYTE *)h + DETOUR_ARITH_OFFSET;
    g_target_idwt  = (BYTE *)h + DETOUR_IDWT_OFFSET;
    fprintf(stderr, "ARITH detour : granny2.dll+0x%x @ %p, first 5 bytes :",
            DETOUR_ARITH_OFFSET, g_target_arith);
    for (int i = 0; i < 5; i++) fprintf(stderr, " %02x", g_target_arith[i]);
    fprintf(stderr, "\n");
    fprintf(stderr, "IDWT  detour : granny2.dll+0x%x @ %p, first 8 bytes :",
            DETOUR_IDWT_OFFSET, g_target_idwt);
    for (int i = 0; i < 8; i++) fprintf(stderr, " %02x", g_target_idwt[i]);
    fprintf(stderr, "\n");

    if (install_detour(g_target_arith, (void *)detour_arith_decompress,
                       DETOUR_ARITH_SAVE, &g_trampoline_arith) != 0) {
        fprintf(stderr, "ERROR: install_detour ARITH failed\n"); return 4;
    }
    if (install_detour(g_target_idwt, (void *)detour_idwt2d,
                       DETOUR_IDWT_SAVE, &g_trampoline_idwt) != 0) {
        fprintf(stderr, "ERROR: install_detour IDWT failed\n"); return 4;
    }
    fprintf(stderr, "Trampolines : arith=%p idwt=%p\n",
            g_trampoline_arith, g_trampoline_idwt);
    g_trace_active = 1;

    GrannyDecompressIGCTextureFn DecompressIGC =
        (GrannyDecompressIGCTextureFn)GetProcAddress(h, "_GrannyDecompressIGCTexture@12");
    if (!DecompressIGC) {
        fprintf(stderr, "ERROR: GetProcAddress _GrannyDecompressIGCTexture@12 failed\n");
        return 4;
    }

    size_t   rgba_bytes = (size_t)W * (size_t)H * 4u;
    uint8_t *rgba = (uint8_t *)calloc(1, rgba_bytes);

    GrannyIGCTexture igc = { W, H, alpha ? 1 : 0, (int32_t)sz, igc_bytes };
    int32_t dest_stride = W * (alpha ? 4 : 3);

    fprintf(stderr, "DECODE: starting (%dx%d alpha=%d)\n", W, H, alpha);
    DecompressIGC(&igc, dest_stride, rgba);
    fprintf(stderr, "DECODE: done — %zu arith calls, %zu iDWT2D dumps\n",
            g_trace_calls, g_idwt_calls);

    g_trace_active = 0;
    fclose(g_trace_fp);

    FILE *fo = fopen(g_out_path, "wb"); fwrite(rgba, 1, rgba_bytes, fo); fclose(fo);
    fprintf(stderr, "OUTPUT: wrote %zu bytes to %s\n", rgba_bytes, g_out_path);
    fprintf(stderr, "TRACE : wrote %zu arith calls to %s\n", g_trace_calls, trace_path);
    fprintf(stderr, "IDWT  : wrote %zu plane dumps next to %s\n", g_idwt_calls, g_out_path);

    free(rgba); free(igc_bytes);
    return 0;
}
