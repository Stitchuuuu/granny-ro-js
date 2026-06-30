/*
 * gr2_igc_export_trace — captures per-call ARITH ctx state via in-process detour.
 *
 * Installs a 5-byte JMP at granny2.dll+0xE6F0 (entry of fcn.1000e6f0, the
 * Arith_decompress function). The detour logs the ctx struct fields read by
 * the function (cumCounts[16], singlesLength, bandBoundary, shiftDepth,
 * bucketSize, uniqueCount) to a JSON-lines file, then chains back to the
 * original function.
 *
 * Output format (one JSON per call, written to <out.rgba>.trace) :
 *   {"call":N,"ctx":"0xADDR","cum":[u16x16],"sL":N,"bB":N,"sD":N,"bS":N,"uC":N}
 *
 * Build :
 *   i686-w64-mingw32-gcc -static -O2 -masm=intel -o gr2_igc_export_trace.exe gr2_igc_export_trace.c
 *
 * Run :
 *   wine ./gr2_igc_export_trace.exe <in.bin> <W> <H> <alpha> <out.rgba>
 *
 * SPDX-License-Identifier: MIT
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

#define DETOUR_OFFSET 0xE6F0       /* offset of fcn.1000e6f0 inside granny2.dll */
#define DETOUR_SAVE_BYTES 8         /* save 8 bytes : 3 first instructions (sub esp,8; push esi; mov esi,[esp+0x10]). 5-byte patch ends mid-mov, trampoline must restart at +8. */

static FILE   *g_trace_fp = NULL;
static int     g_trace_active = 0;
static size_t  g_trace_calls = 0;
static BYTE   *g_target = NULL;     /* granny2.dll + 0xE6F0 */
static BYTE   *g_trampoline = NULL; /* original 5 bytes + JMP target+5 */

