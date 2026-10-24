import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  guessLayout,
  LAYOUT_TYPES,
  layoutRequestSchema,
  layoutSpecSchema,
  pageBlocks,
  type LayoutSpec,
  type LayoutType,
  type PageBlock,
  type PageLayoutInfo,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { pageLayouts } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { findPage } from '../routes/pages.js';
import type { AiConfig, SettingsStore } from '../settings.js';
import { requireKey, upstream } from './insight.js';
import { guessLanguage, languageName } from './language.js';
import { completeJson } from './llm.js';

const MAX_BLOCKS = 150;

const replySchema = z.object({
  type: z.enum(LAYOUT_TYPES).catch('document'),
  language: z.string().max(10).nullish(),
  servings: z.number().nullish(),
  ingredients: z.array(z.string()).nullish(),
  steps: z.array(z.string()).nullish(),
  lists: z.array(z.string()).nullish(),
  reason: z.string().default(''),
});

const SYSTEM = `You decide how a note in a notes app is best presented, and which of its blocks play which part. Reply with one JSON object only.`;

/** One line per block for the prompt: id, kind, heading above it and the start of its content. */
function describe(block: PageBlock, i: number): string {
  const under = block.heading.at(-1) ?? '—';
  const id = `b${i + 1}`;
  const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
  switch (block.kind) {
    case 'heading':
      return `${id} | heading h${block.level} | ${under} | ${cut(block.text, 80)}`;
    case 'list': {
      const kind = `${block.ordered ? 'numbered' : 'bullet'} list, ${block.items.length} items${block.items.some((i) => i.checked !== null) ? ' with checkboxes' : ''}`;
      return `${id} | ${kind} | ${under} | ${cut(block.items.slice(0, 6).map((i) => i.text).join('; '), 220)}`;
    }
    default:
      return `${id} | ${block.kind} | ${under} | ${cut(block.text.replace(/\s+/g, ' '), 140)}`;
  }
}

/**
 * Asks the model for a layout: the type, and which blocks are ingredients, steps or checklist
 * lists. Block ids in the reply are checked and turned into stable block keys; parts the model
 * leaves out are filled in by the heuristic for that type.
 */
export async function analyzeLayout(
  cfg: AiConfig,
  page: { title: string; content: string; tags: string[] },
  forced?: LayoutType,
): Promise<{ spec: LayoutSpec; reason: string; cost: number; model: string }> {
  const blocks = pageBlocks(page.content).slice(0, MAX_BLOCKS);
  const language = guessLanguage(page.content.slice(0, 5000));
  const model = cfg.models.layout;
  const reply = await upstream(() =>
    completeJson({
      apiKey: requireKey(cfg),
      model,
      schema: replySchema,
      maxTokens: 800,
      system: SYSTEM,
      user: `LAYOUTS:
- document: ordinary notes or mixed content (the default when unsure)
- checklist: mainly items to tick off (packing, shopping or to-do lists)
- recipe: cooking or baking, with ingredients and preparation steps
- steps: instructions to follow in order that are not a recipe (how-tos, setup guides)
- reader: a story, essay or article meant to be read through, mostly prose
${forced ? `The user chose the layout "${forced}": use it and pick the blocks for it.\n` : ''}
Reply as {"type":"recipe","language":"de","servings":4,"ingredients":["b2"],"steps":["b4"],"lists":[],"reason":"…"}
- ingredients (recipe only): list blocks with ingredients, in order
- steps (recipe and steps): list blocks (each item is one step) or paragraph blocks (each is one step), in order
- lists (checklist only): the list blocks that make up the checklist
- language: ISO 639-1 code of the note's language; servings: number of servings if the note says, else null
- reason: one short sentence${language ? ` in ${languageName(language)}` : ''}

NOTE "${page.title || 'Untitled'}"${page.tags.length ? ` (tags: ${page.tags.join(', ')})` : ''}
BLOCKS (id | kind | under heading | content):
${blocks.map(describe).join('\n') || '(empty page)'}`,
    }),
  );

  const data = reply.data;
  const type = forced ?? data.type;
  const pick = (ids: string[] | null | undefined, kinds: PageBlock['kind'][]) =>
    [...new Set(ids ?? [])]
      .map((id) => blocks[Number(/^b(\d+)$/.exec(id.trim())?.[1]) - 1])
      .filter((b): b is PageBlock => !!b && kinds.includes(b.kind))
      .sort((a, b) => a.start - b.start)
      .map((b) => b.key);
  const fallback = guessLayout(page.content, page.tags, type);
  const spec: LayoutSpec = {
    type,
    language: (data.language ?? language)?.toLowerCase().slice(0, 5) ?? null,
    servings: data.servings && data.servings > 0 && data.servings < 1000 ? Math.round(data.servings) : fallback.servings,
    ingredients: type === 'recipe' ? pick(data.ingredients, ['list']) : [],
    steps: type === 'recipe' || type === 'steps' ? pick(data.steps, ['list', 'paragraph']) : [],
    lists: type === 'checklist' ? pick(data.lists, ['list']) : [],
  };
  // A layout without its parts would show nothing useful: fill gaps from the heuristic.
  if (type === 'recipe' && !spec.ingredients.length) spec.ingredients = fallback.ingredients;
  if ((type === 'recipe' || type === 'steps') && !spec.steps.length) spec.steps = fallback.steps;
  if (type === 'checklist' && !spec.lists.length) spec.lists = fallback.lists;
  return { spec: layoutSpecSchema.parse(spec), reason: data.reason.trim(), cost: reply.usage.cost, model };
}

