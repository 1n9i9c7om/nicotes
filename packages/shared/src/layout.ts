import { z } from 'zod';
import { pageBlocks, SUB_LIST, subLists, tableRows, type PageBlock } from './blocks';
import { guessLanguage } from './language';
import { findServings, parseQuantity } from './recipe';

/**
 * Page layouts: besides editing, a page can be shown in a view that fits its content — a
 * checklist to tick and reorder, a recipe with servings and cook mode, a step-by-step guide,
 * or a reader that reads aloud. A layout spec names the type and which blocks (by key, see
 * `pageBlocks`) play which part; the views render and edit those blocks themselves.
 */

export const LAYOUT_TYPES = ['document', 'checklist', 'recipe', 'steps', 'reader'] as const;
export type LayoutType = (typeof LAYOUT_TYPES)[number];

export const LAYOUT_INFO: Record<LayoutType, { label: string; hint: string }> = {
  document: { label: 'Document', hint: 'A clean reading view' },
  checklist: { label: 'Checklist', hint: 'Tick, add, edit and reorder items' },
  recipe: { label: 'Recipe', hint: 'Servings, ingredients and a step-by-step cook mode' },
  steps: { label: 'Guide', hint: 'One step at a time, with timers' },
  reader: { label: 'Reader', hint: 'Read aloud with the current sentence highlighted' },
};

export const layoutSpecSchema = z.object({
  type: z.enum(LAYOUT_TYPES),
  /** ISO 639-1 code of the page's language (read-aloud voice, number format). */
  language: z.string().max(10).nullable(),
  /** Recipe: servings the amounts are for. */
  servings: z.number().int().positive().max(999).nullable(),
  /** Recipe: list blocks with the ingredients. */
  ingredients: z.array(z.string().max(300)).max(50),
  /** Recipe and guide: lists (one step per item) or paragraphs (one step each). */
  steps: z.array(z.string().max(300)).max(200),
  /** Checklist: the lists that make up the checklist. */
  lists: z.array(z.string().max(300)).max(100),
});
export type LayoutSpec = z.infer<typeof layoutSpecSchema>;

export const layoutRequestSchema = z.object({ type: z.enum(LAYOUT_TYPES).optional() });

/** A stored layout (made by the AI or chosen by hand), as GET /api/ai/layout/:pageId returns it. */
export interface PageLayoutInfo {
  spec: LayoutSpec;
  source: 'ai' | 'manual';
  /** The page changed since; the spec still applies if its blocks are found. */
  stale: boolean;
  model: string | null;
  cost: number;
  /** Why the AI chose this layout. */
  reason: string;
  createdAt: number;
}

