import { parseRecipe, type Recipe } from '../model/recipes';

export const RECIPE_LIBRARY_KEY = 'new-modeler.recipes';
export interface RecipeStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
type Lock = <T>(write: () => T) => Promise<T>;
const message = (error: unknown) => error instanceof Error ? error.message : String(error);

/** No recovery-by-overwrite: an unreadable library stays intact until the user recovers it. */
export function createRecipeLibrary(storage: RecipeStorage, lock?: Lock) {
  function read(): Recipe[] {
    try {
      const raw = storage.getItem(RECIPE_LIBRARY_KEY);
      if (raw === null) return [];
      const data: unknown = JSON.parse(raw);
      if (!data || typeof data !== 'object' || !('version' in data) || data.version !== 1) {
        throw new Error('unsupported library version; open it with a compatible app');
      }
      if (!('recipes' in data) || !Array.isArray(data.recipes)) throw new Error('missing recipe entries');
      const recipes = data.recipes.map(parseRecipe);
      if (new Set(recipes.map((r) => r.id)).size !== recipes.length) throw new Error('duplicate recipe identifiers');
      return recipes;
    } catch (error) {
      throw new Error(`Recipes could not be loaded: ${message(error)}. Your stored library has not been changed.`);
    }
  }
  async function save(value: Recipe): Promise<Recipe[]> {
    const recipe = parseRecipe(value);
    const write = () => {
      // Read inside the lock, never write a stale in-memory library back over another tab.
      const recipes = read();
      if (recipes.some((r) => r.id === recipe.id)) throw new Error('This recipe is already saved.');
      const next = [...recipes, recipe];
      try { storage.setItem(RECIPE_LIBRARY_KEY, JSON.stringify({ version: 1, recipes: next })); }
      catch (error) { throw new Error(`Recipe was not saved: ${message(error)}. Check browser storage space and permissions.`); }
      return next;
    };
    return lock ? lock(write) : write();
  }
  return { read, save };
}

export function browserRecipeLibrary() {
  // Access localStorage inside the methods: its getter itself can throw in restricted browsers.
  return createRecipeLibrary({
    getItem: (key) => localStorage.getItem(key),
    setItem: (key, value) => localStorage.setItem(key, value),
  }, typeof navigator !== 'undefined' && navigator.locks
    ? (write) => navigator.locks.request(RECIPE_LIBRARY_KEY, write)
    : undefined);
}
