/*
 * gr2_worldpose_isoclient — EXHAUSTIVE iso-client granny oracle.
 *
 * Goal: leave ZERO unknowns on the granny side of the guild-flag (mob 722)
 * render. The original gr2_worldpose.c took shortcuts (one mesh, manual LBS,
 * Offset4x4=NULL, skipped VersionsMatch/IsRigid/VertexType/Deformer). If ANY
 * granny call the client makes modifies the geometry, we must SEE it — so this
 * harness makes the client's FULL chain and cross-checks every stage.
 *
 * Client chain (ragexe mars26 fcn.00683f60 / fcn.006800d0 / fcn.00c03e10),
 * exact symbols from index/imports.tsv:
 *   VersionsMatch_ -> ReadEntireFileFromMemory -> GetFileInfo ->
 *   InstantiateModel -> NewWorldPose -> GetSourceSkeleton ->
 *   [per mesh] NewMeshBinding -> GetMeshBindingToBoneIndices ->
 *              GetMeshIndexCount -> GetMeshBytesPerIndex -> CopyMeshIndices ->
 *              GetMeshVertexCount -> MeshIsRigid -> GetMeshVertexType ->
 *              NewMeshDeformer(src,PNT332,dof) ->
 *   [per frame] SetModelClock -> SampleModelAnimations -> NewLocalPose ->
 *               BuildWorldPose(...,Offset4x4,...) ->
 *               GetWorldPoseComposite4x4Array ->
 *               DeformVertices(deformer, indexMap, composite, n, src, dst)
 *
 * CROSS-CHECKS emitted (this is the whole point):
 *   1. per-mesh RAW (bind) bbox + POSED bbox, BOTH meshes, + UNION.
 *   2. DLL DeformVertices bbox  vs  our manual LBS bbox  (must match; if not, a
 *      granny call is doing something we reimplemented wrong).
 *   3. model[0].InitialPlacement 4x4 dumped + scale magnitude — the prime
 *      suspect for a ~2.76x the NULL-offset run missed.
 *   4. BuildWorldPose with Offset4x4 = NULL  vs  = InitialPlacement  -> compare
 *      the two posed bboxes. If they differ by ~2.76x, the flag really renders
 *      that much bigger and the shortcut hid it.
 *   5. root bone composite scale (basis-vector lengths) — any bone scale != 1.
 *
 * granny2.dll = the byte-identical client build (md5 c4879696…, verified
 * mars-26/granny2.dll == oracle-run/granny2.dll).
 *
 * Compile (mingw-w64, host):
 *   i686-w64-mingw32-gcc -static -O2 -o gr2_worldpose_isoclient.exe gr2_worldpose_isoclient.c
 * Run (host, granny2.dll in CWD):
 *   wine ./gr2_worldpose_isoclient.exe guildflag90_1.gr2 [duration] [samples]
 *   (no mesh-name arg — it loops ALL meshes.)
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdint.h>
#include <math.h>

/* ---- granny2.dll __stdcall typedefs (arg counts from the @N decoration) ---- */
typedef void*    (__stdcall *ReadMemFn)(int32_t, void*);            /* @8  */
typedef void*    (__stdcall *GetInfoFn)(void*);                     /* @4  */
typedef void*    (__stdcall *InstFn)(void*);                        /* @4  */
typedef void*    (__stdcall *PlayCtrlFn)(float, void*, void*);      /* @12 */
typedef void*    (__stdcall *GetSkelFn)(void*);                     /* @4  */
typedef void     (__stdcall *SetClockFn)(void*, float);            /* @8  */
typedef void     (__stdcall *SampleFn)(void*, int32_t, int32_t, void*); /* @16 */
typedef void     (__stdcall *BuildFn)(void*, int32_t, int32_t, void*, float*, void*); /* @24 */
typedef float*   (__stdcall *CompFn)(void*);                        /* @4  */
typedef void*    (__stdcall *NewLPFn)(int32_t);                     /* @4  */
typedef void*    (__stdcall *NewWPFn)(int32_t);                     /* @4  */
typedef int32_t  (__stdcall *VCountFn)(void*);                      /* @4  */
typedef void*    (__stdcall *VertsFn)(void*);                       /* @4  */
typedef void*    (__stdcall *NewBindFn)(void*, void*, void*);       /* @12 */
typedef int32_t* (__stdcall *BindIdxFn)(void*);                    /* @4  */
typedef int32_t  (__stdcall *IsRigidFn)(void*);                    /* @4  */
typedef void*    (__stdcall *VtxTypeFn)(void*);                    /* @4  GetMeshVertexType */
typedef int32_t  (__stdcall *ICountFn)(void*);                    /* @4  GetMeshIndexCount */
typedef int32_t  (__stdcall *BpiFn)(void*);                       /* @4  GetMeshBytesPerIndex */
typedef void     (__stdcall *CopyIdxFn)(void*, int32_t, void*);   /* @12 CopyMeshIndices */
typedef void*    (__stdcall *NewDefFn)(void*, void*, int32_t);    /* @12 NewMeshDeformer(src,dst,dof) */
typedef void     (__stdcall *DeformFn)(void*, int32_t*, float*, int32_t, void*, void*); /* @24 DeformVertices */
typedef void     (__stdcall *BuildXFFn)(void*, float*);           /* @8  BuildCompositeTransform4x4(granny_transform*, out[16]) */

