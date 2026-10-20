import { and, eq, isNull, max } from 'drizzle-orm';
import { z } from 'zod';
import { RESEARCH_DEPTHS, type ResearchResult, researchRequestSchema } from '@nicotes/shared';
import type { Db } from '../db/index.js';
import { notebooks, pages } from '../db/schema.js';
import { extractUrl } from '../import/extract.js';
import { indexPageLinks } from '../links.js';
import { newId } from '../ids.js';
import { setPageTags } from '../routes/tags.js';
import type { AiConfig } from '../settings.js';
import { guessLanguage, languageName } from './language.js';
import { chat, completeJson, LlmError } from './llm.js';
import { mapLimit, type JobContext } from './jobs.js';

type Input = z.infer<typeof researchRequestSchema>;

interface Candidate {
  url: string;
  title: string;
  /** Snippet or page text from the search provider, used if fetching the page fails. */
  snippet: string;
}

interface SourceNote {
  url: string;
  title: string;
  site: string;
  summary: string;
  facts: string[];
}

const SOURCE_CHARS = 15_000;
const SKIP_URL = /\.(pdf|zip|mp4|mp3|jpe?g|png|gif)(\?|$)|youtube\.com\/watch|youtu\.be\/|tiktok\.com|instagram\.com|facebook\.com/i;

const host = (url: string) => {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
};

/** Normalises URLs for de-duplication (drops fragments, tracking params, trailing slash). */
export function canonicalUrl(raw: string): string {
  try {
    const url = new URL(raw);
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) if (/^(utm_|fbclid|gclid|ref$)/i.test(key)) url.searchParams.delete(key);
    return url.href.replace(/\/$/, '');
  } catch {
    return raw;
  }
}

/** Interleaves results of several queries, dropping duplicates and limiting per site. */
export function pickSources(perQuery: Candidate[][], limit: number, perSite = 2): Candidate[] {
  const picked: Candidate[] = [];
  const seen = new Set<string>();
  const sites = new Map<string, number>();
  for (let rank = 0; picked.length < limit && perQuery.some((list) => list.length > rank); rank++) {
    for (const list of perQuery) {
      const c = list[rank];
      if (!c || picked.length >= limit) continue;
      const key = canonicalUrl(c.url);
      const site = host(c.url);
      if (seen.has(key) || SKIP_URL.test(c.url) || (sites.get(site) ?? 0) >= perSite) continue;
      seen.add(key);
      sites.set(site, (sites.get(site) ?? 0) + 1);
      picked.push(c);
    }
  }
  return picked;
}

async function searchSearxng(url: string, query: string, language: string, signal: AbortSignal): Promise<Candidate[]> {
  const params = new URLSearchParams({ q: query, format: 'json', language, safesearch: '0' });
  const res = await fetch(`${url}/search?${params}`, { signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]) });
  if (!res.ok) throw new LlmError(`SearXNG answered ${res.status}${res.status === 403 ? ' (enable the json format)' : ''}`);
  const body = (await res.json()) as { results?: { url: string; title?: string; content?: string }[] };
  return (body.results ?? []).map((r) => ({ url: r.url, title: r.title ?? r.url, snippet: r.content ?? '' }));
}

async function searchOpenRouter(ctx: JobContext<Input>, query: string): Promise<Candidate[]> {
  const reply = await chat({
    apiKey: ctx.cfg.openrouterApiKey!,
    model: ctx.cfg.models.research,
    messages: [{ role: 'user', content: `Search the web for: ${query}\nList the most relevant pages in one line each.` }],
    maxTokens: 500,
    webResults: 6,
    signal: ctx.signal,
  });
  ctx.charge(reply.usage);
  return reply.citations.map((c) => ({ url: c.url, title: c.title || c.url, snippet: c.content }));
}

/** Turns "[1]" / "[2, 3]" markers into links to the numbered sources. */
export function linkCitations(markdown: string, sources: { url: string }[]): string {
  return markdown.replace(/(?<![[\]!])\[(\d+(?:\s*[,;]\s*\d+)*)\](?![(\]])/g, (whole, list: string) => {
    const links = list
      .split(/\s*[,;]\s*/)
      .map((n) => Number(n))
      .filter((n) => sources[n - 1])
      .map((n) => `[${n}](${sources[n - 1]!.url})`);
    return links.length ? links.join(', ') : whole;
  });
}

