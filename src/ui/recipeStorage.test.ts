import { describe, expect, it } from 'vitest';
import { demoDoc } from '../model/defaults';
import { captureRecipe } from '../model/recipes';
import { createRecipeLibrary, RECIPE_LIBRARY_KEY, type RecipeStorage } from './recipeStorage';

function memory() {
  const data = new Map<string, string>();
  const storage: RecipeStorage = { getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); } };
  return { data, storage };
}
const recipe = () => captureRecipe(demoDoc(), { name: 'Cabinet', description: 'Frameless construction' });

describe('recipe library storage', () => {
  it('survives creating a fresh library and preserves independent records', async () => {
    const { storage } = memory();
    const saved = recipe();
    await createRecipeLibrary(storage).save(saved);
    const loaded = createRecipeLibrary(storage).read();
    expect(loaded).toEqual([saved]);
    loaded[0]!.name = 'Changed';
    expect(createRecipeLibrary(storage).read()[0]!.name).toBe('Cabinet');
  });
  it('reads the latest entries on every save across library instances', async () => {
    const { storage } = memory();
    const a = createRecipeLibrary(storage), b = createRecipeLibrary(storage);
    expect(b.read()).toEqual([]);
    await a.save(recipe());
    await b.save(recipe());
    expect(a.read()).toHaveLength(2);
  });
  it.each(['{broken', JSON.stringify({ version: 2, recipes: [] }), JSON.stringify({ version: 1, recipes: [{}] })])('preserves malformed or future storage: %s', async (raw) => {
    const { storage, data } = memory();
    data.set(RECIPE_LIBRARY_KEY, raw);
    const library = createRecipeLibrary(storage);
    expect(() => library.read()).toThrow('could not be loaded');
    await expect(library.save(recipe())).rejects.toThrow('could not be loaded');
    expect(data.get(RECIPE_LIBRARY_KEY)).toBe(raw);
  });
  it('reports a failed write without claiming success or losing existing records', async () => {
    const { storage } = memory();
    const saved = recipe();
    await createRecipeLibrary(storage).save(saved);
    const library = createRecipeLibrary({ ...storage, setItem: () => { throw new Error('quota exceeded'); } });
    await expect(library.save(recipe())).rejects.toThrow('was not saved');
    expect(library.read()).toEqual([saved]);
  });
  it('reports unavailable reads and refuses writes', async () => {
    let writes = 0;
    const library = createRecipeLibrary({ getItem: () => { throw new Error('unavailable'); }, setItem: () => { writes++; } });
    await expect(library.save(recipe())).rejects.toThrow('unavailable');
    expect(writes).toBe(0);
  });
  it('rejects duplicate identifiers without replacing a saved recipe', async () => {
    const { storage } = memory();
    const library = createRecipeLibrary(storage), saved = recipe();
    await library.save(saved);
    await expect(library.save(saved)).rejects.toThrow('already saved');
    expect(library.read()).toEqual([saved]);
  });
  it('preserves valid entries when any sibling entry is malformed', async () => {
    const { storage, data } = memory();
    const raw = JSON.stringify({ version: 1, recipes: [recipe(), {}] });
    data.set(RECIPE_LIBRARY_KEY, raw);
    await expect(createRecipeLibrary(storage).save(recipe())).rejects.toThrow('could not be loaded');
    expect(data.get(RECIPE_LIBRARY_KEY)).toBe(raw);
  });
  it('reads after acquiring the write lock so waiting writers preserve new entries', async () => {
    const { storage } = memory();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const waiting = createRecipeLibrary(storage, async (write) => { await gate; return write(); });
    const save = waiting.save(recipe());
    await createRecipeLibrary(storage).save(recipe());
    release();
    await save;
    expect(waiting.read()).toHaveLength(2);
  });
});
