import { describe, expect, it } from 'vitest';
import { parseSensors, type Adapter, type AdapterRun, type DailyEntry, type Notebook, type Page } from '@nicotes/shared';
import { aggregate } from '../src/adapters/homeAssistant.js';
import { setJournalLine, upsertLogbookRow } from '../src/adapters/writers.js';
import { startOfDay } from '../src/time.js';
import { setup } from './helpers.js';

const at = (iso: string) => Date.parse(iso);

describe('logbook tables', () => {
  const solar = (value: number | null) => [{ label: 'Solar', unit: 'kWh', value }];

  it('adds a table, then keeps one row per day in date order', () => {
    let content = upsertLogbookRow('Notes on the panels.\n', '2026-11-04', solar(12.345));
    expect(content).toBe('Notes on the panels.\n\n| Date | Solar (kWh) |\n| --- | --- |\n| 2026-11-04 | 12.35 |\n');
    content = upsertLogbookRow(content, '2026-11-02', solar(8));
    content = upsertLogbookRow(content, '2026-11-04', solar(13));
    expect(content).toContain('| 2026-11-02 | 8 |\n| 2026-11-04 | 13 |');
  });

  it('adds columns for new values and keeps the rest of the page', () => {
    const page = 'Intro\n\n| Date | Solar (kWh) |\n| --- | --- |\n| 2026-11-01 | 5 |\n\nWritten by hand.';
    const content = upsertLogbookRow(page, '2026-11-02', [...solar(6), { label: 'Weather', unit: null, value: 'Rain | wind' }]);
    expect(content).toBe(
      'Intro\n\n| Date | Solar (kWh) | Weather |\n| --- | --- | --- |\n| 2026-11-01 | 5 |  |\n| 2026-11-02 | 6 | Rain \\| wind |\n\nWritten by hand.',
    );
  });

  it('replaces its own journal line', () => {
    const once = setJournalLine('# Today\n\nWoke up early.', 'Weather', 'Sunny');
    expect(once).toBe('# Today\n\nWoke up early.\n\n**Weather:** Sunny\n');
    expect(setJournalLine(once, 'Weather', 'Rain')).toBe('# Today\n\nWoke up early.\n\n**Weather:** Rain\n');
  });
});

describe('Home Assistant figures', () => {
  it('reads the sensor list', () => {
    expect(parseSensors('sensor.solar_today, Solar\n# a comment\nsensor.temp, Outside, average\nsensor.grid_total, change').sensors).toEqual([
      { entityId: 'sensor.solar_today', label: 'Solar', take: 'state' },
      { entityId: 'sensor.temp', label: 'Outside', take: 'average' },
      { entityId: 'sensor.grid_total', label: null, take: 'change' },
    ]);
    expect(parseSensors('Solar panels').errors[0]).toMatch(/not an entity id/);
    expect(parseSensors('sensor.a, Solar, sum').errors[0]).toMatch(/should be state, average/);
  });

  it('weights averages by time and counts counter resets', () => {
    const states = [
      { state: '10', last_changed: '2026-11-04T00:00:00Z' },
      { state: 'unavailable', last_changed: '2026-11-04T05:00:00Z' },
      { state: '20', last_changed: '2026-11-04T06:00:00Z' },
    ];
    // 10 for six hours, 20 for eighteen.
    expect(aggregate('average', states, at('2026-11-05T00:00:00Z'))).toBe(17.5);
    expect(aggregate('max', states, 0)).toBe(20);
    const counter = ['100', '104', '110', '2', '5'].map((state, i) => ({ state, last_changed: `2026-11-04T0${i}:00:00Z` }));
    expect(aggregate('change', counter, 0)).toBe(15);
  });

  it('finds midnight in a time zone, also on daylight saving days', () => {
    expect(new Date(startOfDay('2026-11-04', 'Europe/Berlin')).toISOString()).toBe('2026-11-03T23:00:00.000Z');
    expect(new Date(startOfDay('2026-03-29', 'Europe/Berlin')).toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(new Date(startOfDay('2026-10-25', 'Europe/Berlin')).toISOString()).toBe('2026-10-24T22:00:00.000Z');
  });
});

/** Fake Home Assistant and Open-Meteo; every request is kept. */
function fakes() {
  let now = at('2026-11-04T21:00:00Z');
  const requests: string[] = [];
  let solar = '12.345';
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push(url);
    if (url.startsWith('http://ha.local:8123/')) {
      if (new Headers(init?.headers).get('authorization') !== 'Bearer ha-token') return json({ message: 'Unauthorized' }, 401);
      const path = url.slice('http://ha.local:8123'.length);
      if (path === '/api/states/sensor.solar_energy_today') return json({ state: solar, attributes: { unit_of_measurement: 'kWh', friendly_name: 'Solar energy' } });
      if (path === '/api/states/sensor.outdoor_temperature') return json({ state: '9.5', attributes: { unit_of_measurement: '°C' } });
      if (path.startsWith('/api/history/period/')) {
        return json([
          [
            { entity_id: 'sensor.outdoor_temperature', state: '8', last_changed: '2026-11-03T23:00:00Z' },
            { state: '12', last_changed: '2026-11-04T11:00:00Z' },
          ],
        ]);
      }
      return json({ message: 'Entity not found.' }, 404);
    }
    if (url.startsWith('https://geocoding-api.open-meteo.com/')) {
      return json(url.includes('name=Hamburg') ? { results: [{ name: 'Hamburg', latitude: 53.55, longitude: 9.99 }] } : {});
    }
    if (url.startsWith('https://api.open-meteo.com/v1/forecast')) {
      const date = new URL(url).searchParams.get('start_date');
      return json({
        daily: {
          time: [date],
          weather_code: [2],
          temperature_2m_max: [14.4],
          temperature_2m_min: [7.6],
          precipitation_sum: [2.1],
          precipitation_probability_max: [60],
          sunshine_duration: [18_720],
          wind_speed_10m_max: [21.3],
        },
      });
    }
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  }) as typeof globalThis.fetch;
  return { options: { fetch, now: () => now }, setNow: (iso: string) => (now = at(iso)), requests, setSolar: (v: string) => (solar = v) };
}

