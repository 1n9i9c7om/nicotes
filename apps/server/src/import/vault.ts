import { posix } from 'node:path';
import { eq, inArray } from 'drizzle-orm';
import { strFromU8, unzipSync } from 'fflate';
import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { HTTPException } from 'hono/http-exception';
import {
  MAX_ATTACHMENT_BYTES,
  normalizeTag,
  vaultImportSchema,
  type VaultImportMode,
  type VaultImportResult,
  type VaultPreview,
} from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { readJson } from '../http.js';
import { Pending } from '../pending.js';
import { attachments, notebooks, pages } from '../db/schema.js';
import { newId } from '../ids.js';
import { indexPageLinks } from '../links.js';
import { storeAttachment } from '../routes/attachments.js';
import { setPageTags } from '../routes/tags.js';

/**
 * Folders of Markdown notes from a zip: an Obsidian vault, or a Nicotes export (which is
 * laid out like one). Notes become pages, folders become notebooks or parent pages, and
 * the files notes use become attachments.
 */

export interface VaultNote {
  /** Path in the vault, e.g. "Projects/Home lab.md". */
  path: string;
  folder: string;
  /** File name without ".md". */
  name: string;
  title: string;
  tags: string[];
  createdAt: number | null;
  updatedAt: number | null;
  /** The Markdown without its frontmatter; properties other than the known ones lead it. */
  body: string;
}

export interface Vault {
  name: string;
  notes: VaultNote[];
  /** Everything else, by path. */
  files: Map<string, Uint8Array>;
  skipped: { path: string; reason: string }[];
}

// Hidden files and folders (.obsidian, .trash, .git, …) and macOS zip debris.
const IGNORED = /(^|\/)(\.[^/]*|__MACOSX)(\/|$)/;
const MARKDOWN = /\.(md|markdown)$/i;

/** Zips made on Windows store non-ASCII names in the local code page or as unflagged UTF-8. */
function fixName(name: string): string {
  if (!/[\u0080-ÿ]/.test(name) || /[^\u0000-ÿ]/.test(name)) return name;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(name, (c) => c.charCodeAt(0)));
  } catch {
    return name;
  }
}

// ---------- Frontmatter ----------

type Props = Record<string, string | string[]>;

function unquote(value: string): string {
  const v = value.trim();
  if (v.startsWith('"') && v.endsWith('"')) {
    try {
      return JSON.parse(v) as string;
    } catch {
      return v.slice(1, -1);
    }
  }
  if (v.startsWith("'") && v.endsWith("'")) return v.slice(1, -1).replace(/''/g, "'");
  return v;
}

function parseValue(value: string): string | string[] {
  const v = value.trim();
  if (v.startsWith('[') && v.endsWith(']')) {
    try {
      const list = JSON.parse(v) as unknown;
      if (Array.isArray(list)) return list.map(String);
    } catch {
      // YAML flow list: [a, "b c"]
    }
    return v
      .slice(1, -1)
      .split(',')
      .map(unquote)
      .filter(Boolean);
  }
  return unquote(v);
}

/** The small part of YAML frontmatter that notes use: scalars, lists, block text. */
export function splitFrontmatter(text: string): { props: Props; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) return { props: {}, body: text };
  const props: Props = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([^\s:#][^:]*):[ \t]*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.trim();
    const rest = kv[2]!;
    if (rest === '' || /^[|>][+-]?$/.test(rest)) {
      // A list ("- item" lines) or block text (indented lines) follows.
      const block: string[] = [];
      while (i + 1 < lines.length && /^(\s+|-\s)/.test(lines[i + 1]!)) block.push(lines[++i]!);
      const items = block.filter((l) => /^\s*-\s+/.test(l)).map((l) => unquote(l.replace(/^\s*-\s+/, '')));
      props[key] = rest === '' && items.length ? items : block.map((l) => l.trim()).join(rest.startsWith('>') ? ' ' : '\n');
    } else {
      props[key] = parseValue(rest);
    }
  }
  return { props, body: text.slice(m[0].length) };
}

