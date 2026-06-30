/*
 * gr2_igc_export_hooked — workaround for granny2.dll's heap-buffer overflow bug.
 *
 * The DLL's `Arith_open` (fcn.1000e0c0) computes alloc_size via
 * `4 * ((uniqueValues+5)&~3) + 0x38` where `uniqueValues` is taken from the
 * IGC bitstream. For some textures (e.g. kg7-tex0), `uniqueValues = 0xF817 =
 * 63511`, producing alloc_size = 254,120 bytes. But the caller (fcn.10007540
 * / fcn.10006e50 chain) allocates a much smaller buffer (~64 KB) for the
 * Arith context. The subsequent `memset(buf, 0, 254120)` overflows by ~190
 * KB. On Windows XP the overflow wrote into scratch space without crashing.
 * On Wine (Linux or macOS), the overflow hits an uncommitted guard page —
 * page fault at 0x10019DA5.
 *
 * Workaround : install an in-process detour on ntdll.RtlAllocateHeap that
 * multiplies every requested allocation size by N (default 16). This grows
 * the Arith ctx buffer enough to absorb the overflow.
 *
 * Build (mingw-w64) :
 *   i686-w64-mingw32-gcc -static -O2 -o gr2_igc_export_hooked.exe gr2_igc_export_hooked.c
 *
 * Run :
 *   wine ./gr2_igc_export_hooked.exe <in.bin> <W> <H> <alpha> <out.rgba>
 *
 * SPDX-License-Identifier: MIT
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

#define ALLOC_MULTIPLIER 16
#define ALLOC_MIN_BYTES (1024 * 1024)   /* 1 MB minimum */

typedef PVOID (NTAPI *RtlAllocateHeapFn)(PVOID HeapHandle, ULONG Flags, SIZE_T Size);

static RtlAllocateHeapFn g_orig_RtlAllocateHeap = NULL;
static int g_hook_active = 0;
static size_t g_hook_calls = 0;

/* Hook : multiply size by ALLOC_MULTIPLIER, ensure ALLOC_MIN_BYTES floor. */
static PVOID NTAPI hook_RtlAllocateHeap(PVOID HeapHandle, ULONG Flags, SIZE_T Size) {
    if (!g_hook_active) {
        return g_orig_RtlAllocateHeap(HeapHandle, Flags, Size);
    }
    SIZE_T new_size = Size * ALLOC_MULTIPLIER;
    if (new_size < Size) new_size = (SIZE_T)-1;   /* overflow guard */
    if (new_size < ALLOC_MIN_BYTES) new_size = ALLOC_MIN_BYTES;
    g_hook_calls++;
    return g_orig_RtlAllocateHeap(HeapHandle, Flags, new_size);
}

/* Install a 5-byte JMP detour at target. Saves the original 5 bytes into a
 * VirtualAlloc'd trampoline, appends a `JMP target+5` so the trampoline can
 * be called as the "original" function. */