const INGREDIENTS =
  /^(ingredients?|zutaten|ingrédients|ingredientes|ingredienti|ingrediënten|you(?:'ll)? need|what you need|was du brauchst|einkaufsliste|shopping list)\b/i;
const STEPS =
  /^(instructions?|directions?|method|steps?|preparation|how to make( it)?|zubereitung|anleitung|schritte|so geht'?s|préparation|preparación|preparazione|bereiding)\b/i;

const under = (block: PageBlock, re: RegExp) => block.heading.some((h) => re.test(h.replace(/[*_`]/g, '').trim()));
const keys = (blocks: PageBlock[]) => blocks.map((b) => b.key);
const byStart = (blocks: PageBlock[]) => [...blocks].sort((a, b) => a.start - b.start);
const plain = (text: string) => text.replace(/[*_`]/g, '').trim();

export const emptySpec = (type: LayoutType, language: string | null = null): LayoutSpec => ({
  type,
  language,
  servings: null,
  ingredients: [],
  steps: [],
  lists: [],
});

/**
 * Picks a layout from the page's structure, instantly and without AI. `confidence` (0–1) says
 * how sure it is; below ~0.75 the AI is asked. With `forced`, it fills in the parts for that
 * layout as well as it can.
 */
export function guessLayout(markdown: string, tags: string[] = [], forced?: LayoutType): LayoutSpec & { confidence: number } {
  const blocks = pageBlocks(markdown);
  const lists = blocks.filter((b): b is Extract<PageBlock, { kind: 'list' }> => b.kind === 'list');
  const prose = blocks.filter((b) => b.kind === 'paragraph' || b.kind === 'quote');
  const items = lists.flatMap((l) => l.items);
  const tasks = items.filter((i) => i.checked !== null);
  const proseChars = prose.reduce((n, b) => n + ('text' in b ? b.text.length : 0), 0);
  const listChars = items.reduce((n, i) => n + i.text.length, 0);
  const language = guessLanguage(markdown.slice(0, 5000));
  // Lists nested under a labelled item ("- **Method:**") count when the label itself fits;
  // tables count as ingredients under an ingredients heading or with an ingredient column.
  const subs = subLists(blocks);
  const labelled = (re: RegExp, chosen: PageBlock[]) =>
    subs.filter((s) => re.test(s.heading.at(-1) ?? '') && !chosen.some((c) => s.key.startsWith(`${c.key}${SUB_LIST}`)));
  const ingredientTables = blocks.filter(
    (b) => b.kind === 'table' && (under(b, INGREDIENTS) || tableRows(b.text).header.some((h) => INGREDIENTS.test(h.replace(/[*_`]/g, '').trim()))),
  );
  const ingredientLists = lists.filter((b) => under(b, INGREDIENTS));
  const ingredientBlocks = byStart([...ingredientLists, ...labelled(INGREDIENTS, ingredientLists), ...ingredientTables]);
  const stepHeaded = blocks.filter((b) => (b.kind === 'list' || b.kind === 'paragraph') && under(b, STEPS));
  const stepBlocks = byStart([...stepHeaded, ...labelled(STEPS, stepHeaded)]);
  const base = emptySpec('document', language);

  const recipe = (confidence: number) => {
    // Without headings: the list that reads most like ingredients (amounts first), then the
    // numbered lists after it, or else the section that follows it, as steps.
    const quantified = lists.filter((l) => l.items.filter((i) => parseQuantity(plain(i.text))).length >= l.items.length / 2);
    const ingredients = ingredientBlocks.length ? ingredientBlocks : (quantified[0] ?? lists[0]) ? [quantified[0] ?? lists[0]!] : [];
    const after = ingredients.at(-1)?.end ?? -1;
    const later = blocks.filter((b) => (b.kind === 'list' || b.kind === 'paragraph') && b.start > after);
    const ordered = later.filter((b) => b.kind === 'list' && b.ordered);
    const section = later.filter((b) => b.heading.join('/') === later[0]?.heading.join('/'));
    const steps = stepBlocks.length ? stepBlocks : ordered.length ? ordered : section;
    return { ...base, type: 'recipe' as const, servings: findServings(markdown), ingredients: keys(ingredients), steps: keys(steps), confidence };
  };
  const checklist = (confidence: number) => ({
    ...base,
    type: 'checklist' as const,
    lists: keys(tasks.length ? lists.filter((l) => l.items.some((i) => i.checked !== null)) : lists),
    confidence,
  });
  const steps = (confidence: number) => {
    const ordered = lists.filter((l) => l.ordered);
    const chosen = stepBlocks.length ? stepBlocks : ordered.length ? ordered : lists.length ? lists : prose;
    return { ...base, type: 'steps' as const, steps: keys(chosen), confidence };
  };

  if (forced === 'recipe') return recipe(1);
  if (forced === 'checklist') return checklist(1);
  if (forced === 'steps') return steps(1);
  if (forced) return { ...base, type: forced, confidence: 1 };

  if (ingredientBlocks.length && (stepBlocks.length || tags.includes('recipe'))) return recipe(0.9);
  if (tasks.length >= 2 && tasks.length >= items.length * 0.6 && listChars >= proseChars * 0.5) return checklist(0.85);
  if (ingredientBlocks.length) return recipe(0.6);
  if (tags.includes('recipe') && lists.length) return recipe(0.5);
  if (stepBlocks.length) return steps(0.75);
  if (proseChars >= 1200 && prose.length >= 4 && listChars < proseChars * 0.3) return { ...base, type: 'reader', confidence: 0.8 };
  const ordered = lists.filter((l) => l.ordered);
  const orderedItems = ordered.reduce((n, l) => n + l.items.length, 0);
  if (orderedItems >= 4 && orderedItems >= items.length * 0.7) return steps(0.6);
  // Short or mixed pages: a plain reading view is right, and the AI would not add much.
  return { ...base, confidence: markdown.length < 600 ? 0.9 : 0.5 };
}

/** Whether every block a spec refers to still exists in the page. */
export function specMatches(spec: LayoutSpec, blocks: PageBlock[]): boolean {
  const present = new Set([...blocks, ...subLists(blocks)].map((b) => b.key));
  return [...spec.ingredients, ...spec.steps, ...spec.lists].every((key) => present.has(key));
}