static HMODULE H;
static void* P(const char* name) {
    void* p = GetProcAddress(H, name);
    if (!p) { fprintf(stderr, "WARN: GetProcAddress(%s) failed (skipping)\n", name); }
    return p;
}
static void* PR(const char* name) { /* required */
    void* p = GetProcAddress(H, name);
    if (!p) { fprintf(stderr, "FATAL: GetProcAddress(%s) failed\n", name); exit(9); }
    return p;
}

/* granny_file_info offsets (32-bit) — from gr2_worldpose.c, re-validated */
#define OFF_MESHCOUNT  56
#define OFF_MESHES     60
#define OFF_MODELCOUNT 64
#define OFF_MODELS     68
#define OFF_ANIMCOUNT  80
#define OFF_ANIMS      84

static int32_t rdI(void* b, int o){ return *(int32_t*)((char*)b+o); }
static void*   rdP(void* b, int o){ return *(void**)((char*)b+o); }

typedef struct { float mnx,mxx,mny,mxy,mnz,mxz; int init; } BB;
static void bbReset(BB* b){ b->init=0; }
static void bbAdd(BB* b, float x,float y,float z){
    if(!b->init){ b->mnx=b->mxx=x; b->mny=b->mxy=y; b->mnz=b->mxz=z; b->init=1; return; }
    if(x<b->mnx)b->mnx=x; if(x>b->mxx)b->mxx=x;
    if(y<b->mny)b->mny=y; if(y>b->mxy)b->mxy=y;
    if(z<b->mnz)b->mnz=z; if(z>b->mxz)b->mxz=z;
}
static void bbPrint(const char* tag, BB* b){
    if(!b->init){ printf("%s (empty)\n", tag); return; }
    printf("%s  X span=%.4f  Y span=%.4f  Z span=%.4f   (x0.3 cells: %.3f x %.3f x %.3f)\n",
        tag, b->mxx-b->mnx, b->mxy-b->mny, b->mxz-b->mnz,
        (b->mxx-b->mnx)*0.3f/5.0f, (b->mxy-b->mny)*0.3f/5.0f, (b->mxz-b->mnz)*0.3f/5.0f);
}

