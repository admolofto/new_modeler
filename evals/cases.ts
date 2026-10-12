import { clashText, clearance } from '../src/model/clearance.ts';
import { cutList, cutParts } from '../src/model/cutlist.ts';
import { modelPartIds } from '../src/model/decor.ts';
import { movingParts, parentIndex } from '../src/model/doc.ts';
import { frontOf } from '../src/edit/blocks.ts';
import { applyOps, type Op } from '../src/model/ops.ts';
import { roomIssues, roomOf, roomParams } from '../src/model/room.ts';
import { viewMotions } from '../src/model/views.ts';
import { Grader, IN } from './grade.ts';

/**
 * Phase 2 eval set: prompts with checks on the resulting model. Multi-step cases auto-accept
 * each proposal before the next prompt. Checks are deliberately about outcomes (sizes,
 * counts, placement), not about which ops the AI chose.
 */
export interface EvalCase {
  name: string;
  start: 'empty' | 'demo';
  /** Applied to the start doc before the first step (e.g. markup notes). */
  setup?: Op[];
  steps: string[];
  check(g: Grader, replies: string[]): void;
}

/** A markup note, as the inspector pins it. */
const note = (id: string, text: string, ...targets: { node: string; handle?: string }[]): Op => ({
  op: 'add',
  entity: { kind: 'annotation', id, note: text, targets },
});

/** A placeholder block, as the block tool draws it (inches). */
const block = (id: string, position: [number, number, number], rotation: [number, number, number], size: [number, number, number]): Op => ({
  op: 'add',
  entity: { kind: 'block', id, transform: { position: position.map((c) => c * IN) as [number, number, number], rotation }, size: size.map((c) => c * IN) as [number, number, number] },
});

const flat = (g: Grader, id: string) => {
  const s = g.size(id);
  return s ? Math.min(...s) : Infinity;
};

