import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { pushSubscribeSchema, type ReminderStatus } from '@nicotes/shared';
import type { AppEnv } from '../auth.js';
import { notFound, readJson, requestOrigin } from '../http.js';
import type { ReminderService } from '../reminders.js';

/** /api/reminders (session only): devices for push, the Telegram chat, a test message. */
export function reminderRoutes(reminders: ReminderService) {
  return new Hono<AppEnv>()
    .use(async (c, next) => {
      // Messages link back to the address the app is used at.
      reminders.rememberAppUrl(c.var.user.id, requestOrigin(c));
      await next();
    })
    .get('/', async (c) => {
      const userId = c.var.user.id;
      const status: ReminderStatus = {
        vapidPublicKey: reminders.vapidKeys(userId).publicKey,
        devices: reminders.devices(userId),
        telegram: await reminders.telegramStatus(userId),
      };
      return c.json(status);
    })
    .post('/push', async (c) => {
      const input = await readJson(c, pushSubscribeSchema);
      return c.json(reminders.subscribe(c.var.user.id, input), 201);
    })
    .delete('/push/:id', (c) => {
      if (!reminders.unsubscribe(c.var.user.id, c.req.param('id'))) throw notFound('Device');
      return c.body(null, 204);
    })
    .post('/telegram/link', async (c) => {
      try {
        return c.json({ url: await reminders.startLink(c.var.user.id) });
      } catch (err) {
        throw new HTTPException(400, { message: (err as Error).message });
      }
    })
    .delete('/telegram', (c) => {
      reminders.disconnectTelegram(c.var.user.id);
      return c.body(null, 204);
    })
    .post('/test', async (c) => {
      const results = await reminders.deliver(c.var.user.id, {
        title: 'Test reminder',
        body: 'Reminders from Nicotes arrive here.',
        url: '/tasks',
        tag: 'test',
      });
      if (!results.length) throw new HTTPException(409, { message: 'Turn on a device or connect Telegram first' });
      return c.json(results);
    });
}
