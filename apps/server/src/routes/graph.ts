import { Hono } from 'hono';
import { resolveWikilink, type GraphLinks } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import type { Db } from '../db/index.js';
import { liveLinks, loadLinkContext } from '../links.js';

/** All resolved page-to-page links of a user (the client adds hierarchy and tag edges). */
export function graphLinks(db: Db, userId: string): GraphLinks {
  const ctx = loadLinkContext(db, userId);
  const links = new Map<string, { source: string; target: string }>();
  const missing = new Map<string, { source: string; target: string }>();
  for (const link of liveLinks(db, userId)) {
    const page = resolveWikilink(ctx, link.target, link.notebookId);
    if (page) {
      if (page.id !== link.sourceId) links.set(`${link.sourceId}>${page.id}`, { source: link.sourceId, target: page.id });
    } else {
      missing.set(`${link.sourceId}>${link.target.toLowerCase()}`, { source: link.sourceId, target: link.target });
    }
  }
  return { links: [...links.values()], missing: [...missing.values()] };
}

export function graphRoutes(db: Db) {
  return new Hono<AppEnv>().get('/', (c) => c.json(graphLinks(db, c.var.user.id)));
}
