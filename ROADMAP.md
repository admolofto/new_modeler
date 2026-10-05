# Roadmap — AI-first cabinetry & furniture modeler

Browser 3D modeler where you describe a piece, the AI builds it, and you refine by
talking, marking up the model, or grabbing faces/edges/vertices directly. Personal shop tool first.

## Guiding decisions

| Decision | Choice | Why |
|---|---|---|
| Rendering | Three.js | Proven, flexible, no lock-in |
| Model / parts / AI layer | Built from scratch | Full control over the data model |
| Geometry | Own **2.5D builders** (outline + thickness + features) + special-case shapes | Covers most furniture; fast; we own face identity for picking |
| CAD kernel | None — can be added later as one more builder behind the same interface | Only needed for truly sculpted parts or STEP/CNC export |
| Source of truth | Part data (JSON), geometry derived | AI and UI edit data, never meshes |
| Joints | Metadata now; can emit cut features later | Real dados without a redesign |
| Units | **Integer 1/64" internally** | No float drift; exact fractions everywhere |
| Stack | Vite + TypeScript + Three.js, Zod schemas, Vitest | Fast iteration, typed + validated model |

## Foundation rules

Decisions that are cheap now and force a rewrite if wrong. Every change must respect these.

1. **Data is the source of truth.** Geometry is always derived; nothing edits meshes directly.
2. **One mutation path.** All changes (UI, AI, markup, direct drag) go through `applyOps()` → undo, diffs, AI output format.
3. **Stable IDs** for parts, assemblies, features, and semantic faces/edges/vertices.
4. **Full transforms in the data.** Rotation stored as 3-axis angles, any angle (the v1 90°-step limit was lifted for blockout, 2026-09-25 — a rule change, no migration). Joints still only find parts that meet squarely.
5. **Nested assemblies** with transforms relative to parent (drawer moves as a unit; cabinets nest in a run).
6. **Versioned schema + migrations** from the first save. Old files upgrade, never break.
7. **Shape + features registry.** A part is a *shape* (stock) plus an ordered list of *features* (operations). New capabilities are plugins, not core changes.
8. **Semantic references only.** Faces/edges are referenced as `face:top`, `edge:top-front`, `f2:wall` — never triangle indices.
9. **Generators keep their params; user edits are overrides.** Regenerating ("make it 30 wide") preserves manual tweaks.
10. **Joints can emit features** onto the parts they join (dado joint → dado cut on both).
11. **Strict layering.** `model/` and `geometry/` are pure data (no Three.js, testable, worker-ready); `render/`, `ai/`, `ui/` sit on top.
12. **Plugins declare handles.** Every grabbable face/edge/vertex and what dragging/clicking it does. Direct editing, markup, and AI references all use the same handles.

### Plugin contract

Shapes and features share one pattern:

```ts
interface FeatureDef<P> {
  type: string
  version: number
  schema: ZodSchema<P>             // validates AI/UI input
  describe: string                 // AI-facing docs; tool schemas are generated from the registry
  appliesTo(shape): boolean        // refuse unsupported combos with a clear error
  channel?(params)                 // stage 0: dados / rabbets the shape builds in (box parts)
  profile?(prism, params)          // stage 1: reshape the 2.5D prism (edge profiles)
  cut?(geom, params)               // stage 2: cut faceted geometry (holes, pockets); tags its triangles
  handles(params, geom): Handle[]  // grabbable faces/edges/vertices + what they drive
  migrate?(old): P                 // keep old saves loading
  cutList?(part, params): Adjust   // e.g. dado adds depth to the mating part
}
```

Pipeline: `Part data → shape (prism) → profile features → facets → cut features → tagged mesh → Three.js` (with channels: `shape + channels → facets → cut features → …`)

### Data model sketch

```ts
Part = {
  id, name, material, grain,
  transform: { position, rotation },     // integer 1/64" positions; 3-axis rotation
  shape:    { type: "box", params: { x, y, z } },   // size along local axes; grain says which is length
  features: [
    { id: "f1", type: "edgeProfile", params: { edges: ["edge:top-front"], profile: "roundover", r: 16 } },
    { id: "f2", type: "hole",        params: { face: "face:left", at: [64, 128], d: 20, depth: 24 } },
  ],
}
```