export const CASES: EvalCase[] = [
  {
    name: 'base cabinet with two drawers (phase exit prompt)',
    start: 'empty',
    steps: ['36" wide base cabinet, two drawers, 3/4 ply'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      g.near(c.params.width, 36, 'width');
      g.near(c.params.height, 34.5, 'height', 1);
      g.near(c.params.depth, 24, 'depth', 1);
      g.check(c.params.material === 'ply-3-4', `material ${c.params.material}`);
      g.check(c.params.drawers.length === 2, `drawers: ${JSON.stringify(c.params.drawers)}`);
      g.check(c.params.shelves === 0, `shelves ${c.params.shelves} with a full drawer bank`);
    },
  },
  {
    name: 'wall cabinet',
    start: 'empty',
    steps: ['A wall cabinet 30 wide, 30 tall, 12 deep with two shelves'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      g.near(c.params.width, 30, 'width');
      g.near(c.params.height, 30, 'height');
      g.near(c.params.depth, 12, 'depth');
      g.check(c.params.toeKick === null, 'wall cabinet should have no toe kick');
      g.check(c.params.shelves === 2, `shelves ${c.params.shelves}`);
    },
  },
  {
    name: 'resize keeps one cabinet',
    start: 'empty',
    steps: ['base cabinet 24 wide with one shelf', 'make it 30 wide'],
    check(g) {
      const c = g.oneCarcass();
      if (c) g.near(c.params.width, 30, 'width');
    },
  },
  {
    name: 'add a drawer to an existing cabinet',
    start: 'empty',
    steps: ['base cabinet 18 wide with two equal drawers', 'add a third drawer'],
    check(g) {
      const c = g.oneCarcass();
      if (c) g.check(c.params.drawers.length === 3, `drawers: ${JSON.stringify(c.params.drawers)}`);
    },
  },
  {
    name: 'drawer over shelves',
    start: 'empty',
    steps: ['24" base cabinet with a 6" drawer on top and one adjustable shelf below'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      g.check(c.params.drawers.length === 1, `drawers: ${JSON.stringify(c.params.drawers)}`);
      g.near(c.params.drawers[0], 6, 'drawer front height', 1 / 4);
      g.check(c.params.shelves === 1, `shelves ${c.params.shelves}`);
    },
  },
  {
    name: 'tall pantry',
    start: 'empty',
    steps: ['Tall pantry cabinet, 18 wide, 84 tall, 24 deep, 5 shelves'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      g.near(c.params.width, 18, 'width');
      g.near(c.params.height, 84, 'height');
      g.check(c.params.shelves === 5, `shelves ${c.params.shelves}`);
    },
  },
  {
    name: 'two cabinets side by side',
    start: 'empty',
    steps: ['Two base cabinets side by side: a 24" one on the left and a 30" one to its right'],
    check(g) {
      const cs = g.carcasses().sort((a, b) => (g.box(a.id)?.min[0] ?? 0) - (g.box(b.id)?.min[0] ?? 0));
      if (!g.check(cs.length === 2, `expected 2 carcasses, found ${cs.length}`)) return;
      g.near(cs[0]!.params.width, 24, 'left width');
      g.near(cs[1]!.params.width, 30, 'right width');
      const [a, b] = [g.box(cs[0]!.id)!, g.box(cs[1]!.id)!];
      g.near(b.min[0] - a.max[0], 0, 'gap between cabinets');
      g.check(a.min[1] === b.min[1] && a.min[2] === b.min[2], 'cabinets should share floor and back line');
    },
  },
  {
    name: 'countertop over a cabinet run',
    start: 'empty',
    steps: ['Two base cabinets side by side, 24 and 30 wide', 'Add a 1 1/2" thick countertop over both with a 1" overhang at the front'],
    check(g) {
      const run = g.overall(g.carcasses().flatMap((c) => c.children.filter((id) => g.doc.parts[id])));
      const top = g.parts((p) => /counter|top/i.test(p.name) && !p.role);
      if (!g.check(top.length >= 1 && !!run, 'no countertop part')) return;
      const b = g.overall(top.map((p) => p.id))!;
      g.near(b.max[0] - b.min[0], 54, 'countertop width', 1);
      g.near(b.max[1] - b.min[1], 1.5, 'countertop thickness');
      g.near(b.min[1], 34.5, 'countertop bottom height', 1 / 8);
      g.check(b.max[2] >= run!.max[2] + IN / 2, 'countertop should overhang the front');
      g.noOverlaps(top.map((p) => p.id));
    },
  },
  {
    name: 'question does not change the model',
    start: 'demo',
    steps: ['How wide is the cabinet?'],
    check(g, replies) {
      g.check(g.carcasses()[0]?.params.width === 36 * IN, 'cabinet changed');
      g.check(/36/.test(replies.join(' ')), `reply should say 36": ${replies.at(-1)}`);
    },
  },
  {
    name: 'remove a part',
    start: 'demo',
    steps: ['remove the tabletop'],
    check(g) {
      g.check(!g.doc.parts.tabletop, 'tabletop still there');
      g.check(g.carcasses().length === 1 && !!g.doc.parts.door, 'removed more than the tabletop');
    },
  },
  {
    name: 'overhang relative to existing part',
    start: 'demo',
    steps: ['Make the tabletop overhang the cabinet by exactly 1" on the left and right, flush at the back'],
    check(g) {
      const t = g.box('tabletop');
      const cab = g.box('a1');
      if (!g.check(!!t && !!cab, 'tabletop or cabinet missing')) return;
      g.near(t!.min[0], -1, 'tabletop left edge');
      g.near(t!.max[0], 37, 'tabletop right edge');
      g.near(t!.min[2], 0, 'tabletop back edge');
    },
  },
  {
    name: 'grommet hole centered in tabletop',
    start: 'demo',
    steps: ['Drill a 2" grommet hole through the center of the tabletop'],
    check(g) {
      const holes = g.features(g.doc.parts.tabletop, 'hole');
      const h = holes.find((p) => p.d === 2 * IN);
      if (!g.check(!!h, `no 2" hole on the tabletop: ${JSON.stringify(holes)}`)) return;
      g.check(h!.depth === undefined, 'grommet should go through');
      const s = g.size('tabletop')!;
      const at = h!.at as [number, number];
      g.near(at[0], s[0] / 2 / IN, 'hole u', 1 / 4);
      g.near(at[1], s[2] / 2 / IN, 'hole v', 1 / 4);
    },
  },
  {
    name: 'swap a profile',
    start: 'demo',
    steps: ['Change the roundover on the tabletop to a 1/4" chamfer'],
    check(g) {
      const profiles = g.features(g.doc.parts.tabletop, 'edgeProfile');
      g.check(profiles.length >= 1 && profiles.every((p) => p.profile === 'chamfer' && p.r === IN / 4), `profiles: ${JSON.stringify(profiles)}`);
    },
  },
  {
    name: 'new material for drawer fronts',
    start: 'empty',
    steps: ['30" base cabinet with three equal drawers', 'Add 3/4" walnut plywood as a material and make the drawer fronts from it'],
    check(g) {
      const walnut = Object.values(g.doc.materials).find((m) => /walnut/i.test(m.name));
      if (!g.check(!!walnut, 'no walnut material')) return;
      g.check(walnut!.thickness >= 44 && walnut!.thickness <= 48, `walnut thickness ${walnut!.thickness}`);
      const c = g.oneCarcass();
      g.check(c?.params.frontMaterial === walnut!.id, `frontMaterial ${c?.params.frontMaterial}`);
    },
  },
  {
    name: 'impossible size is refused or clamped, never corrupts',
    start: 'demo',
    steps: ['Make the cabinet 200 inches wide'],
    check(g) {
      const c = g.carcasses()[0];
      g.check(!!c && c.params.width <= 120 * IN, 'cabinet width beyond the generator max');
    },
  },
  {
    name: 'mantel shelf',
    start: 'empty',
    steps: ['A fireplace mantel shelf: 60" long, 8" deep, 2" thick, 1/2" roundover along the top front and top ends, bottom mounted 54" off the floor'],
    check(g) {
      g.overallSize([60, 2, 8], 1 / 4);
      g.near(g.overall()?.min[1], 54, 'mantel bottom height', 1 / 4);
      const profiles = g.parts().flatMap((p) => g.features(p, 'edgeProfile'));
      g.check(profiles.some((p) => p.profile === 'roundover' && p.r === IN / 2), `no 1/2" roundover: ${JSON.stringify(profiles)}`);
    },
  },
  {
    name: 'mantel surround (no generator)',
    start: 'empty',
    steps: [
      'Build a simple fireplace mantel surround: two pilasters 6" wide × 50" tall × 4" deep, 48" apart inside, a frieze board spanning between them at the top, and a 66" long × 8" deep shelf on top.',
    ],
    check(g) {
      const all = g.parts();
      g.check(all.length >= 4, `only ${all.length} parts`);
      const b = g.overall();
      if (!g.check(!!b, 'no parts')) return;
      g.near(b!.max[0] - b!.min[0], 66, 'overall width', 1);
      g.check(b!.max[1] - b!.min[1] >= 50 * IN, 'shorter than the pilasters');
      g.noOverlaps();
      const legs = all.filter((p) => (g.size(p.id)?.[1] ?? 0) >= 45 * IN);
      g.check(legs.length === 2, `${legs.length} pilasters`);
      if (legs.length === 2) {
        const [l, r] = legs.map((p) => g.box(p.id)!).sort((a, c) => a.min[0] - c.min[0]);
        g.near(r!.min[0] - l!.max[0], 48, 'opening between pilasters', 1 / 4);
      }
      g.check(Object.keys(g.doc.assemblies).length >= 1, 'parts should be grouped in an assembly');
    },
  },
  {
    name: 'coffee table (outline top + legs)',
    start: 'empty',
    steps: ['Coffee table 48" × 24", 18" high: four 2×2 legs and a 1" thick top with 2" radius corners, legs inset 2" from the top edges'],
    check(g) {
      g.overallSize([48, 18, 24], 1 / 4);
      const legs = g.parts((p) => {
        const s = g.size(p.id);
        return !!s && s[1] >= 15 * IN && s[0] <= 2.5 * IN && s[2] <= 2.5 * IN;
      });
      g.check(legs.length === 4, `${legs.length} legs`);
      const top = g.parts((p) => flat(g, p.id) <= 1.1 * IN && (g.size(p.id)?.[0] ?? 0) >= 40 * IN);
      g.check(top.length === 1, `${top.length} tops`);
      if (top[0]) g.check(top[0].shape.type === 'outline', 'rounded corners need an outline top');
      g.noOverlaps();
    },
  },
  {
    name: 'bookshelf',
    start: 'empty',
    steps: ['Bookshelf 36" wide, 72" tall, 12" deep, 3/4 ply, four adjustable shelves'],
    check(g) {
      g.overallSize([36, 72, 12], 1 / 2);
      const horizontal = g.parts((p) => {
        const s = g.size(p.id);
        return !!s && s[1] <= IN && s[0] >= 30 * IN;
      });
      g.check(horizontal.length >= 6, `${horizontal.length} horizontal panels (want top, bottom + 4 shelves)`);
    },
  },
  {
    name: 'bench',
    start: 'empty',
    steps: ['A simple bench from 4/4 maple: 48" long, 14" deep, 18" high, two slab ends and a stretcher under the seat'],
    check(g) {
      g.overallSize([48, 18, 14], 1 / 2);
      g.check(g.parts().length >= 4, `only ${g.parts().length} parts`);
      g.noOverlaps();
      g.check(g.parts().every((p) => p.material === 'maple-4-4'), 'not all maple');
    },
  },
  {
    name: 'floating shelf beside existing model',
    start: 'demo',
    steps: ['Add a floating shelf, 36" long, 10" deep, 1 1/2" thick, 60" off the floor'],
    check(g) {
      const shelf = g.parts((p) => !['tabletop', 'door'].includes(p.id) && !p.role);
      if (!g.check(shelf.length >= 1, 'no new shelf')) return;
      const b = g.overall(shelf.map((p) => p.id))!;
      g.near(b.max[0] - b.min[0], 36, 'shelf length');
      g.near(b.max[2] - b.min[2], 10, 'shelf depth');
      g.near(b.max[1] - b.min[1], 1.5, 'shelf thickness');
      g.near(b.min[1], 60, 'shelf height', 1 / 2);
      g.noOverlaps(shelf.map((p) => p.id));
    },
  },
  // ── Phase 3: markup notes ("select two parts, write a note, AI fixes it") ────
  {
    name: 'note: top overhang at the front',
    start: 'demo',
    setup: [note('n1', 'The top should overhang the front of the cabinet by 1 1/2" (keep it flush at the back)', { node: 'tabletop', handle: 'face:side-fr' }, { node: 'a1.side-right', handle: 'face:front' })],
    steps: ['Fix my notes.'],
    check(g) {
      const b = g.box('tabletop');
      g.near(b && b.max[2] - 24 * IN, 1.5, 'front overhang', 1 / 16);
      g.near(b?.min[2], 0, 'back edge', 1 / 8);
      g.noteResolved('n1');
    },
  },
  {
    name: 'note: hang this door on that cabinet',
    start: 'demo',
    setup: [note('n1', 'Hang this door on the front of that cabinet, full overlay, hinged on the left', { node: 'door' }, { node: 'a1.side-left', handle: 'face:front' })],
    steps: ['Fix my notes.'],
    check(g) {
      const b = g.box('door');
      g.near(b?.min[2], 24, 'door back against the cabinet front', 1 / 8);
      g.near(b?.min[0], 0, 'door left edge over the left side', 1 / 2);
      g.check(!!b && b.min[1] >= 4 * IN - 8, 'door hangs below the toe kick line');
      g.noOverlaps(['door']);
      g.noteResolved('n1');
    },
  },
  {
    name: 'note on a hole: bigger and lower',
    start: 'demo',
    setup: [note('n1', 'Make this a 2 1/2" cord grommet hole, 6" lower', { node: 'a1.side-right', handle: 'f1:wall' })],
    steps: ['Fix my notes.'],
    check(g) {
      const holes = g.features(g.parts((p) => p.id === 'a1.side-right')[0], 'hole').filter((h) => h.depth === undefined);
      g.check(holes.length === 1, `through holes in the right side: ${holes.length}`);
      const h = holes[0];
      g.near(h?.d as number, 2.5, 'hole diameter', 1 / 64);
      g.near((h?.at as number[] | undefined)?.[1], 18, 'hole height', 1 / 16);
      g.near((h?.at as number[] | undefined)?.[0], 12, 'hole stays 12" back', 1 / 16);
      g.noteResolved('n1');
    },
  },
  {
    name: 'note on an edge: bigger roundover',
    start: 'demo',
    setup: [note('n1', 'Bigger roundover here — 1/2"', { node: 'tabletop', handle: 'edge:top-fr' })],
    steps: ['Fix my notes.'],
    check(g) {
      const p = g.features(g.parts((x) => x.id === 'tabletop')[0], 'edgeProfile').find((f) => (f.edges as string[]).includes('edge:top-fr'));
      g.check(p?.profile === 'roundover', `profile on edge:top-fr: ${JSON.stringify(p)}`);
      g.near(p?.r as number, 0.5, 'roundover radius', 1 / 64);
      g.noteResolved('n1');
    },
  },
  {
    name: 'relational note: this shelf sits on that top',
    start: 'demo',
    setup: [
      { op: 'add', entity: { kind: 'part', id: 'shelf', name: 'Display shelf', material: 'maple-4-4', grain: 'x', transform: { position: [60 * IN, 50 * IN, 0] }, shape: { type: 'box', params: { x: 30 * IN, y: 48, z: 10 * IN } } } },
      note('n1', 'This shelf should sit on that top, centered side to side, against the back', { node: 'shelf' }, { node: 'tabletop', handle: 'face:top' }),
    ],
    steps: ['Fix my notes.'],
    check(g) {
      const s = g.box('shelf');
      const t = g.box('tabletop');
      if (!s || !t) return void g.check(false, 'shelf or tabletop missing');
      g.near(s.min[1], t.max[1] / IN, 'shelf bottom on the top', 1 / 16);
      g.near((s.min[0] + s.max[0]) / 2, (t.min[0] + t.max[0]) / 2 / IN, 'shelf centered', 1 / 4);
      g.near(s.min[2], t.min[2] / IN, 'shelf against the back', 1 / 8);
      g.noteResolved('n1');
    },
  },
  {
    name: 'two notes in one go',
    start: 'demo',
    setup: [
      note('n1', 'Cabinet should be 30" wide', { node: 'a1.top', handle: 'face:top' }),
      note('n2', 'Door 1/4" shorter', { node: 'door', handle: 'face:top' }),
    ],
    steps: ['Please address my notes.'],
    check(g) {
      g.near(g.oneCarcass()?.params.width, 30, 'cabinet width');
      g.near(g.size('door')?.[1], 30, 'door height', 1 / 64);
      g.noteResolved('n1');
      g.noteResolved('n2');
    },
  },
  {
    name: 'variables: doors get editable fields that follow the cabinet',
    start: 'empty',
    steps: ['base cabinet 30 wide with one shelf', 'add two full-overlay doors'],
    check(g) {
      const vars = Object.values(g.doc.variables);
      const doorVars = vars.filter((v) => /door/i.test(v.group));
      g.check(doorVars.length >= 2, `door variables: ${JSON.stringify(vars.map((v) => `${v.group} › ${v.name}`))}`);
      const doors = g.named(/door/i).filter((p) => !p.role);
      g.check(doors.length === 2, `doors: ${doors.map((p) => p.name).join(', ') || 'none'}`);
      g.check(doors.length > 0 && doors.every((p) => Object.keys(p.bind ?? {}).length >= 2), 'doors are bound to variables');
      const ids = doors.map((p) => p.id);
      g.noOverlaps(ids);
      const span = (gr: Grader) => {
        const b = gr.overall(ids);
        return b && b.max[0] - b.min[0];
      };
      g.near(span(g), 30, 'doors span the cabinet', 1 / 4);
      // Every door field the user would nudge still gives a valid model.
      for (const v of doorVars) {
        const r = applyOps(g.doc, [{ op: 'update', id: v.id, patch: { value: v.value + (v.unit === 'length' ? 4 : 1) } }]);
        g.check(r.ok, `nudging ${v.group} › ${v.name}: ${r.ok ? '' : r.error}`);
      }
      // Resize the cabinet the way a face drag does: the doors follow.
      const c = g.oneCarcass();
      if (!c) return;
      const r = applyOps(g.doc, [{ op: 'update', id: c.id, patch: { params: { width: 32 * IN } } }]);
      if (!g.check(r.ok, `resizing the cabinet: ${r.ok ? '' : r.error}`) || !r.ok) return;
      const wider = new Grader(r.doc);
      g.near(span(wider), 32, 'doors span the resized cabinet', 1 / 4);
      wider.noOverlaps(ids);
      g.failures.push(...wider.failures);
    },
  },
  {
    name: 'joinery: dadoed bookcase with a cut list that includes the dados',
    start: 'empty',
    steps: ['Build a bookcase 30" wide, 36" tall, 11 1/4" deep from 3/4" plywood with a top, a bottom and two fixed shelves, all dadoed into the sides'],
    check(g) {
      const dados = Object.values(g.doc.joints).filter((j) => j.type === 'dado' || j.type === 'rabbet');
      g.check(dados.length >= 6, `dado / rabbet joints: ${dados.length} (want top, bottom and 2 shelves into both sides)`);
      const list = cutList(g.doc);
      g.check(list.problems.length === 0, `cut list problems: ${list.problems.join(' | ')}`);
      g.noOverlaps(Object.keys(g.doc.parts));
      const overall = g.overall();
      g.near(overall && overall.max[0] - overall.min[0], 30, 'overall width', 1 / 8);
      // A shelf between the sides is cut longer than it looks by the two dado depths.
      const cuts = cutParts(g.doc).parts;
      const shelf = cuts.find((p) => /shelf/i.test(p.name));
      const sideT = 46;
      g.check(!!shelf && shelf.allowances.length === 2, `shelf allowances: ${JSON.stringify(shelf?.allowances ?? null)}`);
      if (shelf) g.near(shelf.length - shelf.allowances.reduce((s, a) => s + a.depth, 0), 30 - (2 * sideT) / IN, 'shelf visible length', 1 / 8);
    },
  },
  // ── Blockout: sketched placeholder blocks, told what they are by notes ───────
  {
    name: 'blocks: a row of blocks becomes cabinets, the fridge stays a block',
    start: 'empty',
    setup: [
      block('b1', [0, 0, 0], [0, 0, 0], [36, 34.5, 24]),
      block('b2', [36, 0, 0], [0, 0, 0], [18, 34.5, 24]),
      block('b3', [54, 0, 0], [0, 0, 0], [36, 70, 30]),
      note('n1', 'Sink base: two doors, no shelf', { node: 'b1' }),
      note('n2', 'Three-drawer base', { node: 'b2' }),
      note('n3', 'This is the fridge — leave it as a placeholder', { node: 'b3' }),
    ],
    steps: ['Please address my notes.'],
    check(g) {
      g.check(!g.doc.parts.b1 && !g.doc.parts.b2, 'blocks b1 and b2 should be replaced by cabinets');
      g.check(!!g.doc.parts.b3?.block, 'the fridge block stays a block');
      g.check(/fridge/i.test(g.doc.parts.b3?.name ?? ''), `fridge block renamed: "${g.doc.parts.b3?.name}"`);
      const cabs = g.carcasses();
      g.check(cabs.length === 2, `carcasses: ${cabs.length}`);
      const at = (x: number) => cabs.find((c) => Math.abs((g.box(c.id)?.min[0] ?? Infinity) - x * IN) <= 8);
      g.near(at(0)?.params.width, 36, 'sink base width', 1 / 8);
      g.near(at(36)?.params.width, 18, 'drawer base width', 1 / 8);
      g.check((at(36)?.params.drawers.length ?? 0) === 3, `drawer base drawers: ${JSON.stringify(at(36)?.params.drawers)}`);
      g.noOverlaps();
      for (const n of ['n1', 'n2', 'n3']) g.noteResolved(n);
    },
  },
  {
    name: 'blocks: a turned block becomes a cabinet facing the same way',
    start: 'empty',
    setup: [block('b1', [0, 0, 0], [0, 90, 0], [30, 34.5, 24]), note('n1', 'Base cabinet with one shelf', { node: 'b1' })],
    steps: ['Please address my notes.'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      // The block's front (+z) faced +x: the cabinet's front must too, filling the same space.
      g.check(!g.doc.parts.b1, 'block replaced');
      g.near(c.params.width, 30, 'width', 1 / 8);
      const b = g.box(c.id);
      g.near(b?.min[0], 0, 'back at x = 0', 1 / 8);
      g.near(b?.max[0], 24, 'front at x = 24"', 1 / 8);
      g.near(b?.min[2], -30, 'left end', 1 / 8);
      g.near(b?.max[2], 0, 'right end', 1 / 8);
      g.noteResolved('n1');
    },
  },
  {
    name: 'animation: a drawer over a pair of carcass doors, all opening',
    start: 'empty',
    steps: ['Base cabinet 30" wide with one drawer over a pair of doors'],
    check(g) {
      const c = g.oneCarcass();
      if (!c) return;
      g.check(c.params.doors === 2, `doors: ${c.params.doors}`);
      g.check(c.params.drawers.length === 1, `drawers: ${JSON.stringify(c.params.drawers)}`);
      const generated = Object.values(g.doc.motions).filter((m) => m.role);
      const sides = generated.filter((m) => m.type === 'hinge').map((m) => m.params.side).sort();
      g.check(JSON.stringify(sides) === '["left","right"]', `door hinges: ${JSON.stringify(sides)}`);
      g.check(generated.some((m) => m.type === 'slide'), 'the drawer slides');
      // Nothing doubles up the generated ones.
      const user = Object.values(g.doc.motions).filter((m) => !m.role);
      g.check(user.length === 0, `extra animations: ${user.map((m) => `${m.id} ${m.type}`).join(', ')}`);
      g.check(clearance(g.doc).length === 0, `opening check: ${clearance(g.doc).map((x) => clashText(g.doc, x)).join('; ')}`);
    },
  },
  {
    name: 'animation: a hand-built frame-and-panel door swings as one',
    start: 'empty',
    steps: ['Build a frame-and-panel door 18" wide and 30" tall: 2 1/4" stiles and rails of 3/4" maple around a 1/4" plywood panel, hinged on the right'],
    check(g) {
      const motions = Object.values(g.doc.motions);
      g.check(motions.length === 1, `animations: ${motions.length}`);
      const m = motions[0];
      if (!m) return;
      g.check(m.type === 'hinge' && m.params.side === 'right', `hinge: ${m.type} ${JSON.stringify(m.params)}`);
      const moving = movingParts(g.doc, m.nodes);
      const door = g.parts((p) => !p.block);
      g.check(door.length >= 5, `door parts: ${door.length}`);
      g.check(door.every((p) => moving.has(p.id)), `doesn't move: ${door.filter((p) => !moving.has(p.id)).map((p) => p.name).join(', ')}`);
      g.check(m.nodes.length === 1 && !!g.doc.assemblies[m.nodes[0]!], `animates ${m.nodes.join(', ')} rather than the door's folder`);
    },
  },
  {
    name: 'animation: a door beside a wall opens clear, or the AI says why not',
    start: 'empty',
    setup: [block('wall', [-4, 0, -12], [0, 0, 0], [4, 96, 48]), { op: 'update', id: 'wall', patch: { name: 'Wall' } }],
    steps: ['Base cabinet 18" wide with one door, set right against the wall on its left'],
    check(g, replies) {
      const c = g.oneCarcass();
      if (!c) return;
      g.near(g.box(c.id)?.min[0], 0, 'cabinet against the wall', 1);
      const hits = clearance(g.doc);
      const said = /hit|clear|filler|90/i.test(replies.at(-1) ?? '');
      g.check(hits.length === 0 || said, `opening check: ${hits.map((x) => clashText(g.doc, x)).join('; ')} (not mentioned)`);
    },
  },
  // ── Presentation: the room around the model (`-t presentation`) ──────────────
  {
    name: 'presentation: room around a run, a window over the sink and a right-wall doorway',
    start: 'empty',
    setup: [
      cabinet('sink', 'Sink base 36"', 0, { width: 36 * IN, doors: 2, shelves: 0 }),
      cabinet('drawers', 'Drawer base 18"', 36, { width: 18 * IN, drawers: [0, 0, 0], shelves: 0 }),
    ],
    steps: ['Put a room around these cabinets, with a 36" wide window centered over the sink base and a 32" doorway in the right wall.'],
    check(g) {
      const all = Object.values(g.doc.assemblies).filter((a) => a.generator?.type === 'room');
      g.check(all.length === 1, `rooms: ${all.length}`);
      const room = roomOf(g.doc);
      if (!room) return;
      const p = roomParams(room);
      g.near(p.back, 0, 'back wall flush behind the cabinets');
      g.check(p.right >= 54 * IN && p.left <= 0, `the room holds the run (x ${p.left / IN}" to ${p.right / IN}")`);
      const win = p.openings.find((o) => o.kind === 'window');
      g.check(win?.wall === 'back', `window on the back wall: ${win?.wall ?? 'none'}`);
      g.near(win?.at, 18, 'window centered over the sink', 1 / 2);
      g.near(win?.width, 36, 'window width', 1 / 2);
      const door = p.openings.find((o) => o.wall === 'right' && o.kind !== 'window');
      g.check(!!door, 'a doorway on the right wall');
      g.near(door?.width, 32, 'doorway width', 1 / 2);
      const issues = roomIssues(g.doc);
      g.check(issues.length === 0, `room issues: ${issues.join('; ')}`);
      g.noOverlaps(modelPartIds(g.doc));
    },
  },
  {
    name: 'presentation: a room door near cabinets swings clear, or the AI says why not',
    start: 'empty',
    setup: [
      cabinet('base', 'Base 24"', 0, { width: 24 * IN, doors: 1, shelves: 1 }),
      {
        op: 'add',
        entity: { kind: 'assembly', id: 'room', name: 'Room', generator: { type: 'room', params: { left: -36 * IN, right: 48 * IN, back: 0, front: 120 * IN } } },
      },
    ],
    steps: ['Add a 32" door in the right wall of the room, as close to the back corner as it can go.'],
    check(g, replies) {
      const room = roomOf(g.doc);
      const p = room && roomParams(room);
      const door = p?.openings.find((o) => o.kind === 'door' && o.wall === 'right');
      g.check(!!door, `a door on the right wall: ${JSON.stringify(p?.openings ?? null)}`);
      g.near(door?.width, 32, 'door width', 1 / 2);
      const hits = clearance(g.doc).filter((c) => c.motion.startsWith('room.') || (c.with ?? '').startsWith('room.'));
      const said = /hit|clear|swing|hinge|cabinet/i.test(replies.at(-1) ?? '');
      g.check(hits.length === 0 || said, `opening check: ${hits.map((x) => clashText(g.doc, x)).join('; ')} (not mentioned)`);
    },
  },
  {
    name: 'presentation: island stools and pendants',
    start: 'empty',
    setup: [
      // An island: a 72" run of base cabinets facing −z, its seating side (+z) open, with a top overhanging 12" there.
      { op: 'add', entity: { kind: 'assembly', id: 'island', name: 'Island 72"', transform: { position: [72 * IN, 0, 48 * IN], rotation: [0, 180, 0] }, generator: { type: 'carcass', params: { width: 72 * IN, height: 34.5 * IN, depth: 24 * IN, material: 'ply-3-4', doors: 2 } } } },
      { op: 'add', entity: { kind: 'part', id: 'top', name: 'Island top', material: 'ply-3-4', transform: { position: [0, 34.5 * IN, 24 * IN] }, shape: { type: 'box', params: { x: 72 * IN, y: 1.5 * IN, z: 37 * IN } } } },
    ],
    steps: ['Put three bar stools along the seating side of the island (the +z side, under the overhang) and two pendants over it.'],
    check(g) {
      const top = g.box('top');
      const stools = g.parts((p) => p.shape.type === 'barStool');
      const pendants = g.parts((p) => p.shape.type === 'pendant');
      g.check(stools.length === 3, `stools: ${stools.length}`);
      g.check(pendants.length === 2, `pendants: ${pendants.length}`);
      if (!top) return;
      const parents = parentIndex(g.doc);
      for (const s of stools) {
        const b = g.box(s.id);
        if (!b) continue;
        g.near(b.min[1], 0, `${s.name} on the floor`, 1 / 4);
        g.check(b.min[0] >= top.min[0] - 6 * IN && b.max[0] <= top.max[0] + 6 * IN, `${s.name} along the island (x ${b.min[0] / IN}–${b.max[0] / IN}")`);
        g.check(b.min[2] >= 48 * IN - 1 * IN && b.min[2] <= top.max[2] + 6 * IN, `${s.name} on the seating side (z ${b.min[2] / IN}")`);
        g.check(frontOf(g.doc, s.id)[2] < -0.9, `${s.name} faces the island`);
        g.check(s.shape.params.seatHeight === undefined || Math.abs((s.shape.params.seatHeight as number) - 24 * IN) <= 2 * IN, `${s.name} counter height: ${(s.shape.params.seatHeight as number) / IN}"`);
        g.check(parents.get(s.id) !== null && parents.get(s.id) !== undefined, `${s.name} is in a folder`);
      }
      for (const p of pendants) {
        const b = g.box(p.id);
        if (!b) continue;
        const above = (b.min[1] - top.max[1]) / IN;
        g.check(above >= 24 && above <= 42, `${p.name} shade ${above}" above the counter`);
        g.check(b.min[0] >= top.min[0] && b.max[0] <= top.max[0], `${p.name} over the island`);
      }
      g.noOverlaps(stools.map((s) => s.id));
    },
  },
  {
    name: 'presentation: a fridge block becomes a fridge in exactly its space',
    start: 'empty',
    setup: [
      cabinet('base', 'Base 30"', 0, { width: 30 * IN, doors: 2 }),
      block('fb', [30, 0, 0], [0, 0, 0], [36, 70, 30]),
      { op: 'update', id: 'fb', patch: { name: 'Fridge 36"' } },
    ],
    steps: ['Show the fridge block as a real stainless French-door fridge.'],
    check(g) {
      g.check(!g.doc.parts.fb, 'the block is gone');
      const fridges = Object.values(g.doc.assemblies).filter((a) => a.generator?.type === 'fridge');
      g.check(fridges.length === 1, `fridges: ${fridges.length}`);
      const f = fridges[0];
      if (!f) return;
      const p = f.generator!.params as Record<string, number | string>;
      g.near(p.width as number, 36, 'width', 1 / 2);
      g.near(p.height as number, 70, 'height', 1 / 2);
      g.near(p.depth as number, 30, 'depth', 1 / 2);
      g.check(f.transform.position[0] === 30 * IN && f.transform.position[2] === 0 && f.transform.rotation.every((r) => r === 0), `in the block's place: ${JSON.stringify(f.transform)}`);
      g.check((p.style ?? 'french') === 'french' && (p.finish ?? 'stainless') === 'stainless', `style ${p.style}, finish ${p.finish}`);
    },
  },
  {
    name: 'presentation: a three-shot client tour',
    start: 'empty',
    setup: [
      cabinet('sink', 'Sink base 36"', 0, { width: 36 * IN, doors: 2, shelves: 0 }),
      cabinet('drawers', 'Drawer base 18"', 36, { width: 18 * IN, drawers: [0, 0, 0], shelves: 0 }),
      { op: 'add', entity: { kind: 'assembly', id: 'island', name: 'Island 48"', transform: { position: [48 * IN, 0, 72 * IN], rotation: [0, 180, 0] }, generator: { type: 'carcass', params: { width: 48 * IN, height: 34.5 * IN, depth: 24 * IN, material: 'ply-3-4', drawers: [0, 0, 0], shelves: 0 } } } },
    ],
    steps: ['Set up a three-shot client tour: the whole kitchen, the island with its drawers open, the sink base with doors open.'],
    check(g) {
      const views = g.doc.presentation?.views ?? [];
      g.check(views.length === 3, `views: ${views.length}`);
      const [whole, island, sink] = views;
      const covers = (v: typeof whole, ids: string[]) => !!v?.frame && (v.frame.nodes.length === 0 || ids.every((id) => v.frame!.nodes.includes(id)));
      g.check(covers(whole, ['sink', 'drawers', 'island']), `shot 1 frames the whole kitchen: ${JSON.stringify(whole?.frame ?? whole?.camera)}`);
      g.check(!!island?.frame?.nodes.includes('island'), `shot 2 frames the island: ${JSON.stringify(island?.frame)}`);
      g.check(!!sink?.frame?.nodes.includes('sink'), `shot 3 frames the sink base: ${JSON.stringify(sink?.frame)}`);
      const opens = (v: typeof whole, prefix: string, kind: RegExp) => (v ? viewMotions(g.doc, v) : []).filter((m) => m.startsWith(`${prefix}.`) && kind.test(m));
      g.check(opens(island, 'island', /drawer/).length === 3, `shot 2 opens the island's drawers: ${island ? viewMotions(g.doc, island).join(', ') : 'none'}`);
      g.check(opens(sink, 'sink', /door/).length === 2, `shot 3 opens the sink doors: ${sink ? viewMotions(g.doc, sink).join(', ') : 'none'}`);
      g.check(views.every((v) => !!v.caption && v.caption.length <= 160), `short captions: ${views.map((v) => JSON.stringify(v.caption)).join(', ')}`);
    },
  },
];

/** A carcass at x inches along the back (z = 0), facing +z. */
function cabinet(id: string, name: string, x: number, params: Record<string, unknown>): Op {
  return {
    op: 'add',
    entity: {
      kind: 'assembly',
      id,
      name,
      transform: { position: [x * IN, 0, 0] },
      generator: { type: 'carcass', params: { width: 24 * IN, height: 34.5 * IN, depth: 24 * IN, material: 'ply-3-4', ...params } },
    },
  };
}
