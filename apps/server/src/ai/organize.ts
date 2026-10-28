import { and, desc, eq, isNull, max } from 'drizzle-orm';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  normalizeTag,
  organizeApplySchema,
  organizeRequestSchema,
  researchRequestSchema,
  type AiBatch,
  type OrganizeRequest,
  type OrganizeResult,
  type OrganizeSuggestion,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { aiBatches, notebooks, pages } from '../db/schema.js';
import { notFound, readJson } from '../http.js';
import { newId } from '../ids.js';
import { propagateRenames, type Tx } from '../links.js';
import { applyMove, descendantIds, siblingIndex } from '../routes/pages.js';
import { inheritedTags, setPageTags, tagsByPage } from '../routes/tags.js';
import { deletionTime } from '../routes/trash.js';
import { guessLanguage, languageName } from './language.js';
import { completeJson } from './llm.js';
import type { JobContext, JobRunner } from './jobs.js';

const CHUNK = 30;
const EXCERPT = 600;
const MAX_PARENTS = 300;

type Row = { id: string; notebookId: string; parentId: string | null; title: string; content: string; createdAt: number };

const plainExcerpt = (md: string) =>
  md
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[#>*_`~|-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EXCERPT);

const replySchema = z.object({
  tags: z
    .array(z.object({ page: z.string(), add: z.array(z.string()).default([]), reason: z.string().default('') }))
    .nullish()
    .transform((v) => v ?? []),
  moves: z
    .array(z.object({ page: z.string(), parent: z.string().nullable(), reason: z.string().default('') }))
    .nullish()
    .transform((v) => v ?? []),
  groups: z
    .array(
      z.object({
        title: z.string(),
        parent: z.string().nullable().default(null),
        pages: z.array(z.string()),
        reason: z.string().default(''),
      }),
    )
    .nullish()
    .transform((v) => v ?? []),
});

const SYSTEM = `You help organise a personal notes app. Notes live in notebooks as a tree of pages and can carry tags.
Reply with one JSON object only. Reasons are one short sentence each.`;

function instructions(opts: { tags: boolean; moves: boolean; groups: boolean }) {
  const parts = [
    opts.tags &&
      `- "tags": for pages that are missing useful tags. Strongly prefer EXISTING tags. Only invent a new tag if it fits several pages or is clearly useful; tags are short, lowercase, words joined with "-". Max 3 per page. Skip pages whose tags are fine.`,
    opts.moves &&
      `- "moves": only when a page clearly belongs under another existing page (use ids from PARENT OPTIONS, or null for the notebook's top level). Never move a page under itself or its own subpages.`,
    opts.groups &&
      `- "groups": when 3 or more of the listed pages share a theme and no suitable parent exists, propose a new parent page (title in the notes' language), its parent (id or null) and the page ids to move under it.`,
  ].filter(Boolean);
  return `Suggest improvements:\n${parts.join('\n')}
Be conservative: an empty list is a good answer. Use only page ids given below, and in reasons refer to pages by their title, never by id.
Reply as {"tags":[{"page":"p1","add":["tag"],"reason":"…"}],"moves":[{"page":"p2","parent":"p7","reason":"…"}],"groups":[{"title":"…","parent":null,"pages":["p3","p4","p5"],"reason":"…"}]}`;
}

/** Loads the pages of a scope plus everything needed to validate suggestions. */
function loadScope(db: Db, userId: string, scope: OrganizeRequest['scope']) {
  let notebookId: string;
  let scopeTitle: string;
  if (scope.kind === 'notebook') {
    const nb = db
      .select({ id: notebooks.id, title: notebooks.title })
      .from(notebooks)
      .where(and(eq(notebooks.id, scope.id), eq(notebooks.userId, userId), isNull(notebooks.deletedAt)))
      .get();
    if (!nb) throw notFound('Notebook');
    notebookId = nb.id;
    scopeTitle = nb.title;
  } else {
    const page = db
      .select({ notebookId: pages.notebookId, title: pages.title })
      .from(pages)
      .where(and(eq(pages.id, scope.id), eq(pages.userId, userId), isNull(pages.deletedAt)))
      .get();
    if (!page) throw notFound('Page');
    notebookId = page.notebookId;
    scopeTitle = page.title || 'Untitled';
  }
  const all: Row[] = db
    .select({
      id: pages.id,
      notebookId: pages.notebookId,
      parentId: pages.parentId,
      title: pages.title,
      content: pages.content,
      createdAt: pages.createdAt,
    })
    .from(pages)
    .where(and(eq(pages.userId, userId), eq(pages.notebookId, notebookId), isNull(pages.deletedAt)))
    .all();
  const subtree = scope.kind === 'subtree' ? new Set([scope.id, ...descendantIds(db, userId, scope.id)]) : null;
  const inScope =
    scope.kind === 'notebook'
      ? all
      : scope.kind === 'page'
        ? all.filter((p) => p.id === scope.id)
        : all.filter((p) => subtree!.has(p.id));
  return { notebookId, scopeTitle, all, inScope };
}

function pathOf(byId: Map<string, Row>, page: Row): string {
  const parts = [page.title || 'Untitled'];
  let cur = page;
  while (cur.parentId && byId.get(cur.parentId)) {
    cur = byId.get(cur.parentId)!;
    parts.unshift(cur.title || 'Untitled');
  }
  return parts.join(' / ');
}

const isAncestor = (byId: Map<string, Row>, maybeAncestor: string, id: string) => {
  let cur = byId.get(id);
  while (cur?.parentId) {
    if (cur.parentId === maybeAncestor) return true;
    cur = byId.get(cur.parentId);
  }
  return false;
};

export function organizeJob(db: Db) {
  return async (ctx: JobContext<z.infer<typeof organizeRequestSchema>>): Promise<OrganizeResult> => {
    const { input, cfg, userId } = ctx;
    const { notebookId, scopeTitle, all, inScope } = loadScope(db, userId, input.scope);
    const byId = new Map(all.map((p) => [p.id, p]));
    const tagMap = tagsByPage(db, userId);
    const inherited = inheritedTags(db, userId);
    const vocabulary = new Map<string, number>();
    for (const list of tagMap.values()) for (const t of list) vocabulary.set(t, (vocabulary.get(t) ?? 0) + 1);

    // Short ids keep prompts small and stop the model from inventing real ids.
    const short = new Map<string, string>();
    const long = new Map<string, string>();
    all.forEach((p, i) => {
      short.set(p.id, `p${i + 1}`);
      long.set(`p${i + 1}`, p.id);
    });
    const parentOptions = all
      .slice(0, MAX_PARENTS)
      .map((p) => `${short.get(p.id)} | ${pathOf(byId, p)}`)
      .join('\n');
    const vocabText = [...vocabulary.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => `${t} (${n})`).join(', ') || '(none yet)';

    // Small models drift into other languages unless told explicitly (one run answered in Danish).
    const sample = inScope.map((p) => `${p.title} ${plainExcerpt(p.content)}`).join(' ').slice(0, 6000);
    const reasonLanguage = languageName(guessLanguage(sample) ?? 'en');

    const suggestions: OrganizeSuggestion[] = [];
    let n = 0;
    const nextId = () => `s${++n}`;
    const chunks: Row[][] = [];
    for (let i = 0; i < inScope.length; i += CHUNK) chunks.push(inScope.slice(i, i + CHUNK));

    for (const [i, chunk] of chunks.entries()) {
      ctx.step(chunks.length > 1 ? `Analysing pages (part ${i + 1} of ${chunks.length})…` : 'Analysing pages…', i, chunks.length);
      const list = chunk
        .map((p) => {
          const via = inherited.get(p.id);
          const tags = [...(tagMap.get(p.id) ?? []), ...(via ?? []).map((t) => `${t} (inherited)`)].join(', ') || '-';
          return `${short.get(p.id)} | ${pathOf(byId, p)} | tags: ${tags} | ${plainExcerpt(p.content) || '(empty)'}`;
        })
        .join('\n');
      const reply = await completeJson({
        keys: cfg.keys,
        model: cfg.models.organize,
        system: SYSTEM,
        user: `${instructions(input)}\nWrite all reasons in ${reasonLanguage}.\n\nEXISTING TAGS: ${vocabText}\n\nPARENT OPTIONS (id | path):\n${parentOptions}\n\nPAGES TO REVIEW (id | path | tags | beginning):\n${list}`,
        schema: replySchema,
        maxTokens: 4000,
        signal: ctx.signal,
      });
      ctx.charge(reply.usage);

      const chunkIds = new Set(chunk.map((p) => p.id));
      const grouped = new Set<string>();
      if (input.groups) {
        for (const g of reply.data.groups) {
          const ids = [...new Set(g.pages.map((s) => long.get(s)).filter((id): id is string => !!id && chunkIds.has(id)))];
          const parentId = g.parent ? (long.get(g.parent) ?? undefined) : null;
          const title = g.title.trim().slice(0, 120);
          if (ids.length < 2 || parentId === undefined || !title) continue;
          if (parentId && ids.some((id) => id === parentId || isAncestor(byId, id, parentId))) continue;
          ids.forEach((id) => grouped.add(id));
          suggestions.push({
            id: nextId(),
            type: 'group',
            title,
            notebookId,
            parentId,
            parentTitle: parentId ? byId.get(parentId)!.title : null,
            pageIds: ids,
            pageTitles: ids.map((id) => byId.get(id)!.title || 'Untitled'),
            reason: g.reason,
          });
        }
      }
      if (input.moves) {
        for (const m of reply.data.moves) {
          const id = long.get(m.page);
          const parentId = m.parent ? (long.get(m.parent) ?? undefined) : null;
          if (!id || !chunkIds.has(id) || grouped.has(id) || parentId === undefined) continue;
          const page = byId.get(id)!;
          if (parentId === page.parentId || parentId === id || (parentId && isAncestor(byId, id, parentId))) continue;
          suggestions.push({
            id: nextId(),
            type: 'move',
            pageId: id,
            pageTitle: page.title || 'Untitled',
            parentId,
            parentTitle: parentId ? byId.get(parentId)!.title : null,
            reason: m.reason,
          });
        }
      }
      if (input.tags) {
        for (const t of reply.data.tags) {
          const id = long.get(t.page);
          if (!id || !chunkIds.has(id)) continue;
          const have = new Set([...(tagMap.get(id) ?? []), ...(inherited.get(id) ?? [])]);
          const add = [...new Set(t.add.map(normalizeTag).filter((tag) => tag && !have.has(tag)))].slice(0, 3);
          if (!add.length) continue;
          suggestions.push({
            id: nextId(),
            type: 'tag',
            pageId: id,
            pageTitle: byId.get(id)!.title || 'Untitled',
            tags: add,
            newTags: add.filter((tag) => !vocabulary.has(tag)),
            reason: t.reason,
          });
        }
      }
    }
    ctx.step(`Found ${suggestions.length} suggestion${suggestions.length === 1 ? '' : 's'}`, chunks.length, chunks.length);
    return { scopeTitle, pageCount: inScope.length, suggestions };
  };
}

// ---------- Applying & undoing ----------

type UndoOp =
  | { op: 'untag'; pageId: string; tags: string[] }
  | { op: 'move'; pageId: string; notebookId: string; parentId: string | null; index: number }
  | { op: 'remove'; pageId: string };

function currentTags(tx: Tx, userId: string, pageId: string) {
  return tagsByPage(tx, userId, [pageId]).get(pageId) ?? [];
}

function livePage(tx: Tx, userId: string, id: string) {
  return tx
    .select({ id: pages.id, notebookId: pages.notebookId, parentId: pages.parentId })
    .from(pages)
    .where(and(eq(pages.id, id), eq(pages.userId, userId), isNull(pages.deletedAt)))
    .get();
}

/** Applies the chosen suggestions in one transaction and returns the undo steps. */
function apply(tx: Tx, userId: string, chosen: OrganizeSuggestion[]): UndoOp[] {
  const undo: UndoOp[] = [];
  const movedAlready = new Set<string>();
  const moveTo = (pageId: string, notebookId: string, parentId: string | null) => {
    const page = livePage(tx, userId, pageId);
    if (!page || movedAlready.has(pageId)) return;
    undo.push({ op: 'move', pageId, notebookId: page.notebookId, parentId: page.parentId, index: siblingIndex(tx, userId, page) });
    const last = tx
      .select({ v: max(pages.sortOrder) })
      .from(pages)
      .where(and(eq(pages.notebookId, notebookId), parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId), isNull(pages.deletedAt)))
      .get();
    applyMove(tx, userId, pageId, { notebookId, parentId, index: (last?.v ?? -1) + 1 });
    movedAlready.add(pageId);
  };

  for (const s of chosen) {
    if (s.type !== 'group') continue;
    const now = Date.now();
    const id = newId();
    const last = tx
      .select({ v: max(pages.sortOrder) })
      .from(pages)
      .where(and(eq(pages.notebookId, s.notebookId), s.parentId ? eq(pages.parentId, s.parentId) : isNull(pages.parentId), isNull(pages.deletedAt)))
      .get();
    tx.insert(pages)
      .values({ id, userId, notebookId: s.notebookId, parentId: s.parentId, title: s.title, content: '', sortOrder: (last?.v ?? -1) + 1, createdAt: now, updatedAt: now })
      .run();
    undo.push({ op: 'remove', pageId: id });
    for (const pageId of s.pageIds) moveTo(pageId, s.notebookId, id);
  }
  for (const s of chosen) {
    if (s.type !== 'move') continue;
    const page = livePage(tx, userId, s.pageId);
    if (page) moveTo(s.pageId, page.notebookId, s.parentId);
  }
  for (const s of chosen) {
    if (s.type !== 'tag' || !livePage(tx, userId, s.pageId)) continue;
    const have = currentTags(tx, userId, s.pageId);
    const added = s.tags.filter((t) => !have.includes(t));
    if (!added.length) continue;
    setPageTags(tx, userId, s.pageId, [...have, ...added]);
    undo.push({ op: 'untag', pageId: s.pageId, tags: added });
  }
  return undo;
}

