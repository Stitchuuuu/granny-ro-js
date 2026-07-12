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
 * --pose-json mode (numeric oracle, granny-ro-js Session B) : append the
 * --pose-json flag to emit the raw DLL numbers instead of the bbox table, so
 * the JS port can be asserted float-for-float against granny2.dll. It prints
 * ONLY parseable lines to stdout (diagnostics stay on stderr) :
 *   PLACEMENT flags=<u32> pos=<f>,<f>,<f> orient=<f>,<f>,<f>,<f> scale=<f>×9
 *     — the model's inline InitialPlacement granny_transform @ model+8
 *       (flags@8, pos@12, orient@24, scaleShear@40). Emitted before the mesh/
 *       animation path, so a fixture with no matching mesh or no animation
 *       still yields a PLACEMENT line (then exits 0 cleanly).
 *   LOCALPOSE t=<f> bone=<i> flags=<u32> pos=<3f> orient=<4f> scale=<9f>
 *     — the raw per-bone granny_transform straight out of
 *       GrannySampleModelAnimations (curve-evaluator output, pre-FK), read via
 *       _GrannyGetLocalPoseTransform@8 (granny_transform: flags@0, pos@4,
 *       orient@16 xyzw, scaleShear@32 — stride 68 B). Isolates the JS curve
 *       evaluator from the FK/skinning stages.
 *   POSE t=<f> bone=<i> m=<16 comma-sep floats>
 *     — the GetWorldPoseComposite4x4Array entry for each bone at each sampled
 *       t (col-major, T@12..14 — this is the skinning composite, world×invBind).
 * Full precision (%.9g). Without the flag the bbox table is byte-unchanged.
 * In --pose-json mode the mesh arg is OPTIONAL : POSE/LOCALPOSE are per-bone and
 * mesh-independent, so a fixture with no mesh binding (pure action files) still
 * dumps them (pass any placeholder mesh name, e.g. __pose__).
 *
 * Compile (mingw-w64) :
 *   i686-w64-mingw32-gcc -static -O2 -o prebuilt/gr2_worldpose.exe gr2_worldpose.c
 * Run via Wine with granny2.dll in CWD :
 *   wine ./gr2_worldpose.exe guildflag90_1.gr2 Object08 [duration] [samples] [--pose-json]
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
typedef void*    (__stdcall *GetLPTFn)(void*, int32_t);   /* GetLocalPoseTransform(pose, bone) -> granny_transform* */

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
    if (argc < 3) { fprintf(stderr, "usage: gr2_worldpose in.gr2 MeshName [duration] [samples] [--pose-json]\n"); return 2; }
    int poseJson = 0;
    for (int i = 1; i < argc; i++) if (strcmp(argv[i], "--pose-json") == 0) poseJson = 1;
    const char* meshName = argv[2];
    float duration = (argc > 3 && strcmp(argv[3], "--pose-json")) ? (float)atof(argv[3]) : 5.6667f;
    int   samples  = (argc > 4 && strcmp(argv[4], "--pose-json")) ? atoi(argv[4]) : 24;

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
    /* Raw local-pose reader — plain GetProcAddress (NOT P()) so a missing export
     * degrades to the buffer fallback instead of exit(9). Confirmed present in
     * the Nov-2002 build (ordinal 189), so the primary path is what runs. */
    GetLPTFn   GetLPT = (GetLPTFn) GetProcAddress(H, "_GrannyGetLocalPoseTransform@8");

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

    /* --pose-json : dump the inline InitialPlacement granny_transform @ model+8
     * (flags@8, pos@12, orient@24, scaleShear@40). Emitted here — before the
     * mesh/anim path — so placement-only fixtures still yield a line. */
    if (poseJson && model) {
        uint32_t plFlags = (uint32_t)rdI(model, 8);
        float* pl = (float*)((char*)model + 12);   /* pos=pl[0..2] orient=pl[3..6] scaleShear=pl[7..15] */
        printf("PLACEMENT flags=%u pos=%.9g,%.9g,%.9g orient=%.9g,%.9g,%.9g,%.9g "
               "scale=%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g\n",
               plFlags, pl[0], pl[1], pl[2], pl[3], pl[4], pl[5], pl[6],
               pl[7], pl[8], pl[9], pl[10], pl[11], pl[12], pl[13], pl[14], pl[15]);
        fflush(stdout);
    }

    /* locate the requested mesh by Name @ +0 */
    void* mesh = NULL;
    for (int i = 0; i < meshCount; i++) {
        char* nm = (char*)rdP(meshes[i], 0);
        fprintf(stderr, "mesh[%d].Name = \"%s\"\n", i, nm ? nm : "(null)");
        if (nm && strcmp(nm, meshName) == 0) mesh = meshes[i];
    }
    /* The POSE / LOCALPOSE dump is per-bone and mesh-independent, so in
     * --pose-json mode a missing mesh is NOT fatal — the 11 pure-action fixtures
     * carry no mesh binding yet must still reach the pose loop. Continue with
     * mesh == NULL; only the bbox (non-JSON) path actually needs vertices. */
    if (!mesh && !poseJson) { fprintf(stderr, "FATAL: mesh \"%s\" not found\n", meshName); return 7; }
    if (!mesh) fprintf(stderr, "note: mesh \"%s\" not found — pose dump is mesh-independent, continuing\n", meshName);
    if (!model || animCount < 1) { fprintf(stderr, "FATAL: no model/animation\n"); return poseJson ? 0 : 7; }

    void* inst = Instantiate(model);
    PlayCtrl(0.0f, anims[0], inst);
    void* skel = GetSkel(inst);
    int32_t boneCount = rdI(skel, 4);
    fprintf(stderr, "skeleton.Name=\"%s\" boneCount=%d\n", (char*)rdP(skel, 0), boneCount);

    /* localPose / worldPose are mesh-independent — always allocated. The mesh
     * binding + vertices are only needed by the bbox (non-JSON) skinning path,
     * so they stay NULL/0 when mesh == NULL (pose-json on a mesh-less fixture). */
    void* localPose = NewLP(boneCount);
    void* worldPose = NewWP(boneCount);

    void* binding = NULL;
    int32_t* toBone = NULL;   /* mesh-local bone idx -> skeleton bone idx */
    int32_t vcount = 0;
    uint8_t* v = NULL;
    const int STRIDE = 40, P_OFF = 0, W_OFF = 12, I_OFF = 16;
    if (mesh) {
        binding = NewBind(mesh, skel, skel);
        toBone = BindIdx(binding);
        vcount = VCount(mesh);
        v = (uint8_t*)Verts(mesh);
        fprintf(stderr, "vcount=%d first vtx pos=(%.4f,%.4f,%.4f)\n", vcount,
                ((float*)(v+P_OFF))[0], ((float*)(v+P_OFF))[1], ((float*)(v+P_OFF))[2]);
    }

    /* raw (un-posed) bbox */
    if (!poseJson) {
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
    if (!poseJson) printf("t(s)      Xspan    Yspan    Zspan     Xmin     Xmax\n");
    if (poseJson)
        fprintf(stderr, "LOCALPOSE read path: %s\n",
                GetLPT ? "_GrannyGetLocalPoseTransform@8 (primary)"
                       : "buffer fallback localPose+4 stride 68 (UNTESTED)");
    float maxXspan=-1e30f, minXspan=1e30f;
    for (int s = 0; s < samples; s++) {
        float t = (samples > 1) ? duration * (float)s / (float)(samples-1) : 0.0f;
        SetClock(inst, t);
        Sample(inst, 0, boneCount, localPose);

        /* --pose-json : dump the raw per-bone local Transform straight out of
         * GrannySampleModelAnimations (the curve-evaluator output, pre-FK).
         * granny_transform layout: flags@0, pos@4 (3f), orient@16 (4f, xyzw),
         * scaleShear@32 (9f, 3x3) — stride 68 B, same as the model+8 placement
         * read above. Emitted before POSE; POSE stdout stays byte-unchanged. */
        if (poseJson) {
            for (int b = 0; b < boneCount; b++) {
                char* tr = GetLPT ? (char*)GetLPT(localPose, b)
                                  : (char*)rdP(localPose, 4) + (size_t)b * 68;
                uint32_t fl = *(uint32_t*)(tr + 0);
                float* pp = (float*)(tr + 4);    /* pos[3]         */
                float* oo = (float*)(tr + 16);   /* orient[4] xyzw */
                float* sc = (float*)(tr + 32);   /* scaleShear[9]  */
                printf("LOCALPOSE t=%.9g bone=%d flags=%u pos=%.9g,%.9g,%.9g "
                       "orient=%.9g,%.9g,%.9g,%.9g "
                       "scale=%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g\n",
                       t, b, fl, pp[0], pp[1], pp[2], oo[0], oo[1], oo[2], oo[3],
                       sc[0], sc[1], sc[2], sc[3], sc[4], sc[5], sc[6], sc[7], sc[8]);
            }
        }

        Build(skel, 0, boneCount, localPose, NULL, worldPose);
        float* comp = Composite(worldPose);   /* boneCount * 16, col-major, T@12..14 */

        /* --pose-json : print the raw composite (skinning) matrix per bone. */
        if (poseJson) {
            for (int b = 0; b < boneCount; b++) {
                float* m = comp + b*16;
                printf("POSE t=%.9g bone=%d m=%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,"
                       "%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g,%.9g\n",
                       t, b, m[0],m[1],m[2],m[3], m[4],m[5],m[6],m[7],
                       m[8],m[9],m[10],m[11], m[12],m[13],m[14],m[15]);
            }
            continue;
        }

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
    if (!poseJson)
        printf("SUMMARY  Xspan min=%.4f max=%.4f  (max/raw ratio computed by caller)\n",
               minXspan, maxXspan);
    return 0;
}
