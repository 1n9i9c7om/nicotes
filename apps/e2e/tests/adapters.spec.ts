import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { expect, test } from '@playwright/test';
import { getPage, uniq } from './fixtures';

/** A fake Home Assistant with two sensors, behind a token. */
let ha: Server;
let haUrl = '';
test.beforeAll(async () => {
  ha = createServer((req, res) => {
    const send = (status: number, body: unknown) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.headers.authorization !== 'Bearer e2e-ha-token') return send(401, { message: 'Unauthorized' });
    if (req.url === '/api/states/sensor.solar_energy_today') return send(200, { state: '12.5', attributes: { unit_of_measurement: 'kWh' } });
    if (req.url === '/api/states/sensor.outdoor_temperature') return send(200, { state: '9', attributes: { unit_of_measurement: '°C' } });
    if (req.url?.startsWith('/api/history/period/')) {
      return send(200, [[{ entity_id: 'sensor.outdoor_temperature', state: '9', last_changed: new Date(Date.now() - 3600e3).toISOString() }]]);
    }
    send(404, { message: 'Entity not found.' });
  });
  await new Promise<void>((resolve) => ha.listen(0, '127.0.0.1', resolve));
  haUrl = `http://127.0.0.1:${(ha.address() as AddressInfo).port}`;
});
test.afterAll(() => ha.close());

test('a Home Assistant adapter is added in Settings and fills its logbook', async ({ page }) => {
  const name = uniq('Home');
  await page.goto('/settings/integrations');
  const card = page.locator('#adapters');
  await card.getByRole('button', { name: 'Home Assistant' }).click();
  const form = card.getByRole('form', { name: 'New Home Assistant adapter' });
  await form.getByLabel('Name').fill(name);
  await form.getByLabel('Address').fill(haUrl);
  await form.getByLabel('Long-lived access token').fill('wrong-token');
  await form.getByLabel('Sensors').fill('sensor.solar_energy_today, Solar\nsensor.outdoor_temperature, Temperature, average');
  await form.getByRole('button', { name: 'Add and run' }).click();

  // The first run shows straight away whether the settings work.
  const item = card.getByRole('listitem').filter({ hasText: name });
  await expect(item).toContainText('Home Assistant did not accept the access token');
  await item.getByRole('button', { name: 'Edit' }).click();
  const edit = card.getByRole('form', { name: `Edit ${name}` });
  await expect(edit.getByLabel('Long-lived access token')).toHaveAttribute('placeholder', /Stored/);
  await edit.getByLabel('Long-lived access token').fill('e2e-ha-token');
  await edit.getByRole('button', { name: 'Save' }).click();
  await item.getByRole('button', { name: 'Run now' }).click();
  await expect(item).toContainText('Solar 12.5 kWh, Temperature 9 °C');

  await item.getByRole('link', { name: 'Open logbook' }).click();
  await expect(page.getByLabel('Page title')).toHaveValue(name);
  const id = page.url().split('/p/')[1]!;
  expect((await getPage(page, id)).content).toMatch(/\| Date \| Solar \(kWh\) \| Temperature \(°C\) \|\n\| --- \| --- \| --- \|\n\| \d{4}-\d{2}-\d{2} \| 12\.5 \| 9 \|/);
  // The token never comes back from the server.
  expect(await (await page.request.get('/api/adapters')).text()).not.toContain('e2e-ha-token');
});