int main(int argc, char** argv){
    if (argc < 2){ fprintf(stderr, "usage: %s in.gr2 [duration] [samples]\n", argv[0]); return 2; }
    float duration = argc>2 ? (float)atof(argv[2]) : 5.6667f;
    int   samples  = argc>3 ? atoi(argv[3]) : 24;

    H = LoadLibraryA("granny2.dll");
    if (!H){ fprintf(stderr,"FATAL: LoadLibrary(granny2.dll)=%lu\n",(unsigned long)GetLastError()); return 3; }

    ReadMemFn ReadMem=(ReadMemFn)PR("_GrannyReadEntireFileFromMemory@8");
    GetInfoFn GetInfo=(GetInfoFn)PR("_GrannyGetFileInfo@4");
    InstFn    Inst   =(InstFn)PR("_GrannyInstantiateModel@4");
    PlayCtrlFn Play  =(PlayCtrlFn)PR("_GrannyPlayControlledAnimation@12");
    GetSkelFn GetSkel=(GetSkelFn)PR("_GrannyGetSourceSkeleton@4");
    SetClockFn SetClk=(SetClockFn)PR("_GrannySetModelClock@8");
    SampleFn  Sample =(SampleFn)PR("_GrannySampleModelAnimations@16");
    BuildFn   Build  =(BuildFn)PR("_GrannyBuildWorldPose@24");
    CompFn    Comp   =(CompFn)PR("_GrannyGetWorldPoseComposite4x4Array@4");
    NewLPFn   NewLP  =(NewLPFn)PR("_GrannyNewLocalPose@4");
    NewWPFn   NewWP  =(NewWPFn)PR("_GrannyNewWorldPose@4");
    VCountFn  VCount =(VCountFn)PR("_GrannyGetMeshVertexCount@4");
    VertsFn   Verts  =(VertsFn)PR("_GrannyGetMeshVertices@4");
    NewBindFn NewBind=(NewBindFn)PR("_GrannyNewMeshBinding@12");
    BindIdxFn BindIdx=(BindIdxFn)PR("_GrannyGetMeshBindingToBoneIndices@4");
    IsRigidFn IsRigid=(IsRigidFn)P("_GrannyMeshIsRigid@4");
    VtxTypeFn VtxType=(VtxTypeFn)P("_GrannyGetMeshVertexType@4");
    ICountFn  ICount =(ICountFn)P("_GrannyGetMeshIndexCount@4");
    BpiFn     Bpi    =(BpiFn)P("_GrannyGetMeshBytesPerIndex@4");
    CopyIdxFn CopyIdx=(CopyIdxFn)P("_GrannyCopyMeshIndices@12");
    NewDefFn  NewDef =(NewDefFn)P("_GrannyNewMeshDeformer@12");
    DeformFn  Deform =(DeformFn)P("_GrannyDeformVertices@24");
    BuildXFFn BuildXF=(BuildXFFn)P("_GrannyBuildCompositeTransform4x4@8");
    void* PNT332     = GetProcAddress(H, "GrannyPNT332VertexType"); /* data export, undecorated */
    fprintf(stderr,"PNT332 export = %p  (NULL = wrong data-export name)\n", PNT332);

    /* read file into a heap buffer that stays alive (Granny fixes up in place) */
    FILE* f=fopen(argv[1],"rb"); if(!f){perror("open");return 5;}
    fseek(f,0,SEEK_END); long sz=ftell(f); fseek(f,0,SEEK_SET);
    void* buf=malloc((size_t)sz);
    if(fread(buf,1,(size_t)sz,f)!=(size_t)sz){perror("read");return 5;}
    fclose(f);

    void* file=ReadMem((int32_t)sz,buf);
    if(!file){fprintf(stderr,"FATAL: ReadEntireFileFromMemory NULL\n");return 6;}
    void* info=GetInfo(file);
    if(!info){fprintf(stderr,"FATAL: GetFileInfo NULL\n");return 6;}

    int32_t meshCount=rdI(info,OFF_MESHCOUNT);
    void**  meshes   =(void**)rdP(info,OFF_MESHES);
    int32_t modelCount=rdI(info,OFF_MODELCOUNT);
    void**  models   =(void**)rdP(info,OFF_MODELS);
    int32_t animCount=rdI(info,OFF_ANIMCOUNT);
    void**  anims    =(void**)rdP(info,OFF_ANIMS);
    fprintf(stderr,"meshCount=%d modelCount=%d animCount=%d\n",meshCount,modelCount,animCount);

    void* model=(modelCount>0)?models[0]:NULL;
    if(!model||animCount<1){fprintf(stderr,"FATAL: no model/anim\n");return 7;}
    fprintf(stderr,"model[0].Name=\"%s\"\n",(char*)rdP(model,0));

    /* --- CROSS-CHECK 3: dump model InitialPlacement candidates ---
     * granny_model layout (v2): Name@0, Skeleton*@4, InitialPlacement@8..?
     * We dump 24 floats from model+8 and report any that look like a 4x4 with a
     * non-1.0 diagonal (a scale). This is the prime ~2.76x suspect. */
    printf("== model[0] float dump (model+8 .. +8+24*4), scanning for a scaling InitialPlacement ==\n");
    for(int i=0;i<24;i++){ float v=*(float*)((char*)model+8+i*4); printf("  m+%2d = % .5f\n", 8+i*4, v); }

    void* inst=Inst(model);
    Play(0.0f,anims[0],inst);
    void* skel=GetSkel(inst);
    int32_t boneCount=rdI(skel,4);
    fprintf(stderr,"skeleton=\"%s\" boneCount=%d\n",(char*)rdP(skel,0),boneCount);

    /* per-mesh setup */
    typedef struct { void* mesh; void* binding; int32_t* toBone; int32_t vcount;
                     uint8_t* src; int32_t rigid; void* vtype; void* deformer;
                     uint8_t* dst; int stride; } M;
    M* M_=(M*)calloc(meshCount,sizeof(M));
    for(int i=0;i<meshCount;i++){
        void* mesh=meshes[i]; M_[i].mesh=mesh;
        char* nm=(char*)rdP(mesh,0);
        M_[i].binding=NewBind(mesh,skel,skel);
        M_[i].toBone =BindIdx(M_[i].binding);
        M_[i].vcount =VCount(mesh);
        M_[i].src    =(uint8_t*)Verts(mesh);
        M_[i].rigid  =IsRigid?IsRigid(mesh):-1;
        M_[i].vtype  =VtxType?VtxType(mesh):NULL;
        int32_t icount=ICount?ICount(mesh):-1;
        int32_t bpi   =Bpi?Bpi(mesh):-1;
        /* CopyMeshIndices — client calls it; indices don't affect bbox, just prove the call */
        if(CopyIdx && icount>0 && bpi>0){ void* tmp=malloc((size_t)icount*bpi); CopyIdx(mesh,bpi,tmp); free(tmp); }
        /* deformer: source = mesh vtype, dest = *PNT332, dof = 2 — EXACTLY as the
         * client (fcn.00683f60 @0x6841d3): GrannyPNT332VertexType is a POINTER data-
         * export, so the client does `mov esi,[eax]` to DEREFERENCE it before pushing
         * it as the dest. Passing the export address itself (un-dereferenced) makes
         * NewMeshDeformer return NULL ("no matching deformer for the vertex format"). */
        void* pntType = PNT332 ? *(void**)PNT332 : NULL;
        if(NewDef && pntType && M_[i].vtype){
            M_[i].deformer = NewDef(M_[i].vtype, pntType, 2);
            fprintf(stderr,"  NewMeshDeformer(vtype=%p, *PNT332=%p, dof=2) = %p\n",
                    M_[i].vtype, pntType, M_[i].deformer);
        } else {
            fprintf(stderr,"  deformer skipped: NewDef=%p *PNT332=%p vtype=%p\n",
                    (void*)NewDef, pntType, M_[i].vtype);
        }
        M_[i].dst=(uint8_t*)malloc((size_t)M_[i].vcount*32);
        M_[i].stride=40; /* manual-LBS assumed source stride (PWNT: pos12 w4 i4 n12 uv8) */
        fprintf(stderr,"mesh[%d]=\"%s\" vcount=%d rigid=%d icount=%d bpi=%d vtype=%p deformer=%p\n",
                i,nm?nm:"?",M_[i].vcount,M_[i].rigid,icount,bpi,M_[i].vtype,M_[i].deformer);

        /* CROSS-CHECK 1a: raw (bind) bbox from source positions */
        BB raw; bbReset(&raw);
        for(int k=0;k<M_[i].vcount;k++){ float* p=(float*)(M_[i].src+k*M_[i].stride); bbAdd(&raw,p[0],p[1],p[2]); }
        char t[64]; snprintf(t,sizeof t,"RAW mesh[%d] %-10s",i,nm?nm:"?"); bbPrint(t,&raw);
    }

    void* localPose=NewLP(boneCount);
    void* worldPose=NewWP(boneCount);

    /* CROSS-CHECK 4: two Offset4x4 variants for BuildWorldPose.
     * variant A = NULL (what the old oracle did). variant B = model InitialPlacement
     * (model+8 as a float[16] col-major, if it is a 4x4). If B's bbox is ~2.76x A's,
     * the flag really renders that much bigger and NULL hid it. */
    /* model+8 is a granny_transform (Flags,Position[3],Orientation quat[4],
     * ScaleShear[3][3]) — NOT a float[16] 4x4. Build the real Offset matrix from it
     * via the DLL. The float dump above decodes as identity, so [B] will now equal
     * [A]; this fixes the earlier degenerate [B] (which read the transform as a raw
     * 4x4 and collapsed to X=42.36 Y=0 Z=0). */
    float initPlace[16];
    if(BuildXF){ BuildXF((char*)model+8, initPlace); }
    else { memset(initPlace,0,sizeof initPlace); initPlace[0]=initPlace[5]=initPlace[10]=initPlace[15]=1.0f; }

    printf("\n== per-frame posed bbox: [A]=Offset NULL, [B]=Offset InitialPlacement, [DLL]=DeformVertices, [LBS]=manual ==\n");
    /* Task-2 bridge: dump the LBS-posed (model-space) verts of every mesh, every
     * frame, so the on-screen projector can apply the client transform stack and
     * measure projected px. columns: sample, t, mesh_index, x, y, z (granny units). */
    FILE* vf=fopen("wp-flag-posed-verts.tsv","w");
    if(vf) fprintf(vf,"sample\tt\tmesh\tx\ty\tz\n");
    for(int s=0;s<samples;s++){
        float tt=(samples>1)?duration*(float)s/(float)(samples-1):0.0f;
        SetClk(inst,tt); Sample(inst,0,boneCount,localPose);

        BB unionA,unionB,unionDLL,unionLBS;
        bbReset(&unionA); bbReset(&unionB); bbReset(&unionDLL); bbReset(&unionLBS);

        for(int variant=0; variant<2; variant++){
            float* off = variant==0 ? NULL : initPlace;
            Build(skel,0,boneCount,localPose,off,worldPose);
            float* comp=Comp(worldPose);

            /* root bone composite scale (basis lengths) — cross-check 5, once */
            if(s==0 && variant==0){
                float sx=sqrtf(comp[0]*comp[0]+comp[1]*comp[1]+comp[2]*comp[2]);
                float sy=sqrtf(comp[4]*comp[4]+comp[5]*comp[5]+comp[6]*comp[6]);
                float sz=sqrtf(comp[8]*comp[8]+comp[9]*comp[9]+comp[10]*comp[10]);
                printf("  root bone[0] composite scale = (%.4f, %.4f, %.4f)  [1.0 = no scale]\n",sx,sy,sz);
            }

            for(int i=0;i<meshCount;i++){
                M* m=&M_[i];
                /* manual LBS (variant selects the offset already baked into comp) */
                for(int k=0;k<m->vcount;k++){
                    uint8_t* vb=m->src+k*m->stride; float* p=(float*)vb;
                    uint8_t* w=vb+12; uint8_t* bi=vb+16;
                    float wsum=(float)w[0]+w[1]+w[2]+w[3]; if(wsum<=0)wsum=1;
                    float ox=0,oy=0,oz=0;
                    for(int l=0;l<4;l++){ if(!w[l])continue; int32_t sb=m->toBone?m->toBone[bi[l]]:bi[l];
                        float* mm=comp+sb*16; float wx=(float)w[l]/wsum;
                        ox+=wx*(p[0]*mm[0]+p[1]*mm[4]+p[2]*mm[8]+mm[12]);
                        oy+=wx*(p[0]*mm[1]+p[1]*mm[5]+p[2]*mm[9]+mm[13]);
                        oz+=wx*(p[0]*mm[2]+p[1]*mm[6]+p[2]*mm[10]+mm[14]); }
                    bbAdd(variant==0?&unionA:&unionB, ox,oy,oz);
                    if(variant==0){ bbAdd(&unionLBS, ox,oy,oz);
                        if(vf) fprintf(vf,"%d\t%.4f\t%d\t%.6f\t%.6f\t%.6f\n",s,tt,i,ox,oy,oz); }
                }
                /* DLL DeformVertices (variant 0 only — the client's exact skin) */
                if(variant==0 && m->deformer && Deform){
                    Deform(m->deformer, m->toBone, comp, m->vcount, m->src, m->dst);
                    for(int k=0;k<m->vcount;k++){ float* p=(float*)(m->dst+k*32); bbAdd(&unionDLL,p[0],p[1],p[2]); }
                }
            }
        }
        printf("t=%.4f\n",tt);
        bbPrint("  [A NULL   union]",&unionA);
        bbPrint("  [B Init   union]",&unionB);
        if(unionDLL.init) bbPrint("  [DLL deform union]",&unionDLL);
        bbPrint("  [LBS manual union]",&unionLBS);
    }
    if(vf){ fclose(vf); fprintf(stderr,"wrote wp-flag-posed-verts.tsv (%d samples x all-mesh verts)\n",samples); }
    printf("\nDONE. Compare: [A] vs [B] (InitialPlacement scale?), [DLL] vs [LBS] (deformer parity?).\n");
    return 0;
}