function revert(tx: Tx, userId: string, ops: UndoOp[]) {
  for (const op of [...ops].reverse()) {
    const page = livePage(tx, userId, op.pageId);
    if (!page) continue; // Deleted since: nothing to undo for it.
    if (op.op === 'untag') {
      setPageTags(tx, userId, op.pageId, currentTags(tx, userId, op.pageId).filter((t) => !op.tags.includes(t)));
    } else if (op.op === 'move') {
      const parentOk = !op.parentId || livePage(tx, userId, op.parentId);
      applyMove(tx, userId, op.pageId, { notebookId: op.notebookId, parentId: parentOk ? op.parentId : null, index: op.index });
    } else {
      // Group pages created by AI: to the trash (subpages were moved back first).
      const hasChildren = tx
        .select({ id: pages.id })
        .from(pages)
        .where(and(eq(pages.parentId, op.pageId), isNull(pages.deletedAt)))
        .get();
      if (!hasChildren) tx.update(pages).set({ deletedAt: deletionTime(tx, userId) }).where(eq(pages.id, op.pageId)).run();
    }
  }
}

function describe(chosen: OrganizeSuggestion[]) {
  const count = (type: OrganizeSuggestion['type']) => chosen.filter((s) => s.type === type).length;
  const parts = [
    count('tag') && `${count('tag')} tagged`,
    count('move') && `${count('move')} moved`,
    count('group') && `${count('group')} new group${count('group') === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return parts.join(', ');
}

export function aiRoutes(db: Db, runner: JobRunner) {
  return new Hono<AppEnv>()
    .post('/research', async (c) => {
      const input = await readJson(c, researchRequestSchema);
      return c.json(runner.start(c.var.user.id, 'research', input), 202);
    })
    .post('/organize', async (c) => {
      const input = await readJson(c, organizeRequestSchema);
      // Validate the scope up front so mistakes are reported immediately.
      loadScope(db, c.var.user.id, input.scope);
      return c.json(runner.start(c.var.user.id, 'organize', input), 202);
    })
    .post('/organize/:jobId/apply', async (c) => {
      const { ids } = await readJson(c, organizeApplySchema);
      const userId = c.var.user.id;
      const job = runner.get(userId, c.req.param('jobId'));
      const result = job.result as OrganizeResult | null;
      if (job.kind !== 'organize' || job.status !== 'done' || !result) {
        throw new HTTPException(409, { message: 'This run has no suggestions to apply' });
      }
      if (result.batchId) throw new HTTPException(409, { message: 'These suggestions were already applied' });
      const chosen = result.suggestions.filter((s) => ids.includes(s.id));
      if (!chosen.length) throw new HTTPException(400, { message: 'Nothing selected' });

      const batchId = newId();
      db.transaction((tx) => {
        let undo: UndoOp[] = [];
        propagateRenames(tx, userId, () => {
          undo = apply(tx, userId, chosen);
        });
        tx.insert(aiBatches)
          .values({ id: batchId, userId, jobId: job.id, summary: `${result.scopeTitle}: ${describe(chosen)}`, undo: JSON.stringify(undo), createdAt: Date.now() })
          .run();
      });
      runner.updateResult(job.id, { ...result, batchId });
      return c.json({ batchId, applied: chosen.length });
    })
    .get('/batches', (c) => {
      const rows = db
        .select({ id: aiBatches.id, jobId: aiBatches.jobId, summary: aiBatches.summary, createdAt: aiBatches.createdAt, undoneAt: aiBatches.undoneAt })
        .from(aiBatches)
        .where(eq(aiBatches.userId, c.var.user.id))
        .orderBy(desc(aiBatches.createdAt))
        .limit(20)
        .all();
      return c.json(rows satisfies AiBatch[]);
    })
    .post('/batches/:id/undo', (c) => {
      const userId = c.var.user.id;
      const batch = db
        .select()
        .from(aiBatches)
        .where(and(eq(aiBatches.id, c.req.param('id')), eq(aiBatches.userId, userId)))
        .get();
      if (!batch) throw notFound('Change');
      if (batch.undoneAt) throw new HTTPException(409, { message: 'Already undone' });
      db.transaction((tx) => {
        propagateRenames(tx, userId, () => revert(tx, userId, JSON.parse(batch.undo) as UndoOp[]));
        tx.update(aiBatches).set({ undoneAt: Date.now() }).where(eq(aiBatches.id, batch.id)).run();
      });
      return c.body(null, 204);
    });
}
