import type { Context } from 'hono';
import { getConnInfo } from '@hono/node-server/conninfo';
import { HTTPException } from 'hono/http-exception';
import type { z } from 'zod';

/** Parses and validates a JSON request body, answering 400 on failure. */
export async function readJson<T extends z.ZodType>(c: Context, schema: T): Promise<z.infer<T>> {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw new HTTPException(400, { message: 'Invalid JSON body' });
  }
  const result = schema.safeParse(body);
  if (!result.success) {
    const issue = result.error.issues[0];
    const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    throw new HTTPException(400, { message: `${where}${issue?.message ?? 'Invalid request'}` });
  }
  return result.data;
}

export const notFound = (what: string) => new HTTPException(404, { message: `${what} not found` });

/** The caller's IP address, for rate limits ("unknown" where the runtime does not tell). */
export function clientIp(c: Context): string {
  try {
    return getConnInfo(c).remote.address ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/** The address the request was made to, also behind a reverse proxy. */
export function requestOrigin(c: Context): string {
  const url = new URL(c.req.url);
  const proto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim();
  const host = c.req.header('x-forwarded-host')?.split(',')[0]?.trim();
  return `${proto ?? url.protocol.replace(':', '')}://${host ?? url.host}`;
}
