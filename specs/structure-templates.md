# Recipes

> Save a whole model or a component as a reusable construction design.

## Context / Why

- Save an entire corner closet or just its riser to a recipe library.
- Preserve the way it is built, with its current dimensions as useful defaults.
- Reuse the riser's construction approach in another project, including a straight cabinet.
- Existing model data includes assemblies, parts, joints, materials, generators, and dimension formulas. These support reuse; they do not automatically express how every arbitrary design should change layout.

## Goals & Non-Goals

- **Goals:** whole-model and selected-component recipes; editable copies; preserve construction relationships; support reuse across different sizes and layouts.
- **Proposed boundaries:** local library first; cloud sharing and automatic propagation to existing copies later.

## Core Features (MVP proposal)

- **Save as recipe:** select a component or choose the whole model; give it a name and construction description.
- **Recipes library:** browse named previews, search, and insert a saved recipe into a project.
- **Preserve construction:** keep assemblies, parts, materials, features, joints, generator settings, manual overrides, and existing dimension formulas.
- **Independent copies:** inserted recipes remain editable without changing the saved source or other copies.
- **Size controls:** expose meaningful existing parameters, such as width, depth, height, and support spacing where defined. Preserve board thickness unless explicitly changed; avoid proportional scaling of every part.
- **Self-contained components:** carry needed variable and material dependencies. Surface connections to excluded parts rather than silently leaving broken references or importing the entire closet.
- **Adaptation:** reuse the construction approach for a new footprint through a reviewable proposal. An L-to-straight conversion may change the number and arrangement of parts; it requires more than a resize.

## Stretch / Future Ideas

- Explicit construction rules for support spacing, corner handling, and member count.
- Recipe variants, tags, import/export, and revision history.
- User-requested updates from saved recipes to existing instances.

## Confirmed Direction

- Product name: **Recipes**. Save action: **Save as recipe**.
- A recipe captures how something is built, with its saved dimensions as defaults.
- Preserve the editable source and let AI preview adaptations for a different model or layout.

## Open Questions & Risks

- Saving existing formulas does not infer missing construction rules. Distinguish captured relationships from suggested rules requiring review.
- The actual corner closet/riser has not been inspected; its construction and parameter coverage remain unknown.
- A recipe referencing closet-wide dimensions needs independent inputs when extracted.
- Notes may contain project-specific instructions; decide which describe reusable construction before carrying them into recipes.

## Phased Roadmap

| Phase | Outcome |
| --- | --- |
| 1 — Preserve and reuse | Save whole models or components, browse a local library, and insert independent editable copies with intact dependencies. |
| 2 — Adapt construction | Expose meaningful size inputs and propose layout adaptations using the saved construction as the reference. Required to satisfy the L-shaped-to-straight reuse example. |
| 3 — Manage a growing library | Add variants, revisions, and portable recipe files. |

## Success Criteria

- A saved corner closet can be inserted with its complete editable structure.
- A riser can be saved without dragging along unrelated closet parts.
- Recipes survive restarting the app.
- Two inserted copies can be edited independently; insertion is undoable.
- Resizing supported inputs preserves intended material thicknesses and construction relationships.
- A proposed straight-cabinet adaptation visibly retains the chosen riser construction approach and can be accepted or rejected.

## Implementation Plan (authorized)

| Phase | Slice | Effort | Status |
| --- | --- | --- | --- |
| 1 | Pure recipe capture, validation, independent insertion through ops, focused regression coverage | Extra High: reference remapping and dependency closure | Complete: 15 recipe tests; 66 focused surrounding tests and typecheck passed |
| 2 | Durable local library, Recipes UI with previews/search/save/use, existing parameter controls | High: persistence and interaction state | Complete: 25 focused tests and typecheck passed |
| 3 | AI adaptation context through existing preview/accept/reject flow, integration checks and documentation | High: proposal integration | Complete: 282 full-suite tests and production build passed; browser smoke passed |

### Decisions

- Implement the confirmed design now; leave changes uncommitted as requested by the machine instructions.
- Each recipe owns its captured variables; insertion remaps their identifiers to avoid coupling copies. Materials are shop stock: insertion reuses the target's material with the same name, thickness and stock kind (and sheet size / nominal thickness), so the cut list keeps one group per stock, and adds only the needed materials the target lacks.
- Excluded-part connections must be reported. Project annotations are omitted from recipes; the construction description captures reusable intent.
- Preserve existing dimensions/formulas, generators, overrides, and joints. Do not claim to infer missing construction constraints.
- Local library first. Cloud sharing, linked updates, revisions, and variant management are future work.
- Automated gates: focused tests per phase, TypeScript checks, then the full local test suite and production build. Final hands-on check: save/reload/use a riser recipe and review an AI adaptation.

### Implementation results

- Phase 1: versioned recipe capture/insertion preserves editable parts, formulas, materials, joints, generator overrides (including dormant/deleted roles), and independent identifiers. A single dispatch gives one-step Undo. Root placement is normalized while position formulas retain their response to input edits.
- Read-only validation against the actual exported closet passed: full closet = 20 parts; riser = 2 rails with five required variables; two copies = 4 independent parts. Cross-boundary joints and shared-input extraction are reported.
- Deliberate selection boundaries: components from different parents must be captured via their common assembly; individual generated parts require the complete generating assembly.
- Phase 2: local Recipes dialog includes search, component/whole-model capture, approximate part-bounds thumbnails, descriptions, warnings, and existing construction inputs. Insertion selects the copy for direct editing. Versioned storage validates reads/writes, retains corrupted data, and serializes writes with browser Web Locks where available.
- Phase 3: Adapt with AI attaches a frozen recipe and selection to the existing composer without a model change or external request. Send prepares the independent copy against the current model and appends its construction context. Insertion and AI edits share one proposal and one Undo step. Retry context survives failed requests without reinserting a copy; deciding the proposal clears the context.
- Inserted recipes are framed automatically in the viewport. Attachment removal preserves the typed message and leaves model geometry unchanged.
- Final verification: 33 test files / 282 tests passed; TypeScript and production build passed. Build emits the app bundle-size advisory (about 1.04 MB minified). Browser smoke on an isolated local origin passed assembly capture, saved description, 36-to-24-inch cabinet insertion, library persistence/search after reload, camera framing, one-step Undo, and AI attachment/removal with the typed message retained. Browser error log was empty.
- Actual external AI adaptation was not run. Its proposal/accept/reject/retry behavior was tested with simulated AI responses; evaluating an L-to-straight result with the user's provider remains the hands-on check.

## TLDR

- Save entire models or selected components as reusable construction designs.
- Keep dimensions as defaults and preserve existing relationships.
- Treat different-layout reuse as explicit adaptation, with a preview before acceptance.

