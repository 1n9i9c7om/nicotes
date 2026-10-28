import { extname } from 'node:path';
import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { z } from 'zod';
import {
  IMPORT_PROFILES,
  providerOf,
  importRequestSchema,
  type ImportPreview,
  type ImportProfile,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { readJson } from '../http.js';
import { storeAttachment } from '../routes/attachments.js';
import type { ImportConfig, SettingsStore } from '../settings.js';
import { extractText, extractUrl, type ExtractedPage } from './extract.js';
import { addUsage, completeJson, emptyUsage, hasKeyFor, LlmError } from '../ai/llm.js';
import { FetchError, safeFetch } from './net.js';
import { descriptions, renderMarkdown, schemas, shapes, suggestedTags, type ProfileData } from './profiles.js';
import { findStructured, jsonLdImage, recipeFromJsonLd } from './structured.js';

/** Upper bound for page text sent to the model (characters). */
const MAX_INPUT_CHARS = 40_000;

const SYSTEM = `You turn web pages into structured notes for a personal notes app.
Rules:
- Reply with one JSON object only, no prose, no code fences.
- Write in the same language as the page. Do not translate.
- Only use information from the page. Never invent amounts, dates, prices or facts; use null or [] when the page does not say.
- Ignore navigation, ads, cookie banners, comments and unrelated recommendations.`;

function pageContext(page: ExtractedPage, hint?: unknown): string {
  const parts = [
    page.url && `URL: ${page.url}`,
    page.title && `Title: ${page.title}`,
    page.siteName && `Site: ${page.siteName}`,
    page.description && `Description: ${page.description}`,
    hint ? `Structured data found on the page (schema.org):\n${JSON.stringify(hint).slice(0, 8000)}` : '',
    `Page content (Markdown):\n${page.markdown.slice(0, MAX_INPUT_CHARS)}`,
  ];
  return parts.filter(Boolean).join('\n\n');
}

async function classify(cfg: ImportConfig, page: ExtractedPage) {
  const options = IMPORT_PROFILES.map((p) => `- "${p}": ${descriptions[p]}`).join('\n');
  const excerpt: ExtractedPage = { ...page, markdown: page.markdown.slice(0, 3000) };
  return completeJson({
    keys: cfg.keys,
    model: cfg.models.import,
    system: SYSTEM,
    user: `Which kind of page is this? Options:\n${options}\n\nReply as {"profile": "<option>"}.\n\n${pageContext(excerpt)}`,
    schema: z.object({ profile: z.enum(IMPORT_PROFILES) }),
    maxTokens: 300,
  });
}

/** Downloads the cover image into the attachment store; failures just mean no image. */
async function saveCover(db: Db, dataDir: string, userId: string, url: string | null, allowPrivate: boolean) {
  if (!url) return null;
  try {
    const img = await safeFetch(url, { allowPrivate, maxBytes: 8 * 1024 * 1024, accept: 'image/*', timeoutMs: 10_000 });
    const mime = img.contentType.split(';')[0]!.trim();
    if (!/^image\/(png|jpe?g|gif|webp|avif)$/.test(mime)) return null;
    const ext = extname(new URL(img.url).pathname) || `.${mime.split('/')[1]}`;
    return await storeAttachment(db, dataDir, { userId, pageId: null, filename: `cover${ext}`, mime, bytes: img.body });
  } catch {
    return null;
  }
}

export interface ImportDeps {
  db: Db;
  dataDir: string;
  settings: SettingsStore;
  allowPrivate: boolean;
}

export function importRoutes({ db, dataDir, settings, allowPrivate }: ImportDeps) {
  return new Hono<AppEnv>().post('/preview', async (c) => {
    const req = await readJson(c, importRequestSchema);
    const userId = c.var.user.id;
    const cfg = settings.effective(userId);

    let page: ExtractedPage;
    try {
      page = req.url ? await extractUrl(req.url, cfg, allowPrivate) : extractText(req.text!);
    } catch (error) {
      if (error instanceof FetchError) throw new HTTPException(422, { message: error.message });
      throw error;
    }
    const warnings = [...page.warnings];
    const structured = findStructured(page.jsonLd);
    let profile: ImportProfile | null = req.profile === 'auto' ? (structured?.profile ?? null) : req.profile;
    let data: ProfileData[ImportProfile] | null = null;
    let method: ImportPreview['method'] = 'llm';
    let usage: ImportPreview['usage'] = null;

    // 1. Exact recipe data embedded in the page needs no model at all.
    if (profile === 'recipe' && structured?.profile === 'recipe') {
      data = recipeFromJsonLd(structured.node);
      if (data) method = 'structured-data';
    }

    // 2. Otherwise let the model classify (if needed) and extract.
    if (!data && hasKeyFor(cfg.keys, cfg.models.import)) {
      try {
        let spent = emptyUsage();
        if (!profile) {
          const guess = await classify(cfg, page);
          profile = guess.data.profile;
          spent = guess.usage;
        }
        const hint = structured?.profile === profile ? structured.node : undefined;
        const result = await completeJson({
          keys: cfg.keys,
          model: cfg.models.import,
          system: SYSTEM,
          user: `Extract ${descriptions[profile]} as JSON with this TypeScript type:\n${shapes[profile]}\n\n${pageContext(page, hint)}`,
          schema: schemas[profile] as z.ZodType<ProfileData[ImportProfile]>,
        });
        data = result.data;
        usage = { model: cfg.models.import, ...addUsage(spent, result.usage) };
      } catch (error) {
        if (!(error instanceof LlmError)) throw error;
        warnings.push(`${error.message}. Imported the page text instead.`);
      }
    } else if (!data) {
      warnings.push(`No ${providerOf(cfg.models.import) === 'routeway' ? 'Routeway' : 'OpenRouter'} API key configured (Settings): imported the page text without summarising.`);
    }

    const ldImage = structured && jsonLdImage(structured.node.image);
    const coverUrl = (ldImage && page.url && URL.parse(ldImage, page.url)?.href) || page.image;
    const image = await saveCover(db, dataDir, userId, coverUrl, allowPrivate);
    const ctx = { imageUrl: image?.url ?? null, sourceUrl: page.url, siteName: page.siteName };

    let preview: ImportPreview;
    if (data && profile) {
      const appendix =
        profile === 'article' && req.includeFullText && page.markdown ? `## Full text\n\n${page.markdown}` : undefined;
      preview = {
        profile,
        title: data.title || page.title,
        markdown: renderMarkdown(profile, data, { ...ctx, appendix }),
        suggestedTags: suggestedTags[profile],
        source: { url: page.url, siteName: page.siteName },
        method,
        extractor: page.extractor,
        warnings,
        usage,
      };
    } else {
      // No model (or it failed): a clean clip of the page.
      if (!page.markdown) throw new HTTPException(422, { message: 'Could not extract any content from this page' });
      const clip = renderMarkdown(
        'generic',
        { title: page.title, summary: page.description ?? '', sections: [] },
        { ...ctx, appendix: page.markdown },
      );
      preview = {
        profile: 'generic',
        title: page.title || 'Imported page',
        markdown: clip,
        suggestedTags: [],
        source: { url: page.url, siteName: page.siteName },
        method: 'clip',
        extractor: page.extractor,
        warnings,
        usage: null,
      };
    }
    return c.json(preview);
  });
}
