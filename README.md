# Modeler

Local 3D modeler for cabinetry and furniture. AI changes appear as a proposal;
accept or reject them before they become part of the model.

## Run

```powershell
npm install
npm run dev
```

Open the URL printed by Vite (normally `http://localhost:5173`).

## Tools

The tools, their keys and the way they work follow SketchUp. Pick one from the palette down the
left of the 3D view or by its key; the line at the bottom left says what it wants next, and the
**Measurements** box at the bottom right shows the value. Type a value at any time and press Enter
— no need to click the box.

| Key | Tool | How |
|---|---|---|
| Space | Select | Click a face, edge or corner; double-click the part; triple-click the whole piece; drag a box |
| M | Move | Click a point on what moves, then where it goes. Ctrl: a copy. Then `3x` for a row, `/3` to space three |
| Q | Rotate | Click the center, a point to turn from, then the angle. Ctrl: a copy |
| P | Push/Pull | Click a face, move, click. Double-click another face to repeat the distance |
| R | Rectangle | Draws a block: corner, corner, height (B works too) |
| T | Tape Measure | Click two points |
| E | Eraser | Click parts, or drag across several |
| O / H / Z | Orbit / Pan / Zoom | With the left button. Shift+Z fits the whole model |

- **Inference:** points land on corners (Endpoint, green), the middles of edges (Midpoint, cyan),
  along edges (On Edge, red) and on faces (On Face, blue). Moves follow the red, green or blue axis
  when the cursor is near one; → ← ↑ lock an axis, holding Shift keeps the one you're on.
- **Values:** lengths as anywhere else (`24`, `3 1/2`, `2' 6"`, `18mm`), angles in degrees. Typing
  one just after a move, turn or pull changes it; it's still one undo step.
- **Camera:** middle-drag orbits (Shift: pans), right-drag pans, the wheel zooms toward the cursor,
  whatever tool is on.
- Move and Rotate act on the selection, or on the piece under the first click; a generated
  cabinet moves whole. Esc backs out a step, then returns to Select.
