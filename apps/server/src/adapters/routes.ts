import { Hono } from 'hono';
import { adapterSaveSchema } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import { readJson } from '../http.js';
import type { AdapterService } from './service.js';

/** /api/adapters (session only: they hold tokens for other services). */
export function adapterRoutes(service: AdapterService) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(service.list(c.var.user.id)))
    .post('/', async (c) => c.json(service.save(c.var.user.id, await readJson(c, adapterSaveSchema)), 201))
    .put('/:id', async (c) => c.json(service.save(c.var.user.id, await readJson(c, adapterSaveSchema), c.req.param('id'))))
    .delete('/:id', (c) => {
      service.remove(c.var.user.id, c.req.param('id'));
      return c.body(null, 204);
    })
    .post('/:id/run', async (c) => c.json(await service.run(c.var.user.id, c.req.param('id'))));
}
