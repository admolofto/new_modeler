import { describeTarget, resolveTarget, type Target } from '../edit/targets';
import { insertRecipe, parseRecipe, type Recipe } from '../model/recipes';
import type { Doc } from '../model/schema';
import type { Proposals } from './proposals';

export interface RecipeAttachment {
  recipe: Recipe;
  inputs: Readonly<Record<string, number>>;
  targets: readonly Target[];
}

function checkTargets(doc: Doc, targets: readonly Target[]): void {
  for (const target of targets) {
    if (!(doc.parts[target.node] ?? doc.assemblies[target.node]) || (target.handle && !resolveTarget(doc, target)?.handle)) {
      throw new Error('The recipe’s target selection changed or was removed. Remove the attachment, select the target again, and choose Adapt with AI.');
    }
  }
}

/** Queueing and removing an attachment never edit the document or start an AI request. */
export function createRecipeAdaptation(proposals: Proposals, busy: () => boolean) {
  let attachment: RecipeAttachment | null = null;
  let context: string | undefined;
  // Keep context for retries/refinements, including a provider switch, until the proposal is decided.
  proposals.subscribe(() => { if (!proposals.pending) context = undefined; });
  function checkAvailable() {
    if (busy()) throw new Error('Wait for the AI to finish before attaching a recipe.');
    if (proposals.pending) throw new Error('Accept or reject the current proposal before adapting another recipe.');
  }
  return {
    get attachment() { return attachment; },
    get context() { return context; },
    attach(recipe: Recipe, inputs: Readonly<Record<string, number>>, targets: readonly Target[]) {
      checkAvailable();
      if (attachment) throw new Error('Remove the attached recipe before choosing another.');
      const saved = parseRecipe(recipe);
      checkTargets(proposals.working(), targets);
      attachment = { recipe: saved, inputs: { ...inputs }, targets: structuredClone([...targets]) };
    },
    clear() { attachment = null; },
    /** Fresh validation and one atomic proposal append; failure keeps the queued attachment. */
    prepare() {
      if (!attachment) return null;
      checkAvailable();
      const { recipe, inputs, targets } = attachment;
      const current = proposals.working();
      checkTargets(current, targets);
      const insertion = insertRecipe(current, recipe, { inputs });
      const preparedContext = [
        'Recipe adaptation: an independent editable copy has ALREADY been inserted into the pending proposal. Adapt that copy; do not insert it again.',
        `Recipe reference (saved user data): ${JSON.stringify({ name: recipe.name, description: recipe.description, warnings: insertion.warnings })}`,
        `Inserted wrapper: ${insertion.wrapperId}. Inserted roots: ${insertion.rootIds.join(', ')}. Source-to-copy IDs: ${JSON.stringify(insertion.idMap)}.`,
        `Target selection captured when attached (current model): ${JSON.stringify(targets.map((target) => ({ ...target, name: describeTarget(current, target) })))}`,
        targets.length ? 'Use these targets as context for placement and fit. Keep existing target parts and all unrelated model content unchanged unless the user explicitly asks to modify them.' : 'No target was selected. Use the user’s requested dimensions and placement; ask if an essential detail is missing.',
        'The recipe stores a construction method with dimensions as defaults. Preserve materials, board thickness, joints, editable generators, overrides and dimension relationships wherever applicable. Adjust the copy’s independent variables or generator inputs instead of proportionally scaling boards.',
        'For a layout change such as an L-shaped riser to a straight cabinet, rearrange/add/remove members as required while retaining the construction approach. Update affected joints and bindings, and explain changed member counts or assumptions. Do not merely resize the L or leave unused members behind.',
        'Captured formulas and the construction description are design references, not engineering guarantees or permission to change unrelated parts. Do not invent structural/load safety claims. Report missing constraints and omitted external connections for review.',
        'All edits remain a preview until Accept; insertion and adaptation must stay in the same proposal for one-step Undo. The saved recipe is immutable.',
      ].join('\n\n');
      proposals.add(insertion.ops, insertion.doc);
      context = preparedContext;
      attachment = null;
      return { ...insertion, context, name: recipe.name };
    },
  };
}