---

## Phase 0 — Setup

- Vite + TS project, lint, Vitest
- Folder layout: `model/`, `geometry/` (both pure data, no Three), `render/`, `ai/`, `ui/`
- **Exit:** blank page with a Three.js canvas, tests run

## Phase 1A — Foundation

**Goal:** a parametric carcass renders from data, on an architecture that won't need a rewrite.

- **Data model** (`model/`, zero Three.js imports)
  - `Part`: id, name, shape, features, transform, material id, grain direction
  - `Assembly`: id, name, children, local transform, generator + params + overrides
  - `Joint`: id, type (dado, rabbet, butt, dowel, pocket screw…), parts it joins, params
  - `Material`: name, *actual* thickness (3/4" ply = 23/32"), color
  - Schema version + migration runner
- **Registry + pipeline:** plugin contract, shape/feature registration, tagged-mesh output
- **Box shape** + one proof feature (**through hole**) end to end
- **Generators:** `carcass({ width, height, depth, material, back, toeKick })` → parts + joints, with overrides preserved on regenerate
- **Ops layer:** `add`, `update`, `delete`, `move`, `addFeature`, `removeFeature` → `applyOps()` with undo/redo
- **Viewport:** orbit camera, grid, lighting, one mesh per part
- **Pick-ready meshes:** `userData.partId`; triangles tagged with semantic face/feature ids; handles exposed
- **Persistence:** save/load JSON (file + localStorage), golden-file tests for migrations
- **Exit:** edit carcass params in a debug panel → model updates live; undo works; reload restores it; a hole on a panel renders and survives save/load
- **Status: done.** Notes:
  - Box params are `{ x, y, z }` (size per local axis), not `{ l, w, t }` — axis-aligned panels need no rotation and face names match world directions; cut list derives l/w/t from `grain` + material thickness
  - Carcass sides are plain boxes, so the toe-kick notch waits for the outline shape (1B)
  - Undo stores whole-doc snapshots (docs are immutable), not inverse ops
  - Generator overrides are recomputed as a per-field diff against the generator's output whenever a generated part is edited

## Phase 1B — Shapes & features

**Goal:** rounded edges, holes, and shaped parts — the things a router and drill press make.

- **Outline shape (2.5D):** 2D outline with arcs + thickness → rounded corners, curved aprons, shaped parts
- **Holes & pockets:** through and blind holes, rectangular pockets/cutouts on faces (shelf pins, 35mm hinge cups, grommets)
- **Edge profiles:** roundover, chamfer (then cove, ogee…) on selected edges, mitered at corners like a router
- **Geometry tests per plugin:** watertight, correct bounds, correct tags
- **Exit:** a tabletop with rounded corners and roundover edges, and a cabinet side with shelf-pin holes and hinge-cup bores, all rendered correctly
- **Status: done.** Notes:
  - Box and outline both build a **prism** (outline + thickness + corner treatments + per-edge cap profiles); a box's prism runs through its thinnest axis, so "around the edge of a panel" = its cap perimeter
  - Features run in two stages: all `profile` features, then faceting, then all `cut` features (each in list order)
  - Profiles sweep like a bearing-guided router bit: miter at sharp corners, follow rounded ones; a corner radius smaller than the profile collapses to a miter; inside corners miter too (a real bearing leaves a small radius)
  - A rounded corner needs the same profile on both edges meeting there; mixed profiles at a rounded corner are refused
  - Outline params: `axis` (thickness direction), `thickness`, `points: [{ id, at, r?, sag? }]`; point ids auto-fill (`v1`…) so face/edge names stay stable
  - Cuts (`hole` with optional `depth`, `pocket` with size/corner r/optional depth) go into any flat face, incl. an earlier cut's `fN:floor`; they refuse to break out of the face, leave no floor, or collide with other cuts (parallel: exact footprint; skew: bounding box)
  - The doc validator now builds every part, so a doc that validates always renders
  - Demo: hinge-cup bores went on a door beside the cabinet (where they belong) instead of the cabinet side; shelf-pin rows are on both sides

## Phase 2 — AI layer (text → model)

**Goal:** "36" wide base cabinet, two drawers, 3/4 ply" produces a correct model.

