# Modeler

Local 3D modeler for cabinetry and furniture. AI changes appear as a proposal;
accept or reject them before they become part of the model.

## Run

```powershell
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`).

## Recipes

- Open **Recipes** in the toolbar, then **Save as recipe**. Save the whole model,
  selected parts, or a named assembly such as a riser. Give it a name and describe
  which construction choices should stay consistent when it is reused.
- Search the library and open a recipe. **Size and construction** exposes its
  existing dimension controls. **Use recipe** inserts an independent editable copy;
  Undo removes that insertion in one step. The saved recipe stays unchanged.
- **Adapt with AI** attaches a recipe to the AI message box. Describe the new
  footprint or purpose and press **Send**. The copied construction and AI changes
  appear in the normal proposal; **Accept** commits them and **Reject** discards them.
  Attaching a recipe does not send a request to an AI provider.

Recipes retain parts, nested assemblies, materials, joints, dimension formulas,
and generator edits. Component recipes copy only the variables/materials they need;
connections to excluded parts are listed before saving. Select a complete generated
assembly to retain its construction, or the common assembly for parts in different
folders. Project notes are not included; use the recipe's construction description
for reusable intent. Layout adaptation uses the existing AI provider and does not
infer guaranteed structural or engineering rules from geometry alone.

The library is saved **in this browser at this app address**, separately from model
files. Reloading or starting a new model keeps the library; another browser/address
has its own library, and clearing site data removes it. Thumbnails show approximate
part bounds. Cloud sync, portable recipe files, and revision management are not yet
included.

## Animations

- Doors, drawers, lids and flaps open in the view. Select one and pick **Opens like** under
  **Animation** in its settings: Door (hinges left / right), Flip-up, Drop-front, Lid,
  Drawer / pull-out, Slides left / right, Lifts up. Then fine-tune the hinge side, the
  face that swings out, the angle, the slide direction and distance (empty = 90% of its
  depth) and the time. The pivot and travel are worked out from the parts, so resizing
  keeps them right. To move several parts as one (a door's panel, rails and pull), click
  their folder in the model list first.
- **▶ / the slider** in that section, **Open** in the toolbar, or **O** (the selection,
  else everything) open and close things. Open is a view: it isn't saved or undone, and
  the model stays closed. While anything is open the gizmo and face dragging are off;
  the settings still work, so you can change the angle and watch it.
- Generated cabinets come animated: drawers slide out on full-extension slides, and
  **Doors** (one or a pair, under **Cabinet**) are full-overlay slabs with 35 mm
  hinge-cup bores that swing out. **Hinge side** and **Door swing** set how.
- Opening check: the Animation section says what a door or drawer hits as it opens
  (`Door hits “Wall” at 91°`) and tints both yellow while it's open that far. The AI
  gets the same check, and adds an animation to every door, drawer, lid and flap it builds.
- **glTF** in the toolbar downloads `model.glb` (meters, Y up, closed) with an
  "Open — …" clip per animation plus "Open all", for Blender, 3D viewers or a web page.

## SketchUp

Exchange uses COLLADA (.dae), which SketchUp reads and writes natively.

- **To SketchUp:** **Export** downloads `model.dae`. In SketchUp: File › Import,
  choose COLLADA. Assemblies become nested groups; names, colors and sizes carry over
  (Z up, inches). Hidden parts are included.
- **From SketchUp:** File › Export › 3D Model › COLLADA (.dae), then **Import…** here.
  Each group or component becomes:
  - a **box part** when it's a plain rectangular board;
  - an **outline part** when it's a straight extrusion of another shape (notches, angles);
  - a **blockout** otherwise (moldings, roundovers, hardware, appliances).

  Nested groups become assemblies. Material: a same-named model material, else any
  model or library material of that thickness, else a new one. Holes and pockets
  are dropped (the import message counts them). Into an empty model, SketchUp's
  coordinates are kept; otherwise the import lands 12" to the right. Undo removes it.
- Generators, joints, variables and features don't survive a round trip — the result
  is plain parts.

## AI connections

Choose **Claude Code**, **Codex**, or **API** in the AI panel.

- **Claude Code:** uses the installed `claude` CLI and its login. Run `claude`
  and `/login` to sign in.
- **Codex:** uses the installed Codex CLI and its login. Run `codex login`,
  sign in with ChatGPT, then refresh the modeler. When launched from Codex
  desktop, the app detects its bundled executable through `CODEX_CLI_PATH`.
  Otherwise, install the Codex CLI on PATH or set `CODEX_BIN` to its executable
  path in `.env.local` and restart Vite.
- **API:** set `ANTHROPIC_API_KEY` in `.env.local` and restart Vite. This provider
  is billed separately per token.

Copy `.env.example` to `.env.local` for optional model, effort, and CLI path
settings. A blank Codex model uses the CLI's configured default. Credentials
stay in the local server. Codex uses the
[Codex app-server interface](https://learn.chatgpt.com/docs/app-server), including
its experimental dynamic tool interface, so its CLI must support that protocol.

Claude Code and Codex both use the open tab's model tools and proposal flow.
They support screenshots, follow-up messages, and Stop. Switching providers or
starting a new conversation starts a fresh AI session. Voice-note cleanup
follows the selected provider. The terminal MCP endpoint is `/mcp`.

## Checks

```powershell
npm test
npm run build
```

Unit tests exercise Codex with a simulated local CLI; they do not send model
data to an AI service. A completed, signed-in chat turn is the separate check
that the account can use its selected model.