const noteSchema = z.object({
  relevant: z.boolean(),
  summary: z.string().default(''),
  facts: z.array(z.string()).default([]),
});

export function researchJob(db: Db, allowPrivate: boolean) {
  return async (ctx: JobContext<Input>): Promise<ResearchResult> => {
    const { input, cfg } = ctx;
    const depth = RESEARCH_DEPTHS[input.depth];
    const model = cfg.models.research;
    const notebook = db
      .select({ id: notebooks.id })
      .from(notebooks)
      .where(and(eq(notebooks.id, input.notebookId), eq(notebooks.userId, ctx.userId), isNull(notebooks.deletedAt)))
      .get();
    if (!notebook) throw new LlmError('The target notebook no longer exists');

    // 1. Plan. The model sometimes misjudges the language, so a confident local guess is
    // stated explicitly and wins over the model's answer.
    ctx.step('Planning searches…');
    const guessed = guessLanguage(input.question);
    const plan = await completeJson({
      apiKey: cfg.openrouterApiKey!,
      model,
      system: 'You plan web research for a notes app. Reply with one JSON object only.',
      user: `Research question:\n${input.question}\n\n${guessed ? `The question is written in ${languageName(guessed)}; title and labels must be in ${languageName(guessed)}.\n\n` : ''}Reply as {"title": "<short note title in the question's language>", "language": "<ISO 639-1 code of the question>", "queries": ["<${depth.queries} diverse web search queries, mostly in the question's language; add English ones when that finds better sources>"], "labels": {"question": "<'Research question' in that language>", "sources": "<'Sources'>", "openQuestions": "<'Open questions'>"}}`,
      schema: z.object({
        title: z.string().min(1),
        language: z.string().default('en'),
        queries: z.array(z.string().min(2)).min(1),
        labels: z
          .object({ question: z.string().min(1), sources: z.string().min(1), openQuestions: z.string().min(1) })
          .catch({ question: 'Research question', sources: 'Sources', openQuestions: 'Open questions' }),
      }),
      maxTokens: 800,
      signal: ctx.signal,
    });
    ctx.charge(plan.usage);
    const language = guessed ?? plan.data.language;
    const writeIn = languageName(language);
    const queries = plan.data.queries.slice(0, depth.queries);

    // 2. Search
    const provider: ResearchResult['searchProvider'] = cfg.searxngUrl ? 'searxng' : 'openrouter';
    const results: Candidate[][] = [];
    for (const [i, query] of queries.entries()) {
      ctx.step(`Searching (${provider === 'searxng' ? 'SearXNG' : 'OpenRouter'}): ${query}`, i, queries.length);
      try {
        results.push(
          provider === 'searxng'
            ? await searchSearxng(cfg.searxngUrl!, query, language, ctx.signal)
            : await searchOpenRouter(ctx, query),
        );
      } catch (error) {
        if (ctx.signal.aborted) throw error;
        ctx.step(`Search failed for “${query}”: ${(error as Error).message}`);
        results.push([]);
      }
    }
    // Pick extra candidates so failed fetches can be replaced.
    const candidates = pickSources(results, depth.sources * 2);
    if (!candidates.length) throw new LlmError('The searches found no usable sources');

    // 3. Read sources and 4. take notes on each, until enough relevant ones are collected.
    const notes: SourceNote[] = [];
    let tried = 0;
    while (notes.length < depth.sources && tried < candidates.length) {
      const batch = candidates.slice(tried, tried + Math.min(3, depth.sources - notes.length));
      tried += batch.length;
      const batchNotes = await mapLimit(batch, 3, async (c) => {
        ctx.step(`Reading ${host(c.url)}`, notes.length, depth.sources);
        let text = '';
        let title = c.title;
        let site = host(c.url);
        try {
          const page = await extractUrl(c.url, cfg as AiConfig, allowPrivate);
          text = page.markdown;
          title = page.title || title;
          site = page.siteName || site;
        } catch {
          // Unreachable or blocked: fall back to what the search provider returned.
        }
        if (text.length < 300) text = c.snippet;
        if (text.length < 200) return null;
        const note = await completeJson({
          apiKey: cfg.openrouterApiKey!,
          model,
          system: 'You take research notes from one web page. Reply with one JSON object only. Only use facts stated on the page.',
          user: `Research question: ${input.question}\nWrite in ${writeIn}.\n\nReply as {"relevant": true|false, "summary": "<2-4 sentences on what this source says about the question>", "facts": ["<specific facts, numbers, steps or claims relevant to the question>"]}\n\nSource: ${title} (${c.url})\n\n${text.slice(0, SOURCE_CHARS)}`,
          schema: noteSchema,
          maxTokens: 1500,
          signal: ctx.signal,
        }).catch((error: Error) => {
          if (ctx.signal.aborted) throw error;
          return null;
        });
        if (!note) return null;
        ctx.charge(note.usage);
        return note.data.relevant && note.data.summary ? { url: c.url, title, site, summary: note.data.summary, facts: note.data.facts } : null;
      });
      notes.push(...batchNotes.filter((n): n is SourceNote => n !== null));
    }
    if (!notes.length) throw new LlmError('None of the sources could be read or were relevant');

    // 5. Write the note
    ctx.step(`Writing the note from ${notes.length} sources…`, depth.sources, depth.sources);
    const sourceText = notes
      .map((n, i) => `[${i + 1}] ${n.title} (${n.site})\nSummary: ${n.summary}\nFacts:\n${n.facts.map((f) => `- ${f}`).join('\n')}`)
      .join('\n\n');
    const draft = await chat({
      apiKey: cfg.openrouterApiKey!,
      model,
      effort: 'low',
      maxTokens: 6000,
      signal: ctx.signal,
      messages: [
        {
          role: 'system',
          content:
            'You write well-structured research notes in Markdown for a personal notes app. Cite sources with their number in square brackets, e.g. [2] or [1, 3], right after the claim. Only use the provided source notes. Do not add a title, a sources list or links; they are added automatically.',
        },
        {
          role: 'user',
          content: `Question: ${input.question}\nWrite the whole note in ${writeIn}, including headings.\n\nStructure: a short summary paragraph first, then sections with "## " headings covering the findings (lists and tables where they help), and finally "## ${plan.data.labels.openQuestions}" with what the sources leave unclear or disagree on.\n\nSOURCE NOTES:\n${sourceText}`,
        },
      ],
    });
    ctx.charge(draft.usage);
    const body = draft.content.trim().replace(/^#\s+.*\n+/, '');
    if (!body) throw new LlmError('The model returned an empty note');

    const sourcesList = notes.map((n, i) => `${i + 1}. [${n.title.replace(/[[\]]/g, '')}](${n.url}) · ${n.site}`).join('\n');
    const date = new Date().toISOString().slice(0, 10);
    const { labels } = plan.data;
    const content = `> **${labels.question}:** ${input.question.replace(/\n+/g, ' ')}\n\n${linkCitations(body, notes)}\n\n## ${labels.sources}\n\n${sourcesList}\n\n---\n\nResearched ${date} · ${notes.length} sources via ${provider === 'searxng' ? 'SearXNG' : 'OpenRouter web search'} · ${model}`;

    // 6. Save as a page
    ctx.check();
    const id = newId();
    const now = Date.now();
    db.transaction((tx) => {
      const parent = input.parentId
        ? tx
            .select({ id: pages.id })
            .from(pages)
            .where(and(eq(pages.id, input.parentId), eq(pages.notebookId, notebook.id), isNull(pages.deletedAt)))
            .get()
        : undefined;
      const parentId = parent?.id ?? null;
      const last = tx
        .select({ v: max(pages.sortOrder) })
        .from(pages)
        .where(and(eq(pages.notebookId, notebook.id), parentId ? eq(pages.parentId, parentId) : isNull(pages.parentId), isNull(pages.deletedAt)))
        .get();
      tx.insert(pages)
        .values({ id, userId: ctx.userId, notebookId: notebook.id, parentId, title: plan.data.title.slice(0, 200), content, sortOrder: (last?.v ?? -1) + 1, createdAt: now, updatedAt: now })
        .run();
      indexPageLinks(tx, ctx.userId, id, content);
      setPageTags(tx, ctx.userId, id, ['research']);
    });
    ctx.step('Done', depth.sources, depth.sources);
    return { pageId: id, title: plan.data.title, sources: notes.length, searchProvider: provider };
  };
}
