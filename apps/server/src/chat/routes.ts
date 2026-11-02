import { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { chatConfirmSchema, chatSendSchema, type ChatEvent } from '@nicotes/shared';
import { LlmError } from '../ai/llm.js';
import type { AppEnv } from '../auth.js';
import { readJson } from '../http.js';
import { chatHistory, confirmAction, resetChat, runChat, type ChatDeps } from './agent.js';

/** /api/chat: the web app's conversation. */
export function chatRoutes(deps: ChatDeps) {
  return new Hono<AppEnv>()
    .get('/', (c) => c.json(chatHistory(deps.db, c.var.user.id, 'web')))
    .delete('/', (c) => {
      resetChat(deps.db, c.var.user.id, 'web');
      return c.body(null, 204);
    })
    // The user's answer to a step that waits for them, such as deleting a page.
    .post('/actions/:id', async (c) => {
      const { confirm } = await readJson(c, chatConfirmSchema);
      return c.json(confirmAction(deps.db, c.var.user.id, c.req.param('id'), confirm));
    })
    .post('/', async (c) => {
      const { text } = await readJson(c, chatSendSchema);
      const user = c.var.user;
      return streamSSE(c, async (stream) => {
        const send = (event: ChatEvent) => stream.writeSSE({ data: JSON.stringify(event) });
        const abort = new AbortController();
        stream.onAbort(() => abort.abort());
        try {
          const entry = await runChat(deps, {
            userId: user.id,
            username: user.username,
            channel: 'web',
            text,
            signal: abort.signal,
            onUser: (e) => void send({ type: 'user', entry: e }),
            onAction: (action) => void send({ type: 'action', action }),
          });
          await send({ type: 'answer', entry });
        } catch (err) {
          if (!(err instanceof LlmError)) console.error('Chat failed:', err);
          await send({ type: 'error', error: err instanceof LlmError ? err.message : 'The chat failed; see the server log' });
        }
      });
    });
}