- Small local proxy so the API key never touches the browser
- AI output = **ops against the model**, via tool use / structured output, validated with Zod
- Tool schemas generated from the registry — new plugins teach the AI automatically
- Prefer generators + params ("carcass 36×34.5×24") over raw coordinates; fall back to raw parts
- Context sent each turn: current model JSON, materials, units convention, woodworking rules
- Preview diff → accept / reject → lands in undo history
- Chat panel with history
- Eval set: ~20 prompts with expected results, rerun on prompt changes
- **Exit:** create *and* iteratively modify pieces by chat; bad AI output is rejected cleanly, never corrupts the model
- **Status: built; live eval not yet run** (needs a logged-in `claude` CLI, then `npm run eval`). Notes:
  - Two engines behind the chat panel: **Claude Code** (default; `claude -p` on your Claude Code login, no API key) and **API** (`ANTHROPIC_API_KEY`). Both share one proposal controller (`src/ui/proposals.ts`)
  - The modeler is an **MCP server** at `/mcp` on the dev server; tool calls are forwarded to the open tab over Vite's HMR websocket (`server/bridge.ts`), so they run against the live model and land in the pending proposal. The Claude Code engine uses it; any Claude Code session can too (`claude mcp add --transport http modeler http://localhost:5173/mcp`)
  - Headless Claude Code runs with built-in tools off (`--tools ""`), only the modeler's MCP tools allowed, our system prompt, in a temp dir; it never gets `ANTHROPIC_API_KEY` so it always uses the subscription
  - Dev server uses `--configLoader runner` (the config now imports `src/`); unit tests have their own `vitest.config.ts`
  - API proxy = Vite dev-server middleware (`server/aiProxy.ts`); model/effort fixed server-side (`AI_MODEL`, default `claude-opus-5`; `AI_EFFORT`, default `high`); server-side refusal fallback on
  - API agent loop runs in the browser (`src/ai/agent.ts`, pure, transport injected) so tools execute against the real model code; evals reuse it in Node
  - Two tools: `apply_ops` (op schema built from the registry via `makeOpSchema` + `z.toJSONSchema`) and `inspect_part` (face frames, edge ids). Lengths may be written as inch strings (`"34 1/2in"`)
  - Tools run on a draft; tool results report created ids, world bounds and interpenetrating parts, so the AI can self-correct. Rejected batches return the `applyOps` error to the model
  - Each turn sends a fresh model snapshot with world bounds (skipped when unchanged); history is append-only; system + tools cached
  - Preview: draft rendered with changed parts tinted + diff card. Sending another message while a proposal is pending refines the same proposal; accept = one `dispatch` = one undo step; store edits during preview re-apply the ops or mark the preview stale
  - Carcass gained `drawers` (front heights top-down, 0 = share the rest) with five-piece boxes; pieces without a generator (mantels, tables, benches) are built from raw parts
  - Eval set: 21 cases in `evals/cases.ts`, outcome-based checks (sizes, counts, placement, no overlaps); runs on either engine (`AI_ENGINE`); results in `evals/results/`

## Phase 3 — Markup & direct editing (the differentiator)

**Goal:** point at the model and either fix it yourself or tell the AI what's wrong.

- Raycast picking → part id + semantic face/edge/vertex handle
- Hover highlight, click select, multi-select; one click picks the corner, edge or face under the cursor, double-click the part, triple-click the piece
- **Direct editing via handles** — every drag/click becomes an op:
  - Face: push/pull a dimension (drives generator params on generated parts); drill / pocket / dado
  - Edge: apply roundover / chamfer / profile; drag outline segments on shaped parts
  - Vertex: drag outline points on shaped parts; corner radius / clip on boxes
