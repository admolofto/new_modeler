# Presentation mode, room and props

> Walk clients through a rendered version of a design. It should look good, things open on a click, a generated room surrounds the model, and simple props stage the scene.

This is the implementer reference. Read **Decisions** and **Binding notes** first, then the sections your phase points to. Units are integer 1/64" (`UNITS_PER_INCH = 64`). X is width, Y is up, Z is depth, and the front faces +Z. A node's origin is its min corner, and transforms are parent-relative. Scene units are inches; the model root is scaled 1/64. Follow ROADMAP.md's foundation rules: data is the source of truth, there is one mutation path (`applyOps`), plugins teach the AI, and `model/` and `geometry/` are pure (no three.js).

## Phases

| # | Phase | Effort | Status |
|---|---|---|---|
| 1 | Data foundations: schema v8, decor, finishes, look | xhigh | done |
| 2 | Hardware (pulls) and motion folders (carcass v2) | high | done |
| 3 | Presentation shell and click-to-open | high | done |
| 4 | Rendering pipeline, textures, studio look, save image | xhigh | done |
| 5 | Room generator and editor UX | xhigh | done |
| 6 | Room in presentation: sky, sun, cutaway, lighting presets | high | done |
| 7 | Props, appliances, fixture lights | high | done |
| 8 | Views tour and walk mode | high | done |
| 9 | Path-traced photo stills | high | done |
| 10 | Polish, docs, goldens | medium | done |

Every phase ends with these passing:
- `npm test`
- `npm run typecheck`
- `npm run build`

A browser check follows (dev server on 5173). Implementers do **not** commit.

## Decisions (approved by the user)

- **Delivery:** in-app presentation only; the user drives it in person or over a screen share.
- **Textures:** bundled CC0 photo textures from Poly Haven and ambientCG.
  - The user confirms the exact file list (names, sources, sizes) before anything downloads.
- **Extras in scope:** cabinet hardware, a saved-views tour, walk mode, and path-traced photo stills.
- **Props:** appliances (fridge, range, dishwasher, hood, microwave), light fixtures that actually light the scene, decor and furniture.
- **Room:** rectangular. Any of the 4 walls can be turned off. It is generated around the model and edited by clicking walls.

## Binding notes (where the two design passes were reconciled)

1. **Decor as parts.** Room pieces, props and hardware are parts whose shape plugin has `decor` info. Like blocks, they have no material and stay out of the cut list, joints, nesting and overall dims. That way picking, gizmo, snapping, notes, voice, outline, clearance, motions, glTF, undo and the AI schema all keep working.
2. **Door folders without renames.** Generated doors go into folders with role `<doorRole>-leaf`: `door-leaf`, `door-left-leaf`, `door-right-leaf`.
   - The door **part** keeps its role and id (`a1.door-left`), so there is **no id migration** and overrides and notes stay valid.
   - Drawer and door motions move the **folder**.
   - Motion ids are unchanged: `a1.motion.door-left`, `a1.motion.drawer-1`.
3. **The finish vocabulary is split by layer.**
   - `src/model/finishes.ts` (pure) holds preset ids, labels, swatch colors, inference and prompt docs.
   - `src/render/present/finishDefs.ts` holds render parameters per preset.
   - A test enforces that every model preset has render params.
   - Presets are **append-only**; never remove one, only alias it.
4. **Multi-material decor works through `ShapeDef.surfaces(params)`.** It returns a `SurfaceMap`: tag → `Surface` (exact tag first, then the longest prefix, then base). There is no `mat:` tag convention.
   - Glass is any surface whose finish family is `glass`.
   - Emissive is `light` or a `glow`.
5. **Lights:** `ShapeDef.lights?(params): LightSpec[]`, read through the pure `sceneLights(doc)` in `src/model/look.ts`.
6. **Room semantics for rendering:** the pure `roomShell(doc)` in `src/model/room.ts` (see A6).
7. **Views.** One merged schema (A1). A view has either a `camera` or a semantic `frame`, never both; the AI writes frames.
8. **Lighting presets:** `auto` (studio without a room, day with one), `day`, `evening`, `night`, `studio`.
9. **Editor look.** The editor stays flat (no textures).
   - Parts with an **explicit** finish (material `finish`, or a part/folder `finish`) use that finish's swatch color.
   - Inferred finishes keep `material.color`, so existing docs and AI screenshots look identical.
   - Decor parts draw multi-color by surface, and glass draws translucent.
10. **Cutaway** is one pure function in `src/render/cutaway.ts`, shared by both modes:
    - **Editor:** hides walls between the camera and the room, removes them from picking, and hides the ceiling when the camera is above it.
    - **Presentation:** gives hidden walls a shadow-only material.
11. **Room clicks.** Floor, ceiling, trim and recessed cans are generated `unclickable`. Walls, windows and doors stay clickable; that is how "Add window here" works.
12. **The presentation scene is separate.** It has its own `THREE.Scene`, a second `createSceneSync(scene, presentLook)`, and its own camera and controls, and it shares the renderer.
    - It shows `store.doc`: never AI or drag previews, and it ignores isolation.
    - The editor scene, camera and controls are never touched, so `viewport.capture()` doesn't change.

---

# A. Data, plugin and AI layer

## A1. Schema v8 (`src/model/schema.ts`), phase 1

```ts
export const SCHEMA_VERSION = 8;
export const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);           // reuse in Material.color
export const Finish = z.object({
  preset: z.string().regex(/^[a-z]+(?::[a-z0-9-]+)?$/),    // 'paint', 'wood:walnut', 'metal:brushed-nickel'
  color: Hex.optional(),                                    // paint color, or stain tint for wood
  roughness: z.number().min(0).max(1).optional(),
});
Material: + finish: Finish.optional(); stock: z.enum(['sheet', 'solid', 'slab'])   // slab = fabricated stone/quartz tops
Part:     + finish: Finish.optional()     // stock parts only (decor carries looks in shape params)
Assembly: + finish: Finish.optional()     // inherited by stock parts below
Override: + finish: Finish.optional()

export const ViewCamera = z.object({ position: Vec3, target: Vec3, fov: z.number().min(10).max(120).default(50) });
export const ViewFrame = z.object({
  nodes: z.array(Id).default([]),                           // empty = the whole model (not the room)
  from: z.enum(['front', 'front-left', 'front-right', 'left', 'right', 'above', 'eye']).default('front-left'),
  azimuth: z.number().optional(), elevation: z.number().min(-30).max(90).optional(), distance: z.int().positive().optional(),
});
export const LightingPreset = z.enum(['auto', 'day', 'evening', 'night', 'studio']);
export const View = z.object({
  id: Id, name: z.string().min(1),
  camera: ViewCamera.optional(), frame: ViewFrame.optional(),
  mode: z.enum(['orbit', 'walk']).optional(),
  open: z.array(Id).optional(),          // motion ids, or node ids whose motions open
  hide: z.array(Id).optional(),
  caption: z.string().max(400).optional(),
  lighting: LightingPreset.optional(),
}).refine((v) => !!v.camera !== !!v.frame, 'a view has a camera or a frame, not both');
export const Lighting = z.object({
  preset: LightingPreset.default('auto'),
  sun: z.object({ azimuth: z.number(), elevation: z.number().min(0).max(90) }).optional(),
  exposure: z.number().min(-3).max(3).optional(),
  underCabinet: z.boolean().optional(),
});
export const Presentation = z.object({ views: z.array(View).default([]), lighting: Lighting.optional(), eyeHeight: z.int().positive().optional() });
Doc: + presentation: Presentation.optional();
```

- **`src/model/migrations.ts`:** `MIGRATIONS[7] = (doc) => doc`. The comment: "v8: finishes, slab stock, presentation; nothing stored changes shape".
- **`src/model/persistence.ts`:** the `if (raw.version < 7)` rule becomes per assembly.
  - Read the saved `pluginVersions` **before** they are overwritten.
  - Regenerate an assembly when `rawVersion < 7 || (saved['generator:' + type] ?? 1) < generators.get(type).version`.
- **Golden files** (`src/model/__golden__/`):
  - **Step 0 of phase 1, before any code change:** write `v7-folders.json` from the current code. It holds:
    - a carcass with two drawers and `doors: 2` (written as `drawers: [384, 384]`: the carcass refuses `[0, 0]` with doors, since 0 = "share the rest" leaves no room for them)
    - a user `pull` part (a box with a material) inside folder `a1.drawer-1`
    - an override on `door-left` (material `maple-4-4`)
    - a note on `a1.door-left` / `face:front`
    - a hidden `a1.drawer-2` folder
    - the hand-built pantry door with a user hinge
  - Phase 1 also adds `v8-finishes.json` (material finish, assembly finish, slab material). It also has a generated-folder finish, a generated-part finish override and a part finish.
  - Phase 10 adds `v8-presentation.json` (room, props, views, lighting).
  - Extend `persistence.test.ts` accordingly.

## A2. Registry additions (`src/plugins/registry.ts`), phase 1

```ts
export type ParamField = { path: string; label: string; kind: 'length' | 'count' | 'angle' | 'bool' | 'choice' | 'finish' | 'color' | 'number'; options?: string[]; min?: number; max?: number; when?: string };
export interface DecorInfo {
  category: 'room' | 'hardware' | 'appliance' | 'lighting' | 'furniture' | 'accessory';
  label: string;                        // default name + catalog label ("Bar stool")
  internal?: boolean;                   // generator-only pieces (wall, trim, window, door leaf, appliance body/door): hidden from AI add list + catalog
  solid?: false;                        // rugs, trim, recessed cans: skipped by overlap + opening checks
  defaults?: Record<string, unknown>;   // params for a new one
  fields?: ParamField[];                // generic inspector form
}
export interface Surface { finish: Finish; glow?: { kelvin: number; strength: number } }
export interface SurfaceMap { base: Surface; tags?: Record<string, Surface>; prefixes?: [string, Surface][] }
export interface LightSpec { kind: 'spot' | 'point' | 'area'; at: V3; dir?: V3; size?: [number, number]; lumens: number; kelvin: number; beam?: number; glow?: string }
ShapeDef<P>     + decor?: DecorInfo; surfaces?(p: P): SurfaceMap; lights?(p: P): LightSpec[]
GeneratorDef<P> + surroundings?: true; collapse?: true; lockedParts?: true; fields?: ParamField[];
                  actions?(p: P, ctx: { role: string; handle?: string; at?: V3 }): GenAction<P>[]   // GenAction = { label, params: P } (new full params)
GenPart:   material?: string; finish?: Finish; unclickable?: true   // decor parts have no material
GenGroup:  position?: Vec3; rotation?: Rotation                     // a folder's frame; its GenParts' positions are relative to it
GenMotion: nodes: string[] (part OR group roles — replaces `parts`); requires?: string[] (part roles that must exist)
GenFaceDrive: + kind?: 'position'                                   // a coordinate, not a size: snap skips "size = …" candidates
```

- `registerShape` throws when `decor` is set without `surfaces`.
- Carcass is updated to `nodes` in phase 1. Its motions stay part lists until phase 2.
- `src/model/generate.ts`:
  - `genToPart` emits `material`/`finish`/`unclickable` only when set.
  - `folderFor` applies the `GenGroup` transform; `diffFolder` compares against it.
  - Motions map `nodes` to part or folder ids, and are skipped when a node or `requires` part is missing.

## A3. Decor concept, phase 1

- **`src/model/decor.ts`** (pure):
  - `decorInfo(type)`
  - `isDecor(part)` = `!part.block && !!shapes.get(part.shape.type).decor`
  - `isShopPart(part)` = not a block and not decor
  - `isSolid(part)` = `decorInfo?.solid !== false`
  - `surroundingsOf(doc)` returns the part ids under `surroundings` generators (the room)
  - `modelPartIds(doc)` returns everything except the surroundings. Use it for fit-room, camera fits, whole-model dims and recipe placement.
- **New op entity:** `{ kind: 'decor', id?, name?, transform?, grain?, shape: { type, params } }`. Id prefix `p`; default name is `decor.label`.
  - A `part` entity with a decor shape gets a clear error, and so does a `decor` entity with a stock shape.
  - `update` on decor refuses `material` and `finish`, and `addFeature` refuses decor.
  - `PartPatch`, `AssemblyPatch` and `MaterialPatch` gain `finish: Finish.nullable()`.
  - Add `EntityKind 'view'` and `'decor'` handling in `src/model/doc.ts` where needed.
- **Call sites.** Grep `.block` to find them all; every one needs a decision:

| File | Change |
|---|---|
| `model/validate.ts` | Decor: no `material`, no `features`, no `finish` field on the part, no joinery. `grain` is allowed (texture direction for floors and rugs). Joints refuse decor, the same way they refuse blocks. Add views to id uniqueness. Check finish presets against the vocabulary. |
| `model/ops.ts` | Decor entity, finish patches, refusals as above. |
| `model/generate.ts` | As in A2. |
| `model/cutlist.ts` | `if (!isShopPart(part)) continue`. New `slab` branch: sizes only, no nesting, no board feet. |
| `model/world.ts` `overlaps` | Skip pairs where either part is not solid. Decor against decor is still checked. |
| `model/clearance.ts` | Exclude non-solid parts. Skip pairs of decor parts from the same generated assembly (a room door against its casing). Walls stay obstacles. |
| `edit/dimensions.ts` | Whole-model dims use shop parts and blocks only. |
| `edit/actions.ts` | No drill, pocket, profile or joint actions on decor. Add the owning generator's `actions()`, each mapped to `{op:'update', id: owner, patch:{params}}`. |
| `edit/drives.ts` `generatorDrive` | If `faceDrive` returns null and the generator has `lockedParts`, the handle gets no drives (instead of falling back to an override). |
| `edit/duplicate.ts` | Add a decor branch, and copy `finish`. |
| `edit/snap.ts` `inferLine` | Skip the size-match candidate for `kind: 'position'` drives. |
| `model/recipes.ts` | Add a decor branch in `copyNode`. Placement bounds use `modelPartIds`. New generator params must not end in `material` (recipe heuristics treat such keys as material ids). |
| `io/collada.ts`, `render/gltfExport.ts` | Decor and finishes export with their swatch colors. |
| `ai/*` | See A10. |
| `plugins/pipeline.ts` | `CACHE_SIZE` 500 → 2000. |

