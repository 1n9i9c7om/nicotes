import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import TurndownService from 'turndown';
import type { ImportConfig } from '../settings.js';
import { assertPublicUrl, FetchError, safeFetch } from './net.js';

export interface ExtractedPage {
  url: string | null;
  title: string;
  siteName: string | null;
  description: string | null;
  image: string | null;
  /** Parsed `application/ld+json` blocks. */
  jsonLd: unknown[];
  /** Main content as Markdown (Readability or crawl4ai), for the LLM or a plain clip. */
  markdown: string;
  extractor: 'crawl4ai' | 'readability' | 'text';
  warnings: string[];
}

const turndown = new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced', bulletListMarker: '-' });
turndown.remove(['script', 'style', 'noscript', 'iframe', 'form', 'button']);

/** Readability's text is "good enough" when it found a real article body. */
const MIN_ARTICLE_CHARS = 400;

function meta(doc: Document, ...names: string[]): string | null {
  for (const name of names) {
    const el = doc.querySelector(`meta[property="${name}"], meta[name="${name}"]`);
    const value = el?.getAttribute('content')?.trim();
    if (value) return value;
  }
  return null;
}

function absolute(url: string | null, base: string): string | null {
  if (!url) return null;
  try {
    return new URL(url, base).href;
  } catch {
    return null;
  }
}

/** Drops a trailing " - Site" / " | Site" when it names the site or its domain. */
export function cleanTitle(title: string, siteName: string | null, url: string): string {
  const m = /^(.*\S)\s+[-|–—·:]\s+([^-|–—·:]+)$/.exec(title.trim());
  if (!m) return title.trim();
  const suffix = m[2]!.trim().toLowerCase();
  const host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  const matches = suffix === siteName?.trim().toLowerCase() || host.split('.').includes(suffix.replace(/\s+/g, ''));
  return matches ? m[1]! : title.trim();
}

/** Metadata, JSON-LD and Readability text from an HTML document. */
function analyse(html: string, url: string) {
  const { document } = parseHTML(html);
  const jsonLd: unknown[] = [];
  for (const script of document.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(script.textContent ?? ''));
    } catch {
      // Broken JSON-LD is common; ignore it.
    }
  }
  const ogTitle = meta(document, 'og:title', 'twitter:title');
  const siteName = meta(document, 'og:site_name', 'application-name');
  const description = meta(document, 'og:description', 'description', 'twitter:description');
  const image = absolute(meta(document, 'og:image', 'og:image:url', 'twitter:image'), url);

  // Make links and images absolute, or they would point at Nicotes once clipped.
  for (const el of document.querySelectorAll('a[href]')) {
    const href = absolute(el.getAttribute('href'), url);
    if (href) el.setAttribute('href', href);
  }
  for (const el of document.querySelectorAll('img')) {
    const src = absolute(el.getAttribute('src'), url);
    if (src) el.setAttribute('src', src);
    el.removeAttribute('srcset');
  }

  // Readability mutates the document, so it runs last.
  const article = new Readability(document as unknown as Document).parse();
  const markdown = article?.content ? turndown.turndown(article.content).trim() : '';
  return {
    jsonLd,
    title: cleanTitle(ogTitle || article?.title || document.title || '', siteName ?? article?.siteName ?? null, url),
    siteName: siteName ?? article?.siteName ?? null,
    description: description ?? article?.excerpt ?? null,
    image,
    markdown,
  };
}

interface CrawlResult {
  success: boolean;
  html?: string;
  error_message?: string;
  status_code?: number;
  redirected_url?: string;
  markdown?: { raw_markdown?: string; fit_markdown?: string } | string;
}

async function viaCrawl4ai(url: string, cfg: ImportConfig): Promise<{ html: string; markdown: string; url: string }> {
  const res = await fetch(`${cfg.crawl4aiUrl}/crawl`, {
    method: 'POST',
    signal: AbortSignal.timeout(60_000),
    headers: {
      'content-type': 'application/json',
      ...(cfg.crawl4aiToken ? { authorization: `Bearer ${cfg.crawl4aiToken}` } : {}),
    },
    body: JSON.stringify({
      urls: [url],
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: {
          cache_mode: 'bypass',
          excluded_tags: ['nav', 'footer', 'header', 'aside', 'form'],
          remove_overlay_elements: true,
          markdown_generator: {
            type: 'DefaultMarkdownGenerator',
            params: {
              content_filter: { type: 'PruningContentFilter', params: { threshold: 0.45, threshold_type: 'dynamic' } },
              options: { ignore_links: true, ignore_images: true },
            },
          },
        },
      },
    }),
  });
  if (res.status === 401 || res.status === 403) throw new Error('crawl4ai rejected the token');
  if (!res.ok) throw new Error(`crawl4ai answered ${res.status}`);
  const body = (await res.json()) as { results?: CrawlResult[] };
  const result = body.results?.[0];
  if (!result?.success || !result.html) {
    throw new Error(result?.error_message || `crawl4ai could not load the page (${result?.status_code ?? 'no result'})`);
  }
  const md = typeof result.markdown === 'string' ? result.markdown : (result.markdown?.fit_markdown || result.markdown?.raw_markdown);
  return { html: result.html, markdown: md ?? '', url: result.redirected_url || url };
}

/** Fetches a URL (crawl4ai if configured, else directly) and extracts its content. */
export async function extractUrl(url: string, cfg: ImportConfig, allowPrivate: boolean): Promise<ExtractedPage> {
  const warnings: string[] = [];

  if (cfg.crawl4aiUrl) {
    try {
      // crawl4ai fetches on our behalf, so the same destination rules apply.
      await assertPublicUrl(url, allowPrivate);
      const crawled = await viaCrawl4ai(url, cfg);
      const page = analyse(crawled.html, crawled.url);
      // Readability on the rendered HTML is usually cleaner than crawl4ai's own Markdown.
      const markdown = page.markdown.length >= MIN_ARTICLE_CHARS ? page.markdown : crawled.markdown || page.markdown;
      return { ...page, url: crawled.url, markdown, extractor: 'crawl4ai', warnings };
    } catch (error) {
      if (error instanceof FetchError) throw error;
      warnings.push(`crawl4ai failed (${(error as Error).message}); used the built-in extractor instead.`);
    }
  }

  const fetched = await safeFetch(url, { allowPrivate, maxBytes: 8 * 1024 * 1024 });
  if (!/html|xml/i.test(fetched.contentType) && fetched.contentType) {
    throw new FetchError(`Unsupported content type: ${fetched.contentType.split(';')[0]}`);
  }
  const page = analyse(fetched.body.toString('utf8'), fetched.url);
  if (!page.markdown) warnings.push('Could not find the main content of the page.');
  return { ...page, url: fetched.url, extractor: 'readability', warnings };
}

/** Wraps pasted text as if it had been extracted. */
export function extractText(text: string): ExtractedPage {
  const trimmed = text.trim();
  const firstLine = trimmed.split('\n')[0]!.replace(/^#+\s*/, '').trim();
  return {
    url: null,
    title: firstLine.slice(0, 120) || 'Imported text',
    siteName: null,
    description: null,
    image: null,
    jsonLd: [],
    markdown: trimmed,
    extractor: 'text',
    warnings: [],
  };
}
