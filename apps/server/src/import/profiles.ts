import { z } from 'zod';
import type { ImportProfile } from '@nicotes/shared';

/**
 * Import profiles: what the LLM should extract (schema + a TypeScript-style description,
 * which models follow more reliably than JSON Schema) and how it becomes Markdown.
 */

const text = z.string().trim();
const optionalText = text.nullish().transform((v) => v || null);
const list = z.array(text).nullish().transform((v) => (v ?? []).filter(Boolean));

const section = z.object({ section: optionalText, items: list });
export type Section = z.infer<typeof section>;

export const schemas = {
  recipe: z.object({
    title: text,
    description: optionalText,
    servings: optionalText,
    prepTime: optionalText,
    cookTime: optionalText,
    totalTime: optionalText,
    ingredients: z.array(section).min(1),
    steps: z.array(section).min(1),
    notes: list,
  }),
  article: z.object({
    title: text,
    author: optionalText,
    published: optionalText,
    summary: text,
    keyPoints: list,
  }),
  product: z.object({
    title: text,
    brand: optionalText,
    price: optionalText,
    summary: text,
    specs: z
      .array(z.object({ name: text, value: text }))
      .nullish()
      .transform((v) => v ?? []),
    pros: list,
    cons: list,
  }),
  event: z.object({
    title: text,
    start: optionalText,
    end: optionalText,
    location: optionalText,
    organizer: optionalText,
    summary: text,
    details: list,
  }),
  generic: z.object({
    title: text,
    summary: text,
    sections: z
      .array(z.object({ heading: text, points: list }))
      .nullish()
      .transform((v) => v ?? []),
  }),
} satisfies Record<ImportProfile, z.ZodType>;

export type RecipeData = z.infer<typeof schemas.recipe>;
export type ProfileData = { [P in ImportProfile]: z.infer<(typeof schemas)[P]> };

export const shapes: Record<ImportProfile, string> = {
  recipe: `{
  title: string;
  description: string | null;      // one or two sentences
  servings: string | null;         // e.g. "4 servings", "12 cookies"
  prepTime: string | null;         // e.g. "20 min"
  cookTime: string | null;
  totalTime: string | null;
  ingredients: { section: string | null; items: string[] }[];  // items with amount and unit, e.g. "200 g flour"; section for groups like "Dough"
  steps: { section: string | null; items: string[] }[];        // one instruction per item, in order, without numbering
  notes: string[];                 // tips, storage, variations from the page
}`,
  article: `{
  title: string;
  author: string | null;
  published: string | null;        // date as written on the page
  summary: string;                 // 2-4 sentences
  keyPoints: string[];             // 3-8 concise takeaways
}`,
  product: `{
  title: string;
  brand: string | null;
  price: string | null;            // with currency, as shown
  summary: string;                 // what it is, 1-3 sentences
  specs: { name: string; value: string }[];   // key specifications
  pros: string[];
  cons: string[];
}`,
  event: `{
  title: string;
  start: string | null;            // date/time as precise as the page states
  end: string | null;
  location: string | null;
  organizer: string | null;
  summary: string;
  details: string[];               // tickets, schedule, requirements, ...
}`,
  generic: `{
  title: string;
  summary: string;                 // 2-4 sentences
  sections: { heading: string; points: string[] }[];   // the page's main content, condensed
}`,
};

export const descriptions: Record<ImportProfile, string> = {
  recipe: 'a cooking or baking recipe',
  article: 'a news article, blog post, guide or essay',
  product: 'a product page in a shop or a review of one product',
  event: 'an event, concert, meetup or course with a date',
  generic: 'anything else',
};

export const suggestedTags: Record<ImportProfile, string[]> = {
  recipe: ['recipe'],
  article: ['article'],
  product: ['product'],
  event: ['event'],
  generic: [],
};

// ---------- Rendering ----------

const line = (label: string, value: string | null) => (value ? `**${label}:** ${value}` : null);

function sections(items: Section[], render: (items: string[]) => string): string {
  return items
    .filter((s) => s.items.length)
    .map((s) => (s.section ? `### ${s.section}\n\n${render(s.items)}` : render(s.items)))
    .join('\n\n');
}

const bullets = (items: string[]) => items.map((i) => `- ${i}`).join('\n');
const checklist = (items: string[]) => items.map((i) => `- [ ] ${i}`).join('\n');
const numbered = (items: string[]) => items.map((i, n) => `${n + 1}. ${i}`).join('\n');

function body<P extends ImportProfile>(profile: P, data: ProfileData[P]): string[] {
  switch (profile) {
    case 'recipe': {
      const d = data as RecipeData;
      const facts = [
        line('Servings', d.servings),
        line('Prep', d.prepTime),
        line('Cook', d.cookTime),
        line('Total', d.totalTime),
      ].filter(Boolean);
      return [
        d.description ? `> ${d.description}` : '',
        facts.join(' · '),
        `## Ingredients\n\n${sections(d.ingredients, checklist)}`,
        `## Instructions\n\n${sections(d.steps, numbered)}`,
        d.notes.length ? `## Notes\n\n${bullets(d.notes)}` : '',
      ];
    }
    case 'article': {
      const d = data as ProfileData['article'];
      const by = [d.author && `by ${d.author}`, d.published].filter(Boolean).join(' · ');
      return [by ? `*${by}*` : '', `> ${d.summary}`, d.keyPoints.length ? `## Key points\n\n${bullets(d.keyPoints)}` : ''];
    }
    case 'product': {
      const d = data as ProfileData['product'];
      const specs = d.specs.length
        ? `## Specifications\n\n| Property | Value |\n| --- | --- |\n${d.specs
            .map((s) => `| ${s.name.replace(/\|/g, '\\|')} | ${s.value.replace(/\|/g, '\\|')} |`)
            .join('\n')}`
        : '';
      return [
        [line('Brand', d.brand), line('Price', d.price)].filter(Boolean).join(' · '),
        d.summary,
        specs,
        d.pros.length ? `## Pros\n\n${bullets(d.pros)}` : '',
        d.cons.length ? `## Cons\n\n${bullets(d.cons)}` : '',
      ];
    }
    case 'event': {
      const d = data as ProfileData['event'];
      const when = d.start && d.end ? `${d.start} – ${d.end}` : d.start;
      return [
        [line('When', when), line('Where', d.location), line('Organizer', d.organizer)].filter(Boolean).join('\n\n'),
        d.summary,
        d.details.length ? `## Details\n\n${bullets(d.details)}` : '',
      ];
    }
    default: {
      const d = data as ProfileData['generic'];
      return [d.summary, ...d.sections.map((s) => `## ${s.heading}\n\n${bullets(s.points)}`)];
    }
  }
}

export interface RenderContext {
  imageUrl: string | null;
  sourceUrl: string | null;
  siteName: string | null;
  /** Extra Markdown appended before the source line (e.g. an article's full text). */
  appendix?: string;
}

export function renderMarkdown<P extends ImportProfile>(profile: P, data: ProfileData[P], ctx: RenderContext): string {
  const source = ctx.sourceUrl
    ? `Source: [${ctx.siteName || new URL(ctx.sourceUrl).hostname}](${ctx.sourceUrl}) · imported ${new Date().toISOString().slice(0, 10)}`
    : `Imported ${new Date().toISOString().slice(0, 10)}`;
  return [
    ctx.imageUrl ? `![${data.title.replace(/[[\]]/g, '')}](${ctx.imageUrl})` : '',
    ...body(profile, data),
    ctx.appendix ?? '',
    `---\n\n${source}`,
  ]
    .filter((part) => part.trim())
    .join('\n\n');
}
