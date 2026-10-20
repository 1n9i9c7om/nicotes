import type { ImportProfile } from '@nicotes/shared';
import type { RecipeData, Section } from './profiles.js';

type Node = Record<string, unknown>;

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** JSON-LD strings frequently contain HTML entities and tags; turn them into plain text. */
export function plain(value: unknown): string {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value)
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x?[0-9a-f]+|\w+);/gi, (whole, code: string) => {
      if (code[0] === '#') {
        const n = code[1]?.toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : whole;
      }
      return ENTITIES[code.toLowerCase()] ?? whole;
    })
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/** Every object in a set of JSON-LD documents, with @graph and arrays flattened. */
export function flattenJsonLd(docs: unknown[]): Node[] {
  const out: Node[] = [];
  const visit = (value: unknown) => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') return;
    const node = value as Node;
    if (Array.isArray(node['@graph'])) node['@graph'].forEach(visit);
    if (node['@type']) out.push(node);
  };
  docs.forEach(visit);
  return out;
}

const types = (node: Node): string[] => {
  const t = node['@type'];
  return (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string');
};

/** The most specific importable item in the page's structured data. */
export function findStructured(docs: unknown[]): { profile: ImportProfile; node: Node } | null {
  const nodes = flattenJsonLd(docs);
  const match = (test: (type: string) => boolean) => nodes.find((n) => types(n).some(test));
  const recipe = match((t) => t === 'Recipe');
  if (recipe) return { profile: 'recipe', node: recipe };
  const product = match((t) => t === 'Product' || t === 'ProductGroup');
  if (product) return { profile: 'product', node: product };
  const event = match((t) => t === 'Event' || t.endsWith('Event'));
  if (event) return { profile: 'event', node: event };
  const article = match((t) => /^(Article|NewsArticle|BlogPosting|TechArticle|Report|ScholarlyArticle)$/.test(t));
  if (article) return { profile: 'article', node: article };
  return null;
}

/** "PT1H30M" → "1 h 30 min". */
export function isoDuration(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:\d+S)?)?$/i.exec(value.trim());
  if (!m) return plain(value) || null;
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  if (!minutes) return null;
  const h = Math.floor(minutes / 60);
  const min = minutes % 60;
  return [h && `${h} h`, min && `${min} min`].filter(Boolean).join(' ');
}

function instructionSections(value: unknown): Section[] {
  const sections: Section[] = [];
  const main: Section = { section: null, items: [] };
  const push = (text: string, target: Section) => {
    for (const line of text.split(/\n+/)) {
      const clean = line.replace(/^\s*\d+[.)]\s*/, '').trim();
      if (clean) target.items.push(clean);
    }
  };
  const visit = (item: unknown, target: Section) => {
    if (typeof item === 'string') return push(plain(item), target);
    if (Array.isArray(item)) return item.forEach((i) => visit(i, target));
    if (!item || typeof item !== 'object') return;
    const node = item as Node;
    if (types(node).includes('HowToSection') && Array.isArray(node.itemListElement)) {
      const section: Section = { section: plain(node.name) || null, items: [] };
      node.itemListElement.forEach((i) => visit(i, section));
      if (section.items.length) sections.push(section);
      return;
    }
    if (Array.isArray(node.itemListElement)) return node.itemListElement.forEach((i) => visit(i, target));
    push(plain(node.text ?? node.name), target);
  };
  visit(value, main);
  return main.items.length ? [main, ...sections] : sections;
}

function firstString(value: unknown): string | null {
  if (Array.isArray(value)) return firstString(value[0]);
  if (typeof value === 'number') return String(value);
  return plain(value) || null;
}

/** Image URL from a JSON-LD `image` (string, ImageObject or array of either). */
export function jsonLdImage(value: unknown): string | null {
  if (Array.isArray(value)) return jsonLdImage(value[0]);
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return firstString((value as Node).url ?? (value as Node).contentUrl);
  return null;
}

/** Maps a schema.org Recipe to recipe data; null when it lacks ingredients or steps. */
export function recipeFromJsonLd(node: Node): RecipeData | null {
  const ingredients = (Array.isArray(node.recipeIngredient) ? node.recipeIngredient : [])
    .map(plain)
    .filter(Boolean);
  const steps = instructionSections(node.recipeInstructions);
  if (!ingredients.length || !steps.length) return null;
  return {
    title: plain(node.name) || 'Recipe',
    description: plain(node.description) || null,
    servings: firstString(node.recipeYield),
    prepTime: isoDuration(node.prepTime),
    cookTime: isoDuration(node.cookTime),
    totalTime: isoDuration(node.totalTime),
    ingredients: [{ section: null, items: ingredients }],
    steps,
    notes: [],
  };
}