/** Properties Nicotes knows (or that only matter to Obsidian); the rest are kept as text. */
const KNOWN = new Set(['id', 'title', 'tags', 'tag', 'aliases', 'alias', 'created', 'updated', 'modified', 'cssclasses', 'cssclass', 'publish']);

const dateOf = (value: string | string[] | undefined) => {
  const time = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(time) ? time : null;
};

/** Inline #tags outside code: Obsidian wants at least one character that is not a digit. */
const INLINE_TAG = /(?<=^|[\s,])#([\p{L}\p{N}_\-/]*[\p{L}_\-/][\p{L}\p{N}_\-/]*)/gu;

function parseNote(path: string, text: string): VaultNote {
  const folder = posix.dirname(path) === '.' ? '' : posix.dirname(path);
  const name = posix.basename(path).replace(MARKDOWN, '');
  const { props, body } = splitFrontmatter(text.replace(/^﻿/, ''));
  const listed = props.tags ?? props.tag ?? [];
  const tags = (Array.isArray(listed) ? listed : listed.split(/[,\s]+/)).map(normalizeTag);
  forEachText(body, (line) => {
    for (const m of line.matchAll(INLINE_TAG)) tags.push(normalizeTag(m[1]!));
  });
  const extra = Object.entries(props)
    .filter(([key]) => !KNOWN.has(key.toLowerCase()))
    .map(([key, value]) => `**${key}:** ${Array.isArray(value) ? value.join(', ') : value}`);
  const title = typeof props.title === 'string' && props.title.trim() ? props.title.trim() : name;
  // A first heading that repeats the title would show it twice under the page title.
  let markdown = body.replace(/^\s*\n/, '');
  const heading = /^#[ \t]+(.+?)[ \t#]*(?:\r?\n|$)/.exec(markdown);
  if (heading && heading[1]!.trim().toLowerCase() === title.toLowerCase()) {
    markdown = markdown.slice(heading[0].length).replace(/^\s*\n/, '');
  }
  return {
    path,
    folder,
    name,
    title: title.slice(0, 300),
    tags: [...new Set(tags.filter(Boolean))],
    createdAt: dateOf(props.created),
    updatedAt: dateOf(props.updated ?? props.modified),
    body: (extra.length ? `${extra.join('  \n')}\n\n` : '') + markdown,
  };
}

/** Calls `fn` for the text of each line outside fenced code, with inline code blanked. */
function forEachText(markdown: string, fn: (line: string) => void) {
  let fence: string | null = null;
  for (const line of markdown.split('\n')) {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (fence) {
      if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      continue;
    }
    if (marker) {
      fence = marker;
      continue;
    }
    fn(line.replace(/`[^`]*`/g, (code) => ' '.repeat(code.length)));
  }
}

/** Rewrites each line outside fenced code; inline code spans are passed through untouched. */
function mapText(markdown: string, fn: (text: string) => string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
      if (fence) {
        if (marker && marker[0] === fence[0] && marker.length >= fence.length) fence = null;
        return line;
      }
      if (marker) {
        fence = marker;
        return line;
      }
      return line
        .split(/(`[^`]*`)/)
        .map((part) => (part.startsWith('`') && part.endsWith('`') && part.length > 1 ? part : fn(part)))
        .join('');
    })
    .join('\n');
}

// ---------- Reading ----------

export function readVault(zip: Uint8Array, fallbackName: string): Vault {
  const skipped: Vault['skipped'] = [];
  const entries = unzipSync(zip, {
    filter: (file) => {
      const name = fixName(file.name);
      if (name.endsWith('/') || IGNORED.test(name)) return false;
      if (file.originalSize > MAX_ATTACHMENT_BYTES) {
        skipped.push({ path: name, reason: 'larger than 25 MB' });
        return false;
      }
      if (file.compression !== 0 && file.compression !== 8) {
        skipped.push({ path: name, reason: 'compressed in a way that cannot be read; zip it again' });
        return false;
      }
      return true;
    },
  });
  let paths = Object.keys(entries).map((raw) => ({ raw, path: fixName(raw).replace(/\\/g, '/') }));
  // A zip of the vault folder itself: its name is the vault's.
  let name = fallbackName;
  const first = paths[0]?.path.split('/')[0];
  if (first && paths.every((p) => p.path.startsWith(`${first}/`))) {
    name = first;
    paths = paths.map((p) => ({ ...p, path: p.path.slice(first.length + 1) }));
  }
  const notes: VaultNote[] = [];
  const files = new Map<string, Uint8Array>();
  for (const { raw, path } of paths) {
    if (/\.excalidraw\.md$/i.test(path)) skipped.push({ path, reason: 'Excalidraw drawings are not imported' });
    else if (MARKDOWN.test(path)) notes.push(parseNote(path, strFromU8(entries[raw]!)));
    else files.set(path, entries[raw]!);
  }
  return { name, notes, files, skipped };
}