## A4. Finishes and the look contract, phase 1

**`src/model/finishes.ts`** (pure). The v1 vocabulary is append-only:

| Family | Preset ids |
|---|---|
| wood | `wood:white-oak`, `wood:red-oak`, `wood:walnut`, `wood:cherry`, `wood:maple`, `wood:birch-ply`. `color` is the stain tint. |
| paint-like | `paint` (with color), `lacquer` (with color), `melamine` (with color), `laminate` (with color) |
| stone | `stone:quartz-white`, `stone:marble-white`, `stone:marble-dark`, `stone:granite-black` |
| tile | `tile:subway`, `tile:floor` |
| floor | `floor:oak-plank`, `floor:herringbone`, `floor:concrete` |
| metal | `metal:stainless`, `metal:brushed-nickel`, `metal:chrome`, `metal:matte-black`, `metal:brass` |
| glass | `glass:clear`, `glass:frosted` |
| other | `fabric:linen`, `fabric:wool`, `fabric:leather`, `ceramic`, `plant`, `light` |

- `FinishDef = { id, label, family, swatch: '#hex', tint: 'none' | 'multiply' | 'replace' }`.
  - Families (phase 1): `wood`, `paint` (paint, lacquer, melamine, laminate), `stone`, `tile`, `floor`, `metal`, `glass`, `fabric`, `ceramic`, `plant`, `light`.
  - `swatchOf`: `replace` + color → the color; `multiply` + color → swatch × color per channel (a stain); else the swatch.
  - Also `finishDef(id)` (follows `FINISH_ALIASES`), `finishError(f)` (validation), `finishText(f)` (diffs).
- `inferFinish(material)` matches regexes on the id and name:
  - walnut, cherry, `white.?oak`, oak → red oak, maple, poplar and pine → `wood:maple`
  - `birch|baltic|ply` → birch-ply
  - `mdf|hardboard` → `paint` with the material color
  - `melamine|laminate` → melamine
  - quartz, granite, marble → their stone presets
  - Fallback: sheet → birch-ply, solid → maple.
- Also `finishOf(m) = m.finish ?? inferFinish(m)`, `swatchOf(finish)`, and `finishDocs()` (prompt text).
- `materialLibrary.ts`:
  - Add an explicit `finish` to each entry.
  - Add `quartz-3cm` (thickness 76, `slab`, `stone:quartz-white`), `granite-3cm` (76, slab, `stone:granite-black`), `marble-2cm` (51, slab, `stone:marble-white`), and `butcher-block-6-4` (96, solid, `wood:maple`).

**`src/model/look.ts`** (pure). This is the render layer's single entry point.

```ts
export interface PartLook { kind: 'stock' | 'decor' | 'block'; slots: Surface[]; tagSlots: number[] /* per mesh tag → slot index */; explicit: boolean }
export function effectiveFinish(doc: Doc, partId: string): { finish: Finish; explicit: boolean }   // part.finish → nearest ancestor finish → material (explicit when material.finish set)
export function partLook(doc: Doc, part: Part, tags: string[]): PartLook        // decor: shape.surfaces(params) (exact tag → longest prefix → base); blocks: clay + lighter front
export function sceneLights(doc: Doc): { part: string; at: V3; dir?: V3; spec: LightSpec }[]   // world space (model units), skips hidden parts
```

## A5. Hardware and carcass v2, phase 2

**`src/geometry/solids.ts`** (pure), returning `Geom` (patches and faces):
- Primitives: `box(min, max, tag)`; `cylinder(base, axis, r, h, tag, capTag?)` (smooth-normal side patch, flat caps); `lathe(base, profile: [r, y][], tag)` (pole fans); `sphere`.
- Helpers: `translateGeom`, `rotateGeomY` (quarter turns), `mergeGeoms`.
- Segment counts are multiples of 4, so bounds land exactly on `[0, size]`.
- Test: balanced directed edges (each `a→b` matched by a `b→a`), exact bounds, volume close to analytic.

**`pull` decor shape** (`src/plugins/shapes/decor/hardware.ts`, category `hardware`):

```ts
{ style: 'bar'|'arch'|'cup'|'edge'|'knob'|'tab'|'lever' = 'bar', length = 5" c-c (128 mm), size?, projection?, orientation: 'h'|'v' = 'h',
  finish: Finish = { preset: 'metal:brushed-nickel' }, through?: int /* mirror on the far face at this distance, for room doors */ }
```

