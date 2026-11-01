import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { strToU8, zipSync, type Zippable } from 'fflate';
import { Hono } from 'hono';
import { isCanvas } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { attachments, notebooks, pages } from '../db/schema.js';
import { notFound } from '../http.js';
import { tagsByPage } from './tags.js';

const ATTACHMENT_LINK = /\/api\/attachments\/([\w-]+)(?:\/[^)\s"'>]*)?/g;

/** A file/folder name that is valid on Windows, macOS and Linux. */
export function safeFileName(name: string): string {
  const clean = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '-')
    .replace(/[. ]+$/, '')
    .trim()
    .slice(0, 120);
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(clean) || !clean ? `${clean || 'Untitled'}_` : clean;
}

/** Makes names unique within one folder ("Notes", "Notes (2)", …), case-insensitively. */
function uniqueNamer() {
  const used = new Set<string>();
  return (name: string) => {
    let candidate = name;
    for (let n = 2; used.has(candidate.toLowerCase()); n++) candidate = `${name} (${n})`;
    used.add(candidate.toLowerCase());
    return candidate;
  };
}

const iso = (ms: number) => new Date(ms).toISOString();

// JSON strings and arrays are valid YAML, which keeps quoting rules simple.
const yaml = (fields: Record<string, unknown>) => Object.entries(fields).map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n');

const frontmatter = (fields: Record<string, unknown>) => `---\n${yaml(fields)}\n---\n\n`;

export function exportRoutes(db: Db, dataDir: string) {
  return new Hono<AppEnv>().get('/', async (c) => {
    const userId = c.var.user.id;
    const onlyNotebook = c.req.query('notebookId');

    const nbs = db
      .select({ id: notebooks.id, title: notebooks.title })
      .from(notebooks)
      .where(
        and(
          eq(notebooks.userId, userId),
          isNull(notebooks.deletedAt),
          onlyNotebook ? eq(notebooks.id, onlyNotebook) : undefined,
        ),
      )
      .orderBy(notebooks.sortOrder)
      .all();
    if (onlyNotebook && nbs.length === 0) throw notFound('Notebook');

    const rows = nbs.length
      ? db
          .select()
          .from(pages)
          .where(
            and(
              eq(pages.userId, userId),
              isNull(pages.deletedAt),
              inArray(
                pages.notebookId,
                nbs.map((n) => n.id),
              ),
            ),
          )
          .orderBy(pages.sortOrder, pages.createdAt)
          .all()
      : [];
    const tags = tagsByPage(db, userId);
    const children = new Map<string, typeof rows>();
    for (const page of rows) {
      const key = page.parentId ?? `nb:${page.notebookId}`;
      children.set(key, [...(children.get(key) ?? []), page]);
    }

    // Attachments referenced from the exported pages, copied into "attachments/".
    const referenced = new Set<string>();
    for (const page of rows) for (const m of page.content.matchAll(ATTACHMENT_LINK)) referenced.add(m[1]!);
    const files: Zippable = {};
    const attachmentPaths = new Map<string, string>(); // id -> zip path
    if (referenced.size) {
      const atts = db
        .select({ id: attachments.id, filename: attachments.filename })
        .from(attachments)
        .where(and(eq(attachments.userId, userId), inArray(attachments.id, [...referenced])))
        .all();
      for (const att of atts) {
        const path = `attachments/${att.id}-${safeFileName(att.filename)}`;
        try {
          files[path] = await readFile(join(dataDir, 'attachments', att.id));
          attachmentPaths.set(att.id, path);
        } catch {
          // A missing file keeps its original link.
        }
      }
    }

    const writePage = (page: (typeof rows)[number], folder: string, name: string) => {
      // Canvas pages are Obsidian Excalidraw drawings, which that plugin finds by this name.
      const canvas = isCanvas(page.content);
      const path = `${folder}/${name}${canvas ? '.excalidraw' : ''}.md`;
      const up = '../'.repeat(path.split('/').length - 1);
      const content = page.content.replace(ATTACHMENT_LINK, (link, id: string) => {
        const target = attachmentPaths.get(id);
        return target ? up + encodeURI(target) : link;
      });
      const fields = {
        id: page.id,
        title: page.title,
        tags: tags.get(page.id) ?? [],
        created: iso(page.createdAt),
        updated: iso(page.updatedAt),
      };
      // A drawing has frontmatter of its own: the fields join it.
      files[path] = strToU8(canvas ? content.replace(/^---[ \t]*\r?\n/, `---\n${yaml(fields)}\n`) : frontmatter(fields) + content);
    };

    const writeLevel = (key: string, folder: string) => {
      const name = uniqueNamer();
      for (const page of children.get(key) ?? []) {
        const base = name(safeFileName(page.title || 'Untitled'));
        writePage(page, folder, base);
        // Obsidian convention: "Page.md" next to a "Page/" folder with its subpages.
        if (children.has(page.id)) writeLevel(page.id, `${folder}/${base}`);
      }
    };

    const nbName = uniqueNamer();
    for (const nb of nbs) writeLevel(`nb:${nb.id}`, nbName(safeFileName(nb.title)));

    const zip = zipSync(files, { level: 6 });
    const label = onlyNotebook ? safeFileName(nbs[0]!.title) : 'nicotes';
    const filename = `${label}-${new Date().toISOString().slice(0, 10)}.zip`;
    return new Response(zip, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,
        'Cache-Control': 'no-store',
      },
    });
  });
}