- Annotations: `{ targets: [handle ids], note }`, shown as pins in the viewport
- Relational notes: "this leg goes over that one" = note referencing two targets
- Send to AI: annotations + model JSON + optional viewport screenshot
- Annotations resolved/cleared once AI applies a fix
- **Exit:** push/pull a cabinet side and the carcass resizes correctly; select two parts, write a note, AI produces the right change on first or second try for most common fixes
- **Status: built.** Notes:
  - Pure `edit/` layer: a **target** `{ node, handle?, at? }` is the one shape selection, notes and the AI share; `drives.ts` turns handle drives into ops; `actions.ts` lists what the selection allows (drill, pocket, roundover / chamfer, round / clip a corner, remove feature, delete)
  - Drags project the pointer onto the handle's constraint (a face's normal; an outline point's or hole center's plane), snap to 1/16" (Alt: 1/64"), preview live via `applyOps` on the drag-start doc, and commit on release as one undo step. An invalid spot shows the error; release keeps the last valid one. Drag a handle only after selecting it, so orbiting from anywhere still works
  - Generators claim faces with `faceDrive` (rule 12): the carcass's outer faces drive width / height / depth (min-side faces also move the assembly), the toe kick's top / front drive the kick. Unclaimed faces fall back to part overrides
  - Outline sides and cap edges drag both end points; a point dragged below 0 re-bases the outline (`ShapeDef.normalize`) so the origin stays the min corner
  - Box corners round / clip via an edge profile on the edge through the thickness; outline corners via the point's `r` or a chamfer
  - **Schema v2:** `annotations` (first real migration; v1 golden still loads, v2 golden added). Notes are ops (undoable, saved with the file); stale targets are allowed
  - Open notes ride in the AI snapshot with each target's world point (both engines and MCP); the AI resolves them with `update {resolved: true}` in the same proposal, so accept = fixed + resolved. Screenshots: API image blocks; Claude Code via `--input-format stream-json`. Pins are sprites, so they show in screenshots, numbered like the notes list
  - Direct edits are blocked while an AI proposal is pending (notes still work)
  - **Dado deferred to Phase 4** with joint-emitted cuts: a dado runs off the face's edges, which pockets refuse
  - Eval: 6 markup cases (`npm run eval -- -t note`), **6/6 first try** on Claude Code (2026-09-24, ~10–40 s each). The 21 Phase 2 cases still haven't been run live
  - **Variables (schema v3):** named values in groups (`doc.variables`: "Doors" › Door gap…) that the AI creates for what it builds; parts / assemblies bind fields to formulas over them (`bind: { 'shape.x': '(cabW - 2*reveal - gap) / 2' }`, `bind` op). Values stay concrete in the doc; `syncBindings` re-evaluates at the end of every `applyOps`, so a variable edit is one undo step. A field bound to a bare variable writes through when edited directly (push the carcass side → `cabW` → doors follow); other bound fields refuse direct edits until unlinked. Left panel shows one collapsible section per group; formulas are parsed by hand (`model/expr.ts`), no `eval`
  - Eval: `npm run eval -- -t variables` (cabinet → "add two full-overlay doors" → door variables exist, doors follow a cabinet resize), **1/1 first try** on Claude Code (2026-09-24, 35 s)
  - **Voice notes:** press M (or the floating Talk button), talk while pointing, press M again. Speech comes from the browser's Web Speech API (Chrome / Edge); word times are estimated from when each word arrives (`voice/timing.ts`) and every hover change is logged with the point under the cursor (`voice/hoverLog.ts`, via `onHover` in interaction). `voice/align.ts` (pure, constants in `ALIGN`) splits notes where the speech breaks (pauses, phrase ends, "and…") and lets each word vote for what was hovered just before it: leaving early still counts, passing over a part doesn't, nothing hovered casts no vote, a late arrival wins over the last note's part, "this … that" makes a two-target note, and a quick follow-up with nothing hovered carries the last target. Draft pins (dashed, fainter when unsure) update live; on stop, `POST /api/ai/tidy-notes` has Claude clean up and re-attach the notes (chat's engine, low effort; `src/ai/tidy.ts`), then they're added in one dispatch (one undo step) and wait on the chat's message box. Tidy failure, timeout or Skip adds the drafts as heard. `__modeler.voice.simulate(steps)` plays a scripted session without a mic; `.session.last()` dumps a real one for tuning

## Phase 4 — Woodworking polish

**Goal:** output you can take to the shop.