function stored(db: Db, userId: string, pageId: string, version: number): PageLayoutInfo | null {
  const row = db
    .select()
    .from(pageLayouts)
    .where(and(eq(pageLayouts.pageId, pageId), eq(pageLayouts.userId, userId)))
    .get();
  if (!row) return null;
  const spec = layoutSpecSchema.safeParse(JSON.parse(row.spec));
  if (!spec.success) return null;
  return {
    spec: spec.data,
    source: row.source as PageLayoutInfo['source'],
    stale: row.version !== version,
    model: row.model,
    cost: row.cost,
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

function save(db: Db, userId: string, pageId: string, version: number, info: Omit<PageLayoutInfo, 'stale' | 'createdAt'>) {
  const values = {
    spec: JSON.stringify(info.spec),
    version,
    source: info.source,
    model: info.model,
    cost: info.cost,
    reason: info.reason,
    createdAt: Date.now(),
  };
  db.insert(pageLayouts)
    .values({ pageId, userId, ...values })
    .onConflictDoUpdate({ target: pageLayouts.pageId, set: values })
    .run();
}

export function layoutRoutes(db: Db, settings: SettingsStore) {
  return new Hono<AppEnv>()
    .get('/layout/:pageId', (c) => {
      const page = findPage(db, c.var.user.id, c.req.param('pageId'));
      return c.json(stored(db, c.var.user.id, page.id, page.version));
    })
    // Let the AI choose (optionally for a given type).
    .post('/layout/:pageId', async (c) => {
      const { type } = await readJson(c, layoutRequestSchema);
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('pageId'));
      const result = await analyzeLayout(settings.effective(userId), page, type);
      save(db, userId, page.id, page.version, { ...result, source: 'ai' });
      return c.json(stored(db, userId, page.id, page.version));
    })
    // Choose a type by hand; its parts come from the heuristic (no AI).
    .put('/layout/:pageId', async (c) => {
      const { type } = await readJson(c, layoutRequestSchema);
      if (!type) throw new HTTPException(400, { message: 'Choose a layout' });
      const userId = c.var.user.id;
      const page = findPage(db, userId, c.req.param('pageId'));
      const { confidence: _unused, ...spec } = guessLayout(page.content, page.tags, type);
      save(db, userId, page.id, page.version, { spec, source: 'manual', model: null, cost: 0, reason: '' });
      return c.json(stored(db, userId, page.id, page.version));
    })
    // Back to automatic.
    .delete('/layout/:pageId', (c) => {
      const removed = db
        .delete(pageLayouts)
        .where(and(eq(pageLayouts.pageId, c.req.param('pageId')), eq(pageLayouts.userId, c.var.user.id)))
        .run();
      if (!removed.changes) throw notFound('Layout');
      return c.body(null, 204);
    });
}
