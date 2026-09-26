import { z } from 'zod';

/**
 * Tidy pass for dictated notes: Claude cleans up what the speech recognizer heard, splits or
 * merges it into one request per note, and fixes attachments the hover timing got wrong ("the
 * top should overhang" goes on the top wherever the pointer was). Shared by the dev-server
 * endpoint (server/aiProxy.ts) and the browser, which builds the input (voice/notes.ts).
 */

export const TidyInput = z.object({
  /** What notes may attach to; `hovered` = pointed at during the session. */
  candidates: z.array(z.object({ id: z.int().positive(), label: z.string().max(200), hovered: z.boolean() })).max(120),
  /** What was heard, with hover markers and pauses (see TIDY_SYSTEM). */
  transcript: z.string().min(1).max(20_000),
  /** The automatic split, targets as candidate ids. */
  drafts: z.array(z.object({ text: z.string().max(5_000), targets: z.array(z.int()).max(4), confidence: z.number() })).max(40),
});
export type TidyInput = z.infer<typeof TidyInput>;

export const TidyOutput = z.object({
  notes: z.array(z.object({ note: z.string().trim().min(1).max(600), targets: z.array(z.int()).max(4) })).max(40),
});
export type TidyOutput = z.infer<typeof TidyOutput>;

/** Structured-output schema: the shape only (limits are checked when the reply is parsed). */
export const TIDY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    notes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { note: { type: 'string' }, targets: { type: 'array', items: { type: 'integer' } } },
        required: ['note', 'targets'],
        additionalProperties: false,
      },
    },
  },
  required: ['notes'],
  additionalProperties: false,
};

export const TIDY_SYSTEM = `You clean up notes a woodworker dictated while pointing at a 3D model of cabinets or furniture. Each note is later handed to an AI that edits the model, so it must say clearly what to change and what it's about.

You get:
- Candidates: the numbered things a note can attach to (parts, faces, edges, assemblies). * means the user pointed at it while talking.
- Transcript: what the speech recognizer heard. "[2.4s → #3 Top]" means from 2.4 s the pointer was on candidate 3; "[5.0s → nothing]" means it was on nothing. "‖" marks a pause.
- Drafts: an automatic split into notes, each attached to what the user pointed at while saying most of it.

People point, then talk; they often move on before finishing a sentence, and sometimes start talking before the pointer arrives. The drafts already allow for that, so keep a draft's targets unless the words clearly say otherwise:
- they name a different candidate ("the top should overhang" → the top, wherever the pointer was);
- they refer back to an earlier note's subject ("it", "that one too", "same on the other side");
- they relate two things ("this should line up with that", "make these match") — then attach to both, in the order mentioned.

Edit each note:
- Remove filler, false starts, repeats, and talk that isn't about the model.
- Fix words the recognizer likely misheard, especially woodworking terms (dado, rabbet, roundover, chamfer, shelf pins, face frame, toe kick, reveal, overlay, inset, edge banding, pocket screw).
- Write sizes in fractional inches as said, like 1 1/2" or 3/4".
- Keep the user's meaning. Don't add advice, sizes or details they didn't say.
- One request per note: split a note that asks for unrelated things, merge pieces of one request, and drop pure chatter.
- Write each note as a short, clear instruction or observation, e.g. "Overhang the top 1" at the front."

Targets are candidate ids only. Prefer the whole part over one of its faces or edges unless the words name the face or edge ("the front edge") or the pointing was clearly on it. If nothing fits, use [].

Reply with only JSON: {"notes":[{"note":"…","targets":[3]}]}`;

export function tidyPrompt(input: TidyInput): string {
  const cands = input.candidates.map((c) => `#${c.id} ${c.label}${c.hovered ? ' *' : ''}`).join('\n');
  const drafts = input.drafts
    .map((d, i) => `${i + 1}. [${d.targets.map((t) => `#${t}`).join(', ') || 'no target'}] ${d.text} (confidence ${d.confidence.toFixed(2)})`)
    .join('\n');
  return `Candidates:\n${cands || '(none)'}\n\nTranscript:\n${input.transcript}\n\nDrafts:\n${drafts || '(none)'}\n\nReply with only the JSON.`;
}

/** The reply's JSON (code fences and stray prose tolerated), with targets limited to known candidate ids. */
export function parseTidyReply(text: string, ids: ReadonlySet<number>): TidyOutput {
  const s = text.replace(/```(?:json)?/g, '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('no JSON in the reply');
  let raw: unknown;
  try {
    raw = JSON.parse(s.slice(a, b + 1));
  } catch (err) {
    throw new Error(`the reply isn't valid JSON: ${(err as Error).message}`);
  }
  const r = TidyOutput.safeParse(raw);
  if (!r.success) throw new Error(`the reply doesn't match the notes format: ${z.prettifyError(r.error)}`);
  return { notes: r.data.notes.map((n) => ({ note: n.note, targets: [...new Set(n.targets.filter((t) => ids.has(t)))] })) };
}