- The mounting face is local z = 0, and the pull projects toward +Z.
- Export `pullBox(params)` so generators can place a pull by its center.
- As built (phase 2): `length`, `size` and `projection` are optional with per-style defaults (`PULL_DEFAULTS`: bar / arch 5" c-c, cup 3", edge 6" overall, tab 1 1/2", lever 5" reach from the rose's center; knobs have no length). The bar's overall is c-c + 2", the arch's + 1/2", the cup's + 3/4".
- With `through` the origin stays at the min corner: the twin occupies z ∈ [0, projection], the leaf sits between z = projection and projection + through, and `pullBox` z = 2 × projection + through.
- Handles are the box handles of `pullBox` with no drives. Tags: `bar`, `post`, `arch`, `plate`, `hood`, `lip`, `knob`, `tab`, `rose`, `neck`, `lever`, all mapped to `finish`.
- `GenPart.mountedOn` (a part role, listed earlier): the pull is left out when its door or front is gone, so no pull floats where a deleted door was.

**Carcass v2** (`src/plugins/generators/carcass.ts`): `version: 2`, `migrate: (p) => p`, and it regenerates on load (A1).
- **Doors:** each door part (role `door` / `door-left` / `door-right`, unchanged) goes into a group with role `${role}-leaf` and the door's name.
- **Drawer motions:** `{ role: 'drawer-N', nodes: ['drawer-N'], requires: [<6 box roles>] }`. A deleted box behind a false front still leaves it fixed, as before.
- **Door motions:** `{ role, nodes: [`${role}-leaf`], requires: [role] }`. The hinge line is unchanged, because pulls fall under hinge.ts's 5% `HARDWARE` area rule.
- **New params:**
  - `pulls: { style, length?, finish?, doorAt?: 'auto'|'top'|'middle'|'bottom', drawerAt?: 'center'|'top' } | null` (default null, so old files gain no parts).
  - `frontFinish?: Finish`, emitted as `GenPart.finish` on drawer fronts and doors. As built it is `Finish | null` (null clears it, since generator param patches merge).
- **Pull placement:**
  - Drawer pulls: centered and horizontal on the front face.
  - Door pulls: vertical, 1½" in from the opening edge.
  - `auto` puts the pull's top 3" below the door top on base cabinets (those with a toe kick). On wall cabinets (no toe kick) the bottom sits 3" above the door bottom. Tall doors (48" or taller, as built) center it 40" above the cabinet bottom. The pull is always clamped onto its door.
  - `drawerAt: 'top'` (as built) centers the pull 2" below the front's top, or mid-front on a front under 4".
  - Pull roles are `drawer-N-pull` and `${doorRole}-pull`, inside their folders.
- **faceDrive regex:** unchanged, since part roles are unchanged.
- **Also update:** the carcass `describe` (roles, `pulls`, `frontFinish`, door folders), the inspector Cabinet section (Pulls style, length and finish; Front finish), and the prompt.

## A6. Room, phase 5

### Params (`src/plugins/generators/room.ts`)

```ts
const Side = z.enum(['back', 'left', 'right', 'front']);
const OpeningId = z.string().regex(/^[A-Za-z0-9_-]+$/);                 // used in tags: no ':' or '.'
const Base = { id: OpeningId.optional(), wall: Side, at: z.int() /* CENTER along the wall in room coords: X on back/front, Z on left/right */,
  width: z.int().min(inches(12)), height: z.int().min(inches(12)), casing: z.boolean().default(true) };
const Opening = z.discriminatedUnion('kind', [
  z.object({ ...Base, kind: z.literal('window'), sill: z.int().nonnegative().default(inches(36)),
    style: z.enum(['double-hung', 'casement', 'picture', 'slider']).default('double-hung'), grid: z.tuple([z.int().min(1).max(8), z.int().min(1).max(8)]).optional(), stool: z.boolean().default(true) }),
  z.object({ ...Base, kind: z.literal('door'), leaf: z.enum(['panel', 'slab', 'glass', 'none']).default('panel'),
    hinge: z.enum(['left', 'right']).default('left') /* seen from inside */, swing: z.enum(['in', 'out']).default('in'),
    angle: z.number().gt(0).max(180).default(90), handle: z.enum(['lever', 'knob']).default('lever') }),
  z.object({ ...Base, kind: z.literal('opening'), sill: z.int().nonnegative().default(0) }),
]);
schema = z.object({
  left: z.int(), right: z.int(), back: z.int(), front: z.int(),       // inside wall faces, room frame (= world: the room assembly sits at identity)
  height: z.int().min(inches(72)).max(inches(240)).default(inches(96)),
  walls: z.array(Side).default(['back', 'left', 'right', 'front']),
  wallThickness: z.int().min(inches(2)).max(inches(24)).default(inches(4.5)),
  openings: z.array(Opening).default([]),
  floor: z.boolean().default(true), ceiling: z.boolean().default(true), floorGrain: z.enum(['x', 'z']).default('x'),
  baseboard: z.object({ height: z.int().default(inches(4.5)), thickness: z.int().default(inches(0.5)) }).nullable().default({}),
  cans: z.object({ rows: z.int().min(1).max(8), cols: z.int().min(1).max(8), diameter: z.int().default(inches(4)) }).nullable().default(null),
  finishes: z.object({ walls: Finish.default({ preset: 'paint', color: '#ece8df' }), floor: Finish.default({ preset: 'floor:oak-plank' }),
    ceiling: Finish.default({ preset: 'paint', color: '#f6f5f1' }), trim: Finish.default({ preset: 'paint', color: '#f4f2ec', roughness: 0.35 }),
    doors: …(trim), windows: …(trim) }).default({}),
}).superRefine(roomChecks).transform(fillOpeningIds /* w1, d1, o1 by kind */);
```

### Wall frames

Each wall's local frame: x runs along the wall (left→right as seen from inside), y is up, and `face:front` (local +Z) faces the room. Let `Tl`, `Tr`, `Tb`, `Tf` be T when that wall is built, else 0.

| Wall | Rotation | Position | Local x of a room coordinate |
|---|---|---|---|
| back | [0,0,0] | [left−Tl, 0, back−T] | x − (left−Tl) |
| left | [0,90,0] | [left−T, 0, front] | front − z |
| right | [0,−90,0] | [right+T, 0, back] | z − back |
| front | [0,180,0] | [right+Tr, 0, front+T] | (right+Tr) − x |

- Back and front walls run full length, from `left−Tl` to `right+Tr`. Side walls span `[back, front]`.
- The floor and ceiling slabs cover the outer footprint at `y ∈ [−1½", 0]` and `[height, height+1½"]`.
- The generator does its own quarter-turn math. Don't import `model/world.ts`: it would create a module cycle through the plugin pipeline.

### Generated roles (ids `room.<role>`)

- `floor`, `ceiling` (`slab`), and `wall-<side>` (`wall`, with openings converted to wall-local `{id, x, y, w, h}`).
- `baseboard-<side>-<n>` (`trim` run): segments that skip doors and floor-level openings; side runs butt into the back run.
- Window: `window-<id>` (`window`) and `casing-<id>` (`trim` frame with stool and apron).
- Door:
  - A folder `door-<id>` (GenGroup at the wall's transform) holding `door-<id>-leaf` (`doorLeaf`, ¾" undercut, centered in the wall thickness) and `door-<id>-handle` (`pull`, lever or knob, `through` = leaf thickness).
  - `casing-<id>` (three-sided `trim`) sits outside the folder.
  - Motion `{ type: 'hinge', nodes: ['door-<id>'], requires: ['door-<id>-leaf'], params: { side: hinge, toward: swing === 'in' ? 'front' : 'back', angle } }`.
  - `leaf: 'none'` makes a cased opening.
- `can-<r>-<c>` (`recessedLight`) when `cans` is set.
- Floor, ceiling, trim and cans are `unclickable`. Openings on walls that are turned off are kept but not built; `roomIssues` reports them.

### Generator flags and hooks

- Flags: `surroundings`, `collapse`, `lockedParts`, `materialRefs: () => []`.
- **faceDrive:**
  - Inner faces, all `kind: 'position'`: `wall-left` +X face → `left` (+1); `wall-right` −X → `right` (−1); `wall-back` +Z → `back` (+1); `wall-front` −Z → `front` (−1).
  - Wall tops → `height` (+1); the ceiling's bottom → `height` (−1).
  - Outer wall faces → `wallThickness`.
  - Everything else is locked.
- **`actions(p, { role, handle, at })`:**
  - On `wall-*` with `face:front` or `face:back` and an `at`, convert local `at[0]` to a position along the wall (inverse of the wall-frame table), snapped to ½". Offer:
    - "Add window here": 36" × 48", sill 36"
    - "Add door here": 32" × 80"
    - "Add opening here": 36" × 80"
  - On opening tags or opening parts, offer "Remove window w1".
- **Validation (`roomChecks`).** Issue paths look like `openings.2.at`, with readable messages, e.g. "openings[w1]: a 36″ window centered at 160″ runs 10″ past the right wall".
  - The room is at least 36" in both directions; wall sides are unique; opening ids are unique.
  - Each opening fits its wall's inside span, and leaves at least 1" of header (`sill + height ≤ height − 1"`).
  - Openings on one wall don't overlap.
  - Doors start at the floor.

### `src/model/room.ts` (pure)

**`roomAround(doc, opts?) → { params }`**
1. B is the union of world boxes of `modelPartIds`.
2. `back = B.min.z`. The front plane is `B.max.z + 48"`.
3. A side is flush when a generator assembly or block has its back (local −Z, via `frontOf`) facing that side within ½" of B. Otherwise use a 36" margin. Round non-flush planes outward to whole inches.
4. `height = max(96", B.max.y)`.
5. With an empty model: 0 / 144" / 0 / 144" / 96".

**The other exports**
- `refitRoomOps(doc, roomId, opts)` keeps openings, walls and finishes, re-clamps `at`, and reports openings that no longer fit.
- `roomIssues(doc)` reports openings on walls that are off, and openings whose front zone (2" deep, or the leaf width for doors) intersects a solid non-room part. Example: "Window w1 (back wall) is covered by “Wall cabinet 30″”".
- `roomInterior(doc)` returns the interior box and `eyeHeight`.
- `roomShell(doc)` is for the renderer:
  - `walls: { side, ids (wall + hosted: windows, casings, baseboards, door folders on that wall), point, outward: V3 }[]`
  - `ceilings: { ids, height }[]`, `floors: ids[]`
  - `windows: { id, center, outward, area }[]`
  - `shellIds`, `bounds`

### Tags and the editor

- Wall tags: `face:front` (room side), `face:back`, `face:top`, `face:bottom`, `face:left`, `face:right`, and per opening `<id>:jamb-left|jamb-right|head|sill` (no sill when the sill is 0).
- A click yields `{ node: 'room.wall-back', handle: 'face:front', at: [lx, ly, T] }`, which `actions()` consumes.
- Toolbar **Room** button (`top.draw`): generate around the model, or select the existing room.
- Inspector Room section, built from the generator `fields`: dimensions, walls, the openings list (add, remove, edit), finishes, "Fit to model".

### As built (phase 5)

- **`cans`** (phase 7): `{ rows, cols, diameter = 4" }` or null (the default, so no version bump). With the ceiling on, it makes `can-<row>-<col>` (1-based) `recessedLight` parts, named "Ceiling light N", `unclickable`, centered in an even rows × cols grid over the inside (rows along the depth), their tops at the ceiling (`y = height − 9/64"`). They are hosted by the ceiling in `roomShell` (cut away with it). The inspector's Room section has a **Ceiling lights** select (None, 1 × 2 … 4 × 4). Generated decor params must be complete — generated parts aren't parsed on their way into the doc — so the room emits `shapes.parse('recessedLight', { diameter })`.
- `src/plugins/generators/room.ts` exports the wall-frame math the model layer shares: `wallFrame`, `wallX` / `roomCoordAt` (room coordinate ↔ wall-local x), `wallToRoom`, `insideSpan`, `spanEnds`, `openingSpan` (`[at − ⌊w/2⌋, … + w]`), `openingBottom` (doors 0), `wallOpening`, `openingIds` / `nextOpeningId`, `newOpening`, `openingOf`, `roomSchema`, the constants, `ROOM_FINISHES`, `WALL_OUTWARD`. Defaults use explicit `.default(() => …)` values (zod 4's `.default({})` doesn't parse the inner defaults).
- **Pieces and sizes:** casing 3" × ¾"; a window gets a stool (1¾" deep, 1" thick, ¾" horns) and a 3" apron when its sill is at least 4" (apron + stool) and `stool` is on, else a 4-sided frame when the sill is at least the casing width, else 3-sided; doors and floor-level openings get 3-sided casings. A window is `min(T, 4 9/16")` deep, flush with the room face. A door leaf is ⅛" clear of the jambs and head, ¾" off the floor, centered in the wall (`⌊(T − 1⅜")/2⌋`); its handle (pull `lever`/`knob`, `through` = 1⅜", brushed nickel) sits 2⅜" from the latch edge, 36" up, turned 180° about Y when the latch is on the right so a lever points to the hinge. Floor and ceiling slabs are 1½".
- **Baseboards:** back and front runs span the inside width; side runs butt into them (`back + t` … `front − t` where those walls are built). A run breaks at every opening whose bottom is below the baseboard's top, widened by its casing. Numbered along the wall's local x (left → right from inside).
- **Validation messages** (issue paths `openings.<i>.at | width | height | id`, `right`, `front`, `walls`): `openings[w1]: a 36" window centered at 160" runs 10" past the right wall`, `… is wider than the 30" back wall`, `openings[w1]: its top at 98" leaves less than 1" of wall under the 96" ceiling`, `openings[w2]: it overlaps window w1 on the back wall` (2D: stacked openings are fine), `openings[a]: two openings are both a`, `the room is 30" wide inside (left 0" to right 30"); it needs at least 36"`, `list each wall once`. Checks run on every opening, also on walls that are off.
- **`actions()`:** "Add … here" builds the opening with `newOpening`: the defaults, shrunk to fit a low room or a short wall, centered at the clicked point (snapped to ½") and slid along the wall to lie inside it, with its id assigned (`w2`, `d1`…). "Remove window w1" comes from a reveal tag (`w1:jamb-left` on its wall), or the opening's window, casing, door folder, leaf or handle.
- **faceDrive** as specified; wall end faces and every other room part are locked. Pushing a wall moves only that param: openings on the other walls stay put in the world, openings on the moved wall ride with it at the same place along it.
- **`src/model/room.ts`:** `rooms`, `roomOf` (the first), `roomParams`; `roomAround(doc, opts) → { params, model }` (the model's bounds, null when empty); flushness checks every generator assembly (not rooms) and block; an explicit margin overrides the rule for its side (0 = flush), including the back; the room is kept at least 36" each way. `refitRoomOps(doc, id, opts) → { ops, notes }` also keeps the room's **height** (raised only if the model got taller), slides openings to stay on their wall (a note), and drops ones wider than the new wall, too tall, or overlapping after sliding (a note); no ops when it already fits. `roomIssues` messages: `Window w2 (front wall) isn't built: the front wall is turned off`, `Window w1 (back wall) is covered by “Wall cabinet 30″”` (names are the generator assembly's or the part's; the zone is 2" deep, or the leaf width for a door that swings in). Also `alongWall` / `atAlongWall` (distance from the wall's left end seen from inside, for the inspector), `placeOpening` (the widest free stretch, back wall first), `openingText`, `EYE_HEIGHT` (62").
- **`roomShell(doc)`** (memoized per doc, applies the room assembly's transform; model units, world):
  - `walls: { side, room, ids, point, outward }[]` — `ids` = the wall, then its windows, casings, door folders (`room.door-d1`) and baseboards (only ids that exist); `point` = the middle of its inside face.
  - `ceilings: { ids, height, min: [x, z], max: [x, z] }[]` — the inside footprint.
  - `floors: string[]`; `windows: { id, part, center, outward, area }[]` (`center` halfway through the wall, `area` = w × h, built walls only).
  - `shellIds` = every generated room part and door folder; `bounds` = the outside box, slabs included.
- **Editor UX:** a **Room** button (`top.draw`, icon `room`) adds a room around the model as one undo step (id `room` when free) and selects it as an assembly target `{ node: 'room' }`; with a room it selects it. The inspector shows **Room** (width/depth, height, wall thickness, back-left corner x/z, walls, floor, floor grain, ceiling, baseboard, Fit to model, Remove room), **Openings** (each: wall, center from the wall's left end, width, height, sill or style, leaf, hinge side, swing; remove; + Window / Door / Opening) and **Room finishes** (generator `fields`; clearing a finish resets it to the room default) whenever the selection is the room or in it, after Actions. Room parts get no Placement, Look, part fields or Animation picker; the gizmo never moves the room, its parts or its folders (`edit/gizmo.ts`). The editor grid has a polygon offset so the room floor (top at y = 0) covers it.
- **Presentation (until phase 6):** the session hid room ceilings (`visible = false`); phase 6 replaced that with the cutaway (B6).

## A7. Geometry for room pieces, phase 5

- **`wall`** (internal):
  - Reuse `channeledBox` (`src/geometry/orthogonal.ts`), with each opening as a through-block: `{ featureId: o.id, min: [x, y, 0], max: [x + w, y + h, T], axis: 2 }`.
  - This gives exact integer geometry that is watertight. Doorway notches at y = 0 work, and it refuses openings that would split the wall.
  - After building, retag the `${id}:wall` faces by normal: +X → `jamb-left`, −X → `jamb-right`, −Y → `head`, +Y → `sill`.
  - Before building, check that each opening is inside the wall and that none overlap, because `channeledBox` merges overlaps silently.
  - Export `boxFaceInfo` from `plugins/shapes/box.ts`.
  - Handles are box face handles.
- **`slab`** (internal): a box with a finish. Texture direction comes from `part.grain`.
- **`trim`** (internal, `solid: false`):
  - `style: 'run'` is a box.
  - `style: 'frame'` is a `channeledBox` picture frame (3 or 4 sides) plus `stool`/`apron` boxes.
  - Tags: `casing`, `stool`, `apron`.
- **`window`** (internal):
  - Frame jambs, head and sill boxes; sashes per style; a ¼" `glass` pane; `muntin` bars.
  - Depth is `min(T, 4 9/16")`, flush with the interior face.
- **`doorLeaf`** (internal, 1⅜"):
  - `slab` is a box; `panel` is a `channeledBox` with ¼" recessed panels on both faces; `glass` is a through opening plus a `glass` pane.

**As built (phase 5)** — `src/plugins/shapes/decor/room.ts`:
- **Tessellator fix:** a face with holes whose outer loop has grid vertices in line with a hole's edge (a channeled wall with a window) made earcut bridge along them, a T-junction. `tessellate.ts` now splits any triangle edge that passes over a loop vertex (`splitThrough`, faces with holes only), so the walls, window frames, sashes and glass leaves are watertight.
- **`wall`** `{ x, y, z, openings: { id, x, y, w, h }[], finish }`: refuses an opening past its ends or below the floor (`runs past the ends of the 120" wall`), one reaching its top (`leaves no wall above it`, which covers full height), and overlaps (`openings w1 and d2 overlap`). Handles: the six face handles of its box (no edges or corners to grab). One surface (`finish`).
- **`slab`** `{ x, y, z, finish }`: a box with box face tags.
- **`trim`**: `{ style: 'run', x, y, z, finish }` (tag `trim`) or `{ style: 'frame', w, h (the opening), width, thickness, sides: 3 | 4, stool: { depth, thickness, horn } | null, apron: int | null, finish }`; `frameLayout(p)` gives the casing box, the overall size and the opening's corner, which the generator places by. Tags `casing`, `stool`, `apron`. Handles: bounds face handles, no drives.
- **`window`** `{ x, y, z, style, grid?, finish, glass }`: a 1½" frame (a `channeledBox`), 2" sash stiles and rails (a picture window: a 1" stop), sashes `min(1¼", (z − ½")/2)` thick in two planes (double-hung: upper outside, lower inside, meeting rails side by side; slider: left outside, right inside), casements wider than 36" inside split into a pair by a frame-width mullion; a ¼" pane centered in each sash; ⅝" muntins through the sash per `grid` (lites per sash). Tags `frame`, `sash`, `muntin`, `glass`.
- **`doorLeaf`** `{ x, y, z, style, finish, glass }`: stiles `min(4½", w/5)`, top rail = stile, bottom rail `min(9", max(stile, h/9))`; `panel`: two panels (one on a short leaf) under and over a lock rail 2 × stile tall centered at `min(38", 0.45 h)`, recessed ¼" into both faces (tag `panel`); `glass`: a lite through it (reveals tagged `stile`) with a ¼" pane.

## A8. Props and appliances, phase 7

There is one decor shape per kind, in `src/plugins/shapes/decor/<category>.ts`. Each has its origin at the min corner, its front at +Z, defaults, `surfaces` covering every tag it emits, and `fields`.

| Category | Type | Key params (defaults) | Lights / solid |
|---|---|---|---|
| appliance | `rangeHood` | style chimney/wall/island/insert, width 30", hoodHeight, depth 20", chimney, finish stainless | 2 spots down, 300 lm, 3000 K |
| lighting | `pendant` | shade dome/cylinder/globe/cone, diameter 12", drop 30", finish matte black, lumens 800, kelvin 2700 | spot (point for a globe); glow on tag `bulb` |
| lighting | `recessedLight` | diameter 4"/6", trim finish, 650 lm, 3000 K, beam 60 | spot down; `solid: false` |
| lighting | `stripLight` | length, 300 lm/ft, 3000 K | area; `solid: false` |
| furniture | `barStool` | seatHeight 24"/30", seat round/square, back?, frameFinish, seatFinish | — |
| furniture | `chair` | seatHeight 18", width, depth, backHeight 34", finishes | — |
| furniture | `diningTable` | shape rect/round/oval, 72 × 36 × 30, top 1¼", base legs/pedestal/trestle, finish | — |
| furniture | `rug` | width 96", depth 60", rect/round, ⅜", finish `fabric:wool` + color, border? | `solid: false` |
| accessory | `plant`, `bowl` (fruit 0–8), `books` (count, seed), `vase` (stems) | sizes, finishes, `seed` for deterministic variety | — |

**Appliance generators** (`src/plugins/generators/appliances.ts`):
- Flags: `collapse`, `lockedParts`, `materialRefs: () => []`. `faceDrive` maps the outer faces to width, height and depth, as in carcass.

| Generator | Params | Motions |
|---|---|---|
| `fridge` | width 36", height 70", depth 31"; style french / side-by-side / top-freezer / bottom-freezer / column; finish; handle bar or pocket | French doors hinge at 115°; freezer drawer slides |
| `range` | width 30", height 36", depth 27"; fuel gas / electric / induction; burners 4–6; backguard; drawer?; finish | Oven door hinges from the bottom at 90°; drawer slides |
| `dishwasher` | width 24", height 34½", depth 24"; panel stainless or panel-ready | Door hinges from the bottom at 80° |
| `microwave` | width 30", height 16½", depth 15½"; mount over-range / countertop / built-in / drawer | Door hinges left, or slides |

- They use internal shapes `applianceBody` (box plus `cavities`, via `channeledBox`, plus `details` built from `solids.ts`) and `applianceDoor` (box with an optional black-glass window). Handles reuse `pull`.
- **Placement UI:**
  - `src/ui/propsPanel.ts` is a toolbar **Props** catalog, grouped by `DecorInfo.category`. Appliances are listed too, and add generator assemblies.
  - `src/ui/placeTool.ts`:
    - A ghost follows the cursor over the floor, counters and cabinet tops, raycasting all meshes, including unclickable ones, with the y = 0 plane as a fallback.
    - The front faces the camera (reuse `blockPlacement` / `frontOf` from `edit/blocks.ts`). Clicking drops it as one op; Esc cancels.

**As built (phase 7)**
- **Shapes** (`src/plugins/shapes/decor/`): `lighting.ts` (pendant, recessedLight, stripLight), `appliance.ts` (rangeHood; internal applianceBody, applianceDoor), `furniture.ts` (barStool, chair, diningTable, rug), `accessory.ts` (plant, bowl, books, vase), helpers in `common.ts` (`boundsHandles`, `measured`, a seeded `random`, `roundedRect` / `roundedSlab`). `solids.ts` gained `transformGeom` (any rotation) with `rotationX/Y/Z` / `mulRotations`, `geomBounds` and `atMinCorner`. Every prop is closed (balanced edges — solids that would share an edge are inset a little: the hood's canopy starts 1/8" inside its band, books stand 1/64" apart, a grate's crosses end inside its bars), starts at its min corner, and its handles are the box of its bounds (no drives). Organic props (plant, bowl, books, vase) are sized from their geometry (`measured`, cached per params); the rest analytically.
  - `pendant` `{ shade: dome | cylinder | globe | cone, diameter 12", drop 30" (= its height; canopy on top), finish matte black, lumens 800, kelvin 2700 }`: a lathed shell shade (a frosted-glass glowing sphere for the globe), a bulb (`bulb`, finish `light` + glow), socket, cord, canopy. Light: a spot down from the bulb (beam: dome 100°, cylinder 60°, cone 80°), a point for the globe. Refuses a drop shorter than shade + canopy + 2".
  - `recessedLight` `{ diameter 4", trim (white paint), lumens 650, kelvin 3000, beam 60 }`, `solid: false`: a 9/64"-thick trim ring with the lens (`lens`, glowing 1.2) recessed 1/64" in it; its top goes against the ceiling. `RECESSED_HEIGHT` / `recessedWidth(d)` for the room.
  - `stripLight` `{ length 24", width 1", lumensPerFoot 300, kelvin 3000, finish brushed nickel }`, `solid: false`: a 3/8" bar whose `face:bottom` glows; an `area` light with `along` (`LightSpec.along`, new: the area light's width direction, rotated into world by `sceneLights`).
  - `rangeHood` `{ style: chimney | wall | island | insert, width 30", hoodHeight 10", depth 20", chimney 24", finish stainless, lumens 300, kelvin 3000 }`: a front band, a sloped canopy (symmetric on an island), a flue cover, baffle filters and two lamps (spots 70°, glowing `lamp`).
  - `barStool` `{ seatHeight 24", seat round | square, size 15", back false, frameFinish matte black, seatFinish white oak }`: a bevelled round (or rounded-square) seat on four legs with a stepped footrest; with a back, the rear legs run up into a back rail. `chair` `{ seatHeight 18", width 18", depth 20", backHeight 34", frameFinish white oak, seatFinish linen }`: square legs, aprons, two back rails, a rounded cushion. `diningTable` `{ shape rect | round (diameter = width) | oval, width 72", depth 36", height 30", top 1 1/4", base legs | pedestal (two on a long table) | trestle, finish, baseFinish? }`. `rug` `{ shape rect | round, width 96", depth 60", thickness 3/8", finish wool, border { width, finish } | null }`, `solid: false`: the field is cut 1/64" into the border band (`field:floor`).
  - `plant` `{ style leafy | bush, height 24", potDiameter 8", potHeight 7", potFinish ceramic, seed }`: a tapered pot with a lip, soil, and a rosette of lance leaves (9–14, leaning out round the edge) or clipped clumps on a trunk. `bowl` `{ diameter 10", height 4", finish ceramic, fruit 0–8, seed }`: apples (with stems), oranges, lemons, a ring of up to five and the rest on top. `books` `{ count 5, height 9", depth 6", seed }`: a row along X, spines (+Z) aligned, pages up and at the back, eight cloth colors. `vase` `{ height 12", diameter 5", finish ceramic, stems 0–9, seed }`: a lathed vase with leaning stems, three leaves each and a bud.
  - Every prop's surfaces name each tag it draws (tested), and its `fields` drive the generic decor form. Default names are numbered (`numberedName` in ops: past the highest "Bar stool N" in the doc), which fixes phase 1's shared default names.
- **Appliance generators** (`src/plugins/generators/appliances.ts`; `APPLIANCES` lists them for the catalog): common params `width / height / depth` (the overall box, doors included; handles and knobs stand proud), `finish: 'stainless' | 'black' | 'white' | 'panel'` (doors in `panelFinish`, default paint `#f2f0eb`; a panel-ready body is dark gray, its handles brushed nickel), `collapse`, `lockedParts`, `materialRefs: () => []`, `fields`; `faceDrive` maps faces on the outer box (`plane` = 0 or the size) to width / height / depth (min sides move the origin), so the doors' fronts drive the depth and everything inside is locked. Bodies are `applianceBody` (a `channeledBox` with cavities `cav-*` behind the doors in the `inner` finish, plus box / cylinder `details` tagged grate, burner, cap, knob, panel (black glass: `lacquer #141517`, roughness 0.08), zone, rack, shelf (frosted glass), kick, vent, trim, guard); doors and drawer fronts are `applianceDoor` (a slab 1/32" behind its front, a raised face or a black-glass `window`, its back in the liner); drawer bins are top-open `applianceBody` tubs. Each door goes in a folder `<door>-leaf` (identity transform) with its handle (`pull`, `mountedOn` the door); a drawer's folder holds its front, bin and handle.
  - `fridge` (36 × 70 × 31; 24–60 × 60–96 × 24–36): `style` french (two doors over a freezer drawer: `door-left` / `door-right`, `freezer` = `freezer-front` + `freezer-bin` + `freezer-pull`), side-by-side (`door-left` freezer, `door-right`), top-freezer (`freezer-door` over `door`), bottom-freezer (`door` over the drawer), column (`door`); `hinge` (single doors, default right), `handle` bar (7/8" bars standing 2 1/4" off) | pocket (an `edge` lip). 2 1/4" doors over a 3 1/2" toe grille; white cavities with frosted shelves. Doors hinge at 115°, the drawer slides 80% of its bin.
  - `range` (30 × 36 to the cooktop × 27; 20–60 × 30–40 × 20–32): `fuel` gas (burners and caps under a continuous grate: a frame, dividers between columns and rows, a cross over each burner) | electric | induction (a black-glass top with zone rings), `burners` 4–6 (5 adds a center one; 6 = 3 × 2), `backguard` (3" up the back), `drawer` (6" under the oven). Front-control band with knobs, an oven with a window, dark enamel and two racks; the door (`oven-door`) hinges from the bottom at 90°, the drawer slides.
  - `dishwasher` (24 × 34 1/2 × 24): a door over a 4" kick, a stainless tub with two racks; hinges from the bottom at 80°.
  - `microwave` (30 × 16 1/2 × 15 1/2): `mount` over-range (a vent strip on top), countertop, built-in (a trim frame), drawer (a slide-out tub under a control strip). The door (3/4 of the width, a window, a vertical bar handle) hinges left at 90°; a black-glass control panel beside it.
  - The opening check reports a fridge door against a wall beside it (tested: a French-door fridge flush in a room's corner — "Left door hits “Left wall” at 82°" — the handle reaches first).
- **Placement UI:** `src/edit/place.ts` (pure): `mountOf(type, params)` (pendant / recessedLight → ceiling, stripLight → under, rangeHood → raised 66", an over-range microwave → raised 54", else floor), `dropPoint(hit, floor, mount)` (an up-facing face holds it, a down-facing one for `under`, else the y = 0 plane; ceiling mounts take any point), `ceilingAt(doc, x, z)` (the room's inside height over its footprint, else 96"), `dropTransform(size, at, toCamera, mount, ceiling)` (centered in plan, snapped to 1/8", front toward the camera in quarter turns via `facingToward` / `blockPlacement`; a raised item stays under the ceiling). `src/ui/placeTool.ts`: a translucent ghost (the prop's real geometry with its edges, or a box for an appliance) under a 1/64 holder in the editor scene, never picked; raycasts `sceneSync.meshes()` (unclickable ones too); a click dispatches one `add` (decor `p<n>`, or a generator assembly `a<n>` named by `numberedName`), selects it and stops; Shift keeps the tool; Esc cancels. `src/ui/propsPanel.ts`: a **Props** button in `top.draw` (icon `props`) with a fixed popover kept on screen, groups Appliances (the four generators + range hood), Lighting, Furniture, Accessories (`catalog()` reads the registry; hardware stays out: cabinets make their own pulls). `main.ts`: the place tool counts as an active tool for interaction, gizmo, isolation and motion controls; it, the block tool and the split tool are exclusive; `quiesce` stops it. The topbar's right-side labels now hide below 1320px (was 1180) so the third draw button fits.
- **Inspector:** an appliance (or any generator with `fields` other than the carcass and room) gets a section from its fields after the part's own; decor made by a generator says "Part of “Fridge 1”: change it below."; no Look section for appliances (the finish is a param).

## A9. Presentation data, phase 8 (the schema is from phase 1)

- **Ops:**
  - `add { entity: { kind: 'view', id?, name, camera? | frame?, mode?, open?, hide?, caption?, lighting? }, index? }`, with id prefix `view`.
  - `update { id, patch }`, `delete { id }`, `move { id, index }` (a view branch before the node lookup).
  - `{ op: 'setPresentation', lighting?: Lighting | null, eyeHeight?: int | null }`. Phase 6 needs `setPresentation` for lighting, so land it there if phase 8 hasn't happened yet.
  - As built (phase 6): `setPresentation` is in `makeOpSchema` (so the AI schema has it too); `lighting` replaces the saved lighting whole (`preset` defaults to `auto`), `null` clears it or the eye height, and a presentation left with no views, lighting or eye height is dropped (no empty `presentation: {views: []}`). Diff lines (`ai/diff.ts` `lightingChanges`): `~ lighting → evening`, `~ lighting: brightness +0.5 EV, under-cabinet lights off`, `~ lighting reset`, `~ eye height → 60"`. The apply_ops description and the prompt's room section document it in one line each.
- **`prunePresentation(d)`** runs at the end of `applyOps`, next to `pruneMotions`: it drops `open`, `hide` and `frame.nodes` ids that no longer resolve.
- **`src/model/views.ts`:**
  - `viewMotions(doc, view)`: node ids expand to every motion that moves parts inside them.
  - `viewCamera(doc, view, aspect)`: a `camera` is returned as is.
  - A `frame` is fit by bounding sphere over its nodes (or `modelPartIds`):
    - Azimuth: front = 0°, front-left = −35°, front-right = +35°. Elevation 15°; `above` = 70°; `eye` uses the eye height.
    - The pose is pulled inside `roomInterior` when a front wall exists.
- **As built (phase 8):**
  - `ViewFields` (schema.ts) is the view's plain object (`View` = it + the camera-xor-frame refine; zod 4 can't extend a refined object) and `ViewFrom` the `from` enum. The op entity is `ViewFields.extend({ kind: 'view', id? })`, in `makeOpSchema` (so the AI schema has it). `add` checks the rule and that `frame.nodes` / `hide` are parts or folders and `open` motions, parts or folders (`view "X": no part or folder "a9" to frame`), and inserts at `index` (clamped). `ViewPatch` (strict): `name`, `camera` / `frame` / `mode` / `open` / `hide` / `caption` / `lighting`, each nullable (null clears); `frame` **merges** into the view's frame (null clears its azimuth / elevation / distance); a patch's camera replaces the frame and its frame replaces the camera, both at once is refused, and clearing the only one is refused. `move {id, index}` reorders (to / by / rotation / parent refused); `delete` removes it; the last view gone with nothing else saved drops the presentation.
  - `prunePresentation(d)` (exported, after `pruneMotions` in `applyOps`): drops `open` / `hide` / `frame.nodes` ids that no longer resolve (an emptied `open` / `hide` goes; a frame left with no nodes frames the whole model), and drops an empty presentation.
  - `src/model/views.ts`: `viewMotions` (doc order; a node id expands to every motion whose nodes or moving parts are inside it — a door part inside the leaf folder its motion moves counts), `motionPlan(openNow, target) → { close, open }`, `eyeHeightOf(doc)`, `FROM` (left / right = ∓90°, `eye` = −35° at the eye height), `FRAME_FOV` 50 / `WALK_FOV` 60 (a `mode: 'walk'` view), `viewCamera(doc, view, aspect)`: the frame's nodes (or `modelPartIds` less hidden and the view's `hide`), center + half diagonal, distance `max(24", 1.15 r / sin(min half-fov))` unless given. **Inside the room** generalizes "pulled inside when a front wall exists": `insideRoom` walks the camera back along the line to the target until it's 12" (`WALL_MARGIN`) inside every *built* wall and under the ceiling (a room with all four walls is the spec's case; an open side lets it stand outside); walls the target is already outside of don't count; `eye` pulls in level. **Out of cabinets:** a camera within 6" of a solid model part's box is raised 12" over it (at eye height it slides toward the target instead).
  - Diff lines (`ai/diff.ts` `viewChanges`): `+ view "Island"`, `− view "Sink"`, `~ view "Island": renamed (was "…"); camera moved; frames Base from front; walk mode; opens Drawer 2 | nothing; hides …; caption "…"; lighting → evening`, `~ views reordered: "Sink", "Island"`.

## A10. AI layer (land with the phase that adds each piece)

- **`ai/prompt.ts`:**
  - Rewrite "# Blocks": appliances can be replaced by appliance generators in exactly the block's space when the user wants them shown for real.
  - New "# Presentation (room, finishes, props, tour)" section:
    - Room: use `fit_room`; params are room/world coordinates; openings are edited by sending the whole list; never parent things in the room.
    - Finishes: a finish is a look, not stock. Use node `finish` or carcass `frontFinish`; don't add materials for colors. Stone tops use slab stock.
    - Hardware: carcass `pulls`.
    - Props: the decor entity, grouped in folders.
    - Appliances: generators.
    - Views: `frame` + `open` + `caption`.
  - Add `finishDocs()` next to `libraryDocs()`.
- **`ai/context.ts` `modelSnapshot`:**
  - `collapse` generators emit `{ id, name, assembly, generator, world, generatedParts: n }` plus user children; the room also gets `interior`.
  - Generated pulls are omitted; they follow `pulls`.
  - Decor: `{ id, name, decor: true, shape, position, rotation?, front, world }`.
  - Materials gain `finish`. Add top-level `presentation` and `roomIssues`.
- **`ai/tools.ts`:**
  - `part.shape` = the union of non-decor shapes; `decor.shape` = the union of decor shapes that aren't internal; generators include room and appliances; add the view entity and `setPresentation`.
  - Finish presets are plain strings, not zod enums, documented once in the prompt.
  - New tool `fit_room { margins?, height?, walls?, ceiling? }` applies `roomAround`/`refitRoomOps` into the draft.
  - Results gain "Room check" lines and view lines. `nodeIds`/`describeNode` include views.
  - Add a tool-schema budget test: measure `JSON.stringify(toolDefs()).length` now, and set the budget to that + ~25k.
- **`ai/diff.ts`:** lines like `+ Bar stool 1 (bar stool)`, `finish → paint #1f2a44`, `+ view "Island"`, `~ lighting → evening`.
- **`ai/organization.ts`:** loose decor gets "group props in a folder per area or kind".
- **Evals** (`evals/cases.ts`, `-t presentation`):
  - room around a run, with a window over the sink and a right-wall doorway
  - fridge block → fridge
  - pulls on all cabinets
  - island stools and pendants
  - two-tone finish
  - a three-shot tour
  - a room door near cabinets

**As built (phase 5, the room's part):**
- `fit_room` (`TOOL_FIT_ROOM`): `{ margins?: { left?, right?, back?, front? } (lengths, inch strings ok), height?, walls?, ceiling? }`; makes `room` (`roomAround`) or refits the first room (`refitRoomOps`), into the draft and `state.ops`; the result gives the inside size and planes, the refit notes, the openings (`openingText`), wall overlaps with the model and room checks; "already fits" when nothing changes.
- apply_ops results add "Room check — fix these unless intended:" lines: every `roomIssues` line when a room's generator changed, else only new ones; the summary counts room warnings.
- The snapshot collapses `collapse` generators: `{ id, name, assembly, generator: { type, params, overrides? }, world, generatedParts, interior?, children? }` (children = user nodes in it or its folders; the room's `interior` = `[[left, 0, back], [right, height, front]]`), and adds top-level `roomIssues`. Phase 1 hadn't collapsed anything yet.
- `diff.ts`: lists of objects with ids (a room's openings) diff by id — `~ Room: + door d1 (right wall, 32" × 80"); openings[w1].at 72" → 80"`, `− window w1 (back wall, 36" × 48")`; `angle` reads in degrees, `grid` as counts.
- Prompt: a "# Presentation: the room" section (fit_room; params are world coordinates; openings as one list; never move the room or parent things in it; roomIssues), and the "# Blocks" bullet now sends walls, windows and doors to the room when the user wants one. The finishes, props, appliances and views parts come with their phases.
- The room adds ~7k to the apply_ops schema: `toolDefs()` is ~49.5k (budget 60k). The older apply_ops-only caps in `agent.test.ts` / `motionTools.test.ts` went from 40k to 50k.
- Evals (not run): "presentation: room around a run, a window over the sink and a right-wall doorway" and "presentation: a room door near cabinets swings clear, or the AI says why not".

**As built (phase 7, props and appliances):**
- The decor union (non-internal decor shapes) and the generator union pick the new shapes and the four appliances up from the registry. Describes are terse (defaults in parentheses); the tool JSON shows `Finish` objects bare — no patterns or bounds on preset / color / roughness (`override` in `ai/tools.ts` `jsonSchema`; zod still validates when ops apply). `toolDefs()` is ~66k (budget raised 60k → 72k, leaving ~6k for views); the apply_ops-only caps in `agent.test.ts` / `motionTools.test.ts` went 50k → 64k.
- Prompt: the "# Blocks" bullet sends appliance blocks to their generator in exactly the block's space; a new "# Presentation: props and appliances" section (the decor entity with an example, resting on what holds it, pendants at ceiling − drop, cans from the room, folders per area or kind, numbered names, appliances as generators with overall boxes and their finish choices, fixtures light evening and night).
- Snapshot: appliances collapse to one line (`collapse`), their pulls with them. Diff: `+ Bar stool 1 (bar stool)`, `+ Fridge 1 (fridge)`.
- Evals (not run): "presentation: island stools and pendants" and "presentation: a fridge block becomes a fridge in exactly its space".

**As built (phase 8, views):**
- The view entity rides in the apply_ops schema (`camera`, `frame`, `mode`, `open`, `hide`, `caption`, `lighting`); the description adds one sentence (add / update with frame merging / delete / move {id, index}) and `view` to the entity kinds. `toolDefs()` ~67.9k (+1.9k; budget 72k kept). `nodeIds` / `describeNode` include views (`view3 (view "Island")`).
- Prompt: a "Views" bullet in "# Presentation: props and appliances" (a client tour = views in order: frame the area with `from`, open what to show — drawer or door folder ids, a cabinet id opens all of it — a short caption; write frames, not cameras). The snapshot already carried `presentation`.
- Eval (not run): "presentation: a three-shot client tour" (the whole kitchen, the island with its drawers open, the sink base with doors open; checks order, framing, `viewMotions` and short captions).

---

# B. Render and presentation layer

## B1. Shell, phase 3

**`src/render/viewport.ts`**
- Add `setFrame(fn: ((dt) => void) | null)`: when set, frame hooks run and then `fn(dt)` runs **instead of** the editor update and render.
- Add `onResize(fn)`.
- Set `renderer.shadowMap.enabled = true` once. This is a no-op for the editor: `shadowMapEnabled` requires shadow-casting lights, and editor lights never cast.

**`src/render/sceneSync.ts`**
- Extract a `Look` strategy:

  ```ts
  export interface Look { key(doc, part): string; build(doc, part, built: BuiltPart, tint): THREE.Mesh; paint(mesh, doc, part, tint): void; dispose(mesh): void }
  export function createSceneSync(scene, look: Look = editorLook()): SceneSync
  ```

- `editorLook()` is today's `toGeometry` + `frontGroups` + edges + `frontArrow` + `surface()`. Phase 1 extends it with swatches and decor slots (binding note 9).
  - Phase 1 landed this as `partLook` + `editorColors` (model/look.ts) and `slotGroups` (one geometry group per contiguous run of a slot, triangles unsorted; a block's box gets runs [0, 1, 0]), still inside `createSceneSync`.
- The cache key becomes `JSON.stringify([shape, features, block]) + look.key(...)`.
- Add `src/render/sceneSync.test.ts` to lock in the editor look.

**`src/ui/present/`**
- `keys.ts` (eager): `installModalKeys()`, a window-capture keydown/keyup owner, installed right after `mountTheme()`.
  - While an owner exists, every key not typed into an input gets `stopImmediatePropagation`.
  - `preventDefault` only for handled keys; modifier-only keys pass through.
- `mount.ts` (eager):
  - A "Present" button in `top.view` (play icon), the `P` key, and `Esc`.
  - It lazy-imports the session, like `ui/gltf.ts`.
  - It calls `quiesce()` from `main.ts` first: `blockTool.toggle(false)`, `splitTool.toggle(false)`, `interaction.cancelDrag()`, `selection.setHover(null)`, and cancel voice if recording.
- `session.ts` (lazy):
  - **Entering:**
    1. Snapshot which motions are open.
    2. Add `#app.presenting`; mount the HUD and a transparent `.pr-surface` over `#viewport`, so editor handlers never see these pointers; the modal key owner takes the keyboard.
    3. Show a "Preparing…" veil, build the scene, start the camera from the editor pose, then `compileAsync`.
    4. `viewport.setFrame(sessionFrame)`.
  - **Exiting** reverses all of that: dispose, restore renderer state (`toneMapping`, `toneMappingExposure`, pixel ratio, `shadowMap` flags, clear color) and the open motions.
- `hud.ts` (lazy): a bottom-center translucent pill. Phase 3 has Open all, Close all and Exit; later phases add views, lighting, walk, photo, save image, quality and fullscreen.
- As built (phase 3):
  - `keys.ts` exports `installModalKeys()`, `claimKeys(owner) → release` and the pure `routeModalKey(e, owner)`; the `Esc` that leaves presentation is the session's key owner, not `mount.ts`.
  - `SceneSync` gained `dispose()`; the motion player's `subscribe`/`onMove` return unsubscribes; `editorLook()`, `toGeometry` and `Tint` are exported from `sceneSync.ts`.
  - The present look (`render/present/look.ts`) uses per-family roughness/metalness (finish `roughness` wins), keys materials by preset + swatch + roughness, and gives a part that is all glass `castShadow = false`. `hover(m)` lifts emissive by 0.08.
  - Basic studio in `session.ts`: RoomEnvironment PMREM (×0.8), background `#ebe9e5`, one key `DirectionalLight` (2.5, azimuth 35°, elevation 50°, `PCFShadowMap`, radius 4, 2048²) fitted by `fitOrtho` (`render/present/lightPlan.ts`, which also reaches the floor shadows), a `ShadowMaterial` floor disc at the model's min Y, `NeutralToneMapping`. It renders every frame.
  - Double-click focus is `focusPose` (`render/present/focus.ts`) eased over 0.6 s; Open all opens what's closed, Close all closes what's open.
  - `#app.presenting ~ *` also hides body-level editor overlays (drag labels, menus, the voice caption).
- **Supporting changes:**
  - `ui/theme.ts`: `#app.presenting` hides `#topbar`, `#left` and `#right` and collapses the grid. Stage overlays other than the viewport, surface, HUD, veil and toasts are hidden.
  - `main.ts`: a `presenting` flag. The motion player's doc is `presenting ? store.doc : modelShown()`, and so is `player.sync(...)`.
- **Presentation keys:**
  - `Esc`: cancel photo, else leave walk, else close a popover, else exit.
  - `←`/`→`, PageUp/PageDown, Space and `1`–`9` move between views (phase 8).
  - `O` opens or closes all; `L` cycles lighting; `V` toggles walk; `H` hides the HUD; `F` goes fullscreen.

## B2. Pipeline, phase 4 (`src/render/present/pipeline.ts`)

**Interface:** `frame()`, `invalidate({ shadows? })`, `setSize(w, h, dpr)`, `setQuality(q)`, `setBloom(...)`, `still({ width, height, samples }): Promise<Blob>`, `dispose()`.

**Passes**
- `EffectComposer` with HalfFloat targets.
- `RenderPass`: linear HDR output. OutputPass then tone-maps everything, including the clear color.
- `AOPass extends GTAOPass`:
  - Overrides `_overrideVisibility()` to also hide `userData.noAO` objects (glass, bulbs, sky) and `userData.cutaway` ones.
  - Parameters in inches: radius 8, thickness 6, distanceExponent 1.5, samples 12–16, blendIntensity 0.8, `setSceneClipBox(bounds)`.
  - Half resolution on the Fast and Balanced tiers. It needs type casts for private members.
- `UnrealBloomPass(res, 0.15, 0.4, 1.0)`: only HDR above 1.0 blooms; off in Studio.
- `OutputPass`: `renderer.toneMapping = NeutralToneMapping` while presenting.
- `SMAAPass`: only while moving.
- `AccumulatePass` (custom): `mix(history, current, 1/(n+1))` over Halton(2,3) jitter via `camera.setViewOffset` while the view is still.

**Scheduling**
- The signature is camera matrices + a scene version.
- If it changed: draw a moving frame and reset accumulation. Else if `n < N`: draw one more sample. Else: draw nothing.
- `shadowMap.autoUpdate = false`; set `needsUpdate` only on `invalidate({ shadows: true })` (motion frames, preset or model changes).

**Quality tiers.** The tier is auto-picked from `WEBGL_debug_renderer_info`: Intel, UHD or Iris → Balanced; SwiftShader or llvmpipe → Fast. It drops a tier if moving frames average over 28 ms, and the user's choice is stored in localStorage.

| | Fast | Balanced | High |
|---|---|---|---|
| DPR cap | 1 | 1.25 | 2 |
| Shadow map | 1024 | 2048 | 4096 |
| AO | still frames only, half-res | half-res | full-res |
| Bloom | off | on | on |
| Still samples | 8 | 16 | 32 |
| Materials | Standard | Physical | Physical |
| Fixture lights | ≤ 4 | ≤ 8 | ≤ 12 + 1 shadowed spot |

**Studio look**
- Key `DirectionalLight` at front-right, elevation about 50°, using `PCFShadowMap` + `shadow.radius 4`. r186 removed `PCFSoftShadowMap`.
- `RoomEnvironment` PMREM at about 0.8.
- Background `#ebe9e5`, plus a large floor disc at the model's min Y that fades radially to the background via `onBeforeCompile`. No `scene.fog`, because toggling it recompiles.

**Save image.** `still()` builds a temporary composer at export size: about 2× the view, capped at `min(4096, maxTextureSize)`. It renders 32 samples, reads pixels to a PNG and downloads `"<model> – <view>.png"`.

**As built (phase 4)**
- `pipeline.ts` exports the pure helpers `pickTier`, `halton`, `jitter`, `accumulationWeight`, `diskSample`, `stillSize`, `slowWatch`, `neutral` / `untoneMapped`, `savedQuality` (localStorage `new-modeler.present.quality`), plus `TIERS` (each tier also has `softShadows`: off on Fast). The interface adds `setBounds(min, max)` (the AO clip box) and `debug` (the passes, for the console).
- Accumulated samples replace the last moving frame only from the 4th one on (no one-frame flash of an un-anti-aliased image). The auto step-down applies only on Auto (a picked tier is the user's call). Stills: 32 samples (16 on Fast), time-sliced (yields every ~40 ms); afterwards the view re-settles.
- **Soft shadows (addition):** while still (Balanced, High), each sample tilts the shadow-casting directional lights over a disk of radius `SOFT_SHADOW_ANGLE` = 0.06 rad and re-renders the shadow map: contact-hardened penumbrae, crisp where things touch. Moving frames keep the plain PCF shadow (radius 4).
- **AO:** the B2 numbers (radius 8, thickness 6, exponent 1.5, blend 0.8) gave barely visible occlusion; tuned to radius 12", thickness 36", distanceExponent 1, blendIntensity 1. GTAO's noise pattern is fixed per pixel, so `AOPass` shifts it per still sample (a `noiseShift` uniform patched into the GTAO and denoise shaders); otherwise its grain survives accumulation.
- **Studio (`lighting.ts`):** key 1.6 (azimuth 35°, elevation 50°, PCF radius 4, bias −0.0002, normalBias 0.06), RoomEnvironment ×0.65, exposure 1, bloom 0. The B2 values (2.5 / 0.8) lit front faces at ~1.45× albedo and washed the wood out. The backdrop is `untoneMapped(#ebe9e5)`, so it shows exactly as #ebe9e5 (matching the veil). The floor disc's albedo is computed from the lights (`ROOM_ENV_UP` = 1.47, measured), so the lit floor matches the backdrop and only shadows and AO show; it fades from 0.7× to 2.5× the model's span. The PMREM render target is disposed whole (phase 3 disposed only its texture, leaking one texture per session).
- HUD: Save image (camera icon; "Saving…" while busy) and a Quality `<select>` ("Auto · High" names the tier Auto is on). The image is named after the doc's only root (else "model"): `Base cabinet – presentation.png`.
- Dev console: `__modeler.present.session.debug` → `{ scene, camera, controls, pipeline, look, lighting }`.

## B3. Finishes, materials and textures, phase 4

- **`src/render/present/finishDefs.ts`** (pure): `FINISH_RENDER: Record<presetId, { textureSet?, roughness, metalness, clearcoat?, clearcoatRoughness?, anisotropy?, sheen?, tint, castsShadow, glass?: { opacity } }>`. Every model preset must have an entry (tested). Starting values, to be tuned:

| Preset(s) | Texture set | Roughness / metalness | Extras |
|---|---|---|---|
| woods | `wood-*` (color multiplies as stain) | map × (r / setMean) / 0 | clearcoat 0.3, clearcoat roughness 0.3 |
| paint | `paint-micro` (normal scale 0.15) | 0.45 / 0 | — |
| lacquer | — | 0.25 / 0 | clearcoat 0.5 |
| melamine, laminate | — | 0.45 / 0 | — |
| stone | `stone-*` | 0.18 (quartz) / 0.12 (marble) / 0.22 (granite), metalness 0 | clearcoat 0.4 / 0.6 / 0.3 |
| metal:stainless, brushed-nickel, brass | — (procedural) | 0.32–0.35 / 1 | anisotropy 0.5 |
| metal:chrome | — | 0.06 / 1 | — |
| metal:matte-black | — | 0.55 / 0.5 | — |
| glass:clear, frosted | — | 0.02 / 0.35 | raster: transparent, opacity 0.12 / 0.5, `depthWrite` false; no shadow |
| fabric | `fabric-*` | 0.9 | sheen 0.5 |
| ceramic | — | 0.15 | clearcoat 0.6 |
| light | — | — | emissive = `kelvinToRGB(K)`, intensity = level × 6 |

- **`src/render/present/textureSets.ts`** (pure data):
  - Entry: `{ id, files: { color, normal, roughness }, size: [wIn, hIn], grain: 'u' | 'v' | null, avg: '#hex', roughnessMean, normalScale, source, license: 'CC0' }`.
  - Files live at `public/textures/<id>/{color,normal,roughness}.jpg`, using NormalGL maps, and are served via `import.meta.env.BASE_URL`. Credits go in `public/textures/LICENSES.md`.
  - A test checks that every file exists.
- **`scripts/fetch-textures.mjs`** fetches the confirmed list: Poly Haven per-map JPGs; ambientCG zips (add `fflate` as a devDependency if needed).
- **`src/render/present/textures.ts`:**
  - `ImageBitmapLoader` (`imageOrientation: 'flipY'`; resized on Fast).
  - Color maps `SRGBColorSpace`; `RepeatWrapping`, mipmaps, anisotropy `min(8, max)`.
  - `repeat = 1/size`, since UVs are in inches; rotate π/2 when the image grain runs along u.
  - `preload(ids)`, `dispose()`.
- **`src/render/present/appearance.ts`:**
  - Material cache by finish key: `MeshPhysicalMaterial`, or Standard on Fast. Keeps `polygonOffset`.
  - `hover(m)`: a cached clone with an emissive lift of 0.07.
  - `shadowOnly`: `MeshBasicMaterial({ colorWrite: false, depthWrite: false })`.
  - `setFixtureLevel`.
- **`src/render/present/look.ts`:** the present `Look`.
  - UVs from B4. Triangles are stably sorted by slot, with index and `triTags` permuted together so picking stays valid, giving one geometry group per slot.
  - Non-casting slots (glass, emissive) are split into a **child mesh** that shares attributes and has `castShadow = false` and `userData.noAO`.
  - Blocks draw as white massing.
  - Shadows: parts, walls and ceilings cast and receive; floors only receive.

**As built (phase 4)**
- `FinishRender.tint` is the multiplier over a **photo** set's color map when the finish gives no color (`#ffffff` = the photo as is), with an optional linear `gain`; a finish's color (a stain) multiplies on top. Mask sets (procedural tile) and untextured presets draw `swatchOf(finish)`. A set that hasn't loaded yet draws the swatch until `appearance.refresh()`.
- Tuned wood tints (the photos' own tones are off): white oak `#e3ecfa` ×1.3, red oak `#ecdcd8` ×1.22 (both `wood-oak`), walnut `#c9b8ab`, cherry `#c4a6a6`, maple `#fff4e0` ×1.1, birch ply `#fff0d8` ×1.05 (both `wood-maple`). Wood roughness 0.5 + clearcoat 0.3 / 0.3.
- The glass row's "0.02 / 0.35" is read as clear / frosted roughness (metalness 0). Leather is untextured (the weave doesn't suit it): roughness 0.5, sheen 0.25. `light` glows at 2900 K × 6 × the fixture level; a `glow` surface uses its own kelvin and strength.
- Paint's micro-normal: normal scale 0.07 over a 4" repeat (0.15 read as hammered metal up close).
- `kelvinToRGB` landed in `lightPlan.ts` now (glowing finishes need it).
- `appearance.ts` also exports `castsShadow(surface)`, `MASSING`, `HOVER_LIFT` (0.08, kept from phase 3). `textures.ts` exports `configureTexture` (used by the appearance test's fake provider) and `NO_TEXTURES`.
- `look.ts`: `presentLook({ textures?, physical? })` exposes `appearance` and `paintHover(mesh)` (hover clones for the mesh and its see-through child); `usedTextureSets(doc)` lists what to preload; `sortBySlot` writes new index/`triTags` arrays (the built mesh's are cached and shared with the editor). A single casting slot keeps a single material (no groups). `key()` = grain + the stock finish's preset.
- Procedural sets live in `procedural.ts` (pure RGBA bytes → `DataTexture`s, not canvases): `tile-subway` (12" repeat, roughness mean 0.152), `tile-floor` (48" repeat, 0.369), `paint-micro` (normal only).

## B4. UVs, phase 4 (`src/geometry/uv.ts`, pure)

```ts
export function boxUVs(mesh: TaggedMesh, o: { grain: Grain; offset?: [number, number] }): Float32Array;  // inches; v along grain
export function uvOffset(partId: string): [number, number];   // FNV-1a hash → [0, 96)" so neighbouring doors don't repeat
```

- Vertices aren't shared across faces in `tessellate.ts`, so each vertex's tag can be found from its triangles.
- **Per tag:**
  1. n̄ = the area-weighted normal.
  2. g = the part's grain axis.
  3. t = g − n̄(n̄·g), if that is substantial.
  4. Otherwise (end grain or `none`), t = the in-plane direction of the tag's longer extent. This is the edge-banding look: a door's top edge runs along its width.
  5. b = n̄ × t; v = p·t/64 + offset; u = p·b/64 + offset.
- Closed patches (n̄ ≈ 0) fall back to per-vertex dominant-axis projection.
- Only the present look calls it; `tessellate()` and the `buildPart` cache are untouched.
- As built: a tag counts as flat when |Σ area-weighted normal| ≥ 0.999 × its area (a ≤ ~9° arc); the grain is "in" a face when its in-plane part is longer than 0.3. Curved tags run v along their long axis (the grain axis when it reaches at least half the longest extent), with u projected per vertex along the vertex normal's dominant axis — so v is continuous along a bar pull and anisotropy brushes along it.

## B5. Click and hover, phase 3

- **Hover** (rAF-throttled):
  - Raycast the presentation meshes recursively, skipping cutaway. Unclickable parts are pickable here.
  - `motionOf(doc, partId)` gives the motion; all of its moving parts (`movingParts`) get the hover material.
  - The cursor becomes a pointer, and a tooltip reads "Open — Left door" or "Close — Drawer 2" (from `motionName`).
- **Click** (moved less than `CLICK_PX`):
  - `detail === 1` → `player.toggle([id])`.
  - `detail === 2` → fly focus to the hit point at distance `clamp(d × 0.55, 24", 120")`.
- **Open all / Close all:** `player.toggle(all)` / `player.toggle(openIds)`. Close all is animated and staggered, unlike `closeAll()`.
- `player.onMove` → `presentSync.pose(store.doc, player.amount)` + `invalidate({ shadows: true })`.
- **Controls:** OrbitControls on the surface with `{ LEFT: ROTATE, MIDDLE: DOLLY, RIGHT: PAN }`, damping 0.08, `zoomToCursor`, and a floor clamp 6" above min Y.

## B6. Camera, flights, walk and cutaway

- **`src/render/present/flight.ts`** (pure, phase 8):
  - `flight(a: Pose, b: Pose, o?) → { seconds, at(t) }`. The target is lerped; the offset is spherical, with a log-lerped radius, the shortest azimuth and a clamped polar angle. Walk to walk lerps the position and slerps yaw and pitch. It uses `easeInOut` from `model/motion.ts`.
  - Duration `clamp(0.6 + 0.25·log2(1 + d/24) + 0.4·Δangle/π, 0.6, 2.5)` s, or 0 under reduced motion.
  - Motions not in `view.open` close as the flight starts; `view.open` opens at 50%.
  - Ends with `setView` from `frameNodes.ts`.
- **Walk** (phase 8):
  - `src/render/present/occupancy.ts` (pure): `buildGrid(tris, { band: [8, 70], cell: 2, radius: 9, floorTris })`, `move(grid, from, delta)` (slides along walls), `nearestWalkable()`. Doorways are passable because headers sit above the band. Rebuild after poses settle, so open doors block.
  - `src/ui/present/walk.ts`:
    - Eye height 62", fov 60°, near 2".
    - Drag-look at 0.25°/px, pitch ±75°.
    - WASD and arrows at 54 in/s, Shift ×2, wheel ±12".
    - Orbit ↔ walk transitions fly for about 1 s. Double-click the floor to walk there.
- **As built (phase 8):**
  - `flight.ts`: `Pose = { position, target, fov }` (inches); `flight(a, b, { walk?, reduced? }) → { seconds, at(u) }` (u = linear time 0…1, eased inside; `at(0)` / `at(1)` return exact copies of the ends; `seconds` may be overridden by the caller). Orbit: target lerp, radius `rA·(rB/rA)^e`, azimuth `atan2(x, z)` the short way (`shortest`), polar lerp clamped to [0.02, π − 0.02]. Walk (either end walking): position lerp, yaw the short way + pitch lerp (`yawPitch` / `direction`: yaw 0 looks −Z, positive turns left), look distance lerp. `flightSeconds` per B6 with d = the larger of the camera's and the target's travel, Δangle between view directions; 0 when nothing changes. `poseToCamera` (whole 1/64ths, fov to 0.1°, clamped 10–120) / `cameraToPose`. `focus.ts` keeps `focusPose`; its 0.6 s ease is gone (double-click focus is a flight).
  - `occupancy.ts`: `buildGrid(tris, { band, cell, radius, floorTris })` (flat 9-number triangles, inches; `WALK_GRID` = band [8, 70], cell 2, radius 9; cells doubled past 2M). Floor triangles mark walkable cells by their centers; each solid triangle is clipped to the band (Sutherland–Hodgman), its edges marked (sampled at ¼ cell) and its inside filled; blocked cells dilate by a disk of the radius. `isFree`, `move(grid, from, delta)` (sub-steps under half a cell; a blocked step tries x, then z; standing in a blocked cell moves freely so a door swung into you can't trap you), `nearestWalkable` (ring search, Euclidean nearest center).
  - `ui/present/walk.ts`: `createWalk({ camera, surface, eyeHeight, onMove })` — `start(pose)` / `stop()` / `pose()` (target 60" ahead) / `setGrid` / `frame(dt)` / `key(e, down)`; drag-look grabs the view (drag right turns left, drag down looks up, as orbiting does); Shift is watched on the window (the modal key owner passes modifiers through); keys clear on window blur; the wheel queues 12" glides. `sceneGrid(doc, meshes, modelBounds)`: world triangles of the drawn solid parts (`sync.meshes()`: hidden, view-hidden and studio-hidden parts are out; open doors where they stand), room floors as floor triangles, ceilings skipped; no room floor drawn → the model's bounds + 120" all round. Walk constants: 60° fov, near 2", 54 in/s.
  - Session (`ui/present/session.ts`): one flight runner (`fly` / `stepFlight` / `settle`): orbit controls are off during a flight and re-synced at its end; input cuts an orbit flight short (its halfway work still runs); flights into walking always finish. `mode` switches at a flight's start; `walk.active` (input) only after it lands, and the cutaway uses `'walk'` only then (flying in from outside, walls cut as the eye passes). Entering walk builds the grid at once (the spot under the orbit target is found on it) and again 300 ms after things stop moving or the doc changes. `goToView(i)`: `motionPlan` closes now, opens at 50%; `hide` → `sceneSync.setCutaway` (with the studio's room hiding); `lighting` → a presentation-only override fed to `lighting.update` (picking a preset in the HUD clears it; `L` cycles from what shows); a walk view walks there (a saved camera stands where it was saved; a frame's spot snaps to the nearest walkable cell); an orbit view from walk flies with walk interpolation and orbits on landing. `+ Save view` = one `add` (`View N`, `camera` via `poseToCamera`, `mode`, `open` = `player.isOpen`, `hide` = what the current view hides, `lighting` when the shown preset differs from the saved one). The menu's "Update to current view" sends the same fields as a patch (nulls clear). Keys: `presentAction(key, walking)` in `keys.ts` (tested); walking, WASD and the arrows walk, so `←` / `→` change views only while orbiting (PageUp / PageDown / Space always); Esc leaves walk first, then closes a popover or the views menu, then exits. Dev console: `__modeler.present.session.debug.tour` (`goToView`, `saveView`, `toggleWalk`, `mode`, `pose()`) and `.walk`.
  - HUD: Orbit | Walk segmented control (before the lighting), the views strip (`.pr-views`, above the bar: numbered chips, the current one lit, "+ Save view"; right-click → Rename… (an inline field: Enter or leaving saves, Esc cancels), Update to current view, Move left / right, Delete) and the caption (`.pr-caption`, top left: name, caption under it). `theme.ts` lets `.pr-views`, `.pr-caption` and `.pr-menu` (fixed, kept on screen) show while presenting.
  - Checked in the browser (room with a window and a door around the demo, a stool and a plant): three views saved (wide; close-up with the drawer open; in the doorway at eye height, walking, with the room door open); `→` / `PageUp` / `1`–`9` / chips fly smoothly (~1.3 s), the drawer opens halfway through the flight to view 2 and both close on the way back to view 1, view 3 lands walking with the drawer and door open; walking stops 9" off walls and the stool, an open door blocks, the open doorway lets you through to the floor's edge, sliding along a wall works; double-click on the floor walks there; `Esc` flies back to the orbit pose, a second `Esc` leaves with the editor's camera and open motions as they were. The rename / move / update / delete menu works. The test edits were removed afterwards.
- **`src/render/cutaway.ts`** (pure, phase 5 for the editor, phase 6 for presentation):
  - `cutaway(walls, ceilings, eye, mode, prev, margin = 6") → Set<id>`.
  - A wall is hidden when `dot(eye − point, outward) > margin`, and shows again below `−margin` (hysteresis). Hosted ids follow their wall.
  - The ceiling hides when the eye is above it or outside the footprint. Walk mode never cuts.
  - Presentation applies `shadowOnly` + `userData.cutaway`; layers won't work, because r186's shadow pass layer-tests against the main camera.
  - As built (phase 5, editor): `cutaway(walls, ceilings, eye, mode, prev, margin = CUT_MARGIN)` takes `roomShell` walls and ceilings as they are (model units); a wall's `ids[0]` is its key in `prev`. `main.ts` runs it in `viewport.onFrame` (not while presenting) on `roomShell(shown())`, and on a change calls `sceneSync.setCutaway(ids)`: those parts and folders get `visible = false` (re-applied after every `update`), and `pickable()` / `meshes()` skip any mesh with a hidden ancestor, so clicks, hover, box select and the block tool go through. Overlay highlights skip cut parts. `sameCut(a, b)` compares two cutaways.
  - As built (phase 6, presentation): the session runs `cutaway(shell.walls, shell.ceilings, eye × 64, 'orbit', prev)` every frame while the room shows (never in the studio). `render/present/cut.ts` `createCut(appearance.shadowOnly)` applies it: every mesh under each cut id (`sceneSync.objectOf(id)`, new: a part's mesh or a folder's group, so door folders go whole) gets the shadow-only material and `userData.cutaway`; it keeps each mesh's real material and puts it back when the wall returns. Repaints (a model change, hover) reset materials, so the session re-applies the cut after every draw and hover change (`set` is idempotent). Hover and click skip cut meshes (`cut.isCut`), so a click through a cut wall reaches what's behind it. `cut.lifted(fn)` restores the real materials for the probe capture. A change of the cut set only invalidates the pipeline (shadows don't change: cut walls still cast). The studio hides the room with `sceneSync.setCutaway(shellIds)` (`visible = false`, as the editor does). Checked on screen: orbiting outside takes away the near walls and the ceiling with no flicker (the 6" hysteresis); from inside the whole room shows; the room door opens on a click.

## B7. Lighting, phase 6 (fixtures in phase 7)

- **`src/render/present/lightPlan.ts`** (pure):
  - `kelvinToRGB`.
  - `fixtureIntensity(spec)`: lumens → candela (spot: `lm / (2π(1−cos(θ/2)))`; point: `lm / 4π`), ×1550 because decay-2 falloff runs in inches, × a calibration K tuned so a 650 lm downlight at 60" gives about ⅔ of the Day sun's illuminance.
  - `planLights(lights, budget)`: greedy nearest-pair merging per kind.
  - `autoSun(windows)`: the largest window's outward direction, azimuth rotated 25°, elevation 35°.
  - `fitOrtho(dir, box)`; `underCabinetStrips(doc)` (carcasses with min Y > 30", adjacent runs merged, at most 4); `PRESETS`.
- **`src/render/present/lighting.ts`:**
  - A fixed rig per session: sun, hemi fill, Sky, ground, studio floor, planned fixture lights, and `RectAreaLight` strips (`RectAreaLightUniformsLib.init()`).
  - Presets change **only intensities and colors**, never light counts or `castShadow`, which would force recompiles.
  - Spots use `SpotLight` with penumbra 0.6. Pendants and sconces use `PointLight` and never cast shadows.
  - The room probe is `pmrem.fromScene(scene, 0, 1, 3000, { size: 256, position: roomCenter })`, re-captured 500 ms after changes, with cutaway lifted during capture.
- **Sky:** `three/examples/jsm/objects/Sky.js` (GLSL; `SkyMesh` is WebGPU-only), following the camera with `frustumCulled = false` and `userData.noAO`, plus an unlit outdoor ground disc.
- **Presets** (to be tuned):

| | Studio | Day | Evening | Night |
|---|---|---|---|---|
| Exposure | 1.0 | 1.0 | 1.3 | 1.6 |
| Environment | RoomEnvironment ×0.8 | probe ×1.0 | probe ×0.6 | probe ×0.4 |
| Sun | key 2.5, elevation 50° | 3.0 #fff1de, elevation 35°, auto azimuth | 1.2 #ffad66, elevation 4° | 0 |
| Fixtures | off | off | on (2700–3000 K) | on |
| Bloom | 0 | 0.12 | 0.2 | 0.25 |

Studio hides the room shell.

**As built (phase 6)**
- **Presets** (`PRESETS` in `lightPlan.ts`, tuned on screen; presets change only intensities and colors — checked: switching all five compiles no new programs):

| | Studio | Day | Evening | Night |
|---|---|---|---|---|
| Exposure | 1.0 | 1.0 | 1.1 | 1.6 |
| Environment | RoomEnvironment ×0.65 | probe ×1.0 | probe ×0.6 | probe ×0.4 |
| Sun | key 1.6 white, 35° / 50° | 3.0 #fff1de, auto azimuth, 35° | 1.2 #ffad66, auto azimuth, 10° | 0 |
| Hemisphere fill | 0 | 1.2 (#eef2fa / #c8b49c) | 0.12 (#9fb2e0 / #7a5f4c) | 0.04 (#5a6c99 / #3a3532) |
| Fixtures / under-cabinet default | off / off | off / off | on / on | on / on |
| White balance (fixtures) | — | 6500 K | 3300 K | 3200 K |
| Sky (Sky.js) | none (backdrop) | turbidity 2.5, rayleigh 1.2, clouds 0.3, gain 0.5 | turbidity 8, rayleigh 2.5, clouds 0.25, gain 0.5 | sun at −12°, gain 0, tint #060b1c |
| Bloom | 0 | 0.08 | 0.12 | 0.25 |
| Outdoor ground → horizon | — | #8a8f7a → #c4cdd6 | #4d463e → #a08a7c | #14151a → #0c0f19 |

  B7's starting values were too dark inside (Day's interior read near black with only the probe and a 0.35 fill) and too orange in the evening. Now the hemisphere fill does most of a room's ambient work (it isn't occluded; AO adds the contact darkening), the sky's radiance is halved and clamped at 3 (linear) so the sun's disc and glow don't bloom over half the view, and fixtures are white-balanced (`balancedKelvin(k, wb)`: a 2700 K bulb under a 3300 K balance reads warm, not orange). Outdoors (a sky preset with no room) the fill drops to 0.3× (the sky probe already fills).
- **Resolving:** `resolvePreset(lighting, hasRoom)` (`auto` → day with a room, studio without; a hidden room counts as none); `presetExposure(id, ev)` = exposure × 2^ev (HUD slider ±1 EV, schema ±3); `underCabinetOn(id, lighting)` = saved, else the preset's default, never in the studio.
- **Sun:** `autoSun(windows, middle?)` turns ±25° whichever way throws the patch toward the room's middle (not into a side wall); Day uses a saved `sun` as is; Evening keeps the saved/auto azimuth with its own elevation. The key's shadow camera is fitted to the room's outer bounds with `fitOrtho(dir, box, { floorShadows: false })` (the floor is inside the box, so a low sun's depth range stays tight); without a room, to the model + 24" as before. Biases unchanged (bias −0.0002, normalBias 0.06"): no acne or corner leaks seen on walls, sills or floors (the room's slabs and full-length back/front walls seal the corners).
- **Fixtures:** `fixtureIntensity` = candela (spot `lm / 2π(1 − cos(θ/2))`, point `lm / 4π`) or luminance (area `lm / π·w·h`) × 1550 × `FIXTURE_K`, where `FIXTURE_K` is derived so a 650 lm 60° downlight 60" above gives ⅔ of the Day sun (tested). `planLights(lights, budget)` merges the nearest same-kind pair (lumens summed; lumen-weighted position, color and direction; the beam widened by the pair's spread seen from 4' below; `count` summed) until within budget, and drops the dimmest when no same-kind pair is left. Until phase 7, a room gets `autoFixtures(interior)`: a 2 × 2 grid of ceiling spots (800 lm, 2700 K, 70° beam) at ¼ and ¾ of the inside, 1" under the ceiling, planned against the tier's `fixtures` budget. Spots: `SpotLight`, penumbra 0.6, half-angle = beam/2 ÷ 0.7 (the cone's half-power edge near the beam), decay 2; the first casts on High only (1024², bias −0.0005, normalBias 0.05).
- **Under-cabinet:** `underCabinetStrips(doc)`: carcasses whose world bottom is above 30", grouped by front axis and sign, bottom (±1"), front plane (±1") and touching runs (±1"); a strip is the run less 1" each end, ¼" under the bottom, 3½" behind the front (doors and pulls included), 1" wide, 300 lm/ft, 3000 K; the 4 longest kept. Drawn as `RectAreaLight`s facing down (`RectAreaLightUniformsLib.init()` once, on the first strip).
- **The rig** (`createLighting`): key/sun, hemisphere fill, Sky (patched with `skyGain`, `skyTint` and the clamp; `frustumCulled = false`, `noAO`, follows the camera, half the far plane in size — it draws at the far plane anyway), an unlit outdoor ground (a ring mesh with vertex colors fading to the horizon color, 0.9 × far, following the camera in x/z, `noAO`, 0.05" under the room's slab), a `ShadowMaterial` catcher (opacity 0.45) under the model when a sky preset has no room floor, the studio floor and backdrop (unchanged; studio checked pixel-identical to the backdrop), the spot pool and the strip pool. Pools grow or shrink only when the plan does (room added, cabinets hung, tier budget): that alone recompiles.
- **Probe:** `captureProbe()` = `pmrem.fromScene(scene, 0, 1, 3000, { size: 256, position })` from the room's middle at min(54", half the height), else 24" over the model; taken with `scene.environment = null` (direct light only — no feedback between captures), a black background, the sun disc off (the sun light is already there) and the sky moved around the probe; ~16 ms. The session takes it before the first frame (behind the veil), then 500 ms after a preset, sun, fixture-plan or model change (lighting-only doc changes don't count as model changes), inside `cut.lifted`. The old target is disposed.
- **HUD:** a segmented control Auto / Day / Evening / Night / Studio ("Auto · Day" names what Auto shows) and a sun button opening a popover: Brightness (±1 EV, 0.1 steps; previewed while dragging, saved on release; double-click resets) and Under-cabinet lights (disabled in the studio or without wall cabinets; saved only when it differs from the preset's default). Each change is one `setPresentation` (one undo step). `L` cycles the five; `Esc` closes the popover before leaving. The glowing-finish level follows the preset (`appearance.setFixtureLevel`).
- **For phase 7:** feed `sceneLights(doc)` into `planLights` in `lighting.update` in place of `autoFixtures` (scale `at` and `size` by 1/64; `dir` as is; keep `autoFixtures` only when a room has no emitters); add a `point` pool beside the spot pool (`PointLight`, never casting) and route `area` lights from fixtures into the strip pool (or a second RectAreaLight pool). Glowing bulbs already follow `appearance.setFixtureLevel(lighting.fixtureLevel)`.
- `lighting.debug` (dev console) has the key, fill, sky, spots, strips and the probe position.

**As built (phase 7)**
- `lightPlan.ts`: `fixturesFrom(sceneLights(doc))` turns fixtures into `FixtureLight`s (positions and sizes ÷ 64, `dir` and `along` normalized); `FixtureLight.along` is kept through merges. `lighting.update` plans the doc's fixtures (else, in a room with none, `autoFixtures`) into the tier budget and splits the plan by kind: spots → the spot pool (the first casts on High, as before), points → a `PointLight` pool (never casting), areas → a second `RectAreaLight` pool (local x along `along`, shining along `dir`); under-cabinet strips keep their own pool. All fixture kinds follow the preset's fixture level (off in Day and Studio); pools resize only when the plan does. `lighting.debug` adds `points` and `areas`.
- Checked on screen (Night / Evening): the cans throw pools on the walls, the pendant lights the counter, its bulb and the cans' lenses glow; Day and Studio leave them off.
- Fix: `render/present/look.ts` `paint` chose one material or one per slot by the mesh's *current* material, so a cut-away mesh (wearing the single shadow-only material) repainted with one material and lost its see-through child's slot (a can's glowing lens in a cut ceiling, a window's glass in a cut wall). It now goes by how the mesh was built (groups or a child → one material per slot).
- Not done (optional): clicking a fixture to switch it on or off.

## B8. Photo, phase 9 (`src/render/present/photo.ts`, lazy chunk)

- **Dependencies:** pin `three-gpu-pathtracer@0.0.26` and `three-mesh-bvh@0.9.15` (both peer on three ≥ 0.185).
  - `WebGLPathTracer` is deprecated upstream in favor of `WebGPUPathTracer`, so keep it behind an adapter.
  - Exclude `three-mesh-bvh` from Vite `optimizeDeps` if its worker breaks.
- **Settings:** `renderToCanvas = false`, `rasterizeScene = false`, bounces 6, transmissive bounces 4, `filterGlossyFactor` 0.5, `multipleImportanceSampling = true`, tiles scaled to the resolution.
- **Prep, restored afterwards:**
  - Hide the Sky; set a `GradientEquirectTexture` environment and background.
  - Studio gets two `RectAreaLight` softboxes.
  - Glass switches to `transmission 1`, `transparent false` and `material.castShadow = false`.
  - Cutaway walls get `visible = false`.
- **Display:** `OutputPass` of `pathTracer.target.texture`, cross-faded over the raster still. The panel shows samples against the target (Draft 64 / Good 256 / Best 1024), ETA and Save PNG.
- **Cancel and fallback:** any input cancels. Handle `webglcontextlost`. The fallback is the raster `still()`.

**As built (phase 9):**
- **Files:**
  - `photo.ts`: the adapter, in a lazy chunk.
  - `photoScene.ts`: the stand-in scene.
  - `photoPlan.ts`: pure sizes, tiles, pacing, ETA, environments, softboxes, floor and matching.
  - `ui/present/photoPanel.ts`: the panel.
  - The session wiring: Photo in the HUD, the `debug.photo` handle, Esc and any click or wheel cancel, a context-loss handler, and the raster image saved if the path tracer fails.
- **Stand-in scene, not prep and restore:** the photo renders a separate scene built from the presentation scene as drawn (the live scene is never touched).
  - Each geometry group becomes its own mesh, because the path tracer gives a mesh one material.
  - Glass becomes a transmissive stand-in; glowing surfaces that cast no shadow in the raster keep not casting.
  - Hidden and cut-away meshes, the Sky, the outdoor ground, the shadow catcher and the studio floor's shader are left out. A gradient environment, the studio softboxes and an alpha-faded floor disc take their places.
- **Bounces 8 + transmissive 4 (not 6 + 4).** three-gpu-pathtracer 0.0.26 sizes its stratified random table as `bounces + transmissiveBounces + 5` but reads indices up to 16 (`rand(15)` picks the lobe). With a smaller table those draws stop varying, and every pixel settles on its own fixed answer: a salt-and-pepper pattern that more samples never clear. `PHOTO_BOUNCES` / `PATH_TRACER_MAX_RAND` and a test guard it.
- **Matched to the live view:** a room lit only through its windows path-traces darker and bluer than the tuned raster look (measured: mean RGB 99/106/119 vs 152/139/123 for Day).
  - The photo is tone-mapped by its own Neutral pass with per-channel gains.
  - At samples 1, 4, 16 and 64 (`MATCH_AT`), the shown photo's mean color (a 16 × 9 averaged readback) is compared with the settled raster image's, and `matchGain` moves the gains: fully in brightness, 80% in color, clamped to 0.25×–6×.
  - After matching: 154/141/126 vs 151/138/122.
- **Measured** (RTX 3090 Ti, 2560 × 1440, 15 tiles): about 13 samples/s; Draft (64) in about 5 s, Good (256) in about 19 s, after a one-time shader compile.
- **Dev:** the BVH worker works under Vite pre-bundling; no `optimizeDeps` change was needed.

## B9. Tests (render layer, Vitest in Node, no WebGL)

- `uv.test`: grain on faces and edges, a 45° side not stretched, deterministic offsets, span = size in inches.
- `finishDefs.test`: every model preset has an entry, and every texture set exists in the manifest.
- `textureSets.test`: files exist on disk.
- `appearance.test`: uses a fake texture provider.
- `sceneSync.test`: the editor look is locked; the present look has UVs, `castShadow` and a glass child mesh that doesn't cast.
- `lightPlan.test`, `cutaway.test`, `flight.test`, `occupancy.test`.

---

# Textures (final list, approved by the user for download)

All CC0, 1K JPG: about 28 MB downloaded, about 20 MB kept. The user approved downloading exactly these files.

**Poly Haven.** URL pattern: `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/<id>/<id>_{diff,nor_gl,rough}_1k.jpg`

| Set id (ours) | Poly Haven id | Maps | Used by presets |
|---|---|---|---|
| `wood-oak` | `oak_veneer_01` | diff, nor_gl, rough | `wood:white-oak`, plus `wood:red-oak` via a warm default tint |
| `wood-walnut` | `walnut_veneer` | diff, nor_gl, rough | `wood:walnut` |
| `wood-cherry` | `cherry_veneer` | diff, nor_gl, rough | `wood:cherry` |
| `wood-maple` | `romantic_veneer` | diff, nor_gl, rough | `wood:maple`, `wood:birch-ply` |
| `floor-oak-plank` | `oak_wood_planks` | diff, nor_gl, rough | `floor:oak-plank` |
| `floor-herringbone` | `herringbone_parquet` | diff, nor_gl, rough | `floor:herringbone` |
| `floor-concrete` | `brushed_concrete` | diff, nor_gl, rough | `floor:concrete` |
| `fabric-weave` | `rough_linen` | nor_gl, rough only (color comes from the finish) | `fabric:*` |

**ambientCG.** URL pattern: `https://ambientcg.com/get?file=<Id>_1K-JPG.zip`. Keep only `<Id>_1K-JPG_Color.jpg`, `_NormalGL.jpg` and `_Roughness.jpg`.

| Set id (ours) | ambientCG id | Used by presets |
|---|---|---|
| `stone-quartz` | `Marble021` (bright white, subtle) | `stone:quartz-white` |
| `stone-marble` | `Marble012` (white, gray veins) | `stone:marble-white` |
| `stone-marble-dark` | `Marble006` (black) | `stone:marble-dark` |

**Status.** Downloaded by `scripts/fetch-textures.mjs` into `public/textures/<set>/`, with credits in `public/textures/LICENSES.md`.

**Manifest starting values (phase 4).** Grain is read from the previews, so verify it on screen.

| Set | Real-world tile size | Image grain |
|---|---|---|
| `wood-oak` | 1830 mm (72″) | `v` (vertical streaks) |
| `wood-walnut` | 1800 mm (71″) | `v` |
| `wood-cherry` | 1000 mm (39″) | check |
| `wood-maple` | 1000 mm (39″) | `u` (horizontal) — check |
| `floor-oak-plank` | 1200 mm (47″) | check plank direction |
| `floor-herringbone` | 3400 mm (134″) | n/a |
| `floor-concrete` | 2500 mm (98″) | n/a |
| `fabric-weave` | 271 mm (10.7″) | n/a |
| `stone-*` (ambientCG publishes no size) | start at 48″ and tune by eye | n/a |

As built (checked on screen): `wood-oak` `v`, `wood-walnut` `v`, `wood-cherry` `u`, `wood-maple` `u`, `floor-oak-plank` `u` (planks run across the image); `stone-quartz` 48″, `stone-marble` and `stone-marble-dark` 60″. Averages and roughness means were measured from the images (`textureSets.ts`).

**Procedural, no files:**
- Generated at runtime on a canvas: `tile:subway` (3×6 running bond, grout, bevel normal) and `tile:floor` (large-format grid).
- `paint`/`lacquer` use a subtle generated micro-normal.
- Metals, glass, melamine, laminate, `stone:granite-black`, ceramic, plant and light are untextured.

# Risks

- **Path tracer:** WebGL is deprecated upstream; shader compiles take 10–60 s on ANGLE; GPU timeouts. Mitigated with tiling and a context-loss handler.
- **Integrated-GPU performance:** tiers, on-demand rendering, half-res AO, merged lights, DPR caps.
- **Carcass v2 regenerates old files:** guarded by the v7 golden; part ids are unchanged.
- **Tool-schema and prompt growth:** string presets, internal shapes hidden from the AI, a budget test.
- **Box-based clearance treats a wall as solid across its openings:** a door leaf closed inside its own wall counts as already overlapping, so it's ignored.
- **Shadow acne and light leaks:** sealed wall corners, tuned biases (`normalBias ≈ 0.3"`).