// ---------- Planning ----------

interface PlanPage {
  id: string;
  title: string;
  note: VaultNote | null;
  children: PlanPage[];
}

interface PlanNotebook {
  title: string;
  pages: PlanPage[];
}

interface Folder {
  name: string;
  notes: VaultNote[];
  folders: Map<string, Folder>;
}

const byName = (a: { title: string }, b: { title: string }) => a.title.localeCompare(b.title, 'en', { numeric: true, sensitivity: 'base' });

function folderTree(notes: VaultNote[]): Folder {
  const root: Folder = { name: '', notes: [], folders: new Map() };
  for (const note of notes) {
    let node = root;
    for (const part of note.folder ? note.folder.split('/') : []) {
      if (!node.folders.has(part)) node.folders.set(part, { name: part, notes: [], folders: new Map() });
      node = node.folders.get(part)!;
    }
    node.notes.push(note);
  }
  return root;
}

const page = (title: string, note: VaultNote | null, children: PlanPage[] = []): PlanPage => ({ id: newId(), title, note, children });

/**
 * A folder's pages: its notes, and its subfolders as parent pages. A note named like a
 * subfolder, next to it ("Page.md" + "Page/", as Nicotes exports) or inside it (the folder
 * note plugins' "Page/Page.md"), becomes that parent page.
 */
function folderPages(folder: Folder): PlanPage[] {
  const result: PlanPage[] = [];
  const used = new Set<VaultNote>();
  for (const sub of folder.folders.values()) {
    const key = sub.name.toLowerCase();
    const outside = folder.notes.find((n) => n.name.toLowerCase() === key && !used.has(n));
    const inside = outside ? undefined : sub.notes.find((n) => n.name.toLowerCase() === key);
    const note = outside ?? inside ?? null;
    if (note) used.add(note);
    const children = folderPages(inside ? { ...sub, notes: sub.notes.filter((n) => n !== inside) } : sub);
    result.push(page(note?.title ?? sub.name, note, children));
  }
  for (const note of folder.notes) if (!used.has(note)) result.push(page(note.title, note));
  return result.sort(byName);
}

function plan(vault: Vault, mode: VaultImportMode, title?: string): PlanNotebook[] {
  const root = folderTree(vault.notes);
  if (mode === 'single') return [{ title: title ?? vault.name, pages: folderPages(root) }];
  // A folder next to a note of its name holds that note's subpages (as Nicotes exports a
  // single notebook); the other folders become notebooks.
  const noteNames = new Set(root.notes.map((n) => n.name.toLowerCase()));
  const isPage = ([, folder]: [string, Folder]) => noteNames.has(folder.name.toLowerCase());
  const books: PlanNotebook[] = [...root.folders]
    .filter((entry) => !isPage(entry))
    .map(([, folder]) => ({ title: folder.name, pages: folderPages(folder) }));
  if (root.notes.length) books.unshift({ title: vault.name, pages: folderPages({ ...root, folders: new Map([...root.folders].filter(isPage)) }) });
  return books;
}

const countPages = (list: PlanPage[]): number => list.reduce((n, p) => n + 1 + countPages(p.children), 0);

// ---------- Links and files ----------

const WIKI = /(!?)\[\[([^[\]|\n]+?)(?:\|([^[\]\n]*?))?\]\]/g;
const MD_LINK = /(!?)\[([^\]\n]*)\]\((?:<([^>\n]+)>|([^)\s]+))(?:\s+"[^"]*")?\)/g;
const IMAGE = /\.(png|jpe?g|gif|webp|avif|svg|bmp)$/i;

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  pdf: 'application/pdf',
  txt: 'text/plain',
  csv: 'text/csv',
  json: 'application/json',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  webm: 'audio/webm',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  zip: 'application/zip',
};
const mimeOf = (path: string) => MIME[posix.extname(path).slice(1).toLowerCase()] ?? 'application/octet-stream';