static int install_detour(BYTE *target, void *detour, void **out_trampoline) {
    if (!target || !detour) return -1;

    /* Allocate a 16-byte trampoline page. */
    BYTE *trampoline = (BYTE *)VirtualAlloc(NULL, 16, MEM_COMMIT | MEM_RESERVE, PAGE_EXECUTE_READWRITE);
    if (!trampoline) return -2;

    /* Save the original 5 bytes into the trampoline. */
    memcpy(trampoline, target, 5);

    /* Append `JMP rel32 → target+5` to the trampoline. */
    trampoline[5] = 0xE9;
    int32_t rel_back = (int32_t)((intptr_t)(target + 5) - (intptr_t)(trampoline + 10));
    memcpy(trampoline + 6, &rel_back, 4);

    /* Make target writable, patch with `JMP rel32 → detour`. */
    DWORD old_prot;
    if (!VirtualProtect(target, 5, PAGE_EXECUTE_READWRITE, &old_prot)) {
        VirtualFree(trampoline, 0, MEM_RELEASE);
        return -3;
    }
    target[0] = 0xE9;
    int32_t rel_forward = (int32_t)((intptr_t)detour - (intptr_t)(target + 5));
    memcpy(target + 1, &rel_forward, 4);

    DWORD ignore;
    VirtualProtect(target, 5, old_prot, &ignore);

    *out_trampoline = trampoline;
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
                "usage: gr2_igc_export_hooked <in.bin> <W> <H> <alpha 0|1> <out.rgba>\n"
                "  Installs a detour on ntdll.RtlAllocateHeap that multiplies\n"
                "  every alloc size by %d (min %d bytes) to work around granny2.dll's\n"
                "  Arith_open heap-buffer overflow.\n",
                ALLOC_MULTIPLIER, ALLOC_MIN_BYTES);
        return 2;
    }

    char const *in_path  = argv[1];
    int32_t     W        = (int32_t)strtol(argv[2], NULL, 10);
    int32_t     H        = (int32_t)strtol(argv[3], NULL, 10);
    int32_t     alpha    = (int32_t)strtol(argv[4], NULL, 10);
    char const *out_path = argv[5];

    if (W <= 0 || H <= 0 || W > 8192 || H > 8192) {
        fprintf(stderr, "ERROR: implausible dims W=%d H=%d\n", (int)W, (int)H);
        return 2;
    }

    /* Read input file. */
    FILE *f = fopen(in_path, "rb");
    if (!f) {
        fprintf(stderr, "ERROR: open input '%s': %s\n", in_path, strerror(errno));
        return 5;
    }
    fseek(f, 0, SEEK_END);
    long sz = ftell(f);
    rewind(f);
    uint8_t *igc_bytes = (uint8_t *)malloc((size_t)sz);
    if (!igc_bytes || fread(igc_bytes, 1, (size_t)sz, f) != (size_t)sz) {
        fclose(f);
        free(igc_bytes);
        return 5;
    }
    fclose(f);

    /* Install the RtlAllocateHeap detour BEFORE LoadLibrary so we catch all
     * granny2.dll allocs. */
    HMODULE ntdll = GetModuleHandleA("ntdll.dll");
    if (!ntdll) {
        fprintf(stderr, "ERROR: GetModuleHandle(ntdll.dll) failed\n");
        return 4;
    }
    BYTE *rt_alloc = (BYTE *)GetProcAddress(ntdll, "RtlAllocateHeap");
    if (!rt_alloc) {
        fprintf(stderr, "ERROR: GetProcAddress(RtlAllocateHeap) failed\n");
        return 4;
    }

    /* Sanity-check : first 5 bytes shouldn't be a short jump / call (rel8 ops
     * are 2 bytes, but a `mov edi,edi; push ebp; mov ebp,esp; ...` MS-hotpatch
     * prologue is fine to detour). */
    fprintf(stderr, "ntdll.RtlAllocateHeap @ %p, first 5 bytes :", rt_alloc);
    for (int i = 0; i < 5; i++) fprintf(stderr, " %02x", rt_alloc[i]);
    fprintf(stderr, "\n");

    void *trampoline = NULL;
    if (install_detour(rt_alloc, (void *)hook_RtlAllocateHeap, &trampoline) != 0) {
        fprintf(stderr, "ERROR: install_detour failed\n");
        return 4;
    }
    g_orig_RtlAllocateHeap = (RtlAllocateHeapFn)trampoline;
    g_hook_active = 1;
    fprintf(stderr, "DETOUR: hooked RtlAllocateHeap (multiplier=%d, min=%d bytes)\n",
            ALLOC_MULTIPLIER, ALLOC_MIN_BYTES);

    /* Load granny2.dll. The hook is now active : all granny2 allocs are
     * inflated. */
    HMODULE h = LoadLibraryA("granny2.dll");
    if (!h) {
        fprintf(stderr, "ERROR: LoadLibrary(granny2.dll) failed: %lu\n",
                (unsigned long)GetLastError());
        return 3;
    }

    GrannyDecompressIGCTextureFn DecompressIGC =
        (GrannyDecompressIGCTextureFn)GetProcAddress(h, "_GrannyDecompressIGCTexture@12");
    if (!DecompressIGC) {
        fprintf(stderr, "ERROR: missing _GrannyDecompressIGCTexture@12 export\n");
        return 4;
    }

    size_t   rgba_bytes = (size_t)W * (size_t)H * 4u;
    uint8_t *rgba = (uint8_t *)calloc(1, rgba_bytes);
    if (!rgba) return 7;

    GrannyIGCTexture igc;
    igc.Width          = W;
    igc.Height         = H;
    igc.Alpha          = alpha ? 1 : 0;
    igc.ImageDataCount = (int32_t)sz;
    igc.ImageData      = igc_bytes;

    int32_t dest_stride = W * (alpha ? 4 : 3);

    fprintf(stderr, "DECOMPRESS: calling _GrannyDecompressIGCTexture (%dx%d alpha=%d)\n",
            (int)W, (int)H, (int)alpha);
    DecompressIGC(&igc, dest_stride, rgba);
    fprintf(stderr, "DECOMPRESS: returned after %zu hooked allocs\n", g_hook_calls);

    /* Disable hook AFTER the call so cleanup doesn't go through it. */
    g_hook_active = 0;

    /* Write output. */
    FILE *fo = fopen(out_path, "wb");
    if (!fo) {
        fprintf(stderr, "ERROR: open output '%s': %s\n", out_path, strerror(errno));
        return 6;
    }
    fwrite(rgba, 1, rgba_bytes, fo);
    fclose(fo);
    fprintf(stderr, "OUTPUT: wrote %zu bytes to %s\n", rgba_bytes, out_path);

    free(rgba);
    free(igc_bytes);
    return 0;
}
