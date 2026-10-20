import type { Context } from 'hono';
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
