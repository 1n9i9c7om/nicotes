/**
 * Wikilink parsing and resolution, shared by server (backlinks, rename propagation)
 * and web (navigation, autocomplete) so both always agree on what a link points to.
 *
 * Syntax: `[[Target]]` or `[[Target|Label]]`. A target is a page title, optionally
 * qualified with ancestor and/or notebook titles: `[[Elden Ring/Builds]]`,
 * `[[Games/Elden Ring/Builds]]`.
 */

const WIKILINK = /(?<!\\)\[\[([^[\]|\n]+?)(?:\|([^[\]\n]+?))?\]\]/g;
const INLINE_CODE = /(`+)[^`\n]*?\1/g;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;

export interface WikilinkRef {
  target: string;
  label: string | null;
}

/** Calls `fn` for every text range outside code blocks and inline code. */
function mapOutsideCode(markdown: string, fn: (text: string) => string): string {
  const lines = markdown.split('\n');
  let fence: string | null = null;
  return lines
    .map((line) => {
      const marker = FENCE.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      let out = '';
      let last = 0;
      for (const m of line.matchAll(INLINE_CODE)) {
        out += fn(line.slice(last, m.index)) + m[0];
        last = m.index + m[0].length;
      }
      return out + fn(line.slice(last));
    })
    .join('\n');
}

/** Rewrites wikilinks outside code. `fn` returns the replacement target, or null to keep the link. */
export function mapWikilinks(markdown: string, fn: (ref: WikilinkRef) => string | null): string {
  return mapOutsideCode(markdown, (text) =>
    text.replace(WIKILINK, (whole, target: string, label: string | undefined) => {
      const next = fn({ target: target.trim(), label: label?.trim() || null });
      if (next === null) return whole;
      return `[[${next}${label ? `|${label}` : ''}]]`;
    }),
  );
}

/** All distinct wikilinks in a document, ignoring code. */
export function extractWikilinks(markdown: string): WikilinkRef[] {
  const seen = new Map<string, WikilinkRef>();
  mapWikilinks(markdown, (ref) => {
    if (!seen.has(ref.target)) seen.set(ref.target, ref);
    return null;
  });
  return [...seen.values()];
}

const norm = (s: string) => s.trim().toLowerCase();
const segments = (target: string) => target.split('/').map(norm).filter(Boolean);

/** Lookup key stored with each link: the normalised last path segment. */
export const linkKey = (target: string) => segments(target).at(-1) ?? norm(target);

// ---------- Resolution ----------

export interface LinkablePage {
  id: string;
  notebookId: string;
  parentId: string | null;
  title: string;
  createdAt: number;
}

export interface LinkableNotebook {
  id: string;
  title: string;
}

export interface LinkContext {
  pages: Map<string, LinkablePage>;
  notebooks: Map<string, LinkableNotebook>;
  /** Pages by normalised title, oldest first. */
  byTitle: Map<string, LinkablePage[]>;
}

export function buildLinkContext(pages: LinkablePage[], notebooks: LinkableNotebook[]): LinkContext {
  const byTitle = new Map<string, LinkablePage[]>();
  const sorted = [...pages].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  for (const page of sorted) {
    const key = norm(page.title);
    if (!key) continue;
    const list = byTitle.get(key) ?? [];
    list.push(page);
    byTitle.set(key, list);
  }
  return {
    pages: new Map(pages.map((p) => [p.id, p])),
    notebooks: new Map(notebooks.map((n) => [n.id, n])),
    byTitle,
  };
}

/** Titles from the notebook down to the page: `[notebook, ...ancestors, page]`. */
export function pathOf(ctx: LinkContext, page: LinkablePage): string[] {
  const path = [page.title];
  let current = page;
  while (current.parentId) {
    const parent = ctx.pages.get(current.parentId);
    if (!parent) break;
    path.unshift(parent.title);
    current = parent;
  }
  path.unshift(ctx.notebooks.get(page.notebookId)?.title ?? '');
  return path;
}

/** All pages a target could mean, oldest first. */
export function linkCandidates(ctx: LinkContext, target: string): LinkablePage[] {
  // A title may itself contain "/", so an exact title match wins.
  const exact = ctx.byTitle.get(norm(target));
  if (exact?.length) return exact;
  const segs = segments(target);
  if (segs.length < 2) return [];
  return (ctx.byTitle.get(segs.at(-1)!) ?? []).filter((page) => {
    const path = pathOf(ctx, page).map(norm);
    return segs.every((seg, i) => path[path.length - segs.length + i] === seg);
  });
}

/** Resolves a target to a page, preferring the linking page's notebook, then the oldest page. */
export function resolveWikilink(ctx: LinkContext, target: string, fromNotebookId?: string): LinkablePage | null {
  const candidates = linkCandidates(ctx, target);
  return candidates.find((p) => p.notebookId === fromNotebookId) ?? candidates[0] ?? null;
}

/** The shortest unambiguous target for a page: its title, qualified with ancestors as needed. */
export function linkTargetFor(ctx: LinkContext, page: LinkablePage): string {
  const path = pathOf(ctx, page);
  for (let n = 1; n <= path.length; n++) {
    const target = path.slice(-n).join('/');
    const candidates = linkCandidates(ctx, target);
    if (candidates.length === 1 && candidates[0]!.id === page.id) return target;
  }
  return path.join('/');
}

/**
 * Recomputes a link after renames: keeps the same qualification depth as `original`, but with
 * the page's current titles. Returns null if nothing changed.
 */
export function retarget(ctx: LinkContext, page: LinkablePage, original: string): string | null {
  const path = pathOf(ctx, page);
  const exactTitle = norm(original) === norm(page.title);
  const depth = exactTitle ? 1 : Math.min(segments(original).length, path.length);
  const next = path.slice(-depth).join('/');
  return next === original ? null : next;
}
