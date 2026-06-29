/*
 * gr2_igc_export — i386 Win32 shim around `_GrannyDecompressIGCTexture@12`.
 *
 * Takes a raw IGC bitstream blob + Width / Height / Alpha and produces
 * RGBA8888 pixel data. The IGCTexture struct is constructed locally per
 * `IGC-FORMAT.md § 2` (Width/Height/Alpha + ReferenceToArray = 20 bytes
 * total) ; the DLL's wrapper at granny2.dll @ 0x100161e0 reads those and
 * dispatches to the codec core at @ 0x10009e50.
 *
 * The .gr2 file walk lives in JS (see scripts/bake-textures.mjs) — this
 * shim is a thin black-box decoder, fed one IGC MIP at a time. Avoids
 * coupling to `_GrannyGetFileInfo`'s root-object layout (which for the
 * 2002 iRO granny2.dll does NOT match the 2007 leaked-SDK granny.h).
 *
 * SPDX-License-Identifier: MIT
 *
 * Build (mingw-w64) :
 *   i686-w64-mingw32-gcc -static -O2 -o gr2_igc_export.exe gr2_igc_export.c
 *
 * Run (Wine + qemu-i386 under aarch64) with granny2.dll in CWD :
 *   wine ./gr2_igc_export.exe <in_igc_bytes.bin> <W> <H> <alpha 0|1> <out.rgba>
 *
 * Exit codes :
 *   0  success
 *   2  bad usage
 *   3  LoadLibrary failed
 *   4  missing exports
 *   5  open/read input failed
 *   6  open/write output failed
 *   7  oom
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <errno.h>

/* `GrannyIGCTexture` reflection layout per IGC-FORMAT.md § 2 :
 *   +0   int32   Width
 *   +4   int32   Height
 *   +8   int32   Alpha
 *   +12  int32   ImageData.Count    (part of ReferenceToArray tag 0x03)
 *   +16  void*   ImageData.Data     (part of ReferenceToArray)
 * Total = 20 bytes. */
typedef struct GrannyIGCTexture {
    int32_t  Width;
    int32_t  Height;
    int32_t  Alpha;
    int32_t  ImageDataCount;
    void    *ImageData;
} GrannyIGCTexture;

/* `_GrannyDecompressIGCTexture@12` actual signature, recovered by
 * disassembling the wrapper at granny2.dll @ 0x100161e0 and tracing the
 * call to fcn.10009e50 + the fallback ConvertPixelFormat path at
 * @0x10009fcb-@0x1000a013. The wrapper's 2nd arg is **DestStride**
 * (int32, byte stride), not a pixel_layout pointer. The codec hardcodes
 * the destination layout to aux = RGBA8888 (alpha=1) / RGB888 (alpha=0)
 * via `fcn.10009b60(alpha)`. IGC-FORMAT.md § 2 incorrectly labels the
 * 2nd arg as `DestLayout*` — that was inferred from the leaked-SDK 2007
 * `BinkDecompressTexture` signature (which DOES take a layout) ; the
 * iRO 2002 wrapper has a different, simpler API. */
typedef void (__stdcall *GrannyDecompressIGCTextureFn)(
                  GrannyIGCTexture const *Image,
                  int32_t                 DestStride,
                  void                   *Dest);

static int read_file_all(char const *path, uint8_t **out_buf, size_t *out_size) {
    FILE *f = fopen(path, "rb");
    if (!f) {
        fprintf(stderr, "ERROR: open input '%s': %s\n", path, strerror(errno));
        return -1;
    }
    if (fseek(f, 0, SEEK_END) != 0) {
        fprintf(stderr, "ERROR: seek '%s': %s\n", path, strerror(errno));
        fclose(f);
        return -1;
    }
    long sz = ftell(f);
    if (sz < 0) {
        fprintf(stderr, "ERROR: ftell '%s': %s\n", path, strerror(errno));
        fclose(f);
        return -1;
    }
    rewind(f);
    uint8_t *buf = (uint8_t *)malloc((size_t)sz);
    if (!buf) {
        fclose(f);
        return -1;
    }
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) {
        fprintf(stderr, "ERROR: read '%s': %s\n", path, strerror(errno));
        free(buf);
        fclose(f);
        return -1;
    }
    fclose(f);
    *out_buf = buf;
    *out_size = (size_t)sz;
    return 0;
}

static int write_blob(char const *path, void const *buf, size_t bytes) {
    FILE *f = fopen(path, "wb");
    if (!f) {
        fprintf(stderr, "ERROR: open output '%s': %s\n", path, strerror(errno));
        return -1;
    }
    size_t w = fwrite(buf, 1, bytes, f);
    fclose(f);
    if (w != bytes) {
        fprintf(stderr, "ERROR: short write to '%s' (%zu / %zu)\n",
                path, w, bytes);
        return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 6) {
        fprintf(stderr,
                "usage: gr2_igc_export <in_igc_bytes.bin> <W> <H> <alpha 0|1> <out.rgba>\n");
        return 2;
    }

    char const *in_path  = argv[1];
    int32_t     W        = (int32_t)strtol(argv[2], NULL, 10);
    int32_t     H        = (int32_t)strtol(argv[3], NULL, 10);
    int32_t     alpha    = (int32_t)strtol(argv[4], NULL, 10);
    char const *out_path = argv[5];

    if (W <= 0 || H <= 0 || W > 8192 || H > 8192) {
        fprintf(stderr, "ERROR: implausible dims W=%d H=%d\n",
                (int)W, (int)H);
        return 2;
    }

    HMODULE h = LoadLibraryA("granny2.dll");
    if (!h) {
        fprintf(stderr, "ERROR: LoadLibrary(granny2.dll) failed: %lu\n",
                (unsigned long)GetLastError());
        return 3;
    }

    GrannyDecompressIGCTextureFn DecompressIGC =
        (GrannyDecompressIGCTextureFn)GetProcAddress(
            h, "_GrannyDecompressIGCTexture@12");
    if (!DecompressIGC) {
        fprintf(stderr, "ERROR: missing _GrannyDecompressIGCTexture@12 export\n");
        return 4;
    }

    uint8_t *igc_bytes = NULL;
    size_t   igc_size  = 0;
    if (read_file_all(in_path, &igc_bytes, &igc_size) != 0) {
        return 5;
    }

    size_t   rgba_bytes = (size_t)W * (size_t)H * 4u;
    uint8_t *rgba = (uint8_t *)calloc(1, rgba_bytes);
    if (!rgba) {
        free(igc_bytes);
        return 7;
    }

    GrannyIGCTexture igc;
    igc.Width          = W;
    igc.Height         = H;
    igc.Alpha          = alpha ? 1 : 0;
    igc.ImageDataCount = (int32_t)igc_size;
    igc.ImageData      = igc_bytes;

    /* DestStride = W * (alpha ? 4 : 3) — codec writes RGBA8888 / RGB888
     * based on aux layout (fcn.10009b60(alpha)). For alpha=1 with our
     * RGBA out buffer that's exactly W*4. */
    int32_t dest_stride = W * (alpha ? 4 : 3);
    DecompressIGC(&igc, dest_stride, rgba);

    int rc = write_blob(out_path, rgba, rgba_bytes) == 0 ? 0 : 6;

    free(rgba);
    free(igc_bytes);
    return rc;
}
