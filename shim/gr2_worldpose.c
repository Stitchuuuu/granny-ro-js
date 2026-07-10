/*
 * gr2_worldpose — i386 Win32 oracle that runs the REAL granny2.dll's exact
 * client animation+skinning chain and dumps the deformed world-space bbox of
 * a named mesh across the animation cycle.
 *
 * Purpose (sandbox-player-sprite S1.2) : break the circular "16.77 / 1 cell"
 * measurement that so far only ever ran through the clean-room granny-ro-js
 * decoder. The real DLL is ground truth for whether the banner WAVES OUT
 * (bind furled ~16.77 → animated ~2×) or stays ~1 cell.
 *
 * Chain replicated verbatim from ragexe fcn.004358c0 (asm-cited) :
 *   skel  = GrannyGetSourceSkeleton(inst)
 *   bones = *(skel + 4)                          ; granny_skeleton.BoneCount
 *   GrannySetModelClock(inst, t)
 *   GrannySampleModelAnimations(inst, 0, bones, localPose)
 *   GrannyBuildWorldPose(skel, 0, bones, localPose, NULL, worldPose)  ; Offset4x4=NULL
 * plus the setup the caller does elsewhere : InstantiateModel +
 * PlayControlledAnimation, and the deform side : GetWorldPoseComposite4x4Array
 * + linear-blend skin of GrannyGetMeshVertices (weights/indices in-vertex).
 *
 * granny2.dll is the Nov-2002 build shipped in every iRO era (md5
 * c4879696…, byte-identical ver12 == mars26 == rag211105).
 *
 * Compile (mingw-w64) :
 *   i686-w64-mingw32-gcc -static -O2 -o prebuilt/gr2_worldpose.exe gr2_worldpose.c
 * Run via Wine with granny2.dll in CWD :
 *   wine ./gr2_worldpose.exe guildflag90_1.gr2 Object08 [duration] [samples]
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>

/* ---- granny2.dll __stdcall typedefs ---- */
typedef void*    (__stdcall *ReadMemFn)(int32_t, void*);
typedef void*    (__stdcall *GetInfoFn)(void*);
typedef void*    (__stdcall *InstFn)(void*);
typedef void*    (__stdcall *PlayCtrlFn)(float, void*, void*);
typedef void*    (__stdcall *GetSkelFn)(void*);
typedef void     (__stdcall *SetClockFn)(void*, float);
typedef void     (__stdcall *SampleFn)(void*, int32_t, int32_t, void*);
typedef void     (__stdcall *BuildFn)(void*, int32_t, int32_t, void*, float*, void*);
typedef float*   (__stdcall *CompFn)(void*);
typedef void*    (__stdcall *NewLPFn)(int32_t);
typedef void*    (__stdcall *NewWPFn)(int32_t);
typedef int32_t  (__stdcall *VCountFn)(void*);
typedef void*    (__stdcall *VertsFn)(void*);
typedef void*    (__stdcall *NewBindFn)(void*, void*, void*);
typedef int32_t* (__stdcall *BindIdxFn)(void*);

static HMODULE H;
static void* P(const char* name) {
    void* p = GetProcAddress(H, name);
    if (!p) { fprintf(stderr, "FATAL: GetProcAddress(%s) failed\n", name); exit(9); }
    return p;
}

/* granny_file_info offsets (32-bit). Confirmed against THIS file's serialized
 * root type-tree (Granny fixes up in place, so on-disk offset == runtime
 * struct offset): leading _GrannyFileStringTable@0, then ArtToolInfo@4,
 * ExporterInfo@8, FromFileName@12, then array-of-refs {count,ptr} pairs —
 * Textures@16, Materials@24, Skeletons@32, VertexDatas@40, TriTopologies@48,
 * Meshes@56, Models@64, TrackGroups@72, Animations@80. Runtime stderr dump
 * (info dwords + names) re-validates. */
#define OFF_MESHCOUNT  56
#define OFF_MESHES     60
#define OFF_MODELCOUNT 64
#define OFF_MODELS     68
#define OFF_ANIMCOUNT  80
#define OFF_ANIMS      84