async function signedIn(f: ReturnType<typeof fakes>) {
  const api = setup({ adapters: f.options });
  await api.call('POST', '/api/auth/setup', { username: 'nico', password: 'secret-pass' });
  await api.call('PATCH', '/api/settings', { reminderTimeZone: 'Europe/Berlin' });
  return api;
}

const home = {
  type: 'home-assistant',
  name: 'Home',
  config: { url: 'http://ha.local:8123/', entities: 'sensor.solar_energy_today, Solar\nsensor.outdoor_temperature, Temperature, average' },
  secrets: { token: 'ha-token' },
  target: 'logbook',
  dailyAt: '23:55',
};

describe('adapters', () => {
  it('writes Home Assistant values into a logbook, a row per day', async () => {
    const f = fakes();
    const api = await signedIn(f);
    const created = await api.call<Adapter>('POST', '/api/adapters', home);
    expect(created.status).toBe(201);
    expect(created.body.secretsSet).toEqual(['token']);
    expect(JSON.stringify((await api.call('GET', '/api/adapters')).body)).not.toContain('ha-token');

    const run = await api.call<AdapterRun>('POST', `/api/adapters/${created.body.id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.message).toBe('2026-11-04: Solar 12.35 kWh, Temperature 9.82 °C');
    // The day's history starts at midnight in Berlin and ends now: 8 °C for 12 hours, 12 °C for 10.
    expect(f.requests.find((r) => r.includes('/history/'))).toContain('/api/history/period/2026-11-03T23:00:00.000Z?filter_entity_id=sensor.outdoor_temperature&end_time=2026-11-04T21%3A00%3A00.000Z');

    f.setNow('2026-11-05T22:56:00Z');
    f.setSolar('3');
    await api.call('POST', `/api/adapters/${created.body.id}/run`);
    const page = (await api.call<Page>('GET', `/api/pages/${run.body.pageId}`)).body;
    expect(page.title).toBe('Home');
    expect(page.content).toContain('| Date | Solar (kWh) | Temperature (°C) |\n| --- | --- | --- |\n| 2026-11-04 | 12.35 | 9.82 |\n| 2026-11-05 | 3 |');
    const notebooks = (await api.call<Notebook[]>('GET', '/api/notebooks')).body;
    expect(notebooks.find((n) => n.id === page.notebookId)?.title).toBe('Logbooks');
    expect((await api.call<Adapter>('GET', '/api/adapters')).body).toMatchObject([{ pageId: page.id, lastStatus: 'ok' }]);
    api.adapters.stop();
  });

  it('runs once a day at its time', async () => {
    const f = fakes();
    const api = await signedIn(f);
    f.setNow('2026-11-04T12:00:00Z');
    const { id } = (await api.call<Adapter>('POST', '/api/adapters', home)).body;
    await api.adapters.tick();
    expect(f.requests).toHaveLength(0);

    f.setNow('2026-11-04T22:55:00Z'); // 23:55 in Berlin
    await api.adapters.tick();
    await api.adapters.tick();
    expect(f.requests.filter((r) => r.includes('/states/sensor.solar'))).toHaveLength(1);

    // A failed run is tried again after a while, not every minute.
    f.setNow('2026-11-05T22:55:00Z');
    await api.call('PUT', `/api/adapters/${id}`, { ...home, secrets: { token: 'expired' } });
    await api.adapters.tick();
    expect((await api.call<Adapter[]>('GET', '/api/adapters')).body[0]).toMatchObject({
      lastStatus: 'error',
      lastMessage: 'Home Assistant did not accept the access token',
    });
    f.setNow('2026-11-05T22:58:00Z');
    await api.adapters.tick();
    expect(f.requests.filter((r) => r.includes('/states/sensor.solar'))).toHaveLength(2);
    api.adapters.stop();
  });

  it('checks the settings and keeps tokens to their address', async () => {
    const f = fakes();
    const api = await signedIn(f);
    expect((await api.call('POST', '/api/adapters', { ...home, secrets: {} })).body).toEqual({ error: 'Long-lived access token is missing' });
    expect((await api.call('POST', '/api/adapters', { ...home, config: { ...home.config, entities: 'Solar' } })).status).toBe(400);
    const { id } = (await api.call<Adapter>('POST', '/api/adapters', home)).body;
    // Same address: the stored token is kept.
    expect((await api.call('PUT', `/api/adapters/${id}`, { ...home, name: 'House', secrets: {} })).status).toBe(200);
    const moved = { ...home, config: { ...home.config, url: 'https://elsewhere.example.com' }, secrets: {} };
    expect((await api.call('PUT', `/api/adapters/${id}`, moved)).body).toEqual({ error: 'Enter the long-lived access token again for the new address' });

    const unknown = await api.call<Adapter>('POST', '/api/adapters', { ...home, config: { ...home.config, entities: 'sensor.nope' } });
    expect((await api.call('POST', `/api/adapters/${unknown.body.id}/run`)).body).toEqual({ error: 'Home Assistant has no sensor.nope' });
    const away = await api.call<Adapter>('POST', '/api/adapters', { ...home, config: { ...home.config, url: 'http://10.0.0.9:8123' } });
    expect((await api.call('POST', `/api/adapters/${away.body.id}/run`)).body).toEqual({ error: 'Could not reach Home Assistant (ECONNREFUSED)' });

    // Adapters hold tokens: no API token access.
    const token = (await api.call<{ token: string }>('POST', '/api/tokens', { name: 'script' })).body.token;
    expect((await api.request('/api/adapters', { headers: { authorization: `Bearer ${token}` } })).status).toBe(403);
    api.adapters.stop();
  });

  it('writes the weather into the journal, replacing its line', async () => {
    const f = fakes();
    const api = await signedIn(f);
    const weather = { type: 'weather', name: 'Weather', config: { place: 'Hamburg' }, target: 'journal', dailyAt: '07:00' };
    const { id } = (await api.call<Adapter>('POST', '/api/adapters', weather)).body;
    await api.call('POST', `/api/adapters/${id}/run`);
    const run = await api.call<AdapterRun>('POST', `/api/adapters/${id}/run`);
    expect(f.requests.find((r) => r.includes('/forecast'))).toContain('timezone=Europe%2FBerlin&start_date=2026-11-04&end_date=2026-11-04');
    const days = (await api.call<DailyEntry[]>('GET', '/api/daily')).body;
    expect(days).toEqual([{ date: '2026-11-04', pageId: run.body.pageId }]);
    const page = (await api.call<Page>('GET', `/api/pages/${run.body.pageId}`)).body;
    expect(page.content).toBe('**Weather:** Partly cloudy, 8 to 14 °C, 2.1 mm rain (60%), 5.2 h sunshine, wind up to 21 km/h\n');

    const nowhere = await api.call<Adapter>('POST', '/api/adapters', { ...weather, config: { place: 'Atlantis' } });
    expect((await api.call('POST', `/api/adapters/${nowhere.body.id}/run`)).body).toEqual({ error: 'Open-Meteo knows no place called “Atlantis”' });
    api.adapters.stop();
  });
});