- Not SketchUp: there's no line, arc or offset drawing — parts are boards and blocks, not loose
  faces. Voice notes are **V**, open / close is **Shift+O**, quarter turns are **]** and **[**.

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
- **▶ / the slider** in that section, **Open** in the toolbar, or **Shift+O** (the selection,
  else everything) open and close things. Open is a view: it isn't saved or undone, and
  the model stays closed. While anything is open the gizmo and face dragging are off;
  the settings still work, so you can change the angle and watch it.
- Generated cabinets come animated: drawers slide out on full-extension slides, and
  **Doors** (one or a pair, under **Cabinet**) are full-overlay slabs with 35 mm
  hinge-cup bores that swing out. **Hinge side** and **Door swing** set how. Each drawer
  and door is a folder ("Drawer 1", "Left door") that moves as one, so anything you put in
  it (a pull, a panel) goes along.
- **Pulls** under **Cabinet** put hardware on every drawer and door: a style (bar, arch,
  cup, edge, knob, tab), its length and finish, and where door pulls go (**Auto**: near
  the top on base cabinets, near the bottom on wall cabinets, 40" up on tall doors).
  **Front finish** gives the doors and drawer fronts their own look (two-tone).
- Opening check: the Animation section says what a door or drawer hits as it opens
  (`Door hits “Wall” at 91°`) and tints both yellow while it's open that far. The AI
  gets the same check, and adds an animation to every door, drawer, lid and flap it builds.
- **glTF** in the toolbar downloads `model.glb` (meters, Y up, closed) with an
  "Open — …" clip per animation plus "Open all", for Blender, 3D viewers or a web page.

## Finishes

- A finish is how something looks, not what it's cut from: paint, lacquer, a stain, stone,
  metal, glass… Set one per material under **Cut list › Materials** (the Finish column;
  **Auto** goes by the material's name), or on a part, folder or cabinet in its settings
  (**Finish**; a cabinet's or folder's applies to every part inside that has none of its own).
  Paint takes a color; wood takes an optional stain color.
- The view stays flat: something with a finish set draws in that finish's color, anything
  else in its material's color, so older models look the same.
- Stone tops use **slab** stock (3 cm quartz, 3 cm granite, 2 cm marble in the library): the
  cut list lists them by size, with no sheet layout or board feet.
- The AI sets finishes the same way rather than adding materials for colors.

## Room

- **Room** in the toolbar puts walls, a floor, a ceiling and baseboards around the model: the
  back wall right behind it, a side wall flush where a cabinet's back faces it (else 3' out), the
  front wall 4' in front, at least 8' high. With a room already there it selects it. It's for
  showing the design: it never counts in the cut list, the model's dimensions or placement.
- Walls between the camera and the room step aside as you orbit (and the ceiling when you look
  from above or outside), so you always see in; they can't be clicked while they're away.
- Click a wall, then **Add window here**, **Add door here** or **Add opening here** under
  Actions; click a window, door or one of its reveals for **Remove window w1**. Drag a wall's
  inside face to move that wall, its top for the height, its outside face for the thickness.
- The **Room** settings (select any part of the room) set the size, height, which walls are
  built, floor and ceiling, baseboard, **Fit to model** (walls move to the model as it is now;
  windows and doors stay on their walls), each window's and door's wall, position, size, sill,
  style, hinge side and swing, and the walls', floor's, ceiling's, trim's, doors' and windows'
  finishes, and **Ceiling lights** (recessed cans in a grid: none, 2 × 2, 2 × 3…). Room doors
  open like cabinet doors (**Shift+O**).
- The AI makes or refits the room with its `fit_room` tool and edits windows and doors as the
  room's `openings`; it's told when a cabinet covers a window or blocks a door.

## Props and appliances

- **Props** in the toolbar opens a catalog: **Appliances** (fridge, range, dishwasher, microwave,
  range hood), **Lighting** (pendant, recessed light, light strip), **Furniture** (bar stool, chair,
  dining table, rug) and **Accessories** (plant, bowl of fruit, books, vase). Pick one and a
  see-through copy follows the cursor: it rests on the floor, a counter or a cabinet top, a pendant
  hangs from the ceiling (96" without a room), a strip sticks under a cabinet, a hood sits 30" over
  the cooktop; its front faces you. Click to drop it (one undo step), **Shift**-click to drop
  several, **Esc** to stop. Then move it with the gizmo and copy it with **Ctrl D** as usual.
- Props are decor: never in the cut list. Each has its own settings (sizes, styles, finishes,
  light output; **Variation** reshuffles a plant, the fruit or the books). New ones are numbered:
  "Bar stool 1", "Bar stool 2".
- Appliances are generated, like cabinets: their doors and drawers open (French doors swing out,
  the freezer drawer slides, the oven door drops), their outer faces push and pull to resize them,
  and the opening check reports a fridge door that hits the wall beside it. Their settings: size,
  style, handles, finish (stainless, black, white, or panel-ready doors in a finish of your own).
- The AI adds props as decor (grouped in folders) and turns an appliance block into the real
  appliance in exactly its space.

## Presentation mode

- **Present** in the toolbar (or **Shift+P**) shows the model full-window for a client: every
  part in its finish (an **Auto** finish too, so the material's name decides the look),
  blocks as white massing, soft shadows on a warm studio floor. It shows the saved model,
  never a pending AI change, and the whole model even if a folder is isolated (hidden parts
  stay hidden). The editor's view comes back exactly as it was.
- Point at a door, drawer or lid to see "Open — Left door"; click to open or close it (its
  pull goes along). Double-click anything to swing in close to it. **Open all** / **Close
  all** at the bottom (or **O**) animate everything; **Esc** or **✕** leaves.
- Left-drag orbits, right-drag pans, the wheel and middle-drag zoom (toward the cursor).
- Finishes render with real textures (bundled CC0 photo sets from Poly Haven and ambientCG,
  credited in `public/textures/LICENSES.md`): wood grain runs along each part's grain direction
  (up a door, across a drawer front, along the edges like edge banding), stone tops, tile, paint
  with a fine orange peel, brushed metal pulls. A finish's color stains wood.
- The image settles: while the view moves it's drawn quickly; when it holds still it refines to a
  clean, anti-aliased picture (with softer shadows on Balanced and High), then stops drawing until
  something changes.
- **Save image** downloads a PNG at about twice the screen size, named after the model (its
  top-level item when there's only one): `Base cabinet – presentation.png`.
- **Quality** (Auto, Fast, Balanced, High) trades detail for speed. Auto picks one for the
  computer's graphics chip and steps down if moving gets slow; a picked quality is remembered.
- **Lighting** (bottom bar, or **L** to cycle): **Day** — sky outside, sunlight coming in through
  the largest window; **Evening** — a low warm sun, ceiling lights on; **Night** — only the
  lights; **Studio** — the model alone on the gray backdrop (the room hidden); **Auto** — day
  with a room, studio without. The sun button holds a **brightness** slider (±1 stop,
  double-click to reset) and **under-cabinet lights** (strips under wall cabinets, on by
  default in the evening and at night). The choice is saved with the model (one undo step each).
  Pendants, recessed cans, light strips and the hood's lamps light the room in the evening and at
  night, their bulbs and lenses glowing; a room with no fixtures of its own gets four ceiling spots.
- With a room, the walls and ceiling between you and the room are cut away as you orbit (they
  still cast shadows, so the sunlight keeps the window's shape); clicks go through them, so the
  room's door opens on a click like a cabinet door.
- **Views tour:** the strip above the bar holds the model's saved views in order. **+ Save view**
  keeps what's on screen — the camera, orbit or walk, what's open, and the lighting if it differs —
  as one undo step. Click a view (or **→** / **PageDown** / **Space**, **←** / **PageUp** — what
  presenter clickers send — or **1**–**9**) to fly there: what it doesn't show open closes as the
  camera leaves, what it opens opens halfway; its name and caption show at the top left.
  Right-click a view to rename it, update it to the view on screen, move it or delete it. The AI
  writes tours too ("a three-shot client tour…"): views that frame an area from a direction, open
  what to show and carry a short caption.
- **Walk** (bottom bar, or **V**): fly down to eye height (62") and walk through the room — drag to
  look, **WASD** or the arrows to walk (Shift runs), the wheel steps a foot, double-click the floor
  to go there. Walls, cabinets and open doors stop you (you slide along them); doorways let you
  through. Doors and drawers still open on a click. **V** or **Esc** flies back to where you were
  orbiting.
- **Photo** (bottom bar): a path-traced still of the view — light bouncing around the room for real,
  through the window glass, glowing bulbs included. The camera holds still while it renders; the
  panel shows the progress (**Draft** 64 / **Good** 256 / **Best** 1024 samples — on a fast graphics
  card a Draft takes seconds, Best a minute or two, after a one-time warm-up), **Save PNG** at any
  point, and **Cancel** (or any click, scroll or key). Its brightness and color are matched to the
  live view as it renders, so it reads as the same room, only rendered better. If path tracing
  can't run on the computer, the rendered image is saved instead.
- The controls fade when the mouse rests for a few seconds and come back when it moves; **H** hides
  them, **F** fills the screen.

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

## Sharing the app

The app can run as a web link, so someone else only needs a browser.
`npm run build:vercel` writes Vercel's prebuilt layout to `.vercel/output`:
the static app plus one function for the AI (`server/hosted.ts`). Connect the
GitHub repo to a Vercel project (`vercel.json` sets the build command) and set
two environment variables there:

- `ANTHROPIC_API_KEY`: the hosted AI uses the API provider only, billed to this key.
- `APP_ACCESS_CODE`: every AI call must carry it, so the link alone can't spend
  the key. Share the link as `https://<site>/?code=<code>`; the browser remembers
  the code and drops it from the address. Without it, the AI panel says
  "Click to enter the access code".

Every push to `main` redeploys. An open tab notices the new version when it
regains focus (or within half an hour) and offers **Reload**; the model is
autosaved in the browser, so reloading keeps the work.

## Checks

```powershell
npm test
npm run build
```

Unit tests exercise Codex with a simulated local CLI; they do not send model
data to an AI service. A completed, signed-in chat turn is the separate check
that the account can use its selected model.