/* Log function called from the detour trampoline. ctx_ptr = ESI at function entry. */
/* Log : 2 args (ctx, ab) -- __stdcall(@8) */
void __stdcall log_arith_state(void *ctx_ptr, void *ab_ptr) {
    if (!g_trace_fp || !g_trace_active || !ctx_ptr) return;
    g_trace_calls++;
    uint16_t *cc = (uint16_t *)ctx_ptr;
    uint32_t *ab = (uint32_t *)ab_ptr;
    /* DLL ab layout (from fcn.1000ddc0 disasm) :
     *   +0x00 : buf ptr
     *   +0x08 : bit buffer (U32 cached bits)
     *   +0x0c : bit position
     *   +0x10 : high
     *   +0x14 : low
     *   +0x18 : target (stream value f3)
     */
    uint32_t ab_high = ab_ptr ? ab[4] : 0;   /* +0x10 / 4 = idx 4 */
    uint32_t ab_low  = ab_ptr ? ab[5] : 0;   /* +0x14 */
    uint32_t ab_tgt  = ab_ptr ? ab[6] : 0;   /* +0x18 */
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

/* Detour entry — naked function so we control the asm precisely.
 *
 * Original fcn.1000e6f0 prologue (8 bytes) :
 *   0x1000e6f0  sub  esp, 8       ; 3 bytes : 83 EC 08
 *   0x1000e6f3  push esi          ; 1 byte  : 56
 *   0x1000e6f4  mov  esi, [esp+10] ; 4 bytes : 8B 74 24 10
 *
 * We patch the first 5 bytes (sub esp,8 + push esi + the first byte of mov).
 * To restore semantics: in the detour, we execute `sub esp,8; push esi`
 * ourselves, then jump to the (target + 8) which skips the `push esi` we
 * already did, but we also need `mov esi, [esp+10]` — but that's inside the
 * 5-byte patch range. So instead, we re-execute the WHOLE 8 bytes via the
 * trampoline (which has bytes 0..4 saved + JMP to target+5).
 *
 * Sequence :
 *   1. Save all registers + flags
 *   2. Read [esp+offset] to get arg_4h (= the function's first arg, = ctx ptr)
 *   3. Call log_arith_state(ctx_ptr)
 *   4. Restore registers + flags
 *   5. JMP to trampoline (which executes saved 5 bytes then jumps to target+5)
 *
 * Naked function — no C-managed prologue/epilogue. */
__declspec(naked) static void detour_arith_decompress(void) {
    /* AT&T syntax. After pushal+pushfl : esp offset = 0x24 from caller's esp.
     * fcn.1000e6f0 takes (arg_4h=ctx, arg_8h=ab). At entry, [esp_caller+4]=ctx,
     * [esp_caller+8]=ab. After pushal+pushfl that's [esp+0x28]=ctx, [esp+0x2c]=ab.
     * Push right-to-left for __stdcall : ab first, ctx last. Then call @8. */
    __asm__ __volatile__(
        "pushal\n\t"
        "pushfl\n\t"
        "movl 0x2c(%%esp), %%eax\n\t"   /* eax = ab */
        "pushl %%eax\n\t"
        "movl 0x2c(%%esp), %%eax\n\t"   /* eax = ctx (was at 0x28 before our push, now 0x2c) */
        "pushl %%eax\n\t"
        "call _log_arith_state@8\n\t"    /* __stdcall : cleans 8 bytes */
        "popfl\n\t"
        "popal\n\t"
        "jmp _g_trampoline_invoke\n\t"
        : : : "memory"
    );
}

/* Indirect jump through g_trampoline pointer (set at runtime by install_detour). */
__declspec(naked) void g_trampoline_invoke(void) {
    __asm__ __volatile__(
        "jmpl *_g_trampoline\n\t"
        : : : "memory"
    );
}

static int install_detour(BYTE *target, void *detour) {
    /* Allocate trampoline (32 bytes is enough for 8 saved + 5 JMP). */
    BYTE *tramp = (BYTE *)VirtualAlloc(NULL, 32, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!tramp) return -2;

    /* Save original DETOUR_SAVE_BYTES bytes into trampoline.
     * (8 bytes covers the full 3-instruction prologue of fcn.1000e6f0.) */
    memcpy(tramp, target, DETOUR_SAVE_BYTES);

    /* Append `JMP rel32` → target + DETOUR_SAVE_BYTES.
     * The JMP starts at tramp+DETOUR_SAVE_BYTES, instruction is 5 bytes (E9 + 4 byte rel32).
     * next_eip after the JMP = tramp + DETOUR_SAVE_BYTES + 5. */
    tramp[DETOUR_SAVE_BYTES] = 0xE9;
    int32_t rel_back = (int32_t)((intptr_t)(target + DETOUR_SAVE_BYTES) -
                                  (intptr_t)(tramp + DETOUR_SAVE_BYTES + 5));
    memcpy(tramp + DETOUR_SAVE_BYTES + 1, &rel_back, 4);

    g_trampoline = tramp;

    /* Patch target with `JMP rel32` → detour. We still patch only 5 bytes (the
     * JMP instruction). Bytes target+5..target+DETOUR_SAVE_BYTES-1 are dead
     * code (never executed — detour will JMP through trampoline to target+8). */
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
                "usage: gr2_igc_export_trace <in.bin> <W> <H> <alpha 0|1> <out.rgba>\n"
                "  Captures per-call ARITH ctx state to <out.rgba>.trace.jsonl\n");
        return 2;
    }
    char const *in_path  = argv[1];
    int32_t     W        = (int32_t)strtol(argv[2], NULL, 10);
    int32_t     H        = (int32_t)strtol(argv[3], NULL, 10);
    int32_t     alpha    = (int32_t)strtol(argv[4], NULL, 10);
    char const *out_path = argv[5];

    /* Open trace file. */
    char trace_path[1024];
    snprintf(trace_path, sizeof(trace_path), "%s.trace.jsonl", out_path);
    g_trace_fp = fopen(trace_path, "w");
    if (!g_trace_fp) {
        fprintf(stderr, "ERROR: open trace '%s': %s\n", trace_path, strerror(errno));
        return 5;
    }

    /* Read input. */
    FILE *f = fopen(in_path, "rb");
    if (!f) { fprintf(stderr, "ERROR: open '%s': %s\n", in_path, strerror(errno)); return 5; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); rewind(f);
    uint8_t *igc_bytes = (uint8_t *)malloc((size_t)sz);
    fread(igc_bytes, 1, (size_t)sz, f);
    fclose(f);

    /* Load DLL. */
    HMODULE h = LoadLibraryA("granny2.dll");
    if (!h) { fprintf(stderr, "LoadLibrary failed: %lu\n", GetLastError()); return 3; }

    /* Install detour at granny2.dll + 0xE6F0. */
    g_target = (BYTE *)h + DETOUR_OFFSET;
    fprintf(stderr, "DETOUR: granny2.dll @ %p, target @ %p, first 5 bytes :",
            (void *)h, g_target);
    for (int i = 0; i < 5; i++) fprintf(stderr, " %02x", g_target[i]);
    fprintf(stderr, "\n");

    if (install_detour(g_target, (void *)detour_arith_decompress) != 0) {
        fprintf(stderr, "ERROR: install_detour failed\n");
        return 4;
    }
    fprintf(stderr, "DETOUR: trampoline @ %p\n", g_trampoline);
    g_trace_active = 1;

    GrannyDecompressIGCTextureFn DecompressIGC =
        (GrannyDecompressIGCTextureFn)GetProcAddress(h, "_GrannyDecompressIGCTexture@12");

    size_t   rgba_bytes = (size_t)W * (size_t)H * 4u;
    uint8_t *rgba = (uint8_t *)calloc(1, rgba_bytes);

    GrannyIGCTexture igc = { W, H, alpha ? 1 : 0, (int32_t)sz, igc_bytes };
    int32_t dest_stride = W * (alpha ? 4 : 3);

    fprintf(stderr, "DECODE: starting (%dx%d alpha=%d)\n", W, H, alpha);
    DecompressIGC(&igc, dest_stride, rgba);
    fprintf(stderr, "DECODE: done, captured %zu calls\n", g_trace_calls);

    g_trace_active = 0;
    fclose(g_trace_fp);

    FILE *fo = fopen(out_path, "wb"); fwrite(rgba, 1, rgba_bytes, fo); fclose(fo);
    fprintf(stderr, "OUTPUT: wrote %zu bytes to %s\n", rgba_bytes, out_path);
    fprintf(stderr, "TRACE : wrote %zu calls to %s\n", g_trace_calls, trace_path);

    free(rgba); free(igc_bytes);
    return 0;
}