- Fractional inch display & input (`23 5/8"`), metric toggle
- Dimension lines in the viewport
- **Cut list** that accounts for joinery (a 1/4" dado adds 1/4" to the mating part), grouped by material/thickness
- Material library + board-foot / sheet counts
- Joinery shown visually; joints emit real cut features where useful
- Snapping / inference (align to edge, match length)
- Printable/exportable cut list (CSV, print view)
- **Exit:** build a real cabinet from the tool's cut list with no hand recalculation
- **Status: built; not yet checked against a real build.** Notes:
  - **Units:** storage stays integer 1/64"; display is a per-browser preference (toolbar `in`/`mm`, U). Every length field takes `23 1/2`, `23-1/2"`, `2' 6"`, `18mm`, `1.8cm`; a bare number is in the current units, anything with a fraction is inches (`model/units.ts` `parseLength`, `ui/units.ts`). Metric shows one decimal (1/64" ≈ 0.4 mm). AI replies stay in inches
  - **Joints cut real channels (schema v4):** a `dado` feature (box parts) cuts a square-bottomed channel whose footprint may run off the face's edges — dado, groove or rabbet. Built exactly on the grid of all box / channel planes (`geometry/orthogonal.ts`): cells solid or removed, faces merged per plane + tag, every grid vertex kept so it stays watertight; refuses channels that split the part or go too deep. Channels and edge profiles don't mix on one part yet (refused with a clear error)
  - Dado / rabbet joints (`[housing, inserted]`) find where the inserted part touches the housing face to face and cut the channel there: `part.joinery`, kept apart from `features`, re-derived at the end of every `applyOps` and on load (`model/joinery.ts`), never in generator overrides, not editable directly (ops say "change the joint"). Parts stay modeled at their visible size; `depth` defaults to ⅓ of the housing (1/4" in 3/4" stock) for a dado, ½ for a rabbet. Touching nothing or overlapping = no cut, listed as a cut-list problem
  - Carcass: dados become real (bottom dado stopped at the back rabbet, top becomes a rabbet at the top edge); the inset back's rabbet is now 3/8" deep (was the back's thickness). v3 files regenerate their carcasses on load so old joints match
  - **Cut list** (`model/cutlist.ts`, pure): each part at cut size — thickness axis from the material, length along the grain — plus every dado / rabbet it sits in (bottom +1/4" each end, back +3/8" each side); machining per part in shop words ("dado 23/32" wide × 1/4" deep, 4" from bottom, stopped 7/32" from back — right face (for Bottom)", hole groups, pockets, profiles); identical parts grouped; per material sheets (laid out by `model/nesting.ts`, see below) or board feet at nominal thickness (+20% waste) and cost if priced. Warnings: thickness ≠ material, no grain on solid stock, part bigger than a sheet, joints that don't meet
  - **Shop window** (toolbar "Cut list", L): cut list (click a row to select those parts), joinery table, CSV (lengths as plain numbers in the current units), print view (print-only stylesheet). Materials tab: edit thickness / stock / sheet size / nominal / price / color, add from a library of common materials at actual thickness (`model/materialLibrary.ts`); material fields `sheet`, `nominal`, `price` are optional
  - **Sheet layouts** (2026-10-03): `model/nesting.ts` (pure) places every sheet part — guillotine cuts only (rip, crosscut, rip what's left: table saw / track saw friendly), 1/8" kerf, grain along the sheet's length, grainless parts may turn. Runs 4 part orders × 3 fit rules × 6 cut orders and keeps the fewest sheets, then the biggest leftover pieces (200 parts ≈ 40 ms). The sheet count and cost come from this layout. Under each sheet material's table the cut list draws every sheet to scale (`ui/sheetDiagram.ts`, SVG): grain left to right, parts in the material's color with name and length × width, else the row's number (rows got numbers), hatched offcut. Click a part to select it, hover lights it in the view; hovering a row lights its parts; the selection shows amber. Print view draws them full width
  - Selecting two touching parts offers "Dado / Rabbet *A* into *B*" (housing = the one whose face the other only partly covers) and "Remove joint"
  - **Dimension lines** (toolbar "Dims", D): overall width / height / depth of the selection, else of the whole model; sprite labels (show in AI screenshots), in the display units
  - **Inference while dragging** (`edit/snap.ts`): a pushed face snaps flush with other parts' faces or to another part's size along that axis ("width = Door width"), within ~9 px; outline points line up with the part's other corners. The snapped part is highlighted and the drag label says why. Alt = 1/64" steps, no inference
  - AI: prompt teaches joints (touching parts + a joint, never lengthened parts) and the material library; new `cut_list` tool (both engines + MCP); snapshot shows `jointCuts`; proposal diffs list joints and the cuts they make
  - Eval: `npm run eval -- -t joinery` (dadoed bookcase; checks joints, no cut-list problems, shelf allowances). Not run live yet

## UI polish

- **Status: built (2026-09-24).** Notes:
  - Docked layout: top bar (New / Open / Save, undo / redo, Blocks, Dims, in | mm, Cut list, `?` shortcut list, side-panel toggles) · left = Model list (hover finds a part, click selects, an assembly row selects all its parts) and Variables over the selection's settings · right = AI chat. The 3D view gets one floating control, the voice Talk pill (bottom center, red with a timer while recording, status chip above), plus transient overlays: toast (above the pill), drag label, cut-list sheet, start screen
  - **Notes in chat** (2026-09-25): new notes (typed in the left panel or spoken) wait on top of the chat's message box, editable, ✕ deletes; Send / Enter sends them with any typed text (`Please address my notes n1, n2.`), a picture of the view turns on by default. Sent notes stay in your message and tick off when the AI resolves them (✓ resolve, ↺ back to the message box, delete). Which notes were sent is per conversation (`ui/notes.ts`); New conversation puts open ones back. Clicking a pin opens the AI panel and scrolls to its note. The Notes tab is gone
  - Debug panel retired: carcass params → a "Cabinet" section for whichever cabinet the selection belongs to; features → a "Machining" list in the cut list's words (`partMachining` in `model/cutlist.ts`, identical holes grouped, removable); part dropdown → the Model list. Dropped "Add tabletop" and the numeric add-feature form (Face / Edge actions and the AI cover them)
  - New starts an empty model (undoable) with a start screen: Add a base cabinet / Load the example
  - One design system (`ui/theme.ts`); color only means something, in the panels and the viewport (`render/palette.ts`): amber = selected, violet = AI proposal (the 3D tint too), red = notes. One feedback channel (`ui/toast.ts`)
  - Read-only lengths go through `shop()` (`ui/units.ts`): only the fraction gets the font's `frac` feature (Segoe UI shrinks every figure it touches), inch marks become primes. Dimension labels draw the same stacked fraction on their canvas

## Blockout — sketch placeholders, tell the AI what they are

**Goal:** rough a layout out in seconds, SketchUp-style, then point and talk: "this is the sink base, these are drawer bases, that's the fridge" — and the AI builds each one in its space.

- **Status: built (2026-09-25).** Notes:
  - **Blocks are parts** with `block: true` (schema v5): box-shaped, no material, features or joints, never in the cut list. So picking, face handles, push/pull drives, snapping, notes, voice hover and the AI snapshot all work unchanged. `add {entity: {kind: "block", size}}`; default ids `bN`, names "Block N"; a block's `update` takes only name and size. A block's frame is the frame of what it stands for: local +Z is its front
  - **Any-angle rotation** (rule 4): validation no longer limits rotations. `model/world.ts` gained `eulerXYZ` (picks the least-tilted solution, so a half turn reads [0, 180, 0]), `rotateAbout` (parent-aware turn about a world pivot), `frameBoxes` (parts square to a frame, boxed in its coordinates) and an exact OBB test in `overlaps` for parts at odd angles. Snapping runs in the dragged part's own frame, so angled runs snap to each other; dimension lines measure a turned selection along its own axes
  - **Block tool (B):** click a corner, the opposite corner, then the height — on the floor or any flat face (the block comes out of that face in its part's frame). Left-drag still orbits mid-draw. Corners snap in line with other parts' faces (both ways = their corner) or to matching sizes, heights flush with tops or matching heights, else a 1/2" grid; Alt = 1/64", no snapping. Type sizes any time (`24, 18` ⏎, then `34 1/2` ⏎). The front faces the camera on the floor, out of the face on a wall, like the host on a top. One block = one undo step; the tool stays on
  - **Look:** clay gray, lighter front face, an arrow on top pointing to the front, and the name floating above (sprites, so they show in AI screenshots). Inspector: "What is it?" (the name), size, position, rotation (about its center), ↺ / ↻ 90°, Split, Duplicate
  - **Gizmo** (`render/gizmo.ts`, `ui/gizmoControl.ts`): arrows move along the selection's own axes, the square slides on its floor plane, rings turn it (15° steps; Alt 1°); snapping against / in line with / centered on other parts or onto the floor, 1/2" for blocks, 1/16" otherwise. It moves whole pieces (`edit/gizmo.ts`): a generated part moves its cabinet, all of an assembly's parts move the assembly; double-click selects the whole piece. R / Shift+R = quarter turn. A selected block's faces push / pull in Part mode
  - **Row tools:** Ctrl-drag the gizmo moves a copy; Ctrl+D drops a copy flush to its right (`edit/duplicate.ts`: generated assemblies replay their overrides, bindings are dropped, user joints inside the copy come along). Split (S, `ui/splitTool.ts`): a cut follows the cursor across the block (Tab: other axis), snapping to the seams of blocks above / below, the middle and 3" steps from either end; it keeps cutting what's left. "Split into N" in the inspector
  - **AI:** snapshot shows `block: true` and which way its front faces; the prompt says to build the real piece in exactly the block's space (same parent / position / rotation, x / y / z = width / height / depth), delete the block in the same batch and resolve the note, and to keep appliances / walls as renamed blocks. Voice notes work as before — hover a block and talk
  - Eval: `npm run eval -- -t blocks` (a row of blocks → two cabinets + the fridge kept; a turned block → a cabinet facing the same way), **2/2 first try** on Claude Code (2026-09-25, 16–43 s)

## Animations — doors swing, drawers slide

**Goal:** doors, drawers, lids and flaps open in the view; the AI applies a preset instead of inventing motion each time; you can see what an opening door hits.

- **Status: built (2026-10-05); live eval not yet run.** Notes:
  - **Motions (schema v6):** `doc.motions`, a fourth registry kind (`plugins/motions/`: `hinge`, `slide`). A motion moves `nodes` together — siblings (carcass drawers are six flat generated parts), the first one's frame being the motion's — and `pose(params, basis, t)` works out the move from where the parts sit (`model/motion.ts`: basis memoized per doc, `motionDelta` in the parent frame), so params stay semantic (`side`, `toward`, `angle`, `distance`) and resizing keeps it right. Hinge line = the outer edge on the hinge side at the face that swings out; parts under 5% of the face (pulls, hinge leaves) don't count. Slide distance defaults to 90% of the depth. A node has one motion; a motion inside an animated folder rides on it
  - Ops: `add {kind: "motion"}`, strict `update` (params merge, null resets, a new type starts afresh), `delete`; deleted nodes drop out after every batch. Validation: siblings, a part in it, one per node. Files and saved recipes share one upgrade path (`persistence.ts` `upgradeDoc`): v5 and older regenerate their generators, so old drawers gain their slides and the recipe library keeps loading
  - **Generated motions:** generators emit `motions` (by part roles) like joints; read-only, rebuilt on regenerate, skipped when one of their parts was deleted (a sink base's false front stays put). Carcass drawers slide full extension; new carcass `doors` (0 / 1 / 2, `doorHinge`, `doorAngle`): full-overlay slabs below the drawers with 35 mm hinge-cup bores (2 to 40", 3 to 60", then 4), hinged on their outer sides; door fronts drive depth
  - **Open is a view** (`ui/motionPlayer.ts`): eased, a beat apart, instant under reduced motion; keyed by motion id so undo, AI previews and accept / reject keep it; never saved or seen in the snapshot (the screenshot turn says what's shown open). `sceneSync` poses moved nodes on top of their transforms each frame without rebuilding. While anything is open the gizmo hides and handle drags wait; Block / Split close everything. Dims, pins and block labels stay on the closed model
  - **UI:** inspector **Animation** section (preset picker; kind, hinge side, swings out, angle or direction, distance, time; ▶ / slider; read-only summary for generated ones; "Opens with …" from inside an animated folder), Cabinet **Doors / Hinge side / Door swing**, toolbar **Open**, **O**
  - **Opening check** (`model/clearance.ts`): sweeps each motion (5° / 1" steps, refined by bisection) against everything that stays put, then everything open at once; pairs touching when closed don't count. Shown in the Animation section and as a yellow tint while open past the hit; in apply_ops results ("Opening check") and the snapshot (`clashes`)
  - **AI:** motion entity in the apply_ops schema from the registry (nested discriminated union), results list each motion's hinge line / travel in world terms; prompt `# Animation` section: animate every door / drawer / lid / flap built, the folder not the boards, outer hinges for pairs, carcass `doors` for slab doors
  - **glTF export** (`render/gltfExport.ts`, toolbar **glTF**): `.glb`, meters, closed, a clip per motion with the easing baked in, plus "Open all"
  - Eval: `npm run eval -- -t animation` (carcass drawer over doors; a hand-built frame-and-panel door hinged on its folder; a door beside a wall clears or is reported). Not run live yet

## Phase 5 — Later

- Mobile/touch viewing and markup
- Export: OBJ, DXF cut sheets (glTF with animations is done); solid stock laid out on boards (needs board sizes per material)
- Component library (reusable drawers, doors, face frames)
- CAD kernel (e.g. Replicad/OCCT) as a builder plugin **only if** a real part needs it

## Plugin backlog (add when a real piece needs it)

| Plugin | Kind | Notes |
|---|---|---|
| Tapered leg | Shape | Loft between two rectangles |
| Turned leg | Shape | Lathe a profile (`LatheGeometry`) |
| Splayed parts | Feature | Rotation limit already lifted (blockout); still needs angled end cuts and joints at angles |
| Edge holes (dowels, cam locks) | Feature | Holes into an edge — not 2.5D, special-cased |
| Dado / rabbet cuts | Feature | **Done in Phase 4** (box parts; not yet combined with edge profiles) |
| Fixed shelves in the carcass | Generator param | Dadoed shelves instead of adjustable ones |
| Freeform mesh | Shape | Escape hatch for sculpted parts; loses parametric features |

---

## Risks

| Risk | Mitigation |
|---|---|
| AI produces plausible but wrong geometry | Generators over raw coords, schema validation, eval set, diff preview |
| Pick-to-model bridge brittle | Semantic handles + stable IDs, triangles tagged at build time |
| Float precision errors | Integer 1/64" units |
| Interacting features (hole into a roundover) | Features apply in order; unsupported combos refuse with a clear error; solve specific combos when needed |
| Robust triangulation (holes near edges, inside corners) | Per-plugin geometry tests; clamp radii to what a real bit can do |
| Scope creep into general CAD | 2.5D + special cases; kernel only on demand |

## Open questions

- Solid wood vs. sheet goods: model board stock sizes/lumber yard dims early?
- Hosting: purely local, or deployed for phone access later?

## Positioning vs. SketchUp

- SketchUp: general freeform modeler; geometry, not parts. Wins on freeform shapes, snapping polish, rendering, ecosystem.
- This app: parts-aware (material, grain, joints), parametric, AI-first. Wins on idea → correct model speed, changes that ripple correctly, trustworthy cut lists, markup.

---

## TLDR

- **Parts = shape + ordered features**, each a plugin with schema, builder, handles, AI docs, and migration. New capabilities plug in without core changes.
- **12 foundation rules** guard against rewrites. Key changes: full rotations in data, nested assemblies, generator params + overrides, versioned schema, semantic handles.
- **Phase 1A** builds the foundation (box + through hole proof). **Phase 1B** adds rounded corners, holes/pockets, and edge profiles.
- **Phase 3 (built)** adds picking, push/pull and other direct face/edge/vertex edits — every drag becomes an op — plus notes pinned to the model that the AI fixes and resolves.
- **Phase 4 (built)** makes it shop-ready: joints cut real dados / rabbets, a joinery-aware cut list (CSV + print) with sheet / board-foot / cost estimates, a material library, inch ⇄ mm display, dimension lines, and snap-to-align / match-size while dragging.
- **UI (built):** docked top bar / model list + settings / AI panel, one design system where color means selected, AI or note, true fractions for lengths.
- **Blockout (built):** sketch placeholder blocks in three clicks (B), move / turn anything with a gizmo at any angle, copy and split runs, then hover and talk — the AI builds each block's real piece in its space.
- **Animations (built):** hinge / slide presets work out pivots and travel from the parts; carcass drawers and new carcass doors come animated; open things with O, check what they hit, export them to glTF.
- **No CAD kernel** unless a real part needs one; it would slot in as another builder.