static int32_t rdI(void* base, int off) { return *(int32_t*)((char*)base + off); }
static void*   rdP(void* base, int off) { return *(void**)((char*)base + off); }

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: gr2_worldpose in.gr2 MeshName [duration] [samples]\n"); return 2; }
    const char* meshName = argv[2];
    float duration = argc > 3 ? (float)atof(argv[3]) : 5.6667f;
    int   samples  = argc > 4 ? atoi(argv[4]) : 24;

    H = LoadLibraryA("granny2.dll");
    if (!H) { fprintf(stderr, "FATAL: LoadLibrary(granny2.dll) = %lu\n", (unsigned long)GetLastError()); return 3; }

    ReadMemFn  ReadMem = (ReadMemFn) P("_GrannyReadEntireFileFromMemory@8");
    GetInfoFn  GetInfo = (GetInfoFn) P("_GrannyGetFileInfo@4");
    InstFn     Instantiate = (InstFn) P("_GrannyInstantiateModel@4");
    PlayCtrlFn PlayCtrl = (PlayCtrlFn) P("_GrannyPlayControlledAnimation@12");
    GetSkelFn  GetSkel = (GetSkelFn) P("_GrannyGetSourceSkeleton@4");
    SetClockFn SetClock = (SetClockFn) P("_GrannySetModelClock@8");
    SampleFn   Sample = (SampleFn) P("_GrannySampleModelAnimations@16");
    BuildFn    Build = (BuildFn) P("_GrannyBuildWorldPose@24");
    CompFn     Composite = (CompFn) P("_GrannyGetWorldPoseComposite4x4Array@4");
    NewLPFn    NewLP = (NewLPFn) P("_GrannyNewLocalPose@4");
    NewWPFn    NewWP = (NewWPFn) P("_GrannyNewWorldPose@4");
    VCountFn   VCount = (VCountFn) P("_GrannyGetMeshVertexCount@4");
    VertsFn    Verts = (VertsFn) P("_GrannyGetMeshVertices@4");
    NewBindFn  NewBind = (NewBindFn) P("_GrannyNewMeshBinding@12");
    BindIdxFn  BindIdx = (BindIdxFn) P("_GrannyGetMeshBindingToBoneIndices@4");

    /* read file into a heap buffer that stays alive (Granny fixes up in place) */
    FILE* f = fopen(argv[1], "rb");
    if (!f) { perror("open"); return 5; }
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    void* buf = malloc((size_t)sz);
    if (fread(buf, 1, (size_t)sz, f) != (size_t)sz) { perror("read"); return 5; }
    fclose(f);

    void* file = ReadMem((int32_t)sz, buf);
    if (!file) { fprintf(stderr, "FATAL: ReadEntireFileFromMemory returned NULL\n"); return 6; }
    void* info = GetInfo(file);
    if (!info) { fprintf(stderr, "FATAL: GetFileInfo returned NULL\n"); return 6; }

    /* --- ABI validation dump --- */
    fprintf(stderr, "info dwords[0..24]:\n");
    for (int i = 0; i < 25; i++) fprintf(stderr, "  [%2d @%3d] %d\n", i, i*4, rdI(info, i*4));

    int32_t meshCount  = rdI(info, OFF_MESHCOUNT);
    void**  meshes     = (void**)rdP(info, OFF_MESHES);
    int32_t modelCount = rdI(info, OFF_MODELCOUNT);
    void**  models     = (void**)rdP(info, OFF_MODELS);
    int32_t animCount  = rdI(info, OFF_ANIMCOUNT);
    void**  anims      = (void**)rdP(info, OFF_ANIMS);
    fprintf(stderr, "meshCount=%d modelCount=%d animCount=%d\n", meshCount, modelCount, animCount);

    /* model[0] name (Name @ +0) */
    void* model = (modelCount > 0) ? models[0] : NULL;
    if (model) fprintf(stderr, "model[0].Name = \"%s\"\n", (char*)rdP(model, 0));

    /* locate the requested mesh by Name @ +0 */
    void* mesh = NULL;
    for (int i = 0; i < meshCount; i++) {
        char* nm = (char*)rdP(meshes[i], 0);
        fprintf(stderr, "mesh[%d].Name = \"%s\"\n", i, nm ? nm : "(null)");
        if (nm && strcmp(nm, meshName) == 0) mesh = meshes[i];
    }
    if (!mesh) { fprintf(stderr, "FATAL: mesh \"%s\" not found\n", meshName); return 7; }
    if (!model || animCount < 1) { fprintf(stderr, "FATAL: no model/animation\n"); return 7; }

    void* inst = Instantiate(model);
    PlayCtrl(0.0f, anims[0], inst);
    void* skel = GetSkel(inst);
    int32_t boneCount = rdI(skel, 4);
    fprintf(stderr, "skeleton.Name=\"%s\" boneCount=%d\n", (char*)rdP(skel, 0), boneCount);

    void* binding = NewBind(mesh, skel, skel);
    int32_t* toBone = BindIdx(binding);   /* mesh-local bone idx -> skeleton bone idx */

    void* localPose = NewLP(boneCount);
    void* worldPose = NewWP(boneCount);

    int32_t vcount = VCount(mesh);
    uint8_t* v = (uint8_t*)Verts(mesh);
    const int STRIDE = 40, P_OFF = 0, W_OFF = 12, I_OFF = 16;
    fprintf(stderr, "vcount=%d first vtx pos=(%.4f,%.4f,%.4f)\n", vcount,
            ((float*)(v+P_OFF))[0], ((float*)(v+P_OFF))[1], ((float*)(v+P_OFF))[2]);

    /* raw (un-posed) bbox */
    {
        float mnx=1e30f,mxx=-1e30f,mny=1e30f,mxy=-1e30f,mnz=1e30f,mxz=-1e30f;
        for (int i = 0; i < vcount; i++) {
            float* p = (float*)(v + i*STRIDE + P_OFF);
            if(p[0]<mnx)mnx=p[0]; if(p[0]>mxx)mxx=p[0];
            if(p[1]<mny)mny=p[1]; if(p[1]>mxy)mxy=p[1];
            if(p[2]<mnz)mnz=p[2]; if(p[2]>mxz)mxz=p[2];
        }
        printf("RAW  bbox  X[%.4f,%.4f] span=%.4f  Y span=%.4f  Z span=%.4f\n",
               mnx,mxx,mxx-mnx, mxy-mny, mxz-mnz);
    }

    /* posed+skinned bbox across the cycle */
    printf("t(s)      Xspan    Yspan    Zspan     Xmin     Xmax\n");
    float maxXspan=-1e30f, minXspan=1e30f;
    for (int s = 0; s < samples; s++) {
        float t = (samples > 1) ? duration * (float)s / (float)(samples-1) : 0.0f;
        SetClock(inst, t);
        Sample(inst, 0, boneCount, localPose);
        Build(skel, 0, boneCount, localPose, NULL, worldPose);
        float* comp = Composite(worldPose);   /* boneCount * 16, col-major, T@12..14 */

        float mnx=1e30f,mxx=-1e30f,mny=1e30f,mxy=-1e30f,mnz=1e30f,mxz=-1e30f;
        for (int i = 0; i < vcount; i++) {
            uint8_t* vb = v + i*STRIDE;
            float* p = (float*)(vb + P_OFF);
            uint8_t* w = vb + W_OFF;
            uint8_t* bi = vb + I_OFF;
            float wsum = (float)w[0]+w[1]+w[2]+w[3];
            if (wsum <= 0.0f) wsum = 1.0f;
            float ox=0, oy=0, oz=0;
            for (int l = 0; l < 4; l++) {
                if (w[l] == 0) continue;
                int32_t sb = toBone ? toBone[bi[l]] : bi[l];
                float* m = comp + sb*16;
                float wx = (float)w[l] / wsum;
                ox += wx * (p[0]*m[0] + p[1]*m[4] + p[2]*m[8]  + m[12]);
                oy += wx * (p[0]*m[1] + p[1]*m[5] + p[2]*m[9]  + m[13]);
                oz += wx * (p[0]*m[2] + p[1]*m[6] + p[2]*m[10] + m[14]);
            }
            if(ox<mnx)mnx=ox; if(ox>mxx)mxx=ox;
            if(oy<mny)mny=oy; if(oy>mxy)mxy=oy;
            if(oz<mnz)mnz=oz; if(oz>mxz)mxz=oz;
        }
        float xs = mxx-mnx;
        if (xs>maxXspan) maxXspan=xs;
        if (xs<minXspan) minXspan=xs;
        printf("%7.4f  %7.4f  %7.4f  %7.4f  %8.4f %8.4f\n", t, xs, mxy-mny, mxz-mnz, mnx, mxx);
    }
    printf("SUMMARY  Xspan min=%.4f max=%.4f  (max/raw ratio computed by caller)\n",
           minXspan, maxXspan);
    return 0;
}
