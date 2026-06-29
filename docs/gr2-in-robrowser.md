# .gr2 in roBrowser — scope, status, integration plan

Companion to [gr2-format.md](gr2-format.md) (binary spec). This doc covers
**what's actually shipped in iRO data.grf**, **what roBrowser does with it
today**, and **what's needed to render it for real**.

## TL;DR

- iRO ships exactly **21 .gr2 files**, byte-identical between data.grf 2008
  and data.grf 2026 — Gravity stopped producing .gr2 around 2008.
- roBrowser **doesn't render any of them**. The loader
  ([GrannyModel.js:1142](../../../roBrowserLegacy/src/Loaders/GrannyModel.js#L1142))
  reads the header then `return;`s.
- Each affected mob falls back to a hard-coded 2D sprite
  ([EntityView.js:293-308](../../../roBrowserLegacy/src/Renderer/Entity/EntityView.js#L293-L308)).
- granny-ro-js currently parses headers and decompresses Oodle0 with
  byte-exact parity (105/105 sections). Skeleton / mesh / animation
  parsers are next (S6-S7). Runtime integration is S9.

## 1. The fixed corpus — 21 files, forever

Inspecting both data.grf gives identical .gr2 counts and sizes :

| | data.grf 2008 | data.grf mars-26 |
|---|---|---|
| Signature | `Master of Magic` v0x200 | `Event Horizon` v0x300 |
| Total size | 1.2 GB | 4.5 GB (3.7×) |
| Total entries | 35 645 | 295 323 (8.3×) |
| **.gr2 files** | **21** | **21** |
| Same names + sizes | — | yes, byte-pour-byte |

In 18 years Gravity added ~260 000 files but **modified zero .gr2** and
**created zero new .gr2**. All post-2008 content (mobs, MD instances, BG,
TE, EP18+) uses `.spr/.act` sprites + `.str/.lub` effects. Granny is
abandonware on Gravity's side.

**Consequence for granny-ro-js** : the test corpus is the complete corpus.
What works on the 21 fixtures works forever. No future codec to support
(no Oodle1 / BitKnit / BitKnit2 — all 105 compressed sections are
Oodle0).

## 2. Inventory by family

### Props with mesh + skeleton + animation (6 files)

Path : `data\model\3dmob\`

| File | Used by mob IDs | In-game role |
|---|---|---|
| `aguardian90_8.gr2` | 1285, 1830, 1900, 1950 | Archer/Bow Guardian, Camp Guardian B_B |
| `kguardian90_7.gr2` | 1286, 1829, 1899, 1949 | Knight/Sword Guardian, Camp Guardian B_S |
| `sguardian90_9.gr2` | 1287 | Soldier Guardian (WoE 1 only) |
| `empelium90_0.gr2` | 1288, 1846, 3308 | Emperium, Dream Metal, TE Emperium |
| `guildflag90_1.gr2` | NPC 722 | Guild Flag (with dynamic per-guild emblem) |
| `treasurebox_2.gr2` | 1324-1363, 1732, 1798, 1845, 1902-1903, 1938-1946, 1955, 2288, 2335, 2452-2462, 3075, 3291 | All WoE / TE / BG / MD treasure chests (~50 IDs) |

Mapping source : [MonsterTable.js:441-3011](../../../roBrowserLegacy/src/DB/Monsters/MonsterTable.js).

### Standalone animation packs (15 files)

Path : `data\model\3dmob_bone\` — each file contains **only animation
curves** (no mesh, no skeleton), to be applied on a player class
skeleton loaded elsewhere.

Naming : `<class>_<action>.gr2`

| Class | Animations present |
|---|---|
| 1 (Swordsman) | attack only |
| 2 (Magician) | damage, dead |
| 7 (Archer) | attack, damage, dead, move |
| 8 (Merchant) | attack, damage, dead, move |
| 9 (Acolyte) | attack, damage, dead, move |

→ The player class anim packs are **incomplete** — classes 1 and 2 are
missing core states (move, attack for class 2). This is likely the
reason Gravity never shipped a viable 3D player mode : the artists
never finished the animation set.

### Where these mobs spawn in-game

Concrete server-side spawn sources, not all WoE :

- **WoE 1** : prtg_cas01-05, payg_cas01-05, gefg_cas01-05, aldeg_cas01-05
  → Archer/Knight/Soldier Guardian + Emperium
- **WoE 2** : arug_cas01-05, schg_cas01-05 → Sword/Bow Guardian + Emperium
- **WoE TE** : te_aldecas* / te_prtcas* → Dream Metal, TE Emperium, variant Guardians
- **Battleground** : bat_room, bat_a/b/c maps → Camp Guardians
- **Thor Volcano** : [thor_v01/02/03](../../../rathena/npc/re/mobs/dungeons/thor_v.txt)
  → 5-11× Bow Guardian + 5-11× Sword Guardian, **regular farm spawns**
- **Treasure boxes** : appear in castles after Emperium break, instance
  rewards, BG rewards
- **Guild flags** : every map with a guild flag NPC

→ **Thor Volcano is the most visible PvE impact today** : non-WoE farm
zone, accessible anytime, where players currently see Raydric-skinned
fallback sprites instead of the actual 3D guardians.

## 3. Current roBrowser behavior — fallback table

When the loader detects a `.gr2` path, [EntityView.js:293](../../../roBrowserLegacy/src/Renderer/Entity/EntityView.js#L293)
substitutes a 2D sprite per filename :

| .gr2 filename | Fallback job ID | Fallback sprite |
|---|---|---|
| `aguardian90_8.gr2` | 1276 | Raydric Archer |
| `kguardian90_7.gr2` | 2691 | Solid Raydric |
| `sguardian90_9.gr2` | 1163 | Raydric |
| `empelium90_0.gr2` | 2080 | Crystal |
| `guildflag90_1.gr2` | 1911 | Neutrality Flag (static 2D banner) |
| `treasurebox_2.gr2` | 1191 | Mimic |
| **unknown .gr2** | 1002 | **Poring** (only the `else` branch) |

The inline comment `// Display a poring instead` is misleading — only
the unmatched `else` actually renders a Poring. The six known filenames
get topic-specific 2D fallbacks.

## 4. What "Skeleton / Mesh / Animation" means visually

From [gr2-format.md § Section semantic slots](gr2-format.md) :

| Slot | Name | Content | Rendering dependency |
|---|---|---|---|
| 0 | main | type-tree metadata + root object | always required ; without it, nothing loads |
| 1 | rigid_vertex | static (non-skinned) XYZ + normal/UV | optional — for static props (treasure box base) |
| 2 | rigid_index | triangle indices for rigid mesh | required if slot 1 present |
| 3 | deformable_vertex | skinned XYZ + bone weights | main mesh for animated characters |
| 4 | deformable_index | triangle indices for deformable mesh | required if slot 3 present |
| 5 | texture | uncompressed BMP/TGA chunks (NoCompression) | optional — material may reference external paths |

**Dependency chain** :

- No mesh → nothing to draw at all, even with a skeleton
- Mesh without skeleton → rigid model in bind pose (treasure box style)
- Skeleton without animation → T-pose freeze (guardian standing still)
- Mesh + skeleton + animation → animated character (sword swing, flag
  flutter, Emperium pulse)

Per-fixture, this lets you tell at a glance what each .gr2 needs :

- `treasurebox_2.gr2` : main + textures only, slots 1-4 empty → pure
  static mesh, no skeleton, no anim required
- `empelium90_0.gr2` and `guildflag90_1.gr2` : slots 1-2 empty (no rigid
  parts), slots 3-4 present → deformable mesh + embedded animation
- `aguardian90_8.gr2` : all slots populated → static accessories + main
  skinned mesh + embedded anims

## 5. How animations actually work

A Granny `Animation` object contains :

- `Duration` (seconds) + `TimeStep` (typical 1/30s)
- `TrackGroups[]` — one per animated actor (one per target skeleton)
  - `TransformTracks[]` — **the core** : per bone, a curve of
    position / orientation / scale over time
  - `VectorTracks[]` — auxiliary vec3 curves (rare)
  - `TextTracks[]` — timestamped events ("hit", "footstep", "fx_spawn")
    consumed by the engine to sync SFX and visual effects

Each `TransformTrack` points to a `CurveData` encoded in one of ~10
compressed formats (7-bit / 8-bit / 16-bit / float keys, uniform vs
adaptive sampling, position+orientation separate vs combined). The S7
parser must support all variants present in the corpus.

Render-time flow : sample each curve at `t` → produce per-bone local
transforms → compose with skeleton hierarchy → fill the **bone matrix
palette** uniform array → vertex shader does linear blend skinning.

### Two patterns in iRO

1. **Standalone anim files** (`N_action.gr2`) : section 0 holds only
   `Animation` objects, sections 1-4 empty, section 5 unused texture
   chunk. Anim is bound at load time to the matching player class
   skeleton.
2. **Embedded anims** (props : guardians, emperium, flag) : everything in
   one file. Anims live in section 0 alongside the skeleton and mesh
   metadata, vertex/index buffers in slots 3-4.

### Action code → anim name mapping

RO server-side action codes drive both .act sprites and .gr2 anims :

```
0 = idle/stand    5 = attack01    9 = attack03
1 = walk          6 = hurt        12 = casting
2 = sit           7 = die
3 = pickup        8 = attack02
4 = ready weapon
```

For sprites, the mapping is action_code → .act frame slot. For Granny
mobs, the ragexe maps action_code → `Animation.Name` (e.g. attack01 →
"atk_01"). **This mapping table lives in the ragexe binary**, not in
the .gr2 file or in any data resource. It needs to be reverse-engineered
from the ragexe disassembly during S8.

## 6. Guild flag emblem — the three-layer story

The flag in-game displays the guild's emblem painted on the cloth
surface. This requires three coordinated layers, and only one is in the
.gr2 file :

1. **In the .gr2** — nothing emblem-specific. The mesh has UVs and a
   neutral texture in section 5. The emblem is dynamic per-guild,
   uploaded at runtime.
2. **In roBrowser today** — already handles packet `ZC_GUILD_EMBLEM_IMG`
   (0x0152) and renders the emblem as a **2D DOM canvas billboard above
   the entity's head** ([EntityEmblem.js:78](../../../roBrowserLegacy/src/Renderer/Entity/EntityEmblem.js#L78)
   sets `canvas.style.top/left`, no WebGL texture binding). This is the
   nameplate emblem, not the cloth texture.
3. **In the ragexe binary** — knows which UV slot of `guildflag90_1.gr2`
   receives the dynamic emblem texture, uploads the received BMP 24×24
   as a GL texture, and binds it on the appropriate material. **This
   logic does not exist in roBrowser** and must be RE'd from the ragexe.

→ Rendering the flag mesh is necessary but not sufficient. The "drapeau
avec emblème de la guilde" experience needs all three layers wired :
parse + render the mesh (S9), plus a per-mesh dynamic-texture-slot
binding driven by the existing packet handler.

## 7. Effort estimation — decompress is half the work

Decompressing meshes (S6) and animations (S7) gets us structured data
in JS. **Rendering it in roBrowser is a separate chunk of work**
because roBrowser today has zero 3D-skinned pipeline (it's a 100%
sprite billboard engine).

### What's missing after parsing

GPU pipeline :

- New shader pair : vertex (matrix-palette skinning) + fragment
  (textured material). Sprites use trivial shaders.
- VBO/IBO upload per mesh
- Bone matrix palette uniform : per-frame computation of 32-64 mat4
  from animation curves, uploaded as uniform array
- Animation state machine : map RO action codes (attack/move/dead/...)
  to Granny `Animation.Name`s — mapping extracted from ragexe RE

Integration :

- Coordinate space + scale calibration vs ragexe (Granny Y-up, pivot
  conventions, bone-to-world scale)
- Lighting parity : RO uses lightmap (map) + per-vertex tint (sprites).
  Decide whether to mimic for visual cohesion, or render raw
- Hitbox : keep 2D bbox approximation for click/hover compat
- Ground shadow blob under the mesh
- Effects anchored on bones (vs sprite pivot today)

Special case : guild flag dynamic emblem (see § 6).

### Difficulty ranking

| Asset | Difficulty | Why |
|---|---|---|
| Treasure box | easy | Static mesh, no skeleton, no anim → "draw this mesh". Good S9.0 smoke test. |
| Emperium | medium | Skeleton + one pulse anim. No state machine. |
| Guild flag | medium+ | Mesh + skeleton + flutter anim + **dynamic emblem texture** (ragexe RE required). |
| Guardians | hard | Full skinning + state machine (attack/move/dead/damage) + ragexe RE for anim mapping. Unlocks Thor V + WoE. |

### Recommended sequence

1. Treasure box (validates the full chain : decompress → parse → upload
   → render, no anim complexity)
2. Emperium (introduces skeleton + simple anim)
3. Guild flag (adds the dynamic-emblem-texture binding)
4. Guardians (full state machine, biggest visual win — Thor V farm)

Total : ~4-6 sessions beyond granny-ro-js S6-S7, depending on how much
visual parity with ragexe is required.

## 8. Extra knowledge — where does Granny come from ?

### The producer : RAD Game Tools

**Granny 3D** is a 3D animation middleware developed by **RAD Game
Tools** (Kirkland, WA — founded 1988 by Jeff Roberts). RAD's product
family :

| Product | Domain | Notes |
|---|---|---|
| **Smacker** (1994) | Video | First RAD product. Onomatopoeic — "smacks" data. |
| **Bink Video** (1999) | Video | Successor to Smacker. Shipped in ~75% of PC games 1999-2015 (splash screens, cutscenes). |
| **Miles Sound System** | Audio | Named after John Miles, the original author. |
| **Granny 3D** (~1999) | 3D animation | This. |
| **Telemetry** | Profiling | Descriptive name for once. |
| **Oodle** (Kraken/Mermaid/Leviathan/Selkie) | Compression | Modern flagship. "Oodles of data". |

In **2021 Epic Games acquired RAD** primarily to integrate Oodle into
Unreal Engine. Granny has been in **maintenance mode** since — no
active development, attention is 100% on Oodle.

### Where Granny was used (selection)

| Year | Game | Studio |
|---|---|---|
| 2002 | **Ragnarok Online** (WoE props + abandoned 3D character mode) | Gravity |
| 2003 | Pirates! | Firaxis |
| 2004 | EverQuest II | SOE |
| 2009-2010 | Empire / Napoleon: Total War | Creative Assembly |
| 2010 | Sid Meier's Civilization V | Firaxis |
| 2012 | Guild Wars 2 | ArenaNet |
| 2014 | WildStar | Carbine |
| 2014 | Civilization: Beyond Earth | Firaxis |
| 2016 | Sid Meier's Civilization VI | Firaxis |
| 2016+ | Total War: Warhammer I/II/III | Creative Assembly |

Firaxis stayed loyal to Granny for two decades — Civ III through VI
all use it for units/leaders. They're probably the studio that pushed
Granny hardest at scale.

### Why Granny was attractive in the '00s

1. **Aggressive animation compression** — .gr2 can be 10× smaller than
   FBX/Collada thanks to ~10 quantized `CurveData` formats (7-bit /
   8-bit / 16-bit / float adaptive).
2. **Type-tree self-describing format** — the file carries its own
   schema, a single SDK parser handles all internal evolutions. Very
   future-proof for a middleware.
3. **Mesh / skeleton / animation decoupling** — ship each piece
   separately and bind at runtime (the `N_action.gr2` standalone-on-
   player-skeleton pattern in RO).
4. **Polished DCC pipeline** — solid 3ds Max + Maya exporters.
5. **Portable C runtime** — Win32 / PS2 / Xbox / GameCube / PSP / mobile
   from the start.
6. **No-royalty license** — flat upfront fee per title, attractive
   compared to in-house engines or Autodesk-locked solutions.

### Why the decline

- Unity Mecanim (2013) and Unreal Animation System mature → less need
  for third-party middleware
- glTF 2.0 (2017) becomes the open standard for animated 3D
- FBX wins as the universal interchange format despite its flaws
- Epic acquires RAD (2021) → focus on Oodle, Granny frozen

### Why Gravity / RO specifically chose it (~2001-02)

Granny 2.x had just shipped, considered state-of-the-art for animation
compression. Gravity was experimenting with a **3D character mode** for
RO. The artists finished 6 WoE props + an incomplete set of player
class anims (15 files, classes 1 and 2 missing core states), then the
3D character project was **abandoned** — either players preferred the
iconic sprite look, or consumer GPUs in 2002 choked on dozens of
skinned meshes in WoE. The .gr2 props survived because they were
already in production. Everything post-2008 = sprites 2D. Granny in RO
is a fossil of an abandoned technological fork.

### Why the name "Granny" ?

**Nobody knows for sure.** RAD never published an official "this is why
Granny" source. It fits their tradition of intentionally **weird,
friendly, slightly absurd names** — same family as Bink and Smacker.

Theories, none authoritative :

- **Retro-fitted initialism** : "GRanular ANimation" — possible but
  feels like a post-hoc rationalization. No RAD doc claims it.
- **Person / codename tribute** : precedent with Miles (named after
  John Miles). Maybe a co-founder had a grandmother / nickname —
  totally speculative.
- **Intentionally absurd, RAD style** : Jeff Roberts has said in
  interviews that RAD names are chosen to be **memorable and impossible
  to confuse with competitors**, not to describe the product. Friendly
  + cute makes middleware less intimidating for studios evaluating it.

Best lead for a definitive answer : email Jeff Roberts or Mitch Soule
directly, or dig old Gamasutra / Game Developer Magazine postmortems
circa 2000-2005.

### Anecdote — granny2.dll as the live oracle

The original **`granny2.dll`** (~4 MB) is still bundled with any RO
client that ships .gr2 files. [Oodle0Live.test.js](../tests/integration/Oodle0Live.test.js)
uses exactly that DLL via a Wine shim as the canonical oracle for
byte-exact parity testing of the JS Oodle0 port. The DLL likely dates
from ~2005-2008 (Granny 2.7-2.9). RAD does not freely distribute the
SDK, but the runtime DLL is everywhere in the wild.

## 9. Reference paths

- granny-ro-js library : [README](../README.md)
- Binary format spec : [gr2-format.md](gr2-format.md)
- Perf baseline : [perf-baseline.md](perf-baseline.md)
- roBrowser loader stub : [GrannyModel.js](../../../roBrowserLegacy/src/Loaders/GrannyModel.js)
- Mob ID → .gr2 mapping : [MonsterTable.js](../../../roBrowserLegacy/src/DB/Monsters/MonsterTable.js)
- Fallback sprite dispatch : [EntityView.js:293-308](../../../roBrowserLegacy/src/Renderer/Entity/EntityView.js#L293-L308)
- Emblem rendering (2D billboard) : [EntityEmblem.js](../../../roBrowserLegacy/src/Renderer/Entity/EntityEmblem.js)
- Guardian spawn (Thor Volcano) : [rathena/npc/re/mobs/dungeons/thor_v.txt](../../../rathena/npc/re/mobs/dungeons/thor_v.txt)
- Rollout plan : [plans/granny-pipeline/STATUS.md](../../../plans/granny-pipeline/STATUS.md)
