import { describe, expect, it } from 'vitest';
import type { CreatedApiToken, Notebook, Page } from '@nicotes/shared';
import { tasksCalendar } from '../src/routes/calendar.js';
import { setup } from './helpers.js';

async function withTasks() {
  const api = setup();
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  const nb = (await api.call<Notebook>('POST', '/api/notebooks', { title: 'Travel, 2027' })).body;
  const page = (
    await api.call<Page>('POST', '/api/pages', {
      notebookId: nb.id,
      title: 'Lisbon in spring',
      content: [
        '## Before',
        '- [ ] Book flights for [[Lisbon in spring|Lisbon]] 📅 2026-11-03',
        '- [x] Renew passport 📅 2026-11-02',
        '- [ ] Pack light',
        '- [ ] Buy sun cream, hat; **sunglasses** 📅 2026-11-04',
      ].join('\n'),
    })
  ).body;
  const recipe = (await api.call<Page>('POST', '/api/pages', { notebookId: nb.id, title: 'Pancakes', content: '- [ ] Flour 📅 2026-11-05' })).body;
  await api.call('PUT', `/api/pages/${recipe.id}/tags`, { tags: ['recipe'] });
  const calendar = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Phone calendar', scope: 'calendar' })).body;
  return { api, page, calendar };
}

describe('calendar feed', () => {
  it('lists open tasks with a due date as all-day events, without a session', async () => {
    const { api, page, calendar } = await withTasks();
    const res = await api.request(`/api/calendar/${calendar.token}.ics`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/calendar; charset=utf-8');
    const ics = await res.text();
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2); // not done, not undated, not the recipe
    expect(ics).toContain('DTSTART;VALUE=DATE:20261103\r\nDTEND;VALUE=DATE:20261104');
    expect(ics).toContain('SUMMARY:Book flights for Lisbon');
    expect(ics).toContain(String.raw`SUMMARY:Buy sun cream\, hat\; sunglasses`);
    expect(ics).toContain(`URL:http://localhost/p/${page.id}`);
    expect(ics).toContain(String.raw`CATEGORIES:Travel\, 2027`);
    expect(ics).toContain('From “Lisbon in spring” › Before');
    expect(ics).not.toContain('Renew passport');
  });

  it('links back to the address the app is reached at behind a proxy', async () => {
    const { api, page, calendar } = await withTasks();
    const res = await api.request(`/api/calendar/${calendar.token}.ics`, {
      headers: { 'x-forwarded-proto': 'https', 'x-forwarded-host': 'notes.example.com' },
    });
    expect(await res.text()).toContain(`URL:https://notes.example.com/p/${page.id}`);
  });

  it('only opens with a calendar token, which works nowhere else', async () => {
    const { api, calendar } = await withTasks();
    const read = (await api.call<CreatedApiToken>('POST', '/api/tokens', { name: 'Script', scope: 'read' })).body;
    expect((await api.request('/api/calendar/nct_unknown.ics')).status).toBe(404);
    expect((await api.request(`/api/calendar/${read.token}.ics`)).status).toBe(404);
    const asBearer = await api.request('/api/notebooks', { headers: { authorization: `Bearer ${calendar.token}` } });
    expect(asBearer.status).toBe(403);

    await api.call('DELETE', `/api/tokens/${calendar.info.id}`);
    expect((await api.request(`/api/calendar/${calendar.token}.ics`)).status).toBe(404);
  });

  it('folds long lines at 75 bytes without splitting characters', () => {
    const task = {
      line: 0,
      raw: '',
      text: 'Ä'.repeat(60),
      done: false,
      due: '2026-12-31',
      remind: null,
      heading: null,
      depth: 0,
      pageId: 'p1',
      pageTitle: 'Ümlaute',
      notebookId: 'n1',
      version: 1,
      pageUpdatedAt: 0,
    };
    const ics = tasksCalendar([task], new Map(), 'https://notes.example.com', 0);
    const lines = ics.split('\r\n');
    expect(lines.every((l) => Buffer.byteLength(l) <= 75)).toBe(true);
    // Unfolding gives the summary back.
    expect(ics.replace(/\r\n /g, '')).toContain(`SUMMARY:${'Ä'.repeat(60)}`);
    expect(ics).toContain('DTEND;VALUE=DATE:20270101');
  });
});