function decode(target: string): string {
  try {
    return decodeURI(target);
  } catch {
    return target;
  }
}

/** Finds what a link means: a path from the note's folder or the vault's root, else any file of that name. */
class Resolver {
  private notesByPath = new Map<string, VaultNote>();
  private notesByName = new Map<string, VaultNote>();
  private filesByName = new Map<string, string[]>();

  constructor(private vault: Vault) {
    for (const note of vault.notes) {
      this.notesByPath.set(note.path.replace(MARKDOWN, '').toLowerCase(), note);
      if (!this.notesByName.has(note.name.toLowerCase())) this.notesByName.set(note.name.toLowerCase(), note);
    }
    for (const path of vault.files.keys()) {
      const key = posix.basename(path).toLowerCase();
      this.filesByName.set(key, [...(this.filesByName.get(key) ?? []), path]);
    }
  }

  file(target: string, from: string): string | null {
    const clean = decode(target).replace(/^\.\//, '');
    for (const candidate of [posix.normalize(posix.join(from, clean)), posix.normalize(clean)]) {
      if (this.vault.files.has(candidate)) return candidate;
    }
    const matches = this.filesByName.get(posix.basename(clean).toLowerCase()) ?? [];
    return matches.find((p) => p.startsWith(from)) ?? matches[0] ?? null;
  }

  note(target: string, from: string): VaultNote | null {
    const clean = decode(target).replace(/^\.\//, '').replace(MARKDOWN, '').toLowerCase();
    return (
      this.notesByPath.get(posix.normalize(posix.join(from.toLowerCase(), clean))) ??
      this.notesByPath.get(posix.normalize(clean)) ??
      this.notesByName.get(posix.basename(clean)) ??
      null
    );
  }
}

/** Splits "Note#Heading" / "Note^block" / "Note.md" into the note's part. */
const notePart = (target: string) => target.split(/[#^]/)[0]!.trim().replace(MARKDOWN, '');
const isExternal = (target: string) => /^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/');

/**
 * Obsidian Markdown in Nicotes' dialect: wikilinks lose headings and block ids, embeds of
 * notes become links, files become attachment links, and links to notes become wikilinks.
 */
function convert(note: VaultNote, resolver: Resolver, urls: Map<string, string>): string {
  const wikilink = (target: string, label?: string) => {
    const part = notePart(target);
    const found = part ? resolver.note(part, note.folder) : note;
    // Linked by file name, but the page is called something else (a "title" property).
    const name = found && found.title !== found.name && posix.basename(part).toLowerCase() === found.name.toLowerCase() ? found.title : part;
    if (!name) return label || target.replace(/^[#^]/, '');
    return label && label !== name ? `[[${name}|${label}]]` : `[[${name}]]`;
  };
  return mapText(note.body, (text) =>
    text
      .replace(WIKI, (all, bang: string, target: string, label: string | undefined) => {
        const file = !MARKDOWN.test(target) && posix.extname(notePart(target)) ? resolver.file(target, note.folder) : null;
        if (file && urls.has(file)) {
          const name = posix.basename(file);
          return bang && IMAGE.test(file) ? `![${name}](${urls.get(file)})` : `[${name}](${urls.get(file)})`;
        }
        // An embedded note shows as a link; sizes of embedded images ("|300") are dropped.
        return wikilink(target, bang || /^\d+(x\d+)?$/.test(label ?? '') ? undefined : label?.trim());
      })
      .replace(MD_LINK, (all, bang: string, label: string, angled: string | undefined, plain: string | undefined) => {
        const target = angled ?? plain!;
        if (isExternal(target)) return all;
        const file = resolver.file(target, note.folder);
        if (file && urls.has(file)) return `${bang}[${label}](${urls.get(file)})`;
        if (!bang && MARKDOWN.test(decode(target).split(/[#^]/)[0]!)) {
          const found = resolver.note(notePart(target), note.folder);
          if (found) return label && label !== found.title ? `[[${found.title}|${label}]]` : `[[${found.title}]]`;
        }
        return all;
      }),
  );
}

/** Vault paths of the files a note links to or embeds. */
function filesUsed(note: VaultNote, resolver: Resolver): string[] {
  const used: string[] = [];
  forEachText(note.body, (text) => {
    for (const m of text.matchAll(WIKI)) {
      const target = notePart(m[2]!);
      if (MARKDOWN.test(m[2]!) || !posix.extname(target)) continue;
      const file = resolver.file(m[2]!, note.folder);
      if (file) used.push(file);
    }
    for (const m of text.matchAll(MD_LINK)) {
      const target = m[3] ?? m[4]!;
      if (isExternal(target)) continue;
      const file = resolver.file(target, note.folder);
      if (file) used.push(file);
    }
  });
  return used;
}

function unresolvedLinks(vault: Vault, resolver: Resolver): number {
  let count = 0;
  for (const note of vault.notes) {
    forEachText(note.body, (text) => {
      for (const m of text.matchAll(WIKI)) {
        const part = notePart(m[2]!);
        if (part && !posix.extname(part) && !resolver.note(part, note.folder)) count++;
      }
    });
  }
  return count;
}

// ---------- Preview and import ----------

export function previewVault(db: Db, userId: string, vault: Vault, id: string): VaultPreview {
  const resolver = new Resolver(vault);
  const used = new Set(vault.notes.flatMap((n) => filesUsed(n, resolver)));
  const unused = [...vault.files.keys()].filter((p) => !used.has(p)).map((path) => ({ path, reason: 'no note uses it' }));
  const skipped = [...vault.skipped, ...unused].sort((a, b) => a.path.localeCompare(b.path));
  const existing = new Set(
    db
      .select({ title: notebooks.title, deletedAt: notebooks.deletedAt })
      .from(notebooks)
      .where(eq(notebooks.userId, userId))
      .all()
      .filter((n) => n.deletedAt === null)
      .map((n) => n.title.toLowerCase()),
  );
  return {
    id,
    name: vault.name,
    notes: vault.notes.length,
    attachments: used.size,
    tags: new Set(vault.notes.flatMap((n) => n.tags)).size,
    notebooks: plan(vault, 'notebooks').map((b) => ({ title: b.title, pages: countPages(b.pages), exists: existing.has(b.title.toLowerCase()) })),
    unresolvedLinks: unresolvedLinks(vault, resolver),
    skipped: skipped.slice(0, 50),
    skippedCount: skipped.length,
  };
}

export async function importVault(
  db: Db,
  dataDir: string,
  userId: string,
  vault: Vault,
  mode: VaultImportMode,
  title?: string,
): Promise<VaultImportResult> {
  const resolver = new Resolver(vault);
  const books = plan(vault, mode, title);

  // Files first (written to disk, linked to their pages below), so the Markdown can point at them.
  const urls = new Map<string, string>();
  const ids = new Map<string, string>();
  const firstUser = new Map<string, VaultNote>();
  for (const note of vault.notes) for (const path of filesUsed(note, resolver)) if (!firstUser.has(path)) firstUser.set(path, note);
  for (const path of firstUser.keys()) {
    const stored = await storeAttachment(db, dataDir, {
      userId,
      pageId: null,
      filename: posix.basename(path),
      mime: mimeOf(path),
      bytes: Buffer.from(vault.files.get(path)!),
    });
    urls.set(path, stored.url);
    ids.set(path, stored.id);
  }

  const own = db.select({ title: notebooks.title, sortOrder: notebooks.sortOrder, deletedAt: notebooks.deletedAt }).from(notebooks).where(eq(notebooks.userId, userId)).all();
  const existing = new Set(own.filter((n) => n.deletedAt === null).map((n) => n.title.toLowerCase()));
  const pageOf = new Map<VaultNote, string>();
  const created: VaultImportResult['notebooks'] = [];
  const tags = new Set<string>();
  let count = 0;
  const now = Date.now();
  db.transaction((tx) => {
    let order = Math.max(-1, ...own.map((n) => n.sortOrder)) + 1;
    for (const book of books) {
      // Next to a notebook of the same name rather than into it.
      let bookTitle = book.title.slice(0, 200) || 'Imported';
      if (existing.has(bookTitle.toLowerCase())) bookTitle = `${bookTitle.slice(0, 188)} (imported)`;
      const notebookId = newId();
      tx.insert(notebooks).values({ id: notebookId, userId, title: bookTitle, sortOrder: order++, createdAt: now, updatedAt: now }).run();
      created.push({ id: notebookId, title: bookTitle });
      const insert = (list: PlanPage[], parentId: string | null) => {
        list.forEach((p, sortOrder) => {
          const note = p.note;
          tx.insert(pages)
            .values({
              id: p.id,
              userId,
              notebookId,
              parentId,
              title: p.title,
              content: note ? convert(note, resolver, urls) : '',
              sortOrder,
              createdAt: note?.createdAt ?? note?.updatedAt ?? now,
              updatedAt: note?.updatedAt ?? note?.createdAt ?? now,
            })
            .run();
          count++;
          if (note) {
            pageOf.set(note, p.id);
            if (note.tags.length) {
              setPageTags(tx, userId, p.id, note.tags);
              for (const t of note.tags) tags.add(t);
            }
          }
          insert(p.children, p.id);
        });
      };
      insert(book.pages, null);
    }
    for (const [path, note] of firstUser) {
      const pageId = pageOf.get(note);
      if (pageId) tx.update(attachments).set({ pageId }).where(eq(attachments.id, ids.get(path)!)).run();
    }
  });
  // Links are indexed once every page exists, so links between imported pages resolve.
  const imported = [...pageOf.values()];
  for (let i = 0; i < imported.length; i += 500) {
    const rows = db.select({ id: pages.id, content: pages.content }).from(pages).where(inArray(pages.id, imported.slice(i, i + 500))).all();
    for (const row of rows) indexPageLinks(db, userId, row.id, row.content);
  }
  return { notebooks: created, pages: count, attachments: urls.size, tags: tags.size };
}

// ---------- Routes ----------

const MAX_VAULT_BYTES = 300 * 1024 * 1024;
const MAX_NOTES = 20_000;

/** /api/import/vault: upload a zip for a preview, then import it with the chosen layout. */
export function vaultRoutes(db: Db, dataDir: string, onImported: () => void = () => {}) {
  // Unpacked uploads wait here between preview and import; few, as they can be large.
  const uploads = new Pending<{ userId: string; vault: Vault }>(30 * 60 * 1000, 2);
  return new Hono<AppEnv>()
    .post(
      '/preview',
      bodyLimit({ maxSize: MAX_VAULT_BYTES, onError: (c) => c.json({ error: 'The zip is too large (at most 300 MB)' }, 413) }),
      async (c) => {
        const userId = c.var.user.id;
        const file = (await c.req.parseBody()).file;
        if (!(file instanceof File)) throw new HTTPException(400, { message: 'Missing file' });
        let vault: Vault;
        try {
          vault = readVault(new Uint8Array(await file.arrayBuffer()), file.name.replace(/\.zip$/i, '') || 'Imported notes');
        } catch {
          throw new HTTPException(400, { message: 'This zip file cannot be read' });
        }
        if (!vault.notes.length) throw new HTTPException(400, { message: 'There are no Markdown notes (.md files) in this zip' });
        if (vault.notes.length > MAX_NOTES) throw new HTTPException(413, { message: `At most ${MAX_NOTES.toLocaleString('en')} notes at once` });
        return c.json(previewVault(db, userId, vault, uploads.put({ userId, vault })));
      },
    )
    .post('/', async (c) => {
      const input = await readJson(c, vaultImportSchema);
      const userId = c.var.user.id;
      const upload = uploads.get(input.id);
      if (!upload || upload.userId !== userId) throw new HTTPException(409, { message: 'The upload has expired, choose the zip again' });
      uploads.delete(input.id);
      const result = await importVault(db, dataDir, userId, upload.vault, input.mode, input.title);
      onImported();
      return c.json(result, 201);
    });
}
